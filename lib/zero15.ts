import type { Candle } from './binance'
import { atrSeries } from './indicators'
import { impulseMacd, supertrend, type Side, type TradeOutcome } from './impulse5m'

// ---------------------------------------------------------------------------
// MTF Impulse MACD + Supertrend engine: 45M = major trend, 15M = secondary trend, 5M = entry, EMA 200 on all three,
// zero-line dead-zone filter. Pure logic, no I/O.
//
//   45M (last fully CLOSED candle):  Impulse MACD line > signal, both lines above zero, histogram positive, close above EMA 200
//                                    (Binance has no 45M interval: 45M candles are built from three epoch-aligned closed 15M candles)
//   15M (last fully CLOSED candle):  Impulse MACD line > signal, both lines above zero, histogram positive, close above EMA 200,
//                                    Supertrend 12,4 bullish
//   5M  (candle close):              price preferably above EMA 200 (scored; mandatory only if ema5Mandatory = 1)
//   5M  (candle close):              Impulse MACD crosses above its signal, both lines above zero, histogram positive, Supertrend bullish
//   Zero-line filter:                every line must sit further from zero than DEAD_ZONE x ATR (ATR of the same timeframe, so the
//                                    buffer scales with each coin) and both lines must be on the same side of zero; the histogram
//                                    must be at least MIN_HIST x ATR. SELL is the exact mirror image.
//
// Every 5M signal is evaluated "as of" that candle's close: the 45M and 15M timeframes contribute only candles that had already closed by
// then, so nothing repaints and nothing looks ahead. One signal per 5M crossover, plus a per-coin cooldown.
// ---------------------------------------------------------------------------

export const Z15_VERSION = 'z15-2.0'
const MS5 = 300_000
const MS15 = 900_000
const MS45 = 2_700_000
const WARM = 80
/** EMA 200 is only trusted from its 200th candle (SMA-seeded), so every timeframe needs at least this many closed candles. */
const EMA_BARS = 200
export const EMA_LEN = 200

export interface Z15Config {
  /** LazyBear length (smma of high / low, zlema of close). */
  length: number
  signal: number
  stPeriod: number
  stMult: number
  /** Dead zone around zero, in ATRs of the same timeframe. Lines closer than this to zero = MACD near zero. */
  deadZone: number
  /** Minimum |histogram| in ATRs. */
  minHist: number
  /** Stop = this many 5M ATR from the entry. */
  atrSl: number
  /** Take profit = this many R. */
  rr: number
  /** Stops wider than this % of price are rejected. */
  maxRiskPct: number
  /** 5M bars during which the same coin cannot signal again. */
  cooldownBars: number
  /** A signal counts as fresh (shown / popped up) for this many 5M bars after its candle. */
  freshBars: number
  feeBps: number
  slipBps: number
  /** Risk per trade, % of the account balance (used for the position-size hint only; nothing is traded automatically). */
  riskPct: number
  /** 1 = the 5M price must also be on the trade side of its EMA 200 (default 0: preferred, scored, not mandatory). */
  ema5Mandatory: number
}

export const DEFAULT_Z15: Z15Config = {
  length: 34,
  signal: 9,
  stPeriod: 12,
  stMult: 4,
  deadZone: 0.15,
  minHist: 0.03,
  atrSl: 1.5,
  rr: 2,
  maxRiskPct: 3,
  cooldownBars: 3,
  freshBars: 2,
  feeBps: 4,
  slipBps: 2,
  riskPct: 1,
  ema5Mandatory: 0,
}

export function normalizeZ15(p: Partial<Record<keyof Z15Config, unknown>> = {}): Z15Config {
  const d = DEFAULT_Z15
  const num = (k: keyof Z15Config, lo: number, hi: number, int = false) => {
    const x = Number(p[k] ?? d[k])
    const v = Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d[k]
    return int ? Math.round(v) : v
  }
  return {
    length: num('length', 5, 100, true),
    signal: num('signal', 2, 50, true),
    stPeriod: num('stPeriod', 2, 50, true),
    stMult: num('stMult', 0.5, 10),
    deadZone: num('deadZone', 0, 3),
    minHist: num('minHist', 0, 2),
    atrSl: num('atrSl', 0.5, 6),
    rr: num('rr', 1, 5),
    maxRiskPct: num('maxRiskPct', 0.2, 10),
    cooldownBars: num('cooldownBars', 0, 60, true),
    freshBars: num('freshBars', 1, 6, true),
    feeBps: num('feeBps', 0, 30),
    slipBps: num('slipBps', 0, 30),
    riskPct: num('riskPct', 0.1, 5),
    ema5Mandatory: num('ema5Mandatory', 0, 1, true),
  }
}

export type Dir = 'BULLISH' | 'BEARISH' | 'NEUTRAL'

interface S {
  c: Candle[]
  ms: number
  ml: number[]
  sg: number[]
  hist: number[]
  stDir: number[]
  atr: number[]
  ema: number[]
}

/** EMA 200 seeded with the SMA of the first 200 closes (NaN before that), the way charting platforms start it. */
export function ema200Series(c: Candle[], len = EMA_LEN): number[] {
  const out: number[] = new Array(c.length).fill(NaN)
  if (c.length < len) return out
  let e = 0
  for (let i = 0; i < len; i++) e += c[i].close
  e /= len
  out[len - 1] = e
  const k = 2 / (len + 1)
  for (let i = len; i < c.length; i++) {
    e = c[i].close * k + e * (1 - k)
    out[i] = e
  }
  return out
}

/** Binance has no 45M kline: build it from COMPLETE, epoch-aligned groups of three closed 15M candles (a half-built bucket is never emitted). */
export function aggregate45(c15: Candle[]): Candle[] {
  const out: Candle[] = []
  let i = 0
  while (i < c15.length) {
    const b = Math.floor(c15[i].openTime / MS45) * MS45
    if (c15[i].openTime !== b) {
      i++
      continue
    }
    const g = c15.slice(i, i + 3)
    if (g.length === 3 && g[1].openTime === b + MS15 && g[2].openTime === b + 2 * MS15) {
      out.push({ openTime: b, open: g[0].open, high: Math.max(g[0].high, g[1].high, g[2].high), low: Math.min(g[0].low, g[1].low, g[2].low), close: g[2].close, volume: g[0].volume + g[1].volume + g[2].volume })
      i += 3
    } else i++
  }
  return out
}

function series(c: Candle[], ms: number, cfg: Z15Config): S {
  const m = impulseMacd(c, cfg.length, cfg.signal)
  const st = supertrend(c, cfg.stPeriod, cfg.stMult)
  return { c, ms, ml: m.md, sg: m.signal, hist: m.hist, stDir: st.dir, atr: atrSeries(c, 14), ema: ema200Series(c) }
}

const dirOf = (s: S, i: number): Dir => (s.ml[i] > s.sg[i] ? 'BULLISH' : s.ml[i] < s.sg[i] ? 'BEARISH' : 'NEUTRAL')
const crossOf = (s: S, i: number): Side | null =>
  i < 1 ? null : s.ml[i] > s.sg[i] && s.ml[i - 1] <= s.sg[i - 1] ? 'BUY' : s.ml[i] < s.sg[i] && s.ml[i - 1] >= s.sg[i - 1] ? 'SELL' : null

export interface Z15Check {
  key: 't45' | 't15' | 'ema' | 'm5' | 'st' | 'zero' | 'mom' | 'sl' | 'cooldown' | 'ema5'
  label: string
  ok: boolean
  detail: string
  /** Exact line shown when this is the first failing check. */
  wait: string
  /** Preferred-but-not-mandatory check: shown, scored, never blocks a signal. */
  optional?: boolean
}

export interface Z15Part {
  label: string
  pts: number
  max: number
}

export interface Z15Plan {
  entry: number
  sl: number
  tp: number
  risk: number
  riskPct: number
  rr: number
  netRR: number
}

/** Where the last CLOSED candle of a timeframe sits relative to that timeframe's EMA 200. */
export interface EmaStatus {
  state: 'ABOVE' | 'BELOW' | 'NEUTRAL'
  value: number
  close: number
  /** (close − EMA) / EMA × 100 */
  distPct: number
}

export interface Z15Ema {
  m45: EmaStatus
  m15: EmaStatus
  m5: EmaStatus
}

export interface Z15Signal extends Z15Plan {
  id: string
  symbol: string
  side: Side
  /** Close time of the 5M signal candle (ms). */
  time: number
  barsAgo: number
  m45: { line: number; signal: number; hist: number }
  m15: { line: number; signal: number; hist: number }
  m5: { line: number; signal: number; hist: number }
  ema200: Z15Ema
  stBull15: boolean
  stBull5: boolean
  histExpanding: boolean
  score: number
  parts: Z15Part[]
  conditions: string[]
  version: string
  outcome: TradeOutcome
}

export interface Z15Rejection {
  id: string
  symbol: string
  side: Side
  time: number
  reason: string
  failed: string[]
}

export type ZeroState = 'CLEAR' | 'NEAR ZERO' | 'OPPOSITE SIDES'

export interface Z15Row {
  symbol: string
  price: number
  barTime: number
  m45: { dir: Dir; line: number; signal: number; hist: number }
  m15: { dir: Dir; line: number; signal: number; hist: number }
  m5: { dir: Dir; line: number; signal: number; hist: number }
  ema200: Z15Ema
  /** 45M, 15M and 5M closes are all on the same side of their EMA 200. */
  emaAgree: boolean
  st15: 'BULLISH' | 'BEARISH'
  st5: 'BULLISH' | 'BEARISH'
  zero: ZeroState
  /** 15M and 5M Impulse MACD point the same way. */
  agree: boolean
  stAgree: boolean
  status: 'BUY' | 'SELL' | 'WAIT'
  /** Exact reason while WAIT, or a one-line confirmation. */
  text: string
  checks: Z15Check[]
  signal: Z15Signal | null
  score: number | null
  rejections: Z15Rejection[]
  version: string
}

export interface Z15Run {
  signals: Z15Signal[]
  rejections: Z15Rejection[]
  row: Z15Row
}

const W = (s: string) => `WAIT / NO TRADE — ${s}`
export const Z15_REASONS = {
  t45: W('45M trend disagreement'),
  t15: W('15M trend disagreement'),
  ema: W('EMA 200 disagreement'),
  m5: W('5M MACD not confirmed'),
  st: W('Supertrend disagreement'),
  zero: W('MACD near zero'),
  mom: W('Insufficient momentum'),
  sl: W('Invalid stop loss'),
  cooldown: W('Cooldown active'),
} as const

/** Position-size hint: units to buy so a stop-out loses `riskPct` % of the balance. Never executes anything. */
export function positionSize(balance: number, riskPct: number, riskDistance: number, entry: number) {
  if (!(balance > 0) || !(riskDistance > 0)) return null
  const qty = (balance * (riskPct / 100)) / riskDistance
  return { qty, notional: qty * entry, riskAmount: balance * (riskPct / 100) }
}

/** How the zero-line looks for the three timeframes together (independent of the trade side). */
function zeroState(s5: S, i5: number, s15: S, i15: number, s45: S, i45: number, cfg: Z15Config): ZeroState {
  const tf = [
    [s5, i5],
    [s15, i15],
    [s45, i45],
  ] as Array<[S, number]>
  if (tf.some(([s, i]) => Math.sign(s.ml[i]) * Math.sign(s.sg[i]) < 0)) return 'OPPOSITE SIDES'
  for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) if (Math.sign(tf[a][0].ml[tf[a][1]]) * Math.sign(tf[b][0].ml[tf[b][1]]) < 0) return 'OPPOSITE SIDES'
  return tf.some(([s, i]) => Math.min(Math.abs(s.ml[i]), Math.abs(s.sg[i])) < cfg.deadZone * s.atr[i]) ? 'NEAR ZERO' : 'CLEAR'
}

function emaStatus(s: S, i: number): EmaStatus {
  const e = s.ema[i]
  const close = s.c[i].close
  if (!Number.isFinite(e)) return { state: 'NEUTRAL', value: NaN, close, distPct: 0 }
  return { state: close > e ? 'ABOVE' : close < e ? 'BELOW' : 'NEUTRAL', value: e, close, distPct: ((close - e) / e) * 100 }
}

export function runZ15(symbol: string, c5: Candle[], c15: Candle[], cfgIn: Partial<Z15Config> = {}): Z15Run | null {
  const cfg = normalizeZ15(cfgIn)
  const c45 = aggregate45(c15)
  if (c5.length < EMA_BARS + 5 || c15.length < EMA_BARS + 5 || c45.length < EMA_BARS + 5) return null
  const s5 = series(c5, MS5, cfg)
  const s15 = series(c15, MS15, cfg)
  const s45 = series(c45, MS45, cfg)
  const n = c5.length
  const last = n - 1
  const stOk = (s: S, i: number, bull: boolean) => (bull ? s.stDir[i] === 1 : s.stDir[i] === -1)

  /** Evaluate every rule for `side` at 5M bar i with the 15M pointer p and the 45M pointer q. `crossOk` says whether the 5M crossover is on this bar. */
  const assess = (i: number, p: number, q: number, bull: boolean, crossOk: boolean, sinceLast: number) => {
    const checks: Z15Check[] = []
    const add = (key: Z15Check['key'], label: string, ok: boolean, detail: string, optional = false) => checks.push({ key, label, ok, detail, wait: key === 'ema5' ? Z15_REASONS.ema : Z15_REASONS[key], optional })
    const w = (b: boolean) => (b ? 'bullish' : 'bearish')
    const l45 = s45.ml[q]
    const g45 = s45.sg[q]
    const h45 = s45.hist[q]
    const l15 = s15.ml[p]
    const g15 = s15.sg[p]
    const h15 = s15.hist[p]
    const l5 = s5.ml[i]
    const g5 = s5.sg[i]
    const h5 = s5.hist[i]
    const side45 = bull ? l45 > g45 && l45 > 0 && g45 > 0 && h45 > 0 : l45 < g45 && l45 < 0 && g45 < 0 && h45 < 0
    add('t45', '45M trend (closed candle)', side45, side45 ? `45M Impulse MACD ${w(bull)}, both lines ${bull ? 'above' : 'below'} zero, histogram ${bull ? 'positive' : 'negative'}` : `45M line ${l45.toPrecision(4)} / signal ${g45.toPrecision(4)} / histogram ${h45.toPrecision(4)} do not all point ${w(bull)}`)
    const side15 = bull ? l15 > g15 && l15 > 0 && g15 > 0 && h15 > 0 : l15 < g15 && l15 < 0 && g15 < 0 && h15 < 0
    add('t15', '15M trend (closed candle)', side15, side15 ? `15M Impulse MACD ${w(bull)}, both lines ${bull ? 'above' : 'below'} zero, histogram ${bull ? 'positive' : 'negative'}` : `15M line ${l15.toPrecision(4)} / signal ${g15.toPrecision(4)} / histogram ${h15.toPrecision(4)} do not all point ${w(bull)}`)
    const e45 = emaStatus(s45, q)
    const e15 = emaStatus(s15, p)
    const e5 = emaStatus(s5, i)
    const want = bull ? 'ABOVE' : 'BELOW'
    const ema4515 = e45.state === want && e15.state === want
    add('ema', '45M + 15M price vs EMA 200 (closed candles)', ema4515, ema4515 ? `45M close ${e45.distPct.toFixed(2)}% and 15M close ${e15.distPct.toFixed(2)}% ${bull ? 'above' : 'below'} their EMA 200` : `45M close is ${e45.state.toLowerCase()} and 15M close is ${e15.state.toLowerCase()} their EMA 200 (need ${want.toLowerCase()} on both)`)
    const ema5ok = e5.state === want
    add('ema5', '5M price vs EMA 200 (preferred)', ema5ok, ema5ok ? `5M close ${e5.distPct.toFixed(2)}% ${bull ? 'above' : 'below'} its EMA 200` : `5M close is ${e5.state.toLowerCase()} its EMA 200 — preferred ${want.toLowerCase()}${cfg.ema5Mandatory ? ' (mandatory in your settings)' : ', score reduced'}`, !cfg.ema5Mandatory)
    add('m5', '5M crossover on the candle close', crossOk, crossOk ? `5M line crossed ${bull ? 'above' : 'below'} its signal on this candle` : 'no fresh 5M crossover in this direction')
    const st15 = stOk(s15, p, bull)
    const st5 = stOk(s5, i, bull)
    add('st', 'Supertrend 12,4 on 15M and 5M', st15 && st5, st15 && st5 ? `15M and 5M Supertrend ${w(bull)}` : `${!st15 ? '15M' : ''}${!st15 && !st5 ? ' and ' : ''}${!st5 ? '5M' : ''} Supertrend is ${w(!bull)}`)
    const side5 = bull ? l5 > 0 && g5 > 0 : l5 < 0 && g5 < 0
    const dz5 = Math.min(Math.abs(l5), Math.abs(g5)) / s5.atr[i]
    const dz15 = Math.min(Math.abs(l15), Math.abs(g15)) / s15.atr[p]
    const dz45 = Math.min(Math.abs(l45), Math.abs(g45)) / s45.atr[q]
    const zeroOk = side5 && side15 && side45 && dz5 >= cfg.deadZone && dz15 >= cfg.deadZone && dz45 >= cfg.deadZone
    add('zero', 'Zero-line dead zone', zeroOk, zeroOk ? `lines clear of zero (5M ${dz5.toFixed(2)}, 15M ${dz15.toFixed(2)}, 45M ${dz45.toFixed(2)} ATR; limit ${cfg.deadZone})` : !side5 || !side15 || !side45 ? 'lines are on opposite sides of zero or on the wrong side' : `lines inside the dead zone (5M ${dz5.toFixed(2)}, 15M ${dz15.toFixed(2)}, 45M ${dz45.toFixed(2)} ATR; limit ${cfg.deadZone})`)
    const m5 = Math.abs(h5) / s5.atr[i]
    const m15 = Math.abs(h15) / s15.atr[p]
    const m45 = Math.abs(h45) / s45.atr[q]
    const momOk = m5 >= cfg.minHist && m15 >= cfg.minHist && m45 >= cfg.minHist
    add('mom', 'Histogram momentum', momOk, `histogram ${m5.toFixed(2)} ATR (5M) / ${m15.toFixed(2)} ATR (15M) / ${m45.toFixed(2)} ATR (45M), minimum ${cfg.minHist}`)

    const entry = s5.c[i].close
    const risk = cfg.atrSl * s5.atr[i]
    const riskPct = (risk / entry) * 100
    const slOk = Number.isFinite(risk) && risk > 0 && riskPct <= cfg.maxRiskPct
    add('sl', 'ATR stop loss', slOk, slOk ? `stop ${cfg.atrSl} × 5M ATR = ${riskPct.toFixed(2)}% of price` : `stop would be ${riskPct.toFixed(2)}% of price (limit ${cfg.maxRiskPct}%)`)
    add('cooldown', `Coin cooldown (${cfg.cooldownBars} × 5M bars)`, sinceLast >= cfg.cooldownBars, sinceLast >= cfg.cooldownBars ? 'not cooling down' : `last signal ${sinceLast} bar${sinceLast === 1 ? '' : 's'} ago`)

    const costR = ((2 * (cfg.feeBps + cfg.slipBps)) / 10_000) * (entry / risk)
    const plan: Z15Plan = {
      entry,
      sl: bull ? entry - risk : entry + risk,
      tp: bull ? entry + cfg.rr * risk : entry - cfg.rr * risk,
      risk,
      riskPct,
      rr: cfg.rr,
      netRR: (cfg.rr - costR) / (1 + costR),
    }
    // quality score 0-100 (setup quality, NOT a win probability): twelve documented parts
    const sc = (v: number, full: number, max: number) => Math.round(max * Math.min(1, Math.max(0, v / full)))
    const emaClear = Math.min(Math.abs(e45.close - e45.value) / s45.atr[q], Math.abs(e15.close - e15.value) / s15.atr[p])
    const parts: Z15Part[] = [
      { label: '45M histogram strength', pts: sc(m45, 0.3, 8), max: 8 },
      { label: '15M histogram strength', pts: sc(m15, 0.3, 10), max: 10 },
      { label: '5M histogram strength', pts: sc(m5, 0.3, 10), max: 10 },
      { label: '5M histogram expanding', pts: (bull ? h5 > s5.hist[i - 1] : h5 < s5.hist[i - 1]) ? 8 : 0, max: 8 },
      { label: '15M histogram expanding', pts: (bull ? h15 > s15.hist[p - 1] : h15 < s15.hist[p - 1]) ? 4 : 0, max: 4 },
      { label: '15M distance from zero', pts: sc(dz15, 1, 6), max: 6 },
      { label: '5M distance from zero', pts: sc(dz5, 1, 6), max: 6 },
      { label: 'Supertrend agreement (15M + 5M)', pts: (st15 ? 5 : 0) + (st5 ? 7 : 0), max: 12 },
      { label: '45M + 15M + 5M MACD agreement', pts: side45 && side15 && side5 ? 10 : 0, max: 10 },
      { label: '45M / 15M clearance from EMA 200', pts: ema4515 ? sc(emaClear, 1, 8) : 0, max: 8 },
      { label: '5M price on the trade side of EMA 200', pts: ema5ok ? 8 : 0, max: 8 },
    ]
    // last 10 points: a calm signal candle (not oversized)
    const range = s5.c[i].high - s5.c[i].low
    parts.push({ label: 'Signal candle not oversized', pts: range <= 2.5 * s5.atr[i] ? 10 : 0, max: 10 })
    const score = parts.reduce((a, x) => a + x.pts, 0)
    return { checks, plan, score, parts, st15, st5, expanding: parts[3].pts > 0, ema: { m45: e45, m15: e15, m5: e5 } as Z15Ema }
  }
  const mandatory = (cs: Z15Check[]) => cs.filter((c) => !c.ok && !c.optional)

  const signals: Z15Signal[] = []
  const rejections: Z15Rejection[] = []
  let lastIdx = -1e9
  let p15Last = -1
  let p45Last = -1
  let p = -1
  let q = -1
  for (let i = 0; i < n; i++) {
    const T = c5[i].openTime + MS5
    // only candles already CLOSED at this 5M close are ever used
    while (p + 1 < c15.length && c15[p + 1].openTime + MS15 <= T) p++
    while (q + 1 < c45.length && c45[q + 1].openTime + MS45 <= T) q++
    if (i === last) {
      p15Last = p
      p45Last = q
    }
    if (i < EMA_BARS - 1 || p < EMA_BARS - 1 || q < EMA_BARS - 1 || i < WARM) continue
    const cr = crossOf(s5, i)
    if (!cr) continue
    const bull = cr === 'BUY'
    const a = assess(i, p, q, bull, true, i - lastIdx)
    const id = `${symbol}-z15-${cr}-${T}`
    const failed = mandatory(a.checks)
    if (failed.length) {
      rejections.push({ id, symbol, side: cr, time: T, reason: failed[0].wait, failed: failed.map((f) => f.label) })
      continue
    }
    const entry = a.plan.entry
    let outcome: TradeOutcome = { result: 'OPEN', r: 0, pnlPct: 0, closedAt: null }
    const cost = ((2 * (cfg.feeBps + cfg.slipBps)) / 10_000) * (entry / a.plan.risk)
    let done = false
    for (let j = i + 1; j < n && !done; j++) {
      const c = c5[j]
      const hitSl = bull ? c.low <= a.plan.sl : c.high >= a.plan.sl
      const hitTp = bull ? c.high >= a.plan.tp : c.low <= a.plan.tp
      if (hitSl || hitTp) {
        // both inside one candle: the order is unknowable, so the stop is assumed first
        const r = (hitSl ? -1 : cfg.rr) - cost
        outcome = { result: hitSl ? 'LOSS' : 'WIN', r, pnlPct: ((r * a.plan.risk) / entry) * 100, closedAt: c.openTime + MS5 }
        done = true
      }
    }
    if (!done) {
      const r = (bull ? c5[last].close - entry : entry - c5[last].close) / a.plan.risk - cost
      outcome = { result: 'OPEN', r, pnlPct: ((r * a.plan.risk) / entry) * 100, closedAt: null }
    }
    signals.push({
      ...a.plan,
      id,
      symbol,
      side: cr,
      time: T,
      barsAgo: last - i,
      m45: { line: s45.ml[q], signal: s45.sg[q], hist: s45.hist[q] },
      m15: { line: s15.ml[p], signal: s15.sg[p], hist: s15.hist[p] },
      m5: { line: s5.ml[i], signal: s5.sg[i], hist: s5.hist[i] },
      ema200: a.ema,
      stBull15: a.st15 === bull,
      stBull5: a.st5 === bull,
      histExpanding: a.expanding,
      score: a.score,
      parts: a.parts,
      conditions: a.checks.map((c) => `${c.label}: ${c.detail}`),
      version: Z15_VERSION,
      outcome,
    })
    lastIdx = i
  }

  // ---- live row at the latest closed 5M candle
  const pl = p15Last >= 0 ? p15Last : c15.length - 1
  const ql = p45Last >= 0 ? p45Last : c45.length - 1
  const fresh = signals.filter((s) => s.barsAgo < cfg.freshBars).pop() ?? null
  const d45 = dirOf(s45, ql)
  const d15 = dirOf(s15, pl)
  const d5 = dirOf(s5, last)
  // the candidate side follows the MAJOR trend (45M); a 15M or EMA disagreement then shows up as the exact reason
  const cand: Side | null = fresh ? fresh.side : d45 === 'BULLISH' ? 'BUY' : d45 === 'BEARISH' ? 'SELL' : null
  const crossNow = crossOf(s5, last)
  let checks: Z15Check[] = []
  let score: number | null = null
  let status: Z15Row['status'] = 'WAIT'
  let text: string = Z15_REASONS.t45
  if (fresh) {
    status = fresh.side
    text = `${fresh.side} — ALL CONDITIONS CONFIRMED, QUALITY ${fresh.score}/100`
    score = fresh.score
    checks = fresh.conditions.map((c, k) => ({ key: 't15' as const, label: c.split(': ')[0], ok: true, detail: `${c.split(': ').slice(1).join(': ')}`, wait: String(k) }))
  } else if (cand) {
    const a = assess(last, pl, ql, cand === 'BUY', crossNow === cand, last - lastIdx)
    checks = a.checks
    const f = mandatory(a.checks)[0]
    if (f) text = f.wait
    else text = Z15_REASONS.m5
    score = f ? null : a.score
  }
  const st15 = s15.stDir[pl] === 1 ? 'BULLISH' : 'BEARISH'
  const st5 = s5.stDir[last] === 1 ? 'BULLISH' : 'BEARISH'
  const ema200: Z15Ema = { m45: emaStatus(s45, ql), m15: emaStatus(s15, pl), m5: emaStatus(s5, last) }
  return {
    signals: [...signals].reverse(),
    rejections: [...rejections].reverse(),
    row: {
      symbol,
      price: c5[last].close,
      barTime: c5[last].openTime + MS5,
      m45: { dir: d45, line: s45.ml[ql], signal: s45.sg[ql], hist: s45.hist[ql] },
      m15: { dir: d15, line: s15.ml[pl], signal: s15.sg[pl], hist: s15.hist[pl] },
      m5: { dir: d5, line: s5.ml[last], signal: s5.sg[last], hist: s5.hist[last] },
      ema200,
      emaAgree: ema200.m45.state !== 'NEUTRAL' && ema200.m45.state === ema200.m15.state && ema200.m15.state === ema200.m5.state,
      st15,
      st5,
      zero: zeroState(s5, last, s15, pl, s45, ql, cfg),
      agree: d15 !== 'NEUTRAL' && d15 === d5,
      stAgree: st15 === st5,
      status,
      text,
      checks,
      signal: fresh,
      score,
      rejections: [...rejections].reverse().slice(0, 15),
      version: Z15_VERSION,
    },
  }
}

export type Z15Filter = 'all' | 'strongBuy' | 'strongSell' | 'agree' | 'stAgree' | 'ema200' | 'score90'

/** Scanner filters. Strong Buy / Strong Sell show only fully qualified signals. */
export function applyZ15Filter(rows: Z15Row[], f: Z15Filter): Z15Row[] {
  switch (f) {
    case 'strongBuy':
      return rows.filter((r) => r.status === 'BUY')
    case 'strongSell':
      return rows.filter((r) => r.status === 'SELL')
    case 'agree':
      return rows.filter((r) => r.agree)
    case 'stAgree':
      return rows.filter((r) => r.stAgree)
    case 'ema200':
      return rows.filter((r) => r.emaAgree)
    case 'score90':
      return rows.filter((r) => r.score !== null && r.score > 90)
    default:
      return rows
  }
}
