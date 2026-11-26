import { NextResponse } from 'next/server'
import { fetchBulkTicker24hr, fetchFuturesUniverse, fetchKlinesBatch, type Candle } from '@/lib/binance'
import { normalizeWatchlist } from '@/lib/focus'
import { closedOnly } from '@/lib/reversal'
import { isStablePair } from '@/lib/macdmtf'
import { normalizeZ15, runZ15, type Z15Config, type Z15Row, type Z15Signal } from '@/lib/zero15'

// Edge runtime like the other routes (Binance blocks US IPs; edge runs near the visitor).
export const runtime = 'edge'
export const dynamic = 'force-dynamic'

const CACHE_MS = 30_000
const UNIVERSE_CACHE_MS = 60 * 60 * 1000
const MAX_COINS = 30 // 2 klines requests per coin per refresh (800 x 5M + 1500 x 15M: the 15M history feeds the 45M candles and a settled EMA 200)

interface Cache {
  at: number
  c5: Map<string, Candle[]>
  c15: Map<string, Candle[]>
  ticker: Map<string, { price: number; changePct: number; quoteVolume: number }>
  targets: string[]
  symKey: string
}

let cache: Cache | null = null
let inFlight: Promise<Cache> | null = null
let universe: { at: number; symbols: string[] } | null = null
const rowsCache = new Map<string, { rows: Z15Row[]; signals: Z15Signal[] }>()

async function getUniverse(): Promise<string[]> {
  if (universe && Date.now() - universe.at < UNIVERSE_CACHE_MS) return universe.symbols
  const symbols = await fetchFuturesUniverse()
  universe = { at: Date.now(), symbols }
  return symbols
}

async function refresh(pick: string[] | null): Promise<Cache> {
  const [symbols, ticker] = await Promise.all([pick ? Promise.resolve<string[]>([]) : getUniverse(), fetchBulkTicker24hr()])
  const ranked = symbols
    .filter((s) => ticker.has(s) && !isStablePair(s))
    .sort((a, b) => (ticker.get(b)?.quoteVolume ?? 0) - (ticker.get(a)?.quoteVolume ?? 0))
    .slice(0, MAX_COINS)
  const targets = pick ? pick.filter((s) => ticker.has(s) && !isStablePair(s)) : ranked.includes('BTCUSDT') ? ranked : ['BTCUSDT', ...ranked]
  const [c5, c15] = await Promise.all([fetchKlinesBatch(targets, '5m', 800, 12), fetchKlinesBatch(targets, '15m', 1500, 12)])
  if (c5.size === 0) throw new Error('Binance returned no 5M candles')
  return { at: Date.now(), c5, c15, ticker, targets, symKey: pick ? pick.join(',') : '' }
}

export interface Z15Response {
  rows: Z15Row[]
  /** Signals from the last 3 hours, newest first (for the alert history). */
  signals: Z15Signal[]
  computedAt: number
  live: boolean
  config: Z15Config
  error?: string
}

export async function GET(req: Request) {
  const raw: Record<string, string> = {}
  new URL(req.url).searchParams.forEach((v, k) => {
    raw[k] = v
  })
  const config = normalizeZ15(raw)
  const pick = raw.symbols ? normalizeWatchlist(raw.symbols) : null
  const key0 = pick ? pick.join(',') : ''
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS || cache.symKey !== key0) {
      if (!inFlight) {
        inFlight = refresh(pick).finally(() => {
          inFlight = null
        })
      }
      cache = await inFlight
      if (cache.symKey !== key0) cache = await refresh(pick)
    }
    const snap = cache
    const key = `${snap.at}|${JSON.stringify(config)}`
    let out = rowsCache.get(key)
    if (!out) {
      const now = Date.now()
      const rows: Z15Row[] = []
      const signals: Z15Signal[] = []
      for (const symbol of snap.targets) {
        const t = snap.ticker.get(symbol)
        const a = snap.c5.get(symbol)
        const b = snap.c15.get(symbol)
        if (!t || !a || !b) continue
        // closed candles only: the forming 5M / 15M candle never reaches the engine (45M is built from closed 15M candles inside the engine)
        const run = runZ15(symbol, closedOnly(a, now, 300_000), closedOnly(b, now, 900_000), config)
        if (!run) continue
        run.row.price = t.price
        rows.push(run.row)
        for (const s of run.signals) if (now - s.time < 3 * 3600_000) signals.push(s)
      }
      signals.sort((x, y) => y.time - x.time)
      out = { rows, signals }
      rowsCache.set(key, out)
      while (rowsCache.size > 4) rowsCache.delete(rowsCache.keys().next().value as string)
    }
    const body: Z15Response = { rows: out.rows, signals: out.signals, computedAt: snap.at, live: true, config }
    return NextResponse.json(body)
  } catch (err) {
    // Never show made-up data: if Binance is unreachable, say so.
    const body: Z15Response = { rows: [], signals: [], computedAt: Date.now(), live: false, config, error: err instanceof Error ? err.message : 'Unknown error fetching Binance data' }
    return NextResponse.json(body, { status: 200 })
  }
}
