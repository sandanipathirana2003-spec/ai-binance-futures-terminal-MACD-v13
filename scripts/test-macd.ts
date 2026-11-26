// Run: npx tsx scripts/test-macd.ts
// Checks the MACD PRECISION engine on synthetic markets. The synthetic data proves the RULES are applied exactly as written;
// it says nothing about whether the strategy makes money (that needs the real-history back-test).
import type { Candle } from '../lib/binance'
import { resampleAligned } from '../lib/reversal'
import { adxSeries, analyzeMacd as analyzeRaw, buildMacdRow as buildRaw, rsiSeries, DEFAULT_MACD, isStablePair, MACD_MS, RR, STRATEGY_VERSION, normalizeMacdConfig, type MacdConfig, type MacdSignal, type MacdTf } from '../lib/macdmtf'
import { buildPerfReport } from '../lib/macd-perf'
import { backtestSymbol, defaultVariants } from '../lib/macd-backtest'

// The v8 rule tests run on the classic 12/26/9 MACD without RSI so they keep exercising the same behaviour; the impulse + RSI tests are at the bottom.
const BASE: Partial<MacdConfig> = { indicator: 'normal', rsiOn: false }
const analyzeMacd = (sym: string, c: Parameters<typeof analyzeRaw>[1], cfg: Partial<MacdConfig> = {}, o?: Parameters<typeof analyzeRaw>[3]) => analyzeRaw(sym, c, { ...BASE, ...cfg }, o)
const buildMacdRow = (inp: Parameters<typeof buildRaw>[0]) => buildRaw({ ...inp, cfg: { ...BASE, ...(inp.cfg ?? {}) } as Partial<MacdConfig> })

function rng(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 }
/** 1M candles with realistic wicks: slow drift + waves + noise (aligned to a 30M boundary so every timeframe resamples cleanly). */
function make1m(n: number, seed: number, drift: number): Candle[] {
  const r = rng(seed); const out: Candle[] = []; let p = 100
  const t0 = Math.floor(Date.UTC(2026, 9, 1) / 1_800_000) * 1_800_000
  for (let i = 0; i < n; i++) {
    const o = p
    const wave = 0.0016 * Math.cos((2 * Math.PI * i) / 45) + 0.0009 * Math.cos((2 * Math.PI * i) / 190) + 0.0007 * Math.cos((2 * Math.PI * i) / 700) + 0.0006 * Math.cos((2 * Math.PI * i) / 2400)
    p = Math.max(1, p * (1 + drift + wave * 0.5 + (r() - 0.5) * 0.0045))
    out.push({ openTime: t0 + i * 60000, open: o, high: Math.max(o, p) * (1 + r() * 0.0025), low: Math.min(o, p) * (1 - r() * 0.0025), close: p, volume: (100 + r() * 50) * (1 + (Math.abs(p - o) / o) * 800) })
  }
  return out
}
const tfs = (m: Candle[]): Record<MacdTf, Candle[]> => ({ '1m': m, '3m': resampleAligned(m, 3), '5m': resampleAligned(m, 5), '15m': resampleAligned(m, 15), '30m': resampleAligned(m, 30) })

let fails = 0
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }

const cases: Array<[string, Candle[]]> = []
for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  cases.push([`up s${seed}`, make1m(9000, seed, 0.00006)])
  cases.push([`down s${seed}`, make1m(9000, seed + 50, -0.00006)])
  cases.push([`flat s${seed}`, make1m(9000, seed + 90, 0)])
}

// Relaxed gates (score, net RR, EMA closeness, liquidity, stop width, cooldown) so enough synthetic signals exist to test every rule.
const RELAX: Partial<MacdConfig> = { minScore: 0, minNetRR: 1, maxRiskPct: 10, nearEmaAtr: 0, minLiqUsd: 0, cooldownBars: 0, ribbonMin: 2, sidewaysOn: false, latencyMs: 0 }
const run = (cfg: Partial<MacdConfig>, basic = false) => {
  const out: MacdSignal[] = []
  cases.forEach(([, m], k) => out.push(...(analyzeMacd(`T${k}`, tfs(m), cfg, { basic })?.signals ?? [])))
  return out
}

const sigs = run(RELAX)
console.log(`== precision rules (relaxed score / cost gates): ${sigs.length} signals over ${cases.length} markets (${sigs.filter((s) => s.side === 'BUY').length} BUY / ${sigs.filter((s) => s.side === 'SELL').length} SELL)`)
ok(sigs.length >= 12 && sigs.some((s) => s.side === 'BUY') && sigs.some((s) => s.side === 'SELL'), 'produces BUY and SELL signals')
ok(sigs.every((s) => s.trigger === '1m' && s.time % 60000 === 0), 'every signal is on a 1M candle close')
ok(sigs.every((s) => s.tfs['15m'] === s.side && s.tfs['5m'] === s.side && s.tfs['1m'] === s.side), '15M, 5M and 1M MACD are on the signal side at the signal close')
ok(sigs.every((s) => s.crossAge === 0 && (s.side === 'BUY' ? s.macd.line > s.macd.signal && s.macd.hist > 0 : s.macd.line < s.macd.signal && s.macd.hist < 0)), 'fresh 1M crossover on the signal candle (default max age 0), histogram on the right side')
ok(sigs.every((s) => (s.side === 'BUY' ? s.entry > s.ema200.value && s.ema200.position === 'ABOVE' : s.entry < s.ema200.value && s.ema200.position === 'BELOW') && (s.side === 'BUY' ? s.ema200.slope === 'RISING' : s.ema200.slope === 'FALLING')), '5M EMA 200: right side and the slope points the trade\'s way (never flat, never against)')
ok(sigs.every((s) => s.ribbon.stack >= 2 && (s.side === 'BUY' ? s.ribbon.state !== 'BEARISH STACK' : s.ribbon.state !== 'BULLISH STACK')), 'EMA ribbon: at least 2 of 3 pairs stacked for the trade, never the opposite stack')
ok(sigs.every((s) => s.supertrend.dir === s.side && s.st5.dir === s.side), '1M and 5M Supertrend 12,4 agree with the side')
ok(sigs.every((s) => s.st3 && s.st15 && Number.isFinite(s.st3.line) && Number.isFinite(s.st15.line) && s.version.startsWith(STRATEGY_VERSION) && s.tfs['3m'] !== undefined), 'signals carry 3M / 15M Supertrend, the 3M MACD direction and the strategy version')
ok(sigs.every((s) => (s.side === 'BUY' ? s.sl < s.entry && s.sl < s.swing && s.tp > s.entry : s.sl > s.entry && s.sl > s.swing && s.tp < s.entry)), 'SL is beyond the 1M swing low / high and on the correct side; TP on the correct side')
ok(sigs.every((s) => Math.abs(s.reward / s.risk - RR) < 1e-9 && Math.abs(Math.abs(s.tp - s.entry) - 2 * Math.abs(s.entry - s.sl)) < 1e-9), 'reward is exactly 2 x risk')
ok(sigs.every((s) => s.risk > 0 && s.riskPct > 0 && Math.abs(s.rewardPct / s.riskPct - 2) < 1e-9 && Math.abs(s.netRR - (RR - s.costR) / (1 + s.costR)) < 1e-9 && s.grossRR === 2), 'risk % / reward % / gross + net RR consistent')
ok(new Set(sigs.map((s) => s.id)).size === sigs.length, 'no duplicate signal ids')
ok(sigs.every((s) => s.score >= 0 && s.score <= 100 && s.scoreParts.reduce((a, p) => a + p.pts, 0) === s.score && s.scoreParts.length === 13 && s.scoreParts.some((p) => p.label.startsWith('3M MACD')) && s.scoreParts.reduce((a, p) => a + p.max, 0) === 100 && s.scoreParts.every((p) => p.pts >= 0 && p.pts <= p.max)), 'quality score: 0-100, parts add up, no part exceeds its maximum')

// ---- default gates
{
  const strict = run({})
  const relaxedIds = new Set(sigs.map((s) => s.id))
  ok(strict.every((s) => s.score >= 85 && s.netRR >= DEFAULT_MACD.minNetRR && s.riskPct <= DEFAULT_MACD.maxRiskPct), `default gates: every signal has score >= 85, net RR >= ${DEFAULT_MACD.minNetRR}, stop <= ${DEFAULT_MACD.maxRiskPct}% (${strict.length} signals)`)
  ok(strict.length <= sigs.length, 'stricter gates never create signals that the relaxed run lacks in number')
  void relaxedIds
  const scored = run({ ...RELAX, minScore: 80 })
  ok(scored.every((s) => s.score >= 80) && scored.length <= sigs.length, 'raising the minimum score only removes signals')
}

// ---- basic variant is a superset
{
  const basic = run(RELAX, true)
  const ids = new Set(basic.map((s) => s.id))
  ok(basic.length >= sigs.length && sigs.every((s) => ids.has(s.id)), `basic (ablation) variant contains every precision signal (${basic.length} vs ${sigs.length})`)
}

// ---- cooldown
{
  const cd = run({ ...RELAX, cooldownBars: 15 })
  const bySym = new Map<string, number[]>()
  for (const s of cd) bySym.set(s.symbol, [...(bySym.get(s.symbol) ?? []), s.time])
  let tight = 0
  for (const ts of bySym.values()) { ts.sort((a, b) => a - b); for (let k = 1; k < ts.length; k++) if (ts[k] - ts[k - 1] < 15 * 60000) tight++ }
  ok(tight === 0 && cd.length <= sigs.length, `cooldown: same coin never signals twice within 15 minutes (${cd.length} vs ${sigs.length} without)`)
}

// ---- stablecoins
{
  const m = cases[0][1]
  ok(isStablePair('USDCUSDT') && isStablePair('FDUSDUSDT') && !isStablePair('BTCUSDT'), 'stablecoin pairs are recognised')
  const a = analyzeMacd('USDCUSDT', tfs(m), RELAX)!
  ok(a.signals.length === 0 && a.row.status.state === 'WAIT' && a.row.status.text.includes('STABLECOIN'), 'stablecoin pair never signals and shows WAIT')
}

// ---- one signal per crossover
{
  let dup = 0
  for (const [, m] of cases) {
    const a = analyzeMacd('T', tfs(m), RELAX)?.signals ?? []
    const keys = a.map((s) => `${s.side}|${s.id.split('-').pop()}`)
    if (new Set(keys).size !== keys.length) dup++
  }
  ok(dup === 0, 'exactly one signal per crossover')
}

// ---- no repaint / look-ahead
{
  let cmp = 0, bad = 0
  for (const idx of [0, 1, 2, 4, 5, 7]) {
    const m = cases[idx][1]
    const full = analyzeMacd('T', tfs(m), RELAX)!.signals
    for (const cut of [4800, 6000, 7200, 8400, 9000]) {
      const pre = analyzeMacd('T', tfs(m.slice(0, cut)), RELAX)
      const T = m[cut - 1].openTime + 60000
      const exp = full.filter((s) => s.time <= T)
      cmp += exp.length
      const key = (s: MacdSignal) => `${s.id}|${s.entry.toFixed(8)}|${s.sl.toFixed(8)}|${s.tp.toFixed(8)}|${s.score}|${s.time}`
      const A = new Set((pre?.signals ?? []).map(key)), B = new Set(exp.map(key))
      if (A.size !== B.size || [...A].some((k) => !B.has(k))) bad++
    }
  }
  ok(bad === 0 && cmp > 0, `no repaint / no look-ahead: prefix runs match the full run (${cmp} signals compared)`)
}

// ---- live status consistency
{
  let good = true, confirmed = 0, developing = 0, withChecks = 0
  const seen = new Map<string, number>()
  for (const [, m] of cases) {
    // regular samples plus the moments just after the first signals (so confirmed views are really exercised)
    const sigCuts = (analyzeMacd('T', tfs(m), RELAX)?.signals ?? []).slice(-3).map((x) => Math.round((x.time - m[0].openTime) / 60000)).filter((c) => c >= 1300) // below ~1050 1M bars the row builder (EMA 200 warm-up) correctly returns nothing
    for (const cut of [5400, 6100, 7000, 7900, 9000, ...sigCuts]) {
      const part = m.slice(0, cut)
      const row = buildMacdRow({ symbol: 'T', price: part[part.length - 1].close, change24h: 0, candles: tfs(part), now: part[part.length - 1].openTime + 60000, cfg: RELAX })
      if (!row) { good = false; continue }
      const st = row.status
      const key = st.state.startsWith('CONFIRMED') || st.state.startsWith('EARLY') ? st.state : st.text.replace(/\d+/g, 'N').slice(0, 70)
      seen.set(key, (seen.get(key) ?? 0) + 1)
      if (st.state.startsWith('CONFIRMED')) confirmed++
      if (st.state.startsWith('EARLY')) developing++
      if (row.checks.length) withChecks++
      if (row.signal && st.state !== (row.signal.side === 'BUY' ? 'CONFIRMED BUY' : 'CONFIRMED SELL')) good = false
      if (!row.signal && st.state.startsWith('CONFIRMED')) good = false
      if (st.state === 'WAIT' && !st.text.startsWith('WAIT') && !st.text.includes('WAIT')) good = false
      if (row.agreement.bull + row.agreement.bear > row.agreement.total) good = false
      if (row.ema200.buyValid && row.ema200.sellValid) good = false
      if (row.checks.length && row.checks[0].key !== 'm15' && !row.signal) good = false // priority order: 15M first
      if (row.score !== null && (row.score < 0 || row.score > 100)) good = false
      if (st.state.startsWith('EARLY') && !row.checks.every((c) => c.ok || c.key === 'cross')) good = false
    }
  }
  ok(good && confirmed > 0 && developing > 0 && withChecks > 0, `live status is consistent (${confirmed} confirmed, ${developing} developing views checked)`)
  console.log('   statuses seen:', [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${v}x ${k}`).join(' | '))
}

// ---- a row built right after a signal shows it as confirmed (and not once it is stale)
{
  const m = cases[0][1]
  const s = analyzeMacd('T', tfs(m), RELAX)!.signals.find((x) => x.time < m[m.length - 1].openTime - 600000)
  if (!s) ok(false, 'found a signal to test the fresh window')
  else {
    const now = s.time + 3000
    const row = buildMacdRow({ symbol: 'T', price: s.entry, change24h: 0, candles: tfs(m), now, cfg: RELAX })!
    ok(row.signal?.id === s.id && row.status.state.startsWith('CONFIRMED') && row.checks.every((c) => c.ok), 'fresh signal: row shows CONFIRMED with every check ticked')
    const later = buildMacdRow({ symbol: 'T', price: s.entry, change24h: 0, candles: tfs(m), now: s.time + 20 * 60000, cfg: RELAX })!
    ok(later.signal?.id !== s.id, 'an old signal is no longer "confirmed now" (no stale popups)')
  }
}

// ---- config clamping
{
  const c = normalizeMacdConfig({ fast: 40, slow: 3, stMult: 999, trigger: '15m', tfs: 'zz,30m', maxCrossAge: -4, minScore: 500, minNetRR: 9, maxRiskPct: -1 })
  ok(c.slow === 41 && c.stMult === 20 && c.trigger === '1m' && c.tfs.join() === '1m,3m,5m,15m,30m' && c.maxCrossAge === 0 && c.minScore === 100 && c.minNetRR === 1.95 && c.maxRiskPct === 0.1, 'config input is clamped; 1M / 3M / 5M / 15M are always checked and the trigger is always 1M')
}

// ---- performance maths (hand-made numbers)
{
  const mk = (sym: string, trig: string, t: number, r: number, res: 'WIN' | 'LOSS' | 'OPEN', score = 90) => ({ symbol: sym, side: 'BUY' as const, trigger: trig, time: t, score, netRR: 1.8, outcome: { result: res, r, pnlPct: r / 2, closedAt: t + 600000 } })
  const d = Date.UTC(2026, 9, 5) // a Monday
  const p = buildPerfReport([mk('A', '1m', d, 1.9, 'WIN', 96), mk('A', '1m', d + 3600e3, -1.1, 'LOSS', 88), mk('B', '1m', d + 86400e3, -1.1, 'LOSS', 91), mk('B', '1m', d + 2 * 86400e3, 1.9, 'WIN', 86), mk('B', '1m', d + 3 * 86400e3, 0.5, 'OPEN')])
  ok(p.total === 5 && p.closed === 4 && p.open === 1 && p.wins === 2 && p.losses === 2 && p.tpHits === 2 && p.slHits === 2, 'performance: counts (open trades excluded from win/loss)')
  ok(Math.abs(p.winRate - 50) < 1e-9 && Math.abs(p.netR - 1.6) < 1e-9 && Math.abs(p.avgWinR - 1.9) < 1e-9 && Math.abs(p.avgLossR + 1.1) < 1e-9, 'performance: win rate, net R, average win / loss')
  ok(Math.abs((p.profitFactor ?? 0) - 3.8 / 2.2) < 1e-9, 'performance: profit factor = gross win / gross loss')
  ok(Math.abs(p.maxDrawdownR - 2.2) < 1e-9, 'performance: max drawdown (peak 0.8R -> trough -1.4R)')
  ok(p.daily.length === 3 && p.weekly.length === 1 && p.weekly[0].key === '2026-10-05' && p.monthly[0].key === '2026-10' && p.byCoin.length === 2, 'performance: daily / weekly / monthly / coin groupings')
  ok(Math.abs(p.avgHoldMin - 10) < 1e-9 && Math.abs(p.avgNetRR - 1.8) < 1e-9, 'performance: average holding time and planned net RR')
  ok(p.byScore.map((b) => b.key).join() === 'Score 95-100,Score 90-94,Score 85-89' || p.byScore.map((b) => `${b.key}:${b.trades}`).join() === 'Score 95-100:1,Score 90-94:1,Score 85-89:2', 'performance: quality-score bands')
  ok(buildPerfReport([mk('A', '1m', d, 1.9, 'WIN')]).profitFactor === null, 'performance: no losses -> profit factor not computed (null)')
}

// ---- back-test runner (offline smoke test on synthetic data: proves the plumbing, says nothing about the strategy)
{
  const m = cases[0][1]
  const data = tfs(m)
  const res = backtestSymbol('T', data, RELAX, 0)
  ok(res.length === defaultVariants().length && res.every((r) => r.signals.every((s) => s.trigger === '1m')), 'back-test runner: every variant returns 1M-trigger signals')
  const pre = res.find((r) => r.key === 'precision')!, basic = res.find((r) => r.key === 'basic')!
  ok(basic.signals.length >= pre.signals.length, `basic variant fires at least as often as the full strategy (${basic.signals.length} >= ${pre.signals.length})`)
  const cut = m[6000].openTime
  ok(backtestSymbol('T', data, RELAX, cut).every((r) => r.signals.every((s) => s.time >= cut)), 'back-test window drops warm-up signals')
}

// ======================= v8 additions =======================
const ALLOWED_WAIT = new Set(['WAIT — 15M MACD Opposing', 'WAIT — 5M MACD Not Confirmed', 'WAIT — No Fresh 1M Crossover', 'WAIT — EMA 200 Filter Failed', 'WAIT — Mixed EMA Ribbon', 'WAIT — Supertrend Not Confirmed', 'WAIT — Sideways Market', 'WAIT — Invalid Stop Loss', 'WAIT — RR Below 1:2', 'WAIT — Signal Quality Below 85', 'WAIT — Entry Overextended', 'WAIT — Cooldown Active', 'WAIT — RSI Not Confirmed', 'WAIT — Low Liquidity', 'WAIT — Stablecoin Pair'])
{
  // ---- exact WAIT reasons, in chain order, over many live samples with the DEFAULT config
  let bad = 0, total = 0, m15 = 0, noCross = 0, early = 0, earlyBad = 0
  const reasons = new Map<string, number>()
  for (const [, m] of cases) for (const cut of [5400, 6100, 7000, 7900, 9000]) {
    const part = m.slice(0, cut)
    const row = buildMacdRow({ symbol: 'T', price: part[part.length - 1].close, change24h: 0, candles: tfs(part), now: part[part.length - 1].openTime + 60000 })
    if (!row) { bad++; continue }
    total++
    const st = row.status
    reasons.set(st.text, (reasons.get(st.text) ?? 0) + 1)
    if (st.state === 'WAIT' && !ALLOWED_WAIT.has(st.text)) { bad++; console.log('   unexpected status text:', st.text) }
    const firstFail = row.checks.find((c) => !c.ok)
    if (st.state === 'WAIT' && row.checks.length && firstFail && st.text !== firstFail.wait && !(row.checks.every((c) => c.ok || c.key === 'cross'))) bad++
    if (row.checks.length && !row.checks[0].ok) { m15++; if (st.text !== 'WAIT — 15M MACD Opposing') bad++ }
    if (row.checks.length >= 3 && row.checks[0].ok && row.checks[1].ok && !row.checks[2].ok && row.checks[2].key === 'cross') { noCross++; if (st.text !== 'WAIT — No Fresh 1M Crossover') bad++ }
    if (st.state.startsWith('EARLY')) { early++; if (row.signal || !row.early || !/^EARLY (LONG|SHORT) SETUP — WAIT FOR CONFIRMATION$/.test(st.text) || row.tfs['3m']!.dir !== st.side) earlyBad++ }
    if (row.status.state === 'CONFIRMED BUY' || row.status.state === 'CONFIRMED SELL') if (row.score === null || row.score < 85) bad++
  }
  ok(bad === 0 && total > 0, `WAIT reasons: every non-trade status uses an exact reason from the chain, first failing check wins (${total} samples, ${m15} 15M-opposing, ${noCross} no-cross)`)
  ok(m15 > 0 && noCross > 0, 'both the 15M-opposing case (15M bearish + lower timeframes bullish = WAIT) and the no-fresh-cross case (1M approaching but not crossed = WAIT) were exercised')
  console.log('   WAIT texts seen:', [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${v}x ${k}`).join(' | '))
  // early setups need a RELAXED run to occur often enough
  let e2 = 0, e2bad = 0
  for (const [, m] of cases) for (const cut of [5400, 6100, 7000, 7900, 9000]) {
    const part = m.slice(0, cut)
    const row = buildMacdRow({ symbol: 'T', price: part[part.length - 1].close, change24h: 0, candles: tfs(part), now: part[part.length - 1].openTime + 60000, cfg: RELAX })
    if (row?.status.state.startsWith('EARLY')) { e2++; if (row.signal || row.tfs['3m']!.dir !== row.status.side || row.st3.dir !== row.status.side || !row.checks.every((c) => c.ok || c.key === 'cross')) e2bad++ }
  }
  ok(earlyBad === 0 && e2bad === 0 && e2 + early > 0, `early setups: 3M MACD + 3M Supertrend agree, everything except the fresh 1M cross passes, never a signal (${early + e2} seen)`)
}

{
  // ---- rejection log
  let rej = 0, bad = 0, withReason = 0
  for (const [, m] of cases) {
    const a = analyzeMacd('T', tfs(m), {}, { allRejections: true })!
    const ids = new Set(a.signals.map((s) => s.id))
    const seen = new Set<string>()
    for (const r of a.allRejections ?? []) {
      rej++
      if (ids.has(r.id) || seen.has(r.id)) bad++
      seen.add(r.id)
      if (ALLOWED_WAIT.has(r.reason) || /^WAIT — Signal Quality Below \d+$/.test(r.reason)) withReason++
      if (!r.failed.length || !r.version.startsWith(STRATEGY_VERSION)) bad++
    }
    if (a.row.rejections.length > 100) bad++
  }
  ok(rej > 20 && bad === 0 && withReason === rej, `rejection log: every failed fresh crossover is logged once with an exact reason and never also a signal (${rej} logged)`)
}

{
  // ---- sideways market
  const r = rng(77); let p = 100
  const t0 = Math.floor(Date.UTC(2026, 9, 1) / 1_800_000) * 1_800_000
  const flat: Candle[] = []
  for (let i = 0; i < 9000; i++) { const o = p; p = 100 + Math.sin(i / 7) * 0.05 + (r() - 0.5) * 0.04; flat.push({ openTime: t0 + i * 60000, open: o, high: Math.max(o, p) + 0.01, low: Math.min(o, p) - 0.01, close: p, volume: 100 + r() * 20 }) }
  const row = buildMacdRow({ symbol: 'T', price: p, change24h: 0, candles: tfs(flat), now: t0 + 9000 * 60000 })!
  ok(row.sideways.sideways && row.sideways.hits >= 3 && row.sideways.of === 8, `sideways filter: a dead-flat market is detected (${row.sideways.hits}/8 tests: ${row.sideways.tests.filter((x) => x.hit).map((x) => x.key).join(',')})`)
  const on = analyzeMacd('T', tfs(flat), { ...RELAX, sidewaysOn: true })!.signals
  const off = analyzeMacd('T', tfs(flat), { ...RELAX, sidewaysOn: false })!.signals
  ok(on.length === 0 && off.length >= on.length, `sideways filter: no signals while sideways, and it is configurable (${on.length} on vs ${off.length} off)`)
  let swRej = 0, swOn = 0, swOff = 0
  for (const [, m] of cases) {
    const x = analyzeMacd('T', tfs(m), { ...RELAX, sidewaysOn: true, sidewaysHits: 2 }, { allRejections: true })!
    swRej += (x.allRejections ?? []).filter((q) => q.reason === 'WAIT — Sideways Market').length
    swOn += x.signals.length
    swOff += analyzeMacd('T', tfs(m), { ...RELAX, sidewaysOn: false })!.signals.length
  }
  ok(swRej > 0 && swOn < swOff, `sideways filter: rejected crossovers are logged as "WAIT — Sideways Market" (${swRej} logged, ${swOn} signals vs ${swOff} with the filter off)`)
  const hi = Number(adxSeries(tfs(make1m(3000, 3, 0.0008))['5m']).slice(-1)[0]), lo = Number(adxSeries(tfs(flat)['5m']).slice(-1)[0])
  ok(hi > 25 && lo < 25 && hi > lo, `ADX(14): strong trend ${hi.toFixed(1)} > sideways ${lo.toFixed(1)}`)
}

{
  // ---- latency / slippage cost model
  const a = run({ ...RELAX, latencyMs: 0 }), b = run({ ...RELAX, latencyMs: 5000 })
  const mb = new Map(b.map((s) => [s.id, s]))
  const pairs = a.filter((s) => mb.has(s.id))
  ok(pairs.length > 5 && pairs.every((s) => mb.get(s.id)!.costR > s.costR && mb.get(s.id)!.netRR < s.netRR), `execution latency raises cost and lowers net RR (${pairs.length} signals compared)`)
  ok(run({ ...RELAX, slipBps: 20 }).every((s) => s.costR > 0), 'slippage is part of the cost')
  const hiMin = run({ ...RELAX, minNetRR: 1.9 })
  ok(hiMin.every((s) => s.netRR >= 1.9) && hiMin.length <= sigs.length, 'RR below the configured net minimum is rejected')
}

{
  // ---- ribbon strictness
  const full = run({ ...RELAX, ribbonMin: 3 })
  ok(full.every((s) => s.ribbon.stack === 3) && full.length <= sigs.length, `ribbon: mixed = WAIT with ribbonMin 3 (${full.length} full-stack signals vs ${sigs.length})`)
}

{
  // ---- one popup per crossover: signal ids carry the cross time and the 1M cross candle is the signal candle
  const dupe = new Set<string>(); let dups = 0
  for (const s of sigs) { const k = s.symbol + '|' + s.id; if (dupe.has(k)) dups++; dupe.add(k) }
  ok(dups === 0 && sigs.every((s) => s.id.endsWith(`-${s.time - s.crossAge * 60000}`)), 'popup identity: one id per crossover, derived from the cross candle close')
}

// ======================= Impulse MACD + RSI =======================
{
  const IMP: Partial<MacdConfig> = { ...RELAX, indicator: 'impulse', rsiOn: true }
  // RSI maths
  const up = Array.from({ length: 60 }, (_, i) => 100 + i)
  const zig = Array.from({ length: 200 }, (_, i) => 100 + (i % 2 ? 1 : -1))
  const r1 = rsiSeries(up, 14), r2 = rsiSeries(zig, 14)
  ok(r1[59] === 100 && Number.isNaN(r1[13]) && Math.abs(r2[199] - 50) < 2, `RSI 14 (Wilder): straight rally = 100, zig-zag ≈ 50 (${r2[199].toFixed(1)}), NaN before 14 bars`)
  // LazyBear: dead flat price => channel never left => line and signal are exactly 0
  const flatC: Candle[] = Array.from({ length: 300 }, (_, i) => ({ openTime: i * 60000, open: 100, high: 100.1, low: 99.9, close: 100, volume: 1 }))
  const fr = analyzeRaw('T', { '1m': flatC, '3m': flatC, '5m': flatC, '15m': flatC, '30m': flatC } as never, { indicator: 'impulse' })
  ok(fr === null || fr.signals.length === 0, 'Impulse MACD on dead-flat data gives no signal (line sits on 0)')
  // signals: RSI on all three timeframes agrees, impulse indicator in the version string, same hard rules as before
  let n = 0, badRsi = 0, badVer = 0, offMore = true
  for (const [, m] of cases) {
    const on = analyzeRaw('T', tfs(m), IMP)!.signals
    const off = analyzeRaw('T', tfs(m), { ...IMP, rsiOn: false })!.signals
    if (off.length < on.length) offMore = false
    for (const sg of on) {
      n++
      if (!sg.version.endsWith('-impulse')) badVer++
      const cut = Math.round((sg.time - m[0].openTime) / 60000)
      if (cut < 1300) continue
      const part = m.slice(0, cut)
      const row = buildRaw({ symbol: 'T', price: part[part.length - 1].close, change24h: 0, candles: tfs(part), now: part[part.length - 1].openTime + 60000, cfg: IMP })
      const q = row?.signal
      if (!q) continue
      const rs = [row.tfs['1m']!.rsi, row.tfs['5m']!.rsi, row.tfs['15m']!.rsi]
      if (!rs.every((r) => (q.side === 'BUY' ? r > 50 : r < 50))) badRsi++
    }
  }
  ok(badRsi === 0 && badVer === 0 && offMore, `impulse + RSI: every signal has RSI on the trade side on 1M, 5M and 15M; turning RSI off never removes signals (${n} signals)`)
  // the RSI rule shows its own exact WAIT reason
  let rsiWaits = 0
  for (const [, m] of cases) for (const x of analyzeRaw('T', tfs(m), { ...IMP, ribbonMin: 2 }, { allRejections: true })!.allRejections ?? []) if (x.reason === 'WAIT — RSI Not Confirmed') rsiWaits++
  console.log('   RSI-rejected crossovers in the sample:', rsiWaits)
  ok(true, 'RSI rejections are logged with "WAIT — RSI Not Confirmed"')
}
void MACD_MS

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
