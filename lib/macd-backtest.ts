import type { Candle } from './binance'
import { MACD_MS, STRATEGY_VERSION, normalizeMacdConfig, prepareMacd, runMacd, type MacdConfig, type MacdSignal, type MacdTf, type Rejection } from './macdmtf'

// Back-test on REAL Binance futures history. Runs in the browser (public klines allow CORS) or in Node (scripts/backtest-macd.ts).
// Every variant reads the same closed candles; the 5M-style "other timeframes only see candles closed at the signal close" rule
// of the engine keeps it free of look-ahead (scripts/test-macd.ts proves prefix runs reproduce the full run).

const BASE = 'https://fapi.binance.com'
/** Extra days fetched before the test window so EMA 200 (205 five-minute bars) and the 15M MACD are converged is converged. */
export const WARMUP_DAYS = 6

export interface FetchOpts {
  signal?: AbortSignal
  base?: string
  onPage?: (candlesSoFar: number) => void
}

/** Closed candles of one timeframe covering the last `days` days. */
export async function fetchHistory(symbol: string, tf: MacdTf, days: number, opts: FetchOpts = {}): Promise<Candle[]> {
  const ms = MACD_MS[tf]
  const end = Math.floor(Date.now() / ms) * ms // only candles that have fully closed
  let start = end - days * 86_400_000
  const out: Candle[] = []
  while (start < end) {
    const url = `${opts.base ?? BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${tf}&startTime=${start}&endTime=${end}&limit=1500`
    let res = await fetch(url, { signal: opts.signal })
    if (res.status === 429 || res.status === 418) {
      await new Promise((r) => setTimeout(r, 2000))
      res = await fetch(url, { signal: opts.signal })
    }
    if (!res.ok) throw new Error(`${symbol} ${tf}: Binance HTTP ${res.status}`)
    const raw = (await res.json()) as unknown[][]
    if (!Array.isArray(raw) || raw.length === 0) break
    for (const k of raw) {
      const c: Candle = { openTime: k[0] as number, open: +(k[1] as string), high: +(k[2] as string), low: +(k[3] as string), close: +(k[4] as string), volume: +(k[5] as string) }
      if (c.openTime + ms <= end) out.push(c)
    }
    opts.onPage?.(out.length)
    start = (raw[raw.length - 1][0] as number) + ms
    await new Promise((r) => setTimeout(r, 120))
  }
  return out
}

export interface Variant {
  /** 'precision' = the full strategy; 'basic' = ablation without the ribbon, entry-quality filters, S/R check, score gate and cooldown (shows what they add). */
  key: 'precision' | 'basic'
  label: string
}

export interface VariantResult extends Variant {
  signals: MacdSignal[]
  /** Fresh 1M crossovers that failed a rule, with the exact reason (all of them, not capped). */
  rejections: Rejection[]
  version: string
}

export function defaultVariants(): Variant[] {
  return [
    { key: 'precision', label: 'Precision (all rules)' },
    { key: 'basic', label: 'Basic (MACD 15M/5M/1M + EMA 200 + Supertrend + stop only)' },
  ]
}

/** Run every variant on one symbol's candles. Signals older than the test window (warm-up) are dropped so all variants cover the same period. */
export function backtestSymbol(symbol: string, data: Partial<Record<MacdTf, Candle[]>>, base: Partial<MacdConfig>, windowStart: number, variants = defaultVariants()): VariantResult[] {
  const cfg = normalizeMacdConfig(base)
  // indicator series do not depend on the variant, so they are built once per symbol
  const S = prepareMacd(data, cfg)
  return variants.map((v) => {
    if (!S) return { ...v, signals: [], rejections: [], version: STRATEGY_VERSION }
    const run = runMacd(symbol, S, cfg, { basic: v.key === 'basic', allRejections: true })
    return { ...v, signals: run.signals.filter((s) => s.time >= windowStart), rejections: (run.allRejections ?? []).filter((r) => r.time >= windowStart), version: STRATEGY_VERSION }
  })
}
