import type { Candle } from './binance'
import { prepareClassic, runClassic, normalizeClassic, RR_CHOICES, type ClassicConfig, type ClassicSignal } from './macd5m'
import type { MacdTf } from './macdmtf'

// Back-test of the 5M Classic strategy on REAL Binance futures history (the history itself is fetched by fetchHistory in
// ./macd-backtest, in the browser or in Node). Same engine as the live scan: closed candles only, no look-ahead.

/** Signals of one symbol at or after `windowStart` (earlier bars are indicator warm-up and are not traded). */
export function backtestClassic(symbol: string, data: Partial<Record<MacdTf, Candle[]>>, base: Partial<ClassicConfig>, windowStart: number): ClassicSignal[] {
  const cfg = normalizeClassic(base)
  const S = prepareClassic(data, cfg)
  if (!S) return []
  return runClassic(symbol, S, cfg).signals.filter((s) => s.time >= windowStart)
}

/** The same window at every reward : risk choice (indicators are built once). */
export function rrSweep(symbol: string, data: Partial<Record<MacdTf, Candle[]>>, base: Partial<ClassicConfig>, windowStart: number): Array<{ rr: number; signals: ClassicSignal[] }> {
  const cfg0 = normalizeClassic(base)
  const S = prepareClassic(data, cfg0)
  return RR_CHOICES.map((rr) => {
    if (!S) return { rr, signals: [] }
    const cfg = normalizeClassic({ ...base, rr })
    return { rr, signals: runClassic(symbol, S, cfg).signals.filter((s) => s.time >= windowStart) }
  })
}
