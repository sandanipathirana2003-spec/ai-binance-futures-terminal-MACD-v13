// Run: npx tsx scripts/test-classic.ts
// Checks the 5M CLASSIC MACD engine on synthetic markets. Synthetic data proves the RULES are applied exactly as written;
// it says nothing about whether the strategy makes money (that needs the real-history back-test).
import type { Candle } from '../lib/binance'
import { resampleAligned } from '../lib/reversal'
import { regularMacd, supertrend } from '../lib/impulse5m'
import { emaSeries } from '../lib/indicators'
import { MACD_MS, type MacdTf } from '../lib/macdmtf'
import { DEFAULT_CLASSIC, MAX_COST_R, analyzeClassic, buildClassicRow, classicKey, normalizeClassic, type ClassicConfig, type ClassicSignal } from '../lib/macd5m'
import { buildPerfReport } from '../lib/macd-perf'
import { backtestClassic, rrSweep } from '../lib/macd5m-backtest'

function rng(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 }
function make1m(n: number, seed: number, drift: number): Candle[] {
  const r = rng(seed); const out: Candle[] = []; let p = 100
  const t0 = Math.floor(Date.UTC(2026, 9, 1) / 1_800_000) * 1_800_000
  for (let i = 0; i < n; i++) {
    const o = p
    const wave = 0.0016 * Math.cos((2 * Math.PI * i) / 45) + 0.0009 * Math.cos((2 * Math.PI * i) / 190) + 0.0007 * Math.cos((2 * Math.PI * i) / 700) + 0.0006 * Math.cos((2 * Math.PI * i) / 2400)
    p = Math.max(1, p * (1 + drift + wave * 0.5 + (r() - 0.5) * 0.0045))
    out.push({ openTime: t0 + i * 60000, open: o, high: Math.max(o, p) * (1 + r() * 0.0025), low: Math.min(o, p) * (1 - r() * 0.0025), close: p, volume: 100 + r() * 50 })
  }
  return out
}
const tfs = (m: Candle[]): Record<MacdTf, Candle[]> => ({ '1m': m, '3m': resampleAligned(m, 3), '5m': resampleAligned(m, 5), '15m': resampleAligned(m, 15), '30m': resampleAligned(m, 30) })

let fails = 0
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }

const cases: Array<[string, Record<MacdTf, Candle[]>]> = []
for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  cases.push([`up s${seed}`, tfs(make1m(9000, seed, 0.00006))])
  cases.push([`down s${seed}`, tfs(make1m(9000, seed + 50, -0.00006))])
  cases.push([`flat s${seed}`, tfs(make1m(9000, seed + 90, 0))])
}
const run = (cfg: Partial<ClassicConfig> = {}) => {
  const out: ClassicSignal[] = []
  cases.forEach(([, d], k) => out.push(...(analyzeClassic(`T${k}`, d, cfg)?.signals ?? [])))
  return out
}
const cfg = normalizeClassic({})
const sigs = run()
console.log(`== classic rules: ${sigs.length} signals over ${cases.length} markets (${sigs.filter((s) => s.side === 'BUY').length} BUY / ${sigs.filter((s) => s.side === 'SELL').length} SELL)`)
ok(sigs.length >= 10 && sigs.some((s) => s.side === 'BUY') && sigs.some((s) => s.side === 'SELL'), 'produces BUY and SELL signals')
ok(sigs.every((s) => s.entryTf === '5m' && s.confirmTf === '15m' && s.time % 300_000 === 0), 'every signal is on a 5M candle close, confirmed by 15M')
ok(sigs.every((s) => (s.side === 'BUY' ? s.m15.line > s.m15.signal && s.m15.hist > 0 : s.m15.line < s.m15.signal && s.m15.hist < 0)), '15M MACD line and histogram on the signal side')
ok(sigs.every((s) => s.crossAge === 0 && (s.side === 'BUY' ? s.m5.line > s.m5.signal && s.m5.hist > 0 : s.m5.line < s.m5.signal && s.m5.hist < 0)), '5M crossover on the signal candle, histogram on the signal side')
ok(sigs.every((s) => (s.side === 'BUY' ? s.entry > s.ema.value && s.ema.position === 'ABOVE' : s.entry < s.ema.value && s.ema.position === 'BELOW')), 'EMA 200: price on the right side')
ok(sigs.every((s) => (s.side === 'BUY' ? s.sl < s.entry && s.tp > s.entry : s.sl > s.entry && s.tp < s.entry)), 'SL and TP on the correct sides of the entry')
ok(sigs.every((s) => Math.abs(s.reward - s.rr * s.risk) < 1e-9 * s.entry && Math.abs(Math.abs(s.tp - s.entry) - 2 * Math.abs(s.entry - s.sl)) < 1e-7 * s.entry), 'TP distance = 2 x SL distance (default 1:2)')
ok(sigs.every((s) => s.riskPct <= cfg.maxSlPct + 1e-9 && s.costR <= MAX_COST_R + 1e-9), 'wide stops and cost-heavy setups are rejected')
ok(new Set(sigs.map((s) => s.id)).size === sigs.length, 'no duplicate signal ids (one signal per crossover)')

// independent recomputation of the conditions at the signal candle
{
  let good = 0, checked = 0
  cases.forEach(([, d], k) => {
    const mine = (analyzeClassic(`T${k}`, d)?.signals ?? []).slice(0, 4)
    const e = d['5m']; const c15 = d['15m']
    const closes = e.map((x) => x.close)
    const m5 = regularMacd(closes, 12, 26, 9)
    const st = supertrend(e, 12, 4)
    const ema = emaSeries(closes, 200)
    for (const s of mine) {
      const i = e.findIndex((x) => x.openTime + 300_000 === s.time)
      let p = -1; while (p + 1 < c15.length && c15[p + 1].openTime + 900_000 <= s.time) p++
      const m15 = regularMacd(c15.map((x) => x.close), 12, 26, 9)
      const bull = s.side === 'BUY'
      const crossed = bull ? m5.line[i] > m5.signal[i] && m5.line[i - 1] <= m5.signal[i - 1] : m5.line[i] < m5.signal[i] && m5.line[i - 1] >= m5.signal[i - 1]
      const t15 = bull ? m15.line[p] > m15.signal[p] && m15.hist[p] > 0 : m15.line[p] < m15.signal[p] && m15.hist[p] < 0
      const stOk = bull ? st.dir[i] === 1 : st.dir[i] === -1
      const emaOk = bull ? closes[i] > ema[i] : closes[i] < ema[i]
      checked++
      if (crossed && t15 && stOk && emaOk && e[i].close === s.entry) good++
    }
  })
  ok(checked > 0 && good === checked, `independent recomputation agrees on 15M trend, 5M cross, EMA 200, Supertrend, entry (${good}/${checked})`)
}

// stop methods
{
  const sw = run({ slMethod: 'swing' }); const stm = run({ slMethod: 'supertrend' }); const atrM = run({ slMethod: 'atr', atrSlMult: 2 })
  ok(sw.length > 0 && sw.every((s) => s.swing !== null && (s.side === 'BUY' ? s.sl < s.swing : s.sl > s.swing)), 'swing method: stop beyond the swing low / high (ATR buffer)')
  ok(stm.length > 0 && stm.every((s) => (s.side === 'BUY' ? s.sl < s.stLine : s.sl > s.stLine)), 'Supertrend method: stop beyond the Supertrend line')
  ok(atrM.length > 0 && atrM.every((s) => Number.isFinite(s.sl) && s.slMethod === 'atr'), 'ATR method produces valid stops')
  ok(sigs.every((s) => (s.side === 'BUY' ? (s.swing === null || s.sl <= s.swing) : (s.swing === null || s.sl >= s.swing))), 'default method is at least as far as the swing')
  const tight = run({ maxSlPct: 0.2 })
  ok(tight.length < sigs.length && tight.every((s) => s.riskPct <= 0.2), 'a smaller maximum stop distance rejects more signals')
}
// reward:risk choices
for (const rr of [1, 1.5, 3]) {
  const v = run({ rr })
  ok(v.length > 0 && v.every((s) => Math.abs(Math.abs(s.tp - s.entry) - rr * Math.abs(s.entry - s.sl)) < 1e-7 * s.entry), `RR 1:${rr}: TP = ${rr} x risk`)
}
// no look-ahead / no repaint: re-run on history cut right after each signal, the signal must be identical
{
  let same = 0, total = 0
  cases.slice(0, 12).forEach(([, d], k) => {
    for (const s of (analyzeClassic(`T${k}`, d)?.signals ?? []).slice(0, 3)) {
      const cut: Partial<Record<MacdTf, Candle[]>> = {}
      for (const tf of ['5m', '15m'] as MacdTf[]) cut[tf] = d[tf].filter((c) => c.openTime + MACD_MS[tf] <= s.time)
      const again = (analyzeClassic(`T${k}`, cut)?.signals ?? []).find((x) => x.id === s.id)
      total++
      if (again && again.entry === s.entry && again.sl === s.sl && again.tp === s.tp && again.time === s.time && again.strength === s.strength) same++
    }
  })
  ok(total > 0 && same === total, `no repaint / look-ahead: ${same}/${total} signals reproduce exactly from history cut at their candle close`)
}
// outcomes
{
  let good = 0, total = 0
  cases.forEach(([, d], k) => {
    for (const s of (analyzeClassic(`T${k}`, d)?.signals ?? []).slice(0, 5)) {
      const e = d['5m']; const i = e.findIndex((x) => x.openTime + 300_000 === s.time)
      let res: 'WIN' | 'LOSS' | 'OPEN' = 'OPEN'
      for (let j = i + 1; j < e.length; j++) {
        const hitSl = s.side === 'BUY' ? e[j].low <= s.sl : e[j].high >= s.sl
        const hitTp = s.side === 'BUY' ? e[j].high >= s.tp : e[j].low <= s.tp
        if (hitSl || hitTp) { res = hitSl ? 'LOSS' : 'WIN'; break }
      }
      total++
      if (res === s.outcome.result) good++
    }
  })
  ok(total > 0 && good === total, `outcomes match an independent walk-forward (${good}/${total}); SL and TP in one candle counts as a loss`)
  const w = sigs.find((s) => s.outcome.result === 'WIN'); const l = sigs.find((s) => s.outcome.result === 'LOSS')
  ok(Boolean(w && l) && w!.outcome.r > 1 && w!.outcome.r < 2 && l!.outcome.r < -1, 'net R after costs: win a little under +2R, loss a little worse than -1R')
}
// live row
{
  const k = cases.findIndex(([, d], idx) => (analyzeClassic(`T${idx}`, d)?.signals.length ?? 0) > 0)
  const d = cases[k][1]; const s = analyzeClassic(`T${k}`, d)!.signals.slice(-1)[0]
  const cut: Partial<Record<MacdTf, Candle[]>> = {}
  for (const tf of ['5m', '15m'] as MacdTf[]) cut[tf] = d[tf].filter((c) => c.openTime + MACD_MS[tf] <= s.time)
  const row = buildClassicRow({ symbol: `T${k}`, price: s.entry, change24h: 0, candles: cut, now: s.time + 5000 })
  ok(row?.status.state === (s.side === 'BUY' ? 'STRONG BUY' : 'STRONG SELL') && row.signal?.id === s.id && row.checks.every((c) => c.ok) && row.status.text === 'ALL CONFIRMATIONS PASSED', 'live row shows STRONG signal, all six confirmations + stop valid, ALL CONFIRMATIONS PASSED')
  const later = buildClassicRow({ symbol: `T${k}`, price: s.entry, change24h: 0, candles: { '5m': d['5m'].filter((c) => c.openTime + 300_000 <= s.time + 300_000 * 8), '15m': d['15m'].filter((c) => c.openTime + 900_000 <= s.time + 300_000 * 8) }, now: s.time + 300_000 * 8 })
  ok(later !== null && later.signal === null && later.status.state !== 'STRONG BUY' && later.status.state !== 'STRONG SELL', 'an old signal is no longer "STRONG" (no stale alerts)')
  const forming = buildClassicRow({ symbol: `T${k}`, price: s.entry, change24h: 0, candles: { '5m': d['5m'].filter((c) => c.openTime <= s.time), '15m': d['15m'].filter((c) => c.openTime + 900_000 <= s.time) }, now: s.time - 1000 })
  ok(forming !== null && !forming.history.some((x) => x.id === s.id), 'the candle still forming never produces the signal')
  const states = new Set(cases.map(([, dd], idx) => buildClassicRow({ symbol: `T${idx}`, price: 100, change24h: 0, candles: dd, now: dd['1m'][dd['1m'].length - 1].openTime + 60000 })?.status.state))
  console.log('   states seen:', [...states].join(', '))
  ok(states.has('WAIT') && [...states].every((x) => x && ['STRONG BUY', 'STRONG SELL', 'WATCH BUY', 'WATCH SELL', 'WAIT'].includes(x)), 'states are only STRONG / WATCH / WAIT')
  const stable = analyzeClassic('USDCUSDT', d)
  ok(stable !== null && stable.signals.length === 0, 'stablecoin pairs never produce signals')
}
// config
{
  const c = normalizeClassic({ entryTf: '15m', confirmTf: '5m', rr: 99, fast: 1, slow: 1, maxSlPct: -4, slMethod: 'bogus' })
  ok(c.confirmTf === '30m' && c.rr === 10 && c.fast === 2 && c.slow > c.fast && c.maxSlPct === 0.1 && c.slMethod === DEFAULT_CLASSIC.slMethod, 'config is clamped; the confirmation timeframe is always slower than the entry timeframe')
  ok(classicKey(normalizeClassic({ rr: 3 })) !== classicKey(normalizeClassic({ rr: 2 })), 'config key changes with strategy settings')
  const alt = analyzeClassic('T0', cases[0][1], { entryTf: '15m', confirmTf: '30m' })
  ok(alt !== null && alt.signals.every((s) => s.entryTf === '15m' && s.time % 900_000 === 0), 'other entry timeframes work (15M entry, 30M confirmation)')
}
// perf + backtest runner
{
  const rep = buildPerfReport(sigs.map((s) => ({ symbol: s.symbol, side: s.side, trigger: s.trigger, time: s.time, outcome: s.outcome, score: s.strength })))
  ok(rep.total === sigs.length && rep.wins + rep.losses === rep.closed && rep.closed + rep.open === rep.total, 'performance report counts add up')
  const d = cases[0][1]
  const start = d['5m'][0].openTime + 3 * 86_400_000
  const bt = backtestClassic('T0', d, {}, start)
  ok(bt.every((s) => s.time >= start), 'back-test drops the warm-up window')
  const sweep = rrSweep('T0', d, {}, start)
  ok(sweep.length === 4 && sweep.map((x) => x.rr).join() === '1,1.5,2,3', 'RR sweep runs 1, 1.5, 2 and 3 on the same window')
}
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
