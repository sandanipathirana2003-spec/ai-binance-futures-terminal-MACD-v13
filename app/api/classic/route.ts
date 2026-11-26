import { NextResponse } from 'next/server'
import { fetchBulkTicker24hr, fetchFuturesUniverse, fetchKlinesBatch, type Candle } from '@/lib/binance'
import { isStablePair, type MacdTf } from '@/lib/macdmtf'
import { buildClassicRow, normalizeClassic, type ClassicConfig, type ClassicRow } from '@/lib/macd5m'

// Edge runtime for the same reason as the other routes (Binance blocks US IPs; edge runs near the visitor).
export const runtime = 'edge'
export const dynamic = 'force-dynamic'

// Native Binance klines (nothing is resampled). 499 bars keeps the EMA 200 converged and costs request weight 2 per call.
// 1M entry gets 1000 bars (weight 5). Only the entry and confirmation timeframes are fetched.
const limitOf = (tf: MacdTf) => (tf === '1m' ? 1000 : 499)
const CACHE_MS = 20_000
const UNIVERSE_CACHE_MS = 60 * 60 * 1000
const MAX_COINS = 60 // 2 requests per coin per refresh

interface Cache {
  at: number
  candles: Partial<Record<MacdTf, Map<string, Candle[]>>>
  tfs: MacdTf[]
  ticker: Map<string, { price: number; changePct: number; quoteVolume: number }>
  targets: string[]
}

let cache: Cache | null = null
let inFlight: Promise<Cache> | null = null
let universe: { at: number; symbols: string[] } | null = null
/** Computed rows per (candle snapshot, config): a second viewer or a re-render does not recompute every pair. */
const rowsCache = new Map<string, ClassicRow[]>()

async function getUniverse(): Promise<string[]> {
  if (universe && Date.now() - universe.at < UNIVERSE_CACHE_MS) return universe.symbols
  const symbols = await fetchFuturesUniverse()
  universe = { at: Date.now(), symbols }
  return symbols
}

async function refresh(tfs: MacdTf[]): Promise<Cache> {
  const [symbols, ticker] = await Promise.all([getUniverse(), fetchBulkTicker24hr()])
  const ranked = symbols
    .filter((s) => ticker.has(s) && !isStablePair(s))
    .sort((a, b) => (ticker.get(b)?.quoteVolume ?? 0) - (ticker.get(a)?.quoteVolume ?? 0))
    .slice(0, MAX_COINS)
  const targets = ranked.includes('BTCUSDT') ? ranked : ['BTCUSDT', ...ranked]
  const got = await Promise.all(tfs.map((tf) => fetchKlinesBatch(targets, tf, limitOf(tf), 12)))
  const candles: Cache['candles'] = {}
  tfs.forEach((tf, i) => (candles[tf] = got[i]))
  if ((candles[tfs[0]]?.size ?? 0) === 0) throw new Error(`Binance returned no ${tfs[0]} candles`)
  return { at: Date.now(), candles, tfs, ticker, targets }
}

export interface ClassicResponse {
  rows: ClassicRow[]
  computedAt: number
  live: boolean
  config: ClassicConfig
  error?: string
}

export async function GET(req: Request) {
  const raw: Record<string, string> = {}
  new URL(req.url).searchParams.forEach((v, k) => {
    raw[k] = v
  })
  const config = normalizeClassic(raw) // every setting is clamped, never trusted raw
  const need = [config.entryTf, config.confirmTf]
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS || need.some((t) => !cache!.tfs.includes(t))) {
      if (!inFlight) {
        inFlight = refresh(need).finally(() => {
          inFlight = null
        })
      }
      cache = await inFlight
    }
    const snap = cache
    const key = `${snap.at}|${JSON.stringify(config)}`
    let rows = rowsCache.get(key)
    if (!rows) {
      const now = Date.now()
      rows = []
      for (const symbol of snap.targets) {
        const t = snap.ticker.get(symbol)
        const c: Partial<Record<MacdTf, Candle[]>> = {}
        for (const tf of need) {
          const list = snap.candles[tf]?.get(symbol)
          if (list) c[tf] = list
        }
        if (!t || !c[need[0]] || !c[need[1]]) continue
        const row = buildClassicRow({ symbol, price: t.price, change24h: t.changePct, candles: c, now, cfg: config })
        if (row) rows.push(row)
      }
      rowsCache.set(key, rows)
      while (rowsCache.size > 4) rowsCache.delete(rowsCache.keys().next().value as string)
    }
    const body: ClassicResponse = { rows, computedAt: snap.at, live: true, config }
    return NextResponse.json(body)
  } catch (err) {
    // Never show made-up data: if Binance is unreachable, say so.
    const body: ClassicResponse = { rows: [], computedAt: Date.now(), live: false, config, error: err instanceof Error ? err.message : 'Unknown error fetching Binance data' }
    return NextResponse.json(body, { status: 200 })
  }
}

