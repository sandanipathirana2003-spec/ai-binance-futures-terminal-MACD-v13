import type { Candle } from './binance'
import { atrSeries, emaSeries } from './indicators'
import { regularMacd, supertrend, type Side, type TradeOutcome } from './impulse5m'
import { closedOnly } from './reversal'
import { MACD_LABEL, MACD_MS, isStablePair, type MacdTf } from './macdmtf'

// ---------------------------------------------------------------------------
// 5M CLASSIC MACD engine ("Normal MACD", never Impulse MACD). Pure logic, no I/O.
//
//   15M (last CLOSED 15M candle): MACD line on the trade side of its signal line, histogram on the trade side,
//        trend not fading (the histogram is not shrinking for three bars in a row)
//   5M  (the candle that just closed): MACD line crosses the signal line in the trade direction, histogram turns to the
//        trade side, price on the right side of the EMA 200 (and not hugging it), Supertrend 12,4 agrees
//   Stop: latest confirmed swing low / high and / or the Supertrend line (setting), plus an ATR buffer; rejected when too wide
//   Take profit: entry +/- RR x risk (default 1:2; 1:1, 1:1.5, 1:3 selectable)
//
// Entry = close of the signal candle. The confirmation timeframe only contributes candles that had ALREADY closed at that
// moment, so a signal never repaints and never looks ahead. One signal per crossover (the crossover time is in the id).
// ---------------------------------------------------------------------------

export const ENTRY_TFS: MacdTf[] = ['1m', '3m', '5m', '15m']
export const CONFIRM_TFS: MacdTf[] = ['5m', '15m', '30m']
export const RR_CHOICES = [1, 1.5, 2, 3]
export type ClassicSl = 'both' | 'swing' | 'supertrend' | 'atr'
export const SL_METHODS: Array<{ key: ClassicSl; label: string; hint: string }> = [
  { key: 'both', label: 'Swing + Supertrend', hint: 'Whichever of the swing low / high and the Supertrend line is farther from the entry (most protective).' },
  { key: 'swing', label: 'Swing low / high', hint: 'Latest confirmed swing low (BUY) or swing high (SELL) plus the ATR buffer.' },
  { key: 'supertrend', label: 'Supertrend line', hint: 'The Supertrend 12,4 line plus the ATR buffer.' },
  { key: 'atr', label: 'ATR multiple', hint: 'Entry minus / plus a multiple of the ATR (no structure).' },
]

/** Closed entry bars needed before the EMA is trusted, and closed confirmation bars before its MACD is. */
const CONFIRM_WARM = 45
const SWING_K = 3
const SWING_LOOKBACK = 60
/** A setup whose fees + slippage + funding exceed this many R is rejected (the target would be eaten by costs). */
export const MAX_COST_R = 0.5
const FUNDING_MS = 8 * 3_600_000

export interface ClassicConfig {
  fast: number
  slow: number
  signal: number
  emaLen: number
  stPeriod: number
  stMult: number
  entryTf: MacdTf
  confirmTf: MacdTf
  /** Reward : risk (the target is this many times the risk). */
  rr: number
  slMethod: ClassicSl
  /** Buffer beyond the swing / Supertrend level, in ATR of the entry timeframe. */
  atrBuffer: number
  /** Multiple of the ATR used by the "ATR multiple" stop method. */
  atrSlMult: number
  /** Stops wider than this % of the entry price are rejected. */
  maxSlPct: number
  /** Price closer to the EMA than this many ATR = WAIT. */
  nearEmaAtr: number
  /** The crossover may be at most this many entry bars old. 0 = the signal candle itself. */
  maxCrossAge: number
  /** Optional minimum signal strength (0 = off). */
  minStrength: number
  feeBps: number
  slipBps: number
  /** Estimated funding cost in bps per 8 hours of holding (a constant assumption, not real funding history). */
  fundingBps: number
  /** A signal counts as "fresh" (shown as STRONG / alerted) for this many entry bars after its candle. */
  freshBars: number
}

export const DEFAULT_CLASSIC: ClassicConfig = {
  fast: 12,
  slow: 26,
  signal: 9,
  emaLen: 200,
  stPeriod: 12,
  stMult: 4,
  entryTf: '5m',
  confirmTf: '15m',
  rr: 2,
  slMethod: 'both',
  atrBuffer: 0.3,
  atrSlMult: 1.5,
  maxSlPct: 3,
  nearEmaAtr: 0.25,
  maxCrossAge: 0,
  minStrength: 0,
  feeBps: 4,
  slipBps: 2,
  fundingBps: 1,
  freshBars: 2,
}

const clamp = (v: number, lo: number, hi: number, fb: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb)

/** Merge user-supplied values over the defaults and clamp everything (server, client and tests all use this). */
export function normalizeClassic(p: Partial<Record<keyof ClassicConfig, unknown>> = {}): ClassicConfig {
  const d = DEFAULT_CLASSIC
  const num = (k: keyof ClassicConfig, lo: number, hi: number) => clamp(Number(p[k] ?? d[k]), lo, hi, d[k] as number)
  const fast = Math.round(num('fast', 2, 50))
  const entryTf = (ENTRY_TFS as string[]).includes(String(p.entryTf)) ? (p.entryTf as MacdTf) : d.entryTf
  let confirmTf = (CONFIRM_TFS as string[]).includes(String(p.confirmTf)) ? (p.confirmTf as MacdTf) : d.confirmTf
  // the confirmation timeframe must be slower than the entry timeframe
  if (MACD_MS[confirmTf] <= MACD_MS[entryTf]) confirmTf = CONFIRM_TFS.find((t) => MACD_MS[t] > MACD_MS[entryTf]) ?? '30m'
  const slMethod = SL_METHODS.some((m) => m.key === p.slMethod) ? (p.slMethod as ClassicSl) : d.slMethod
  return {
    fast,
    slow: Math.max(fast + 1, Math.round(num('slow', 5, 100))),
    signal: Math.round(num('signal', 2, 50)),
    emaLen: Math.round(num('emaLen', 20, 300)),
    stPeriod: Math.round(num('stPeriod', 2, 50)),
    stMult: num('stMult', 0.5, 20),
    entryTf,
    confirmTf,
    rr: Math.round(num('rr', 0.5, 10) * 100) / 100,
    slMethod,
    atrBuffer: num('atrBuffer', 0, 3),
    atrSlMult: num('atrSlMult', 0.5, 10),
    maxSlPct: num('maxSlPct', 0.1, 20),
    nearEmaAtr: num('nearEmaAtr', 0, 3),
    maxCrossAge: Math.round(num('maxCrossAge', 0, 3)),
    minStrength: Math.round(num('minStrength', 0, 100)),
    feeBps: num('feeBps', 0, 50),
    slipBps: num('slipBps', 0, 50),
    fundingBps: num('fundingBps', 0, 20),
    freshBars: Math.round(num('freshBars', 1, 6)),
  }
}

/** Settings that change what a signal IS (used to keep stored history from mixing strategies). */
export const classicKey = (c: ClassicConfig) =>
  [c.fast, c.slow, c.signal, c.emaLen, c.stPeriod, c.stMult, c.entryTf, c.confirmTf, c.rr, c.slMethod, c.atrBuffer, c.atrSlMult, c.maxSlPct, c.nearEmaAtr, c.maxCrossAge, c.minStrength, c.feeBps, c.slipBps, c.fundingBps].join('|')

// ------------------------------------------------------------------ types

export interface ClassicOutcome extends TradeOutcome {
  /** Price at which the trade closed (the last close while OPEN). */
  exit: number
}

export interface MacdPoint {
  line: number
  signal: number
  hist: number
}

export interface ClassicSignal {
  id: string
  symbol: string
  side: Side
  /** Close time of the signal candle (= the entry time). */
  time: number
  /** Entry bars since the signal candle (0 = the latest closed candle). */
  barsAgo: number
  entry: number
  sl: number
  tp: number
  risk: number
  reward: number
  riskPct: number
  rewardPct: number
  rr: number
  /** Round-trip fees + slippage in R (funding is added to the outcome while the trade is held). */
  costR: number
  slMethod: ClassicSl
  swing: number | null
  stLine: number
  /** 0-100 setup quality. NOT a win probability. */
  strength: number
  /** Label of the entry timeframe (also the "trigger" in the performance tables). */
  trigger: string
  entryTf: MacdTf
  confirmTf: MacdTf
  crossAge: number
  m5: MacdPoint
  m15: MacdPoint
  ema: { value: number; position: 'ABOVE' | 'BELOW'; distPct: number }
  conditions: string[]
  outcome: ClassicOutcome
}

export type ClassicState = 'STRONG BUY' | 'STRONG SELL' | 'WATCH BUY' | 'WATCH SELL' | 'WAIT'

export interface MView extends MacdPoint {
  dir: 'BUY' | 'SELL' | 'NEUTRAL'
  zero: 'ABOVE' | 'BELOW'
  histState: 'POSITIVE' | 'NEGATIVE'
  momentum: 'STRENGTHENING' | 'WEAKENING'
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  cross: { type: 'BUY' | 'SELL'; barsAgo: number } | null
}

export interface Check {
  key: 'c15' | 'cross' | 'hist' | 'ema' | 'st' | 'close' | 'risk'
  label: string
  ok: boolean
  detail: string
}

export interface ClassicRow {
  symbol: string
  price: number
  change24h: number
  /** Open time (ms) of the last closed entry candle. */
  barTime: number
  entryTf: MacdTf
  confirmTf: MacdTf
  m5: MView
  m15: MView
  ema: { value: number; position: 'ABOVE' | 'BELOW'; distPct: number; distAtr: number; near: boolean; label: string }
  st: { dir: 'BUY' | 'SELL'; line: number; distPct: number; label: string }
  /** The side the checks below were evaluated for (the signal side, else the side the 15M MACD leans to). */
  side: Side
  checks: Check[]
  status: { state: ClassicState; text: string }
  signal: ClassicSignal | null
  strength: number | null
  history: ClassicSignal[]
  open: ClassicSignal[]
  atr: number
}

// ------------------------------------------------------------------ series

export interface CSeries {
  c: Candle[]
  ms: number
  close: number[]
  ml: number[]
  sg: number[]
  hist: number[]
  stDir: number[]
  stLine: number[]
  ema: number[]
  atr: number[]
}

export function buildCSeries(tf: MacdTf, c: Candle[], cfg: ClassicConfig): CSeries {
  const close = c.map((x) => x.close)
  const m = regularMacd(close, cfg.fast, cfg.slow, cfg.signal)
  const st = supertrend(c, cfg.stPeriod, cfg.stMult)
  return { c, ms: MACD_MS[tf], close, ml: m.line, sg: m.signal, hist: m.hist, stDir: st.dir, stLine: st.line, ema: emaSeries(close, cfg.emaLen), atr: atrSeries(c, 14) }
}

export interface ClassicSet {
  E: CSeries
  C: CSeries
}

/** Indicator series for both timeframes (closed candles only). Null when either has too little history. */
export function prepareClassic(input: Partial<Record<MacdTf, Candle[]>>, cfg: ClassicConfig): ClassicSet | null {
  const e = input[cfg.entryTf]
  const c = input[cfg.confirmTf]
  if (!e || !c || e.length < cfg.emaLen + 10 || c.length < CONFIRM_WARM + 5) return null
  return { E: buildCSeries(cfg.entryTf, e, cfg), C: buildCSeries(cfg.confirmTf, c, cfg) }
}

const atrAt = (s: CSeries, i: number) => (Number.isFinite(s.atr[i]) && s.atr[i] > 0 ? s.atr[i] : s.close[i] * 0.001)
const crossAt = (s: CSeries, i: number): Side | null =>
  i < 1 ? null : s.ml[i] > s.sg[i] && s.ml[i - 1] <= s.sg[i - 1] ? 'BUY' : s.ml[i] < s.sg[i] && s.ml[i - 1] >= s.sg[i - 1] ? 'SELL' : null
const sgn = (bull: boolean) => (bull ? 1 : -1)

function viewAt(s: CSeries, i: number): MView {
  let cross: MView['cross'] = null
  for (let k = i; k > Math.max(0, i - 60); k--) {
    const c = crossAt(s, k)
    if (c) {
      cross = { type: c, barsAgo: i - k }
      break
    }
  }
  const line = s.ml[i]
  const signal = s.sg[i]
  const hist = s.hist[i]
  return {
    line,
    signal,
    hist,
    dir: line > signal ? 'BUY' : line < signal ? 'SELL' : 'NEUTRAL',
    zero: line >= 0 ? 'ABOVE' : 'BELOW',
    histState: hist >= 0 ? 'POSITIVE' : 'NEGATIVE',
    momentum: Math.abs(hist) >= Math.abs(s.hist[i - 1] ?? hist) ? 'STRENGTHENING' : 'WEAKENING',
    trend: line > signal && hist > 0 ? 'BULLISH' : line < signal && hist < 0 ? 'BEARISH' : 'NEUTRAL',
    cross,
  }
}

/** 15M trend on a side: line on the side, histogram on the side, histogram not shrinking three bars in a row. */
function trendOk(C: CSeries, p: number, bull: boolean): { ok: boolean; detail: string } {
  const k = sgn(bull)
  const lineOk = k * (C.ml[p] - C.sg[p]) > 0
  const histOk = k * C.hist[p] > 0
  const fading = k * C.hist[p] < k * C.hist[p - 1] && k * C.hist[p - 1] < k * C.hist[p - 2] && k * C.hist[p - 2] < k * C.hist[p - 3]
  const word = bull ? 'bullish' : 'bearish'
  return {
    ok: lineOk && histOk && !fading,
    detail: !lineOk ? `15M MACD line is ${bull ? 'below' : 'above'} its signal line` : !histOk ? `15M histogram is ${bull ? 'negative' : 'positive'}` : fading ? '15M histogram has weakened three bars in a row' : `15M MACD ${word}: line ${bull ? 'above' : 'below'} signal, histogram ${bull ? 'positive' : 'negative'}`,
  }
}

interface Plan {
  sl: number
  tp: number
  risk: number
  reward: number
  riskPct: number
  rewardPct: number
  costR: number
  swing: number | null
  stLine: number
  ok: boolean
  detail: string
}

/** Latest confirmed swing low (BUY) / high (SELL) at or before bar i, using only bars <= i. */
function swingAt(E: CSeries, i: number, bull: boolean, entry: number): number | null {
  for (let j = i - SWING_K; j >= Math.max(SWING_K, i - SWING_LOOKBACK); j--) {
    const v = bull ? E.c[j].low : E.c[j].high
    let ok = true
    for (let k = 1; k <= SWING_K && ok; k++) {
      const l = bull ? E.c[j - k].low : E.c[j - k].high
      const r = bull ? E.c[j + k].low : E.c[j + k].high
      if (bull ? !(v < l && v <= r) : !(v > l && v >= r)) ok = false
    }
    if (ok && (bull ? v < entry : v > entry)) return v
  }
  return null
}

function planAt(E: CSeries, i: number, bull: boolean, cfg: ClassicConfig): Plan {
  const entry = E.close[i]
  const a = atrAt(E, i)
  const swing = swingAt(E, i, bull, entry)
  const stRaw = E.stLine[i]
  const stLine = Number.isFinite(stRaw) && (bull ? stRaw < entry : stRaw > entry) ? stRaw : NaN
  const buf = cfg.atrBuffer * a
  const cands: number[] = []
  let method = ''
  if (cfg.slMethod === 'atr') {
    cands.push(bull ? entry - cfg.atrSlMult * a : entry + cfg.atrSlMult * a)
    method = `${cfg.atrSlMult} x ATR`
  } else {
    if ((cfg.slMethod === 'swing' || cfg.slMethod === 'both') && swing !== null) cands.push(bull ? swing - buf : swing + buf)
    if ((cfg.slMethod === 'supertrend' || cfg.slMethod === 'both') && Number.isFinite(stLine)) cands.push(bull ? stLine - buf : stLine + buf)
    method = cfg.slMethod === 'swing' ? `swing ${bull ? 'low' : 'high'}` : cfg.slMethod === 'supertrend' ? 'Supertrend' : 'swing / Supertrend'
  }
  const empty: Plan = { sl: NaN, tp: NaN, risk: NaN, reward: NaN, riskPct: NaN, rewardPct: NaN, costR: NaN, swing, stLine: Number.isFinite(stLine) ? stLine : NaN, ok: false, detail: '' }
  if (cands.length === 0) return { ...empty, detail: cfg.slMethod === 'supertrend' ? 'Supertrend line is not on the correct side of the entry — no valid stop' : `no valid ${method} stop reference — no trade` }
  const sl = bull ? Math.min(...cands) : Math.max(...cands)
  const risk = bull ? entry - sl : sl - entry
  if (!(risk > 0) || !Number.isFinite(sl)) return { ...empty, detail: 'stop is not on the correct side of the entry — no trade' }
  const reward = risk * cfg.rr
  const tp = bull ? entry + reward : entry - reward
  const riskPct = (risk / entry) * 100
  const costR = (entry * 2 * ((cfg.feeBps + cfg.slipBps) / 10_000)) / risk
  const p: Plan = { sl, tp, risk, reward, riskPct, rewardPct: (reward / entry) * 100, costR, swing, stLine: Number.isFinite(stLine) ? stLine : NaN, ok: true, detail: '' }
  if (riskPct > cfg.maxSlPct) return { ...p, ok: false, detail: `stop too wide: ${riskPct.toFixed(2)}% of price (maximum ${cfg.maxSlPct}%)` }
  if (!Number.isFinite(tp) || !(tp > 0)) return { ...p, ok: false, detail: 'take profit could not be calculated' }
  if (costR > MAX_COST_R) return { ...p, ok: false, detail: `stop too tight: fees + slippage would cost ${costR.toFixed(2)}R (maximum ${MAX_COST_R}R)` }
  return { ...p, detail: `stop from ${method}, ${riskPct.toFixed(2)}% risk, 1:${cfg.rr}` }
}

/** 0-100 setup quality: five blocks of 20. A description of the setup, not a probability. */
function strengthOf(E: CSeries, C: CSeries, i: number, p: number, bull: boolean, plan: Plan, cfg: ClassicConfig): number {
  const k = sgn(bull)
  const a = atrAt(E, i)
  const a15 = atrAt(C, p)
  // 15M momentum
  let m15 = 0
  m15 += Math.min(1, Math.abs(C.hist[p]) / (0.15 * a15)) * 10
  m15 += k * C.hist[p] >= k * C.hist[p - 1] ? 5 : 0
  m15 += k * C.ml[p] > 0 ? 5 : 0
  // 5M cross quality
  let c5 = 0
  c5 += Math.min(1, Math.abs(E.hist[i]) / (0.15 * a)) * 10
  c5 += k * E.hist[i] >= k * E.hist[i - 1] ? 5 : 0
  c5 += k * E.ml[i] > 0 ? 5 : 0
  // EMA: room from the line (full at 1.5 ATR) and slope in the trade direction
  const dist = (k * (E.close[i] - E.ema[i])) / a
  const slope = (k * (E.ema[i] - E.ema[Math.max(0, i - 10)])) / a
  const ema = Math.min(1, dist / 1.5) * 15 + (slope > 0 ? 5 : 0)
  // Supertrend: agreement and clearance
  const stClear = Number.isFinite(E.stLine[i]) ? (k * (E.close[i] - E.stLine[i])) / a : 0
  const st = 10 + Math.min(1, Math.max(0, stClear) / 3) * 10
  // risk quality: cheaper costs per R is better
  const rq = plan.costR <= 0.1 ? 20 : plan.costR <= 0.2 ? 15 : plan.costR <= 0.35 ? 10 : 5
  void cfg
  return Math.max(0, Math.min(100, Math.round(m15 + c5 + ema + st + rq)))
}

// ------------------------------------------------------------------ run

export interface ClassicRun {
  signals: ClassicSignal[]
  row: Omit<ClassicRow, 'symbol' | 'price' | 'change24h' | 'history' | 'open'>
}

export function runClassic(symbol: string, S: ClassicSet, cfg: ClassicConfig): ClassicRun {
  const { E, C } = S
  const n = E.c.length
  const last = n - 1
  const stable = isStablePair(symbol)
  const entryLabel = MACD_LABEL[cfg.entryTf]
  const confLabel = MACD_LABEL[cfg.confirmTf]
  const confirmIdx = (T: number, from: number) => {
    let p = from
    while (p + 1 < C.c.length && C.c[p + 1].openTime + C.ms <= T) p++
    return p
  }

  /** Every check for one side at entry bar i with confirmation bar p. */
  const evaluate = (i: number, p: number, bull: boolean, lazy = false) => {
    const k = sgn(bull)
    const side: Side = bull ? 'BUY' : 'SELL'
    const checks: Check[] = []
    const add = (key: Check['key'], label: string, ok: boolean, detail: string) => checks.push({ key, label, ok, detail })

    const t15 = trendOk(C, p, bull)
    add('c15', `${confLabel} MACD trend`, t15.ok, t15.detail)

    let crossIdx = -1
    for (let j = i; j >= Math.max(1, i - cfg.maxCrossAge); j--) {
      if (crossAt(E, j) === side) {
        crossIdx = j
        break
      }
    }
    const stillOn = k * (E.ml[i] - E.sg[i]) > 0
    const crossOk = crossIdx >= 0 && stillOn
    add('cross', `${entryLabel} MACD crossover`, crossOk, crossOk ? `${entryLabel} MACD line crossed ${bull ? 'above' : 'below'} the signal line${crossIdx === i ? ' on this candle' : ` ${i - crossIdx} bar(s) ago`}` : `no ${bull ? 'bullish' : 'bearish'} ${entryLabel} crossover${cfg.maxCrossAge > 0 ? ` in the last ${cfg.maxCrossAge + 1} candles` : ' on the latest closed candle'}`)

    const histOk = crossOk && k * E.hist[i] > 0 && k * E.hist[crossIdx - 1] <= 0
    add('hist', `${entryLabel} MACD histogram`, histOk, histOk ? `histogram turned ${bull ? 'positive' : 'negative'}` : k * E.hist[i] > 0 ? 'histogram is on the trade side but did not just turn' : `histogram is ${bull ? 'negative' : 'positive'}`)

    const a = atrAt(E, i)
    const distAtr = (k * (E.close[i] - E.ema[i])) / a
    const side200 = distAtr > 0
    const near = Math.abs(E.close[i] - E.ema[i]) < cfg.nearEmaAtr * a
    add('ema', `EMA ${cfg.emaLen} (${entryLabel})`, side200 && !near, !side200 ? `price is ${bull ? 'below' : 'above'} the EMA ${cfg.emaLen}` : near ? `price is too close to the EMA ${cfg.emaLen} (${Math.abs(distAtr).toFixed(2)} ATR) — direction unclear` : `price ${bull ? 'above' : 'below'} the EMA ${cfg.emaLen} (${distAtr.toFixed(1)} ATR)`)

    const stOk = E.stDir[i] === (bull ? 1 : -1)
    add('st', `Supertrend ${cfg.stPeriod},${cfg.stMult}`, stOk, `Supertrend is ${E.stDir[i] === 1 ? 'bullish' : 'bearish'}${stOk ? '' : ' — against the trade'}`)

    add('close', 'Candle close', true, `${entryLabel} candle closed; the forming candle is never used`)

    // the stop plan is only worked out when everything else passed (keeps long back-tests fast)
    const plan: Plan = lazy && !checks.every((c) => c.ok) ? { sl: NaN, tp: NaN, risk: NaN, reward: NaN, riskPct: NaN, rewardPct: NaN, costR: NaN, swing: null, stLine: NaN, ok: false, detail: 'not evaluated' } : planAt(E, i, bull, cfg)
    add('risk', 'Stop loss & target valid', plan.ok, plan.detail)
    const strength = plan.ok ? strengthOf(E, C, i, p, bull, plan, cfg) : null
    const strengthOk = cfg.minStrength === 0 || (strength !== null && strength >= cfg.minStrength)
    return { checks, plan, strength, crossIdx, allOk: checks.every((c) => c.ok) && strengthOk && !stable }
  }

  // ---- replay one closed entry candle at a time
  const signals: ClassicSignal[] = []
  const signalled: Record<Side, number> = { BUY: -1, SELL: -1 }
  let p = -1
  let pLast = -1
  const start = Math.max(cfg.emaLen + 5, 40)
  for (let i = 0; i < n; i++) {
    const T = E.c[i].openTime + E.ms
    p = confirmIdx(T, p)
    if (i === last) pLast = p
    if (i < start || p < CONFIRM_WARM) continue
    for (const bull of [true, false]) {
      const side: Side = bull ? 'BUY' : 'SELL'
      const ev = evaluate(i, p, bull, true)
      if (!ev.allOk || ev.strength === null) continue
      if (signalled[side] === ev.crossIdx) continue
      signalled[side] = ev.crossIdx
      const entry = E.close[i]
      const pl = ev.plan
      const crossAge = i - ev.crossIdx
      signals.push({
        id: `${symbol}|${side}|${E.c[ev.crossIdx].openTime}`,
        symbol,
        side,
        time: T,
        barsAgo: last - i,
        entry,
        sl: pl.sl,
        tp: pl.tp,
        risk: pl.risk,
        reward: pl.reward,
        riskPct: pl.riskPct,
        rewardPct: pl.rewardPct,
        rr: cfg.rr,
        costR: pl.costR,
        slMethod: cfg.slMethod,
        swing: pl.swing,
        stLine: pl.stLine,
        strength: ev.strength,
        trigger: entryLabel,
        entryTf: cfg.entryTf,
        confirmTf: cfg.confirmTf,
        crossAge,
        m5: { line: E.ml[i], signal: E.sg[i], hist: E.hist[i] },
        m15: { line: C.ml[p], signal: C.sg[p], hist: C.hist[p] },
        ema: { value: E.ema[i], position: bull ? 'ABOVE' : 'BELOW', distPct: ((entry - E.ema[i]) / E.ema[i]) * 100 },
        conditions: ev.checks.map((c) => c.detail),
        outcome: outcomeOf(E, i, bull, pl, cfg, entry),
      })
    }
  }
  signals.reverse() // newest first

  // ---- the live view of the latest closed candle
  const i = last
  const pp = pLast
  const m5 = viewAt(E, i)
  const m15 = viewAt(C, pp)
  const a = atrAt(E, i)
  const emaDistAtr = (E.close[i] - E.ema[i]) / a
  const near = Math.abs(E.close[i] - E.ema[i]) < cfg.nearEmaAtr * a
  const ema = {
    value: E.ema[i],
    position: (E.close[i] >= E.ema[i] ? 'ABOVE' : 'BELOW') as 'ABOVE' | 'BELOW',
    distPct: ((E.close[i] - E.ema[i]) / E.ema[i]) * 100,
    distAtr: emaDistAtr,
    near,
    label: near ? 'TOO CLOSE TO EMA — WAIT' : E.close[i] > E.ema[i] ? 'BULLISH — BUY SIDE ONLY' : 'BEARISH — SELL SIDE ONLY',
  }
  const stDir = E.stDir[i] === 1 ? 'BUY' : 'SELL'
  const st = { dir: stDir as 'BUY' | 'SELL', line: E.stLine[i], distPct: ((E.close[i] - E.stLine[i]) / E.close[i]) * 100, label: stDir === 'BUY' ? 'BULLISH (green)' : 'BEARISH (red)' }

  const fresh = signals.find((s) => s.barsAgo < cfg.freshBars) ?? null
  // the side the checks are shown for: the fresh signal, else the 15M lean, else the EMA side
  const lean: Side = fresh ? fresh.side : m15.trend === 'BULLISH' ? 'BUY' : m15.trend === 'BEARISH' ? 'SELL' : m15.dir === 'SELL' ? 'SELL' : m15.dir === 'BUY' ? 'BUY' : E.close[i] >= E.ema[i] ? 'BUY' : 'SELL'
  const ev = evaluate(i, pp, lean === 'BUY')
  const bullLean = lean === 'BUY'
  const trend15 = ev.checks[0].ok
  const emaOk = ev.checks.find((c) => c.key === 'ema')!.ok
  const stOk = ev.checks.find((c) => c.key === 'st')!.ok
  const k = sgn(bullLean)
  const converging = k * E.ml[i] >= k * E.sg[i] || (k * E.hist[i] > k * E.hist[i - 1] && k * E.hist[i - 1] > k * E.hist[i - 2])
  let state: ClassicState = 'WAIT'
  let text = 'WAIT — CONDITIONS NOT MET'
  if (stable) {
    text = 'WAIT — stablecoin pair, never traded'
  } else if (fresh) {
    state = fresh.side === 'BUY' ? 'STRONG BUY' : 'STRONG SELL'
    text = 'ALL CONFIRMATIONS PASSED'
  } else if (trend15 && emaOk && stOk && converging) {
    state = bullLean ? 'WATCH BUY' : 'WATCH SELL'
    const miss = ev.checks.find((c) => !c.ok)
    text = `WATCH — ${confLabel} MACD ${bullLean ? 'bullish' : 'bearish'}, entry not confirmed yet${miss ? ` (${miss.detail})` : ''}`
  } else {
    const miss = ev.checks.find((c) => !c.ok)
    text = `WAIT — CONDITIONS NOT MET${miss ? `: ${miss.detail}` : ''}`
  }

  return {
    signals,
    row: {
      barTime: E.c[i].openTime,
      entryTf: cfg.entryTf,
      confirmTf: cfg.confirmTf,
      m5,
      m15,
      ema,
      st,
      side: lean,
      checks: ev.checks,
      status: { state, text },
      signal: fresh,
      strength: fresh ? fresh.strength : ev.strength,
      atr: a,
    },
  }
}

/** Walk forward from the signal candle: SL / TP touched first, else OPEN. SL and TP in one candle -> the stop is assumed first. */
function outcomeOf(E: CSeries, i: number, bull: boolean, p: Plan, cfg: ClassicConfig, entry: number): ClassicOutcome {
  const t0 = E.c[i].openTime + E.ms
  const fund = (until: number) => ((cfg.fundingBps / 10_000) * ((until - t0) / FUNDING_MS) * entry) / p.risk
  const n = E.c.length
  for (let j = i + 1; j < n; j++) {
    const c = E.c[j]
    const hitSl = bull ? c.low <= p.sl : c.high >= p.sl
    const hitTp = bull ? c.high >= p.tp : c.low <= p.tp
    if (hitSl || hitTp) {
      const closedAt = c.openTime + E.ms
      const r = (hitSl ? -1 : cfg.rr) - p.costR - fund(closedAt)
      return { result: hitSl ? 'LOSS' : 'WIN', r, pnlPct: ((r * p.risk) / entry) * 100, closedAt, exit: hitSl ? p.sl : p.tp }
    }
  }
  const lastC = E.close[n - 1]
  const r = (bull ? lastC - entry : entry - lastC) / p.risk - p.costR - fund(E.c[n - 1].openTime + E.ms)
  return { result: 'OPEN', r, pnlPct: ((r * p.risk) / entry) * 100, closedAt: null, exit: lastC }
}

export function analyzeClassic(symbol: string, input: Partial<Record<MacdTf, Candle[]>>, cfgIn: Partial<ClassicConfig> = {}): ClassicRun | null {
  const cfg = normalizeClassic(cfgIn)
  const S = prepareClassic(input, cfg)
  return S ? runClassic(symbol, S, cfg) : null
}

export function buildClassicRow(input: { symbol: string; price: number; change24h: number; candles: Partial<Record<MacdTf, Candle[]>>; now: number; cfg?: Partial<ClassicConfig> }): ClassicRow | null {
  const cfg = normalizeClassic(input.cfg)
  const closed: Partial<Record<MacdTf, Candle[]>> = {}
  for (const tf of [cfg.entryTf, cfg.confirmTf]) if (input.candles[tf]) closed[tf] = closedOnly(input.candles[tf]!, input.now, MACD_MS[tf])
  const a = analyzeClassic(input.symbol, closed, cfg)
  if (!a) return null
  return { symbol: input.symbol, price: input.price, change24h: input.change24h, ...a.row, history: a.signals.slice(0, 20), open: a.signals.filter((s) => s.outcome.result === 'OPEN') }
}

/** Indicator lines for a chart (same functions and settings as the signals). */
export function chartIndicators(candles: Candle[], cfg: ClassicConfig) {
  const s = buildCSeries(cfg.entryTf, candles, cfg)
  return { ema: s.ema, stLine: s.stLine, stDir: s.stDir }
}
