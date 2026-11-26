import type { Candle } from './binance'
import { atrSeries, emaSeries } from './indicators'
import { impulseMacd, regularMacd, supertrend, type Side, type Slope, type TradeOutcome } from './impulse5m'
import { closedOnly } from './reversal'

// ---------------------------------------------------------------------------
// MACD PRECISION engine (v8, strategy version STRATEGY_VERSION). Fewer, higher-quality entries. Pure logic, no I/O.
//
//   Priority (all must hold at the close of a 1M candle, closed candles only). Each step has its own exact WAIT reason:
//    1. 15M MACD line on the trade side of its signal line                      WAIT — 15M MACD Opposing
//    2. 5M  MACD line on the trade side, histogram on the trade side or rising  WAIT — 5M MACD Not Confirmed
//    3. 1M  MACD crossover in the trade direction, confirmed by the candle close WAIT — No Fresh 1M Crossover
//    4. 5M  EMA 200: right side, directional slope (not flat), not hugging it    WAIT — EMA 200 Filter Failed
//    5. 5M  EMA ribbon 20/50/100/200 stacked for the trade (mixed = WAIT)        WAIT — Mixed EMA Ribbon
//    6. Supertrend 12,4: 1M, 3M (must not oppose) and 5M agree                   WAIT — Supertrend Not Confirmed
//    7. Stop = 1M swing + ATR buffer, validated by 5M market structure           WAIT — Invalid Stop Loss
//    8. TP = entry +/- 2 x risk, not blocked by S/R, net RR after costs >= min   WAIT — RR Below 1:2
//    9. Risk / liquidity / volume filters, not overextended                      WAIT — Entry Overextended
//   10. Sideways filter (ADX, EMA 200 slope, ribbon squeeze, ATR / volume contraction, range)   WAIT — Sideways Market
//   11. Setup quality score (0-100, NOT a win probability) >= minScore          WAIT — Signal Quality Below 85
//   12. Per-coin cooldown, one signal per crossover                              WAIT — Cooldown Active
// 3M is an early-warning / momentum timeframe: a 3M MACD that agrees adds score and makes an EARLY setup possible, a 3M
// Supertrend that opposes blocks the entry. Early setups are shown on the dashboard but never trigger a popup.
//
// Entry = close of the signal candle. The other timeframes contribute only candles that had already closed at that moment,
// so a signal never repaints and never looks ahead. One signal per crossover (the crossover time is part of the id).
// ---------------------------------------------------------------------------

/** Bump whenever a rule or default changes; stored on every signal and back-test so results are never mixed up. */
export const STRATEGY_VERSION = 'precision-8.1'

export const MACD_TFS = ['1m', '3m', '5m', '15m', '30m'] as const
export type MacdTf = (typeof MACD_TFS)[number]
export const MACD_MS: Record<MacdTf, number> = { '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000 }
export const MACD_LABEL: Record<MacdTf, string> = { '1m': '1M', '3m': '3M', '5m': '5M', '15m': '15M', '30m': '30M' }

/** Roles of the timeframes (fixed by the strategy). */
export const TRIGGER = '1m' as const
export const TREND = '5m' as const
export const HTF = '15m' as const
export const CORE_TFS: MacdTf[] = ['1m', '3m', '5m', '15m']
/** Optional extra timeframes whose MACD must merely not oppose the trade strongly. */
export const EXTRA_TFS: MacdTf[] = ['30m']

/** Strict reward : risk. Deliberately not configurable. */
export const RR = 2
/** Closed bars a timeframe needs before its MACD is trusted. */
const WARM = 60
/** 5M bars needed before the EMA 200 is trusted. */
export const EMA_WARM = 205
/** Closed 1M bars needed before anything is evaluated (lookbacks for swings / volume / S-R). */
const MIN_1M = 120
const SLOPE_BARS = 10
const SLOPE_FLAT = 0.004
const SWING_K = 3
const SWING_LOOKBACK = 60
const SL_BUFFER_ATR = 0.5
const SL_NOISE_FLOOR_ATR = 1.5
const BIG_CANDLE_ATR = 2.5
const EXTENDED_EMA20_ATR = 3
const PUMP_BARS = 10
const PUMP_ATR = 6
const SR_BLOCK = 0.85
const HIST_ZERO_ATR = 0.04

const STABLES = new Set(['USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'BUSD', 'USDE', 'USDS', 'USD1', 'RLUSD', 'PYUSD', 'XUSD', 'BFUSD', 'EUR', 'AEUR', 'EURI', 'GUSD', 'USTC'])
/** Stablecoin pairs never trend; they are excluded from the scanner and from every signal. */
export const isStablePair = (symbol: string) => STABLES.has(symbol.replace(/USDT$/, ''))

export interface MacdConfig {
  fast: number
  slow: number
  signal: number
  stPeriod: number
  stMult: number
  /** Timeframes checked. 1M / 3M / 5M / 15M are always in; 30M is an optional "must not strongly oppose" check. */
  tfs: MacdTf[]
  /** Entry timeframe. Fixed at 1M. */
  trigger: MacdTf
  /** The 1M crossover may be at most this many 1M bars old. 0 = the signal candle itself (default: no late entries). */
  maxCrossAge: number
  /** 5M price closer to the EMA 200 than this many 5M ATR = WAIT. */
  nearEmaAtr: number
  /** Minimum setup quality score (0-100). */
  minScore: number
  /** After a signal, the same coin is silent for this many 1M bars. */
  cooldownBars: number
  /** Minimum reward : risk after fees and slippage (the gross target is always 1:2). */
  minNetRR: number
  /** Stops wider than this % of price are rejected. */
  maxRiskPct: number
  /** Minimum average 1M traded value (USDT per minute, last 60 bars). */
  minLiqUsd: number
  feeBps: number
  slipBps: number
  /** A signal counts as "fresh" (shown as CONFIRMED / popped up) for this many 1M bars after its candle. */
  freshBars: number
  /** 'impulse' = LazyBear Impulse MACD (smma/zlema channel, SMA signal), 'normal' = classic 12/26/9 MACD. */
  indicator: 'impulse' | 'normal'
  /** LazyBear length (smma of high / low and zlema of close). */
  impLen: number
  /** RSI confirmation on 1M, 5M and 15M. */
  rsiOn: boolean
  rsiLen: number
  /** BUY needs RSI above this, SELL below 100 - this. */
  rsiBull: number
  /** Assumed order latency (ms): the expected adverse drift of that time (latency x 1M ATR / 60 s) is added to the trade cost. */
  latencyMs: number
  /** Ribbon pairs (of 3) that must be stacked for the trade: 3 = full stack (default), 2 = mostly stacked. */
  ribbonMin: 2 | 3
  /** Sideways filter. */
  sidewaysOn: boolean
  /** Sideways when at least this many of the 8 sideways tests hit. */
  sidewaysHits: number
  adxMax: number
  /** 5M ribbon spread (EMA 20..200) below this % of price = squeezed. */
  squeezePct: number
  /** 5M ATR below this fraction of its 50-bar average = contracting. */
  atrContract: number
  /** 1M volume (5 bars) below this fraction of the 60-bar average = contracting. */
  volContract: number
  /** 5M range of the last 30 bars below this many ATR = tight range. */
  rangeAtr: number
}

export const DEFAULT_MACD: MacdConfig = {
  fast: 12,
  slow: 26,
  signal: 9,
  stPeriod: 12,
  stMult: 4,
  tfs: [...CORE_TFS],
  trigger: TRIGGER,
  maxCrossAge: 0,
  nearEmaAtr: 0.25,
  minScore: 85,
  cooldownBars: 15,
  minNetRR: 1.4,
  maxRiskPct: 1.5,
  minLiqUsd: 5000,
  feeBps: 4,
  slipBps: 2,
  freshBars: 3,
  indicator: 'impulse',
  impLen: 34,
  rsiOn: true,
  rsiLen: 14,
  rsiBull: 50,
  latencyMs: 1000,
  ribbonMin: 3,
  sidewaysOn: true,
  sidewaysHits: 3,
  adxMax: 18,
  squeezePct: 0.3,
  atrContract: 0.75,
  volContract: 0.6,
  rangeAtr: 7,
}

const clamp = (v: number, lo: number, hi: number, fb: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb)

/** Merge user-supplied values over the defaults and clamp everything (server and tests both use this; nothing raw is trusted). */
export function normalizeMacdConfig(p: Partial<Record<keyof MacdConfig, unknown>> = {}): MacdConfig {
  const d = DEFAULT_MACD
  const num = (k: keyof MacdConfig, lo: number, hi: number) => clamp(Number(p[k] ?? d[k]), lo, hi, Number(d[k]))
  const fast = Math.round(num('fast', 2, 50))
  const slow = Math.max(fast + 1, Math.round(num('slow', 5, 100)))
  const raw = Array.isArray(p.tfs) ? p.tfs.map(String) : typeof p.tfs === 'string' ? p.tfs.split(',') : d.tfs
  const set = new Set<string>(raw)
  for (const t of CORE_TFS) set.add(t)
  return {
    fast,
    slow,
    signal: Math.round(num('signal', 2, 50)),
    stPeriod: Math.round(num('stPeriod', 2, 50)),
    stMult: num('stMult', 0.5, 20),
    tfs: MACD_TFS.filter((t) => set.has(t)),
    trigger: TRIGGER,
    maxCrossAge: Math.round(num('maxCrossAge', 0, 3)),
    nearEmaAtr: num('nearEmaAtr', 0, 2),
    minScore: Math.round(num('minScore', 0, 100)),
    cooldownBars: Math.round(num('cooldownBars', 0, 240)),
    minNetRR: num('minNetRR', 1, 1.95),
    maxRiskPct: num('maxRiskPct', 0.1, 10),
    minLiqUsd: num('minLiqUsd', 0, 1_000_000),
    feeBps: num('feeBps', 0, 50),
    slipBps: num('slipBps', 0, 50),
    freshBars: Math.round(num('freshBars', 1, 12)),
    indicator: p.indicator === 'normal' ? 'normal' : p.indicator === 'impulse' ? 'impulse' : d.indicator,
    impLen: Math.round(num('impLen', 5, 100)),
    rsiOn: p.rsiOn === undefined ? d.rsiOn : p.rsiOn === true || p.rsiOn === 'true' || p.rsiOn === 1,
    rsiLen: Math.round(num('rsiLen', 2, 50)),
    rsiBull: num('rsiBull', 40, 70),
    latencyMs: num('latencyMs', 0, 10_000),
    ribbonMin: Math.round(num('ribbonMin', 2, 3)) === 2 ? 2 : 3,
    sidewaysOn: p.sidewaysOn === undefined ? d.sidewaysOn : p.sidewaysOn === true || p.sidewaysOn === 'true' || p.sidewaysOn === 1,
    sidewaysHits: Math.round(num('sidewaysHits', 1, 8)),
    adxMax: num('adxMax', 5, 50),
    squeezePct: num('squeezePct', 0.02, 3),
    atrContract: num('atrContract', 0.3, 1),
    volContract: num('volContract', 0.2, 1),
    rangeAtr: num('rangeAtr', 2, 30),
  }
}

// --------------------------------------------------------------------------- types

export type Dir = 'BUY' | 'SELL' | 'NEUTRAL'

export interface TfView {
  tf: MacdTf
  /** True when this timeframe is part of the check (1M / 5M / 15M always; 3M / 30M when enabled). */
  selected: boolean
  barTime: number
  close: number
  dir: Dir
  line: number
  signal: number
  hist: number
  cross: { type: 'BULLISH' | 'BEARISH'; barsAgo: number } | null
  momentum: 'STRENGTHENING' | 'WEAKENING'
  moving: 'UP' | 'DOWN' | 'FLAT'
  zero: 'ABOVE' | 'BELOW'
  rsi: number
}

export interface TradePlan {
  sl: number
  tp: number
  risk: number
  reward: number
  riskPct: number
  rewardPct: number
  /** Round-trip fees + slippage + modelled latency drift, in R. */
  costR: number
  /** The planned reward : risk before costs. Always 2 (strict 1:2). */
  grossRR: number
  /** (2R - cost) / (1R + cost): the reward : risk after fees, slippage and latency. */
  netRR: number
  /** The 1M swing low / high the stop is built on. */
  swing: number
}

export interface ScorePart {
  label: string
  pts: number
  max: number
}

export interface RibbonView {
  e20: number
  e50: number
  e100: number
  e200: number
  /** Number of the three pairs (20/50, 50/100, 100/200) stacked bullish / bearish. */
  stackBull: number
  stackBear: number
  state: 'BULLISH STACK' | 'BEARISH STACK' | 'MIXED'
  buyOk: boolean
  sellOk: boolean
  label: string
}

export interface MacdSignal extends TradePlan {
  id: string
  symbol: string
  side: Side
  trigger: MacdTf
  /** Close time (ms) of the signal candle. */
  time: number
  barsAgo: number
  /** Signal price = close of the signal candle (not an executed fill). */
  entry: number
  crossAge: number
  /** 1M MACD values at the signal. */
  macd: { line: number; signal: number; hist: number }
  /** Direction of every checked timeframe at the signal. */
  tfs: Partial<Record<MacdTf, Dir>>
  selectedTfs: MacdTf[]
  /** 5M EMA 200. */
  ema200: { value: number; position: 'ABOVE' | 'BELOW'; distPct: number; slope: Slope }
  ribbon: { state: RibbonView['state']; stack: number }
  /** 1M Supertrend (entry confirmation) and 5M Supertrend (stop reference). */
  supertrend: { dir: 'BUY' | 'SELL'; line: number }
  st3: { dir: 'BUY' | 'SELL'; line: number }
  st5: { dir: 'BUY' | 'SELL'; line: number }
  st15: { dir: 'BUY' | 'SELL'; line: number }
  /** Strategy version the signal was produced by. */
  version: string
  /** Setup quality 0-100. A measure of how many things line up, NOT a probability of winning. */
  score: number
  scoreParts: ScorePart[]
  conditions: string[]
  outcome: TradeOutcome
}

export type MacdState = 'CONFIRMED BUY' | 'CONFIRMED SELL' | 'EARLY BUY' | 'EARLY SELL' | 'WAIT'

export interface CheckItem {
  key: string
  label: string
  ok: boolean
  detail: string
  /** The exact WAIT line shown when this is the first failing check. */
  wait?: string
}

/** One sideways test. */
export interface SidewaysTest {
  key: string
  label: string
  hit: boolean
  value: string
}

export interface SidewaysView {
  sideways: boolean
  hits: number
  of: number
  tests: SidewaysTest[]
}

/** A fresh 1M crossover that did not become a signal, with the exact reason (logged, never silently dropped). */
export interface Rejection {
  id: string
  symbol: string
  side: Side
  /** Close time (ms) of the crossover candle. */
  time: number
  price: number
  /** The first failing rule, as the exact WAIT line. */
  reason: string
  /** Every rule that failed. */
  failed: string[]
  score: number | null
  version: string
}

export interface MacdRow {
  symbol: string
  price: number
  change24h: number
  trigger: MacdTf
  barTime: number
  tfs: Partial<Record<MacdTf, TfView>>
  agreement: {
    selected: MacdTf[]
    bull: number
    bear: number
    total: number
    side: Side | null
    overall: 'BULLISH' | 'BEARISH' | 'MIXED'
    disagreeing: MacdTf[]
  }
  /** 5M EMA 200 against the latest 1M close. */
  ema200: {
    value: number
    position: 'ABOVE' | 'BELOW'
    slope: Slope
    distPct: number
    distAtr: number
    near: boolean
    trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
    buyValid: boolean
    sellValid: boolean
    label: string
  }
  ribbon: RibbonView
  /** 1M Supertrend (entry confirmation). */
  supertrend: { dir: 'BUY' | 'SELL'; line: number; distPct: number; flipBarsAgo: number | null; label: string }
  /** 3M Supertrend (early confirmation: must not oppose). */
  st3: { dir: 'BUY' | 'SELL'; line: number; distPct: number; label: string }
  /** 5M Supertrend (stop reference and trend context). */
  st5: { dir: 'BUY' | 'SELL'; line: number; distPct: number; label: string }
  /** 15M Supertrend (higher-timeframe context). */
  st15: { dir: 'BUY' | 'SELL'; line: number; distPct: number; label: string }
  status: { state: MacdState; text: string; side: Side | null; blocker: string | null; missing: MacdTf[] }
  /** The priority checklist for the side the 5M / 15M MACD point to (empty when they disagree). */
  checks: CheckItem[]
  /** Quality score of the setup as it stands now (null when there is no candidate side or no valid stop). */
  score: number | null
  scoreParts: ScorePart[]
  /** Planned trade if a fresh crossover appeared right now (null when no valid stop). */
  plan: (TradePlan & { side: Side }) | null
  liquidityUsd: number
  signal: MacdSignal | null
  history: MacdSignal[]
  open: MacdSignal[]
  bars: number
  /** Early setup (everything but the fresh 1M cross lines up, 3M agrees). Never triggers a popup. */
  early: { side: Side; text: string } | null
  sideways: SidewaysView
  /** Fresh crossovers rejected in the loaded window, newest first (capped). */
  rejections: Rejection[]
  version: string
}

// --------------------------------------------------------------------------- series

export interface Series {
  tf: MacdTf
  c: Candle[]
  ms: number
  close: number[]
  vol: number[]
  ml: number[]
  sg: number[]
  hist: number[]
  stDir: number[]
  stLine: number[]
  e20: number[]
  e50: number[]
  e100: number[]
  e200: number[]
  atr: number[]
  adx: number[]
  rsi: number[]
}

export type SeriesSet = Partial<Record<MacdTf, Series>> & Record<'1m' | '3m' | '5m' | '15m', Series>

/** Wilder RSI (RMA of gains / losses, seeded with the simple average). NaN until `period` changes exist. */
export function rsiSeries(v: number[], period = 14): number[] {
  const out = new Array<number>(v.length).fill(NaN)
  if (v.length <= period) return out
  let g = 0
  let l = 0
  for (let i = 1; i <= period; i++) {
    const d = v[i] - v[i - 1]
    if (d >= 0) g += d
    else l -= d
  }
  g /= period
  l /= period
  out[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l)
  for (let i = period + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1]
    g = (g * (period - 1) + (d > 0 ? d : 0)) / period
    l = (l * (period - 1) + (d < 0 ? -d : 0)) / period
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l)
  }
  return out
}

/** Wilder ADX. NaN until 2 x period bars exist. */
export function adxSeries(c: Candle[], period = 14): number[] {
  const n = c.length
  const out = new Array<number>(n).fill(NaN)
  if (n < period * 2 + 1) return out
  const tr: number[] = [0]
  const pdm: number[] = [0]
  const mdm: number[] = [0]
  for (let i = 1; i < n; i++) {
    const up = c[i].high - c[i - 1].high
    const dn = c[i - 1].low - c[i].low
    pdm.push(up > dn && up > 0 ? up : 0)
    mdm.push(dn > up && dn > 0 ? dn : 0)
    tr.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)))
  }
  let atrW = 0
  let pW = 0
  let mW = 0
  for (let i = 1; i <= period; i++) {
    atrW += tr[i]
    pW += pdm[i]
    mW += mdm[i]
  }
  const dx: number[] = new Array(n).fill(NaN)
  const calc = (i: number) => {
    const pdi = atrW > 0 ? (100 * pW) / atrW : 0
    const mdi = atrW > 0 ? (100 * mW) / atrW : 0
    dx[i] = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0
  }
  calc(period)
  for (let i = period + 1; i < n; i++) {
    atrW = atrW - atrW / period + tr[i]
    pW = pW - pW / period + pdm[i]
    mW = mW - mW / period + mdm[i]
    calc(i)
  }
  let a = 0
  for (let i = period; i < period * 2; i++) a += dx[i]
  a /= period
  out[period * 2 - 1] = a
  for (let i = period * 2; i < n; i++) {
    a = (a * (period - 1) + dx[i]) / period
    out[i] = a
  }
  return out
}

function buildSeries(tf: MacdTf, c: Candle[], cfg: MacdConfig): Series {
  const close = c.map((x) => x.close)
  const m = cfg.indicator === 'impulse' ? (() => { const q = impulseMacd(c, cfg.impLen, cfg.signal); return { line: q.md, signal: q.signal, hist: q.hist } })() : regularMacd(close, cfg.fast, cfg.slow, cfg.signal)
  const st = supertrend(c, cfg.stPeriod, cfg.stMult)
  return {
    tf,
    c,
    ms: MACD_MS[tf],
    close,
    vol: c.map((x) => x.volume),
    ml: m.line,
    sg: m.signal,
    hist: m.hist,
    stDir: st.dir,
    stLine: st.line,
    e20: emaSeries(close, 20),
    e50: emaSeries(close, 50),
    e100: emaSeries(close, 100),
    e200: emaSeries(close, 200),
    atr: atrSeries(c, 14),
    adx: adxSeries(c, 14),
    rsi: rsiSeries(close, cfg.rsiLen),
  }
}

/** Indicator series for every checked timeframe (closed candles only). Null when a core timeframe has too little history. */
export function prepareMacd(input: Partial<Record<MacdTf, Candle[]>>, cfg: MacdConfig): SeriesSet | null {
  const S: Partial<Record<MacdTf, Series>> = {}
  for (const tf of cfg.tfs) {
    const c = input[tf]
    if (!c || c.length < WARM + 5) return null
    S[tf] = buildSeries(tf, c, cfg)
  }
  if (S['1m']!.c.length < MIN_1M || S['5m']!.c.length < EMA_WARM + 5) return null
  return S as SeriesSet
}

const atrAt = (s: Series, i: number) => (Number.isFinite(s.atr[i]) && s.atr[i] > 0 ? s.atr[i] : s.close[i] * 0.001)
const dirAt = (s: Series, i: number): Dir => (s.ml[i] > s.sg[i] ? 'BUY' : s.ml[i] < s.sg[i] ? 'SELL' : 'NEUTRAL')
const crossAt = (s: Series, i: number): 'BULL' | 'BEAR' | null =>
  i < 1 ? null : s.ml[i] > s.sg[i] && s.ml[i - 1] <= s.sg[i - 1] ? 'BULL' : s.ml[i] < s.sg[i] && s.ml[i - 1] >= s.sg[i - 1] ? 'BEAR' : null

function slopeAt(s: Series, i: number): Slope {
  if (i < SLOPE_BARS) return 'FLAT'
  const v = (s.e200[i] - s.e200[i - SLOPE_BARS]) / SLOPE_BARS / atrAt(s, i)
  return v > SLOPE_FLAT ? 'RISING' : v < -SLOPE_FLAT ? 'FALLING' : 'FLAT'
}

function viewAt(s: Series, i: number, selected: boolean): TfView {
  let cross: TfView['cross'] = null
  for (let k = i; k > Math.max(0, i - 80); k--) {
    const c = crossAt(s, k)
    if (c) {
      cross = { type: c === 'BULL' ? 'BULLISH' : 'BEARISH', barsAgo: i - k }
      break
    }
  }
  const dl = s.ml[i] - s.ml[i - 1]
  return {
    tf: s.tf,
    selected,
    barTime: s.c[i].openTime + s.ms,
    close: s.close[i],
    dir: dirAt(s, i),
    line: s.ml[i],
    signal: s.sg[i],
    hist: s.hist[i],
    cross,
    momentum: Math.abs(s.hist[i]) > Math.abs(s.hist[i - 1]) ? 'STRENGTHENING' : 'WEAKENING',
    moving: dl > 0 ? 'UP' : dl < 0 ? 'DOWN' : 'FLAT',
    zero: s.ml[i] >= 0 ? 'ABOVE' : 'BELOW',
    rsi: s.rsi[i],
  }
}

function ribbonAt(s: Series, i: number): RibbonView {
  const e20 = s.e20[i]
  const e50 = s.e50[i]
  const e100 = s.e100[i]
  const e200 = s.e200[i]
  const stackBull = Number(e20 > e50) + Number(e50 > e100) + Number(e100 > e200)
  const stackBear = Number(e20 < e50) + Number(e50 < e100) + Number(e100 < e200)
  const state: RibbonView['state'] = stackBull === 3 ? 'BULLISH STACK' : stackBear === 3 ? 'BEARISH STACK' : 'MIXED'
  const buyOk = stackBull >= 2
  const sellOk = stackBear >= 2
  return {
    e20,
    e50,
    e100,
    e200,
    stackBull,
    stackBear,
    state,
    buyOk,
    sellOk,
    label: state === 'MIXED' ? (buyOk ? 'MOSTLY BULLISH (2/3 stacked)' : sellOk ? 'MOSTLY BEARISH (2/3 stacked)' : 'HEAVILY MIXED — WAIT') : state,
  }
}

const isPivotLow = (s: Series, j: number, k: number) => {
  if (j - k < 0 || j + k >= s.c.length) return false
  const v = s.c[j].low
  for (let q = j - k; q <= j + k; q++) if (q !== j && s.c[q].low <= v) return false
  return true
}
const isPivotHigh = (s: Series, j: number, k: number) => {
  if (j - k < 0 || j + k >= s.c.length) return false
  const v = s.c[j].high
  for (let q = j - k; q <= j + k; q++) if (q !== j && s.c[q].high >= v) return false
  return true
}
const mean = (a: number[], from: number, to: number) => {
  let t = 0
  let n = 0
  for (let k = Math.max(0, from); k <= to; k++) {
    t += a[k]
    n++
  }
  return n ? t / n : 0
}

// --------------------------------------------------------------------------- engine

export interface MacdRun {
  signals: MacdSignal[]
  allRejections?: Rejection[]
  row: Omit<MacdRow, 'symbol' | 'price' | 'change24h' | 'history' | 'open'>
}

export interface RunOptions {
  /** Ablation for the back-test: only MACD (15M, 5M, 1M cross) + EMA 200 side + 1M Supertrend + a valid stop. No ribbon, quality filters, S/R, score or cooldown. */
  basic?: boolean
  /** Diagnostics: counts which check rejected each candidate crossover (first failing check). */
  trace?: Record<string, number>
  /** Also return every rejection (not just the newest 100). */
  allRejections?: boolean
}

interface Ptrs {
  [tf: string]: number
}

interface Assessment {
  checks: CheckItem[]
  /** Index in `checks` of the first failure, -1 when everything passed. */
  firstFail: number
  plan: TradePlan | null
  score: number | null
  parts: ScorePart[]
  /** All checks except the crossover timing passed. */
  readyForCross: boolean
  sideways: SidewaysView
}

export function runMacd(symbol: string, S: SeriesSet, cfg: MacdConfig, opts: RunOptions = {}): MacdRun {
  const basic = Boolean(opts.basic)
  const t = S['1m']
  const s3 = S['3m']
  const s5 = S['5m']
  const s15 = S['15m']
  const n = t.c.length
  const last = n - 1
  const word = (bull: boolean) => (bull ? 'BULLISH' : 'BEARISH')
  const stable = isStablePair(symbol)

  /** Support / resistance levels (swing highs for longs, swing lows for shorts) on 1M, 5M and 15M, above / below `price`. */
  const nearestLevel = (bull: boolean, price: number, i: number, p5: number, p15: number): number | null => {
    let best: number | null = null
    const take = (v: number) => {
      if (bull ? v > price : v < price) best = best === null ? v : bull ? Math.min(best, v) : Math.max(best, v)
    }
    const scan = (s: Series, from: number, k: number, count: number) => {
      for (let j = from - k; j > Math.max(k, from - count); j--) {
        if (bull ? isPivotHigh(s, j, k) : isPivotLow(s, j, k)) take(bull ? s.c[j].high : s.c[j].low)
      }
    }
    scan(t, i, 5, 240)
    scan(s5, p5, 3, 144)
    scan(s15, p15, 2, 96)
    return best
  }

  /** The 8 sideways tests at 1M bar `i` (5M pointer `p5`). */
  const sidewaysAt = (i: number, p5: number): SidewaysView => {
    const a5 = atrAt(s5, p5)
    const close = t.close[i]
    const tests: SidewaysTest[] = []
    const add = (key: string, label: string, hit: boolean, value: string) => tests.push({ key, label, hit, value })
    const adx = s5.adx[p5]
    add('adx', `5M ADX(14) below ${cfg.adxMax}`, Number.isFinite(adx) && adx < cfg.adxMax, Number.isFinite(adx) ? adx.toFixed(1) : 'n/a')
    const slope = slopeAt(s5, p5)
    add('slope', '5M EMA 200 flat', slope === 'FLAT', slope.toLowerCase())
    const hi = Math.max(s5.e20[p5], s5.e50[p5], s5.e100[p5], s5.e200[p5])
    const lo = Math.min(s5.e20[p5], s5.e50[p5], s5.e100[p5], s5.e200[p5])
    const spread = ((hi - lo) / close) * 100
    add('squeeze', `5M ribbon squeezed (< ${cfg.squeezePct}%)`, spread < cfg.squeezePct, `${spread.toFixed(2)}%`)
    let hs = 0
    for (let k = Math.max(0, p5 - 9); k <= p5; k++) hs += Math.abs(s5.hist[k])
    hs /= Math.min(10, p5 + 1)
    add('hist', '5M MACD histogram near zero', hs < HIST_ZERO_ATR * a5, `${(hs / a5).toFixed(3)} ATR`)
    const atrAvg = mean(s5.atr, p5 - 49, p5)
    add('atr', `5M ATR contracting (< ${Math.round(cfg.atrContract * 100)}% of its 50-bar average)`, atrAvg > 0 && a5 < cfg.atrContract * atrAvg, atrAvg > 0 ? `${Math.round((a5 / atrAvg) * 100)}%` : 'n/a')
    const v5 = mean(t.vol, i - 4, i)
    const v60 = mean(t.vol, i - 59, i)
    add('vol', `1M volume contracting (< ${Math.round(cfg.volContract * 100)}% of average)`, v60 > 0 && v5 < cfg.volContract * v60, v60 > 0 ? `${Math.round((v5 / v60) * 100)}%` : 'n/a')
    let rh = -Infinity
    let rl = Infinity
    for (let k = Math.max(0, p5 - 29); k <= p5; k++) {
      rh = Math.max(rh, s5.c[k].high)
      rl = Math.min(rl, s5.c[k].low)
    }
    add('range', `5M range of the last 30 bars under ${cfg.rangeAtr} ATR`, (rh - rl) / a5 < cfg.rangeAtr, `${((rh - rl) / a5).toFixed(1)} ATR`)
    let x = 0
    for (let k = Math.max(1, p5 - 29); k <= p5; k++) if (s5.close[k] > s5.e200[k] !== s5.close[k - 1] > s5.e200[k - 1]) x++
    add('cross200', 'Price keeps crossing the 5M EMA 200 (≥ 3 times in 30 bars)', x >= 3, String(x))
    const hits = tests.filter((q) => q.hit).length
    return { sideways: cfg.sidewaysOn && hits >= cfg.sidewaysHits, hits, of: tests.length, tests }
  }

  /** Evaluate every rule for `side` at 1M bar `i`, with the per-timeframe pointers `p`. `cross` is the crossover situation, `lastSig` the 1M index of the previous signal (cooldown). */
  const assess = (i: number, p: Ptrs, bull: boolean, cross: { ok: boolean; detail: string }, lastSig: number): Assessment => {
    const checks: CheckItem[] = []
    const add = (key: string, label: string, ok: boolean, detail: string, wait?: string) => checks.push({ key, label, ok, detail, wait: wait ? `WAIT — ${wait}` : undefined })
    const side: Side = bull ? 'BUY' : 'SELL'
    const p3 = p['3m']
    const p5 = p['5m']
    const p15 = p['15m']
    const close = t.close[i]
    const a1 = atrAt(t, i)
    const a5 = atrAt(s5, p5)

    // 1. 15M
    const d15 = dirAt(s15, p15)
    add('m15', '15M MACD direction', d15 === side, d15 === side ? `15M MACD ${word(bull)}` : `15M MACD is ${d15 === 'NEUTRAL' ? 'neutral' : word(!bull)}`, '15M MACD Opposing')
    // 2. 5M
    const d5 = dirAt(s5, p5)
    const h5 = s5.hist[p5]
    const h5p = s5.hist[p5 - 1]
    const histOk = bull ? h5 > 0 || h5 > h5p : h5 < 0 || h5 < h5p
    add('m5', '5M MACD direction + histogram', d5 === side && histOk, d5 !== side ? `5M MACD is ${d5 === 'NEUTRAL' ? 'neutral' : word(!bull)}` : histOk ? `5M ${word(bull)}, histogram ${bull ? 'positive or rising' : 'negative or falling'}` : '5M histogram is moving against the trade', '5M MACD Not Confirmed')
    // optional 30M: must not oppose strongly
    const opposed: string[] = []
    for (const tf of cfg.tfs) {
      if (CORE_TFS.includes(tf)) continue
      const s = S[tf]
      const q = p[tf]
      if (!s || q === undefined || q < 1) continue
      const d = dirAt(s, q)
      const against = d !== 'NEUTRAL' && d !== side
      const strengthening = Math.abs(s.hist[q]) > Math.abs(s.hist[q - 1])
      if (against && strengthening) opposed.push(MACD_LABEL[tf])
    }
    if (cfg.tfs.some((x) => !CORE_TFS.includes(x))) add('extra', 'No strong opposing higher timeframe', opposed.length === 0, opposed.length ? `${opposed.join(', ')} strongly opposed` : 'no checked timeframe strongly opposes', 'Higher Timeframe Opposing')
    // 3. 1M cross
    add('cross', '1M crossover confirmed at the candle close', cross.ok, cross.detail, 'No Fresh 1M Crossover')
    // 3b. RSI confirmation on 1M, 5M and 15M (BUY above the threshold, SELL below 100 - threshold)
    {
      const r1 = t.rsi[i]
      const r5 = s5.rsi[p5]
      const r15 = s15.rsi[p15]
      const hiT = cfg.rsiBull
      const loT = 100 - cfg.rsiBull
      const pass = (r: number) => Number.isFinite(r) && (bull ? r > hiT : r < loT)
      const rsiOk = basic || !cfg.rsiOn || (pass(r1) && pass(r5) && pass(r15))
      add('rsi', `RSI ${cfg.rsiLen} on 1M / 5M / 15M`, rsiOk, !cfg.rsiOn || basic ? 'RSI confirmation is off' : `1M ${r1.toFixed(1)} · 5M ${r5.toFixed(1)} · 15M ${r15.toFixed(1)} (${bull ? `needs above ${hiT}` : `needs below ${loT}`})`, 'RSI Not Confirmed')
    }
    // 4. EMA 200 (5M): right side, not hugging it, slope must point the trade's way
    const e = s5.e200[p5]
    const above = close > e
    const slope = slopeAt(s5, p5)
    const near = Math.abs(close - e) < cfg.nearEmaAtr * a5
    const emaSide = bull ? above : !above
    const slopeMatch = bull ? slope === 'RISING' : slope === 'FALLING'
    add('ema', '5M EMA 200 bias', emaSide && !near && slopeMatch, !emaSide ? `price ${above ? 'ABOVE' : 'BELOW'} the 5M EMA 200 — against the trade` : near ? 'price too close to the 5M EMA 200' : slope === 'FLAT' ? '5M EMA 200 is flat' : !slopeMatch ? `5M EMA 200 is ${slope.toLowerCase()} — against the trade` : `price ${above ? 'above' : 'below'} the 5M EMA 200, slope ${slope.toLowerCase()}`, 'EMA 200 Filter Failed')
    // 5. ribbon
    const rb = ribbonAt(s5, p5)
    const stackN = bull ? rb.stackBull : rb.stackBear
    const ribOk = stackN >= cfg.ribbonMin
    add('ribbon', '5M EMA ribbon 20/50/100/200', basic ? true : ribOk, basic ? 'not required in the basic variant' : ribOk ? `${stackN}/3 pairs stacked ${bull ? 'bullish' : 'bearish'}` : `ribbon mixed (${stackN}/3 pairs stacked for the trade, needs ${cfg.ribbonMin})`, 'Mixed EMA Ribbon')
    // 6. Supertrend: 1M and 5M must agree; 3M and 15M add context (score)
    const st1 = t.stDir[i] === 1 ? 'BUY' : 'SELL'
    const st3 = s3.stDir[p3] === 1 ? 'BUY' : 'SELL'
    const st5 = s5.stDir[p5] === 1 ? 'BUY' : 'SELL'
    const st15 = s15.stDir[p15] === 1 ? 'BUY' : 'SELL'
    add('st', `Supertrend ${cfg.stPeriod},${cfg.stMult}`, st1 === side && (basic || st5 === side), st1 !== side ? `1M Supertrend is ${word(!bull)} — against the trade` : !basic && st5 !== side ? `5M Supertrend is ${word(!bull)} — against the trade` : `1M ${word(bull)}${st5 === side ? `, 5M ${word(bull)}` : ''}${st3 === side ? `, 3M ${word(bull)}` : ', 3M not yet aligned'}${st15 === side ? `, 15M ${word(bull)}` : ''}`, 'Supertrend Not Confirmed')

    // 7. stop loss: 1M swing + ATR buffer + noise floor, validated by 5M market structure
    let swing: number | null = null
    for (let j = i - SWING_K; j >= Math.max(SWING_K, i - SWING_LOOKBACK); j--) {
      if (bull ? isPivotLow(t, j, SWING_K) && t.c[j].low < close : isPivotHigh(t, j, SWING_K) && t.c[j].high > close) {
        swing = bull ? t.c[j].low : t.c[j].high
        break
      }
    }
    // market structure: the last two confirmed 5M swing lows rising (long) / swing highs falling (short)
    const piv: number[] = []
    for (let j = p5 - 2; j > Math.max(2, p5 - 80) && piv.length < 2; j--) {
      if (bull ? isPivotLow(s5, j, 2) : isPivotHigh(s5, j, 2)) piv.push(bull ? s5.c[j].low : s5.c[j].high)
    }
    const structKnown = piv.length === 2
    const structOk = !structKnown || (bull ? piv[0] > piv[1] : piv[0] < piv[1])
    let plan: TradePlan | null = null
    let slDetail = ''
    let slOk = false
    if (swing === null) slDetail = `no valid 1M swing ${bull ? 'low' : 'high'} in the last ${SWING_LOOKBACK} bars`
    else {
      let sl = bull ? swing - SL_BUFFER_ATR * a1 : swing + SL_BUFFER_ATR * a1
      const floor = SL_NOISE_FLOOR_ATR * a1
      if (Math.abs(close - sl) < floor) sl = bull ? close - floor : close + floor
      const risk = Math.abs(close - sl)
      const reward = risk * RR
      const latencyPrice = (cfg.latencyMs / 60_000) * a1
      const costR = ((2 * (cfg.feeBps + cfg.slipBps)) / 10_000) * (close / risk) + latencyPrice / risk
      const netRR = (RR - costR) / (1 + costR)
      const riskPct = (risk / close) * 100
      plan = { sl, tp: bull ? close + reward : close - reward, risk, reward, riskPct, rewardPct: (reward / close) * 100, costR, grossRR: RR, netRR, swing }
      const stLine5 = s5.stLine[p5]
      if (!(bull ? sl < close : sl > close)) slDetail = 'stop is not on the correct side of the entry'
      else if (riskPct > cfg.maxRiskPct) slDetail = `stop too wide (${riskPct.toFixed(2)}% of price)`
      else if (!basic && !structOk) slDetail = `5M market structure is against the trade (swing ${bull ? 'lows' : 'highs'} ${bull ? 'falling' : 'rising'})`
      else {
        slOk = true
        slDetail = `stop beyond the 1M swing ${bull ? 'low' : 'high'} (+${SL_BUFFER_ATR} ATR); ${structKnown ? `5M ${bull ? 'higher lows' : 'lower highs'}` : 'few 5M swings yet'}; 5M Supertrend ${Number.isFinite(stLine5) ? `at ${stLine5.toPrecision(6)}` : 'n/a'} for reference`
      }
    }
    add('sl', 'Stop loss validated by market structure', slOk, slDetail, 'Invalid Stop Loss')

    // 8. TP 1:2 not blocked by S/R, net RR after fees, slippage and latency
    let tpOk = false
    let tpDetail = 'no valid stop, so no target'
    let roomPartial = false
    if (plan && slOk) {
      const lvl = nearestLevel(bull, close, i, p5, p15)
      const blockedAt = bull ? close + SR_BLOCK * plan.reward : close - SR_BLOCK * plan.reward
      const blocked = lvl !== null && (bull ? lvl < blockedAt : lvl > blockedAt)
      roomPartial = lvl !== null && (bull ? lvl < close + 1.5 * plan.reward : lvl > close - 1.5 * plan.reward)
      const netLow = !basic && plan.netRR < cfg.minNetRR
      tpOk = basic ? true : !blocked && !netLow
      tpDetail = basic ? 'support / resistance not checked in the basic variant' : blocked ? `nearest ${bull ? 'resistance' : 'support'} ${lvl!.toPrecision(6)} sits before the 1:2 target` : netLow ? `fees + slippage + latency leave only 1:${plan.netRR.toFixed(2)} (needs 1:${cfg.minNetRR})` : `1:2 target clear (gross 1:2, net 1:${plan.netRR.toFixed(2)} after costs)`
    }
    add('tp', 'Take profit 1:2 reachable', tpOk, tpDetail, 'RR Below 1:2')

    // 9. risk / liquidity / volume filters
    const range = t.c[i].high - t.c[i].low
    const ext = Math.abs(close - s5.e20[p5]) / a5
    const move = bull ? close - t.close[Math.max(0, i - PUMP_BARS)] : t.close[Math.max(0, i - PUMP_BARS)] - close
    let liq = 0
    for (let k = Math.max(0, i - 59); k <= i; k++) liq += t.close[k] * t.vol[k]
    liq /= Math.min(60, i + 1)
    const over: string[] = []
    const other: string[] = []
    if (stable) other.push('stablecoin pair')
    if (range > BIG_CANDLE_ATR * a1) over.push(`unusually large 1M candle (${(range / a1).toFixed(1)}× ATR)`)
    if (ext > EXTENDED_EMA20_ATR) over.push(`price extended ${ext.toFixed(1)} ATR from the 5M EMA 20`)
    if (move > PUMP_ATR * a1) over.push(`sharp ${bull ? 'pump' : 'dump'} just before (${(move / a1).toFixed(1)}× ATR in ${PUMP_BARS} bars)`)
    if (liq < cfg.minLiqUsd) other.push(`thin liquidity (~$${Math.round(liq).toLocaleString('en-US')} per minute)`)
    const problems = [...over, ...other]
    if (opts.trace) for (const pr of problems) opts.trace[`prob:${pr.replace(/[(0-9$].*/, '').trim()}`] = (opts.trace[`prob:${pr.replace(/[(0-9$].*/, '').trim()}`] ?? 0) + 1
    const filtersOk = problems.length === 0
    add('filters', 'Entry quality / risk filters', basic ? !stable : filtersOk, basic ? (stable ? 'stablecoin pair' : 'not required in the basic variant') : filtersOk ? 'no oversized candle, not extended, liquidity fine, no sharp move' : problems.join('; '), over.length ? 'Entry Overextended' : stable ? 'Stablecoin Pair' : 'Low Liquidity')

    // 10. sideways
    const sw = sidewaysAt(i, p5)
    add('sideways', 'Not a sideways market', basic ? true : !sw.sideways, basic ? 'not required in the basic variant' : sw.sideways ? `SIDEWAYS MARKET — WAIT (${sw.hits}/${sw.of} tests: ${sw.tests.filter((q) => q.hit).map((q) => q.key).join(', ')})` : `${sw.hits}/${sw.of} sideways tests hit (limit ${cfg.sidewaysHits})`, 'Sideways Market')

    // 11. score (13 documented parts, 100 points in total)
    let score: number | null = null
    let parts: ScorePart[] = []
    if (plan && slOk) {
      const delta = bull ? t.hist[i] - t.hist[i - 1] : t.hist[i - 1] - t.hist[i]
      const crossPts = Math.round(9 * Math.min(1, Math.max(0, delta / (0.03 * a1))))
      const m5Pts = (d5 === side ? 4 : 0) + (bull ? (h5 > 0 && h5 > h5p ? 5 : h5 > 0 || h5 > h5p ? 3 : 0) : h5 < 0 && h5 < h5p ? 5 : h5 < 0 || h5 < h5p ? 3 : 0)
      const h15 = s15.hist[p15]
      const h15p = s15.hist[p15 - 1]
      const m15Pts = (d15 === side ? 5 : 0) + (bull ? (h15 > h15p ? 4 : 0) : h15 < h15p ? 4 : 0)
      const emaPts = emaSide && !near && slopeMatch ? 6 + Math.min(3, Math.round(Math.abs(close - e) / a5)) : 0
      const ribPts = stackN === 3 ? 9 : stackN === 2 ? 5 : 0
      const stPts = (st1 === side ? 3 : 0) + (st3 === side ? 2 : 0) + (st5 === side ? 3 : 0) + (st15 === side ? 1 : 0)
      const d3 = dirAt(s3, p3)
      const h3 = s3.hist[p3]
      const h3p = s3.hist[p3 - 1]
      const m3Pts = (d3 === side ? 3 : 0) + (bull ? (h3 > h3p ? 3 : 0) : h3 < h3p ? 3 : 0)
      const momPts = (bull ? (h5 > h5p ? 3 : 0) : h5 < h5p ? 3 : 0) + ((bull ? t.hist[i] > 0 && t.hist[i] > t.hist[i - 1] : t.hist[i] < 0 && t.hist[i] < t.hist[i - 1]) ? 4 : 0)
      const vr = mean(t.vol, i - 20, i - 1) > 0 ? t.vol[i] / mean(t.vol, i - 20, i - 1) : 0
      const volPts = vr >= 1.5 ? 7 : vr >= 1 ? 5 : vr >= 0.8 ? 3 : 0
      const structPts = structKnown ? (structOk ? 6 : 0) : 3
      const extPts = ext <= 0.5 ? 6 : ext <= 1 ? 4 : ext <= 2 ? 2 : 0
      const srPts = roomPartial ? 3 : 6
      const rrPts = plan.netRR >= 1.8 ? 8 : plan.netRR >= 1.6 ? 6 : plan.netRR >= 1.4 ? 4 : 2
      parts = [
        { label: '1M crossover strength', pts: crossPts, max: 9 },
        { label: '5M MACD agreement', pts: m5Pts, max: 9 },
        { label: '15M MACD agreement', pts: m15Pts, max: 9 },
        { label: 'EMA 200 alignment', pts: emaPts, max: 9 },
        { label: 'EMA ribbon alignment', pts: ribPts, max: 9 },
        { label: 'Supertrend alignment (1M/3M/5M/15M)', pts: stPts, max: 9 },
        { label: '3M MACD momentum', pts: m3Pts, max: 6 },
        { label: 'Histogram momentum', pts: momPts, max: 7 },
        { label: 'Volume confirmation', pts: volPts, max: 7 },
        { label: 'Market structure', pts: structPts, max: 6 },
        { label: 'Distance from EMA 20', pts: extPts, max: 6 },
        { label: 'Room to support / resistance', pts: srPts, max: 6 },
        { label: 'Risk-to-reward quality', pts: rrPts, max: 8 },
      ]
      score = parts.reduce((a, x) => a + x.pts, 0)
    }
    add('score', `Setup quality ≥ ${cfg.minScore}/100`, basic ? true : score !== null && score >= cfg.minScore, basic ? 'not required in the basic variant' : score === null ? 'not scored (no valid stop)' : `score ${score}/100`, `Signal Quality Below ${cfg.minScore}`)

    // 12. cooldown
    const since = i - lastSig
    add('cooldown', `Coin cooldown (${cfg.cooldownBars} min)`, basic || since >= cfg.cooldownBars, basic || since >= cfg.cooldownBars ? 'not in cooldown' : `last signal ${since} min ago`, 'Cooldown Active')

    const firstFail = checks.findIndex((c) => !c.ok)
    const readyForCross = checks.every((c) => c.ok || c.key === 'cross')
    return { checks, firstFail, plan, score, parts, readyForCross, sideways: sw }
  }

  const outcomeOf = (i: number, bull: boolean, p: TradePlan): TradeOutcome => {
    const entry = t.close[i]
    for (let j = i + 1; j < n; j++) {
      const c = t.c[j]
      const hitSl = bull ? c.low <= p.sl : c.high >= p.sl
      const hitTp = bull ? c.high >= p.tp : c.low <= p.tp
      // SL and TP inside one candle: the order is unknowable, so the stop is assumed first (conservative)
      if (hitSl || hitTp) {
        const r = (hitSl ? -1 : RR) - p.costR
        return { result: hitSl ? 'LOSS' : 'WIN', r, pnlPct: ((r * p.risk) / entry) * 100, closedAt: c.openTime + MACD_MS['1m'] }
      }
    }
    const r = (bull ? t.close[last] - entry : entry - t.close[last]) / p.risk - p.costR
    return { result: 'OPEN', r, pnlPct: ((r * p.risk) / entry) * 100, closedAt: null }
  }

  // ---- replay: one closed 1M candle at a time
  const ptr: Ptrs = {}
  for (const tf of cfg.tfs) ptr[tf] = -1
  const signals: MacdSignal[] = []
  const rejections: Rejection[] = []
  const signalled: Record<Side, number> = { BUY: -1, SELL: -1 }
  let lastSignalIdx = -1e9
  let curCross: { type: 'BULL' | 'BEAR'; idx: number } | null = null
  let pending: { idx: number; rec: Rejection } | null = null
  let ptrAtLast: Ptrs = { ...ptr }
  const flush = () => {
    if (pending) rejections.push(pending.rec)
    pending = null
  }

  for (let i = 1; i < n; i++) {
    const T = t.c[i].openTime + MACD_MS['1m']
    for (const tf of cfg.tfs) {
      const s = S[tf]!
      while (ptr[tf] + 1 < s.c.length && s.c[ptr[tf] + 1].openTime + s.ms <= T) ptr[tf]++
    }
    if (i === last) ptrAtLast = { ...ptr }
    const cr = crossAt(t, i)
    if (cr) curCross = { type: cr, idx: i }
    if (pending && (!curCross || curCross.idx !== pending.idx || i - pending.idx > cfg.maxCrossAge)) flush()
    if (stable || i < MIN_1M - 1 || ptr['5m'] < EMA_WARM || ptr['15m'] < WARM || cfg.tfs.some((tf) => ptr[tf] < WARM)) continue
    if (!curCross || i - curCross.idx > cfg.maxCrossAge) continue
    const bull = curCross.type === 'BULL'
    const side: Side = bull ? 'BUY' : 'SELL'
    if (signalled[side] === curCross.idx) continue
    const age = i - curCross.idx
    const a = assess(i, ptr, bull, { ok: true, detail: `1M MACD crossed ${bull ? 'above' : 'below'} its signal line ${age === 0 ? 'on the signal candle' : `${age} bar${age === 1 ? '' : 's'} earlier`}, confirmed at the close` }, lastSignalIdx)
    if (opts.trace) {
      const k = a.firstFail === -1 ? 'PASS' : a.checks[a.firstFail].key
      opts.trace[k] = (opts.trace[k] ?? 0) + 1
      if (a.firstFail !== -1) for (const c of a.checks) if (!c.ok) opts.trace[`any:${c.key}`] = (opts.trace[`any:${c.key}`] ?? 0) + 1
    }
    const crossTime = t.c[curCross.idx].openTime + MACD_MS['1m']
    const id = `${symbol}-1m-${side}-${crossTime}`
    if (a.firstFail !== -1 || !a.plan || a.score === null) {
      const f = a.checks[a.firstFail]
      pending = {
        idx: curCross.idx,
        rec: { id, symbol, side, time: crossTime, price: t.close[curCross.idx], reason: f?.wait ?? `WAIT — ${f?.label ?? 'No Trade'}`, failed: a.checks.filter((c) => !c.ok).map((c) => c.label), score: a.score, version: `${STRATEGY_VERSION}-${cfg.indicator}` },
      }
      continue
    }
    if (pending && pending.idx === curCross.idx) pending = null

    const tfSnap: Partial<Record<MacdTf, Dir>> = {}
    for (const tf of cfg.tfs) tfSnap[tf] = dirAt(S[tf]!, ptr[tf])
    const p3 = ptr['3m']
    const p5 = ptr['5m']
    const p15 = ptr['15m']
    const e = s5.e200[p5]
    const close = t.close[i]
    const rb = ribbonAt(s5, p5)
    const stOf = (s: Series, q: number) => ({ dir: (s.stDir[q] === 1 ? 'BUY' : 'SELL') as 'BUY' | 'SELL', line: s.stLine[q] })
    signals.push({
      ...a.plan,
      id,
      symbol,
      side,
      trigger: '1m',
      time: T,
      barsAgo: last - i,
      entry: close,
      crossAge: age,
      macd: { line: t.ml[i], signal: t.sg[i], hist: t.hist[i] },
      tfs: tfSnap,
      selectedTfs: [...cfg.tfs],
      ema200: { value: e, position: close > e ? 'ABOVE' : 'BELOW', distPct: ((close - e) / e) * 100, slope: slopeAt(s5, p5) },
      ribbon: { state: rb.state, stack: bull ? rb.stackBull : rb.stackBear },
      supertrend: { dir: t.stDir[i] === 1 ? 'BUY' : 'SELL', line: t.stLine[i] },
      st3: stOf(s3, p3),
      st5: stOf(s5, p5),
      st15: stOf(s15, p15),
      version: `${STRATEGY_VERSION}-${cfg.indicator}`,
      score: a.score,
      scoreParts: a.parts,
      conditions: a.checks.map((c) => `${c.label}: ${c.detail}`),
      outcome: outcomeOf(i, bull, a.plan),
    })
    signalled[side] = curCross.idx
    lastSignalIdx = i
  }
  if (pending && curCross && pending.idx === curCross.idx && last - curCross.idx >= cfg.maxCrossAge) flush()

  // ---- live readout
  const views: Partial<Record<MacdTf, TfView>> = {}
  for (const tf of cfg.tfs) views[tf] = viewAt(S[tf]!, ptrAtLast[tf] >= 1 ? ptrAtLast[tf] : S[tf]!.c.length - 1, true)
  const dirsNow = cfg.tfs.map((tf) => views[tf]!.dir)
  const bullN = dirsNow.filter((d) => d === 'BUY').length
  const bearN = dirsNow.filter((d) => d === 'SELL').length
  const total = cfg.tfs.length
  const agreeNow: Side | null = bullN === total ? 'BUY' : bearN === total ? 'SELL' : null
  const overall: 'BULLISH' | 'BEARISH' | 'MIXED' = bullN === total ? 'BULLISH' : bearN === total ? 'BEARISH' : 'MIXED'
  const dominant: Dir = bullN > bearN ? 'BUY' : bearN > bullN ? 'SELL' : 'NEUTRAL'
  const disagreeing = dominant === 'NEUTRAL' ? [...cfg.tfs] : cfg.tfs.filter((tf) => views[tf]!.dir !== dominant)

  const ok = (q: number, s: Series) => (q >= 1 ? q : s.c.length - 1)
  const p3 = ok(ptrAtLast['3m'], s3)
  const p5 = ok(ptrAtLast['5m'], s5)
  const p15 = ok(ptrAtLast['15m'], s15)
  const d5 = dirAt(s5, p5)
  const d3 = dirAt(s3, p3)
  const fresh = stable ? null : (signals.filter((s) => s.barsAgo < cfg.freshBars).pop() ?? null)
  const candidate: Side | null = fresh ? fresh.side : d5 !== 'NEUTRAL' ? d5 : null
  const ageNow = curCross ? last - curCross.idx : null
  let checks: CheckItem[] = []
  let score: number | null = null
  let parts: ScorePart[] = []
  let planOut: MacdRow['plan'] = null
  let state: MacdState = 'WAIT'
  let text = stable ? 'WAIT — STABLECOIN PAIR, NOT TRADED' : 'WAIT — 5M MACD Not Confirmed'
  let side: Side | null = null
  let blocker: string | null = stable ? 'STABLECOIN PAIR' : null
  let early: MacdRow['early'] = null
  const swNow = sidewaysAt(last, p5)

  if (candidate && !stable) {
    const bull = candidate === 'BUY'
    side = candidate
    const crossOk = curCross !== null && (curCross.type === 'BULL') === bull && ageNow !== null && ageNow <= cfg.maxCrossAge
    const used = curCross !== null && signalled[candidate] === curCross.idx
    const detail = fresh && fresh.side === candidate ? 'fresh crossover confirmed at the 1M close' : crossOk ? (used ? 'this crossover already produced a signal' : '1M crossover on the latest candle') : curCross && (curCross.type === 'BULL') === bull ? `1M crossover is ${ageNow} bar${ageNow === 1 ? '' : 's'} old — waiting for a fresh one` : 'waiting for the 1M MACD to cross'
    const a = assess(last, ptrAtLast, bull, { ok: crossOk && (!used || (fresh !== null && fresh.side === candidate)), detail }, fresh && fresh.side === candidate ? lastSignalIdx - 1e9 : lastSignalIdx)
    checks = a.checks
    score = a.score
    parts = a.parts
    planOut = a.plan ? { ...a.plan, side: candidate } : null
    const first = a.checks[a.firstFail]
    if (fresh && fresh.side === candidate) {
      // show the checklist as it stood at the signal candle (the live candle may already have moved on)
      checks = fresh.conditions.map((c, k) => ({ key: `c${k}`, label: c.split(': ')[0], ok: true, detail: c.split(': ').slice(1).join(': ') }))
      score = fresh.score
      parts = fresh.scoreParts
      planOut = { ...fresh, side: fresh.side }
      state = bull ? 'CONFIRMED BUY' : 'CONFIRMED SELL'
      text = `MACD PRECISION ${candidate} — ALL CONDITIONS CONFIRMED, QUALITY ${fresh.score}/100`
      blocker = null
    } else if (a.readyForCross) {
      const st3 = s3.stDir[p3] === 1 ? 'BUY' : 'SELL'
      if (d3 === candidate && st3 === candidate) {
        state = bull ? 'EARLY BUY' : 'EARLY SELL'
        text = `EARLY ${bull ? 'LONG' : 'SHORT'} SETUP — WAIT FOR CONFIRMATION`
        early = { side: candidate, text }
        blocker = 'NO FRESH 1M CROSSOVER'
      } else {
        text = 'WAIT — No Fresh 1M Crossover'
        blocker = 'NO FRESH 1M CROSSOVER'
      }
    } else if (first) {
      text = first.wait ?? `WAIT — ${first.label}`
      blocker = text.replace(/^WAIT — /, '').toUpperCase()
    }
  }

  const close = t.close[last]
  const e = s5.e200[p5]
  const a5 = atrAt(s5, p5)
  const above = close > e
  const near = Math.abs(close - e) < cfg.nearEmaAtr * a5
  const slopeNow = slopeAt(s5, p5)
  const stRow = (s: Series, q: number, px: number) => {
    const dir: 'BUY' | 'SELL' = s.stDir[q] === 1 ? 'BUY' : 'SELL'
    return { dir, line: s.stLine[q], distPct: ((px - s.stLine[q]) / px) * 100, label: dir === 'BUY' ? 'BULLISH (green)' : 'BEARISH (red)' }
  }
  const st1 = stRow(t, last, close)
  let flip: number | null = null
  for (let k = last; k > 0 && Number.isFinite(t.stLine[k - 1]); k--) {
    if (t.stDir[k] !== t.stDir[k - 1]) {
      flip = last - k
      break
    }
  }
  let liq = 0
  for (let k = Math.max(0, last - 59); k <= last; k++) liq += t.close[k] * t.vol[k]
  liq /= Math.min(60, last + 1)

  return {
    signals: [...signals].reverse(),
    allRejections: opts.allRejections ? rejections : undefined,
    row: {
      trigger: '1m',
      barTime: t.c[last].openTime + MACD_MS['1m'],
      tfs: views,
      agreement: { selected: [...cfg.tfs], bull: bullN, bear: bearN, total, side: agreeNow, overall, disagreeing },
      ema200: {
        value: e,
        position: above ? 'ABOVE' : 'BELOW',
        slope: slopeNow,
        distPct: ((close - e) / e) * 100,
        distAtr: Math.abs(close - e) / a5,
        near,
        trend: near ? 'NEUTRAL' : above ? 'BULLISH' : 'BEARISH',
        buyValid: above && !near && slopeNow === 'RISING',
        sellValid: !above && !near && slopeNow === 'FALLING',
        label: near
          ? 'WAIT — price too close to the 5M EMA 200'
          : slopeNow === 'FLAT'
            ? 'WAIT — 5M EMA 200 is flat'
            : above !== (slopeNow === 'RISING')
              ? `WAIT — ${above ? 'above' : 'below'} the 5M EMA 200 but its slope is ${slopeNow.toLowerCase()}`
              : above
                ? 'ABOVE 5M EMA 200 — BULLISH'
                : 'BELOW 5M EMA 200 — BEARISH',
      },
      ribbon: ribbonAt(s5, p5),
      supertrend: { ...st1, flipBarsAgo: flip, label: st1.label },
      st3: stRow(s3, p3, close),
      st5: stRow(s5, p5, close),
      st15: stRow(s15, p15, close),
      status: { state, text, side, blocker, missing: [] },
      checks,
      score,
      scoreParts: parts,
      plan: planOut,
      liquidityUsd: liq,
      signal: fresh,
      bars: n,
      early,
      sideways: swNow,
      rejections: [...rejections].reverse().slice(0, 100),
      version: `${STRATEGY_VERSION}-${cfg.indicator}`,
    },
  }
}

export function analyzeMacd(symbol: string, input: Partial<Record<MacdTf, Candle[]>>, cfgIn: Partial<MacdConfig> = {}, opts: RunOptions = {}): MacdRun | null {
  const cfg = normalizeMacdConfig(cfgIn)
  const S = prepareMacd(input, cfg)
  return S ? runMacd(symbol, S, cfg, opts) : null
}

export function buildMacdRow(input: {
  symbol: string
  price: number
  change24h: number
  candles: Partial<Record<MacdTf, Candle[]>>
  now: number
  cfg?: Partial<MacdConfig>
}): MacdRow | null {
  const closed: Partial<Record<MacdTf, Candle[]>> = {}
  for (const tf of MACD_TFS) if (input.candles[tf]) closed[tf] = closedOnly(input.candles[tf]!, input.now, MACD_MS[tf])
  const a = analyzeMacd(input.symbol, closed, input.cfg)
  if (!a) return null
  return {
    symbol: input.symbol,
    price: input.price,
    change24h: input.change24h,
    ...a.row,
    history: a.signals.slice(0, 20),
    open: a.signals.filter((s) => s.outcome.result === 'OPEN'),
  }
}

/** Timeframe views of a row in display order (only the checked ones). */
export function tfList(row: MacdRow): TfView[] {
  return MACD_TFS.map((tf) => row.tfs[tf]).filter((v): v is TfView => Boolean(v))
}
