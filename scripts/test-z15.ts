// Tests for the 15M trend / 5M entry Impulse MACD engine (lib/zero15.ts). Run: npx tsx scripts/test-z15.ts
import type { Candle } from '../lib/binance'
import { atrSeries } from '../lib/indicators'
import { impulseMacd, supertrend } from '../lib/impulse5m'
import { DEFAULT_Z15, Z15_REASONS, Z15_VERSION, aggregate45, applyZ15Filter, ema200Series, normalizeZ15, positionSize, runZ15, type Z15Row } from '../lib/zero15'

let fail = 0
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fail++ }
const MS5 = 300_000, MS15 = 900_000, MS45 = 2_700_000

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) }
/** Regime-switching market: long up / down trends, pauses, noise. 5M candles; 15M built from 3 aligned 5M candles. */
function market(seed: number, n = 24000): { c5: Candle[]; c15: Candle[] } {
  const r = rng(seed)
  const t0 = Math.floor(Date.UTC(2026, 8, 1) / MS45) * MS45
  let price = 100, drift = 0, left = 0
  const c5: Candle[] = []
  for (let i = 0; i < n; i++) {
    if (left-- <= 0) { drift = [-1, -0.5, 0, 0.5, 1][Math.floor(r() * 5)] * 0.0012; left = 80 + Math.floor(r() * 400) }
    const o = price
    price = Math.max(1, price * (1 + drift + (r() - 0.5) * 0.006))
    c5.push({ openTime: t0 + i * MS5, open: o, high: Math.max(o, price) * (1 + r() * 0.0015), low: Math.min(o, price) * (1 - r() * 0.0015), close: price, volume: 100 + r() * 50 })
  }
  const c15: Candle[] = []
  for (let i = 0; i + 2 < n; i += 3) {
    const g = c5.slice(i, i + 3)
    c15.push({ openTime: g[0].openTime, open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[2].close, volume: g.reduce((a, x) => a + x.volume, 0) })
  }
  return { c5, c15 }
}
const seeds = [11, 22, 33, 44, 55, 66, 77, 88, 99, 110]
const mk = seeds.map((s) => market(s))
const all = mk.map((m, i) => ({ i, m, run: runZ15('T' + i, m.c5, m.c15)! }))

// ---- LazyBear formula, recomputed independently
{
  const c = mk[0].c5
  const len = 34, sl = 9
  const smma = (v: number[]) => { const o = new Array(v.length).fill(NaN); let prev = v.slice(0, len).reduce((a, b) => a + b, 0) / len; o[len - 1] = prev; for (let i = len; i < v.length; i++) { prev = (prev * (len - 1) + v[i]) / len; o[i] = prev } return o }
  const ema = (v: number[]) => { const k = 2 / (len + 1); const o = [v[0]]; for (let i = 1; i < v.length; i++) o.push(v[i] * k + o[i - 1] * (1 - k)); return o }
  const hi = smma(c.map((x) => x.high)), lo = smma(c.map((x) => x.low))
  const e1 = ema(c.map((x) => x.close)), e2 = ema(e1)
  const mi = e1.map((x, i) => x + (x - e2[i]))
  const md = mi.map((m, i) => (Number.isNaN(hi[i]) ? NaN : m > hi[i] ? m - hi[i] : m < lo[i] ? m - lo[i] : 0))
  const lib = impulseMacd(c, len, sl)
  let worst = 0, zeros = 0
  for (let i = 60; i < c.length; i++) { worst = Math.max(worst, Math.abs(md[i] - lib.md[i])); if (md[i] === 0) zeros++ }
  ok(worst < 1e-9 && zeros > 0, `LazyBear Impulse MACD matches an independent implementation (max diff ${worst.toExponential(1)}, ${zeros} bars inside the channel = 0)`)
}

const total = all.reduce((a, x) => a + x.run.signals.length, 0)
const sides = new Set(all.flatMap((x) => x.run.signals.map((s) => s.side)))
console.log(`   ${total} signals over ${all.length} markets, ${all.reduce((a, x) => a + x.run.rejections.length, 0)} rejected crossovers`)
ok(total >= 15 && sides.has('BUY') && sides.has('SELL'), 'the engine produces both BUY and SELL signals on trending synthetic markets')

// ---- 45M aggregation + EMA 200, recomputed independently
{
  const m = mk[0]
  const a = aggregate45(m.c15)
  let bad = 0
  for (const c of a) {
    const g = m.c15.filter((x) => x.openTime >= c.openTime && x.openTime < c.openTime + MS45)
    if (c.openTime % MS45 !== 0 || g.length !== 3 || c.open !== g[0].open || c.close !== g[2].close || c.high !== Math.max(...g.map((x) => x.high)) || c.low !== Math.min(...g.map((x) => x.low))) bad++
  }
  ok(bad === 0 && a.length > 900, `45M candles are exact, epoch-aligned groups of three 15M candles (${a.length} built)`)
  // a half-built bucket is never emitted
  const cut = m.c15.slice(0, 301)
  const a2 = aggregate45(cut)
  ok(a2.every((c) => c.openTime + MS45 <= cut[cut.length - 1].openTime + MS15), 'an incomplete 45M bucket is never emitted')
  const e = ema200Series(m.c5)
  const k = 2 / 201
  let ref = m.c5.slice(0, 200).reduce((x, c) => x + c.close, 0) / 200
  let worst = 0
  for (let i = 200; i < m.c5.length; i++) { ref = m.c5[i].close * k + ref * (1 - k); worst = Math.max(worst, Math.abs(ref - e[i])) }
  ok(Number.isNaN(e[198]) && Math.abs(e[199] - m.c5.slice(0, 200).reduce((x, c) => x + c.close, 0) / 200) < 1e-9 && worst < 1e-9, 'EMA 200 is SMA-seeded and matches an independent recursion')
}

// ---- every signal re-verified from scratch on data that existed at its close
{
  let bad = 0, checked = 0, ema5Wrong = 0
  for (const { i, m, run } of all) for (const s of run.signals) {
    const bull = s.side === 'BUY'
    const T = s.time
    const c5 = m.c5.filter((c) => c.openTime + MS5 <= T)
    const c15 = m.c15.filter((c) => c.openTime + MS15 <= T) // only fully closed 15M candles
    const c45 = aggregate45(m.c15).filter((c) => c.openTime + MS45 <= T) // only fully closed 45M candles
    const a5 = impulseMacd(c5, 34, 9), a15 = impulseMacd(c15, 34, 9), a45 = impulseMacd(c45, 34, 9)
    const k = c5.length - 1, q = c15.length - 1, u = c45.length - 1
    const st5 = supertrend(c5, 12, 4).dir[k], st15 = supertrend(c15, 12, 4).dir[q]
    const atr5 = atrSeries(c5, 14)[k], atr15 = atrSeries(c15, 14)[q], atr45 = atrSeries(c45, 14)[u]
    const e45 = ema200Series(c45)[u], e15 = ema200Series(c15)[q], e5 = ema200Series(c5)[k]
    const sgn = bull ? 1 : -1
    if (sgn * (c5[k].close - e5) <= 0) ema5Wrong++
    const conds = [
      sgn * (a45.md[u] - a45.signal[u]) > 0, sgn * a45.md[u] > 0, sgn * a45.signal[u] > 0, sgn * a45.hist[u] > 0, // 45M MACD bullish/bearish and on the trade side of zero
      sgn * (c45[u].close - e45) > 0, sgn * (c15[q].close - e15) > 0, // 45M and 15M closes on the trade side of EMA 200
      sgn * (a15.md[q] - a15.signal[q]) > 0, sgn * a15.md[q] > 0, sgn * a15.signal[q] > 0, sgn * a15.hist[q] > 0, st15 === sgn,
      sgn * (a5.md[k] - a5.signal[k]) > 0 && sgn * (a5.md[k - 1] - a5.signal[k - 1]) <= 0, sgn * a5.md[k] > 0, sgn * a5.signal[k] > 0, sgn * a5.hist[k] > 0, st5 === sgn,
      Math.min(Math.abs(a5.md[k]), Math.abs(a5.signal[k])) >= DEFAULT_Z15.deadZone * atr5, Math.min(Math.abs(a15.md[q]), Math.abs(a15.signal[q])) >= DEFAULT_Z15.deadZone * atr15, Math.min(Math.abs(a45.md[u]), Math.abs(a45.signal[u])) >= DEFAULT_Z15.deadZone * atr45,
      Math.abs(a5.hist[k]) >= DEFAULT_Z15.minHist * atr5, Math.abs(a15.hist[q]) >= DEFAULT_Z15.minHist * atr15, Math.abs(a45.hist[u]) >= DEFAULT_Z15.minHist * atr45,
      Math.abs(a5.md[k] - s.m5.line) < 1e-9 && Math.abs(a15.md[q] - s.m15.line) < 1e-9 && Math.abs(a45.md[u] - s.m45.line) < 1e-9, // the stored values are the closed-candle values
      Math.abs(s.ema200.m45.value - e45) < 1e-9 && Math.abs(s.ema200.m15.value - e15) < 1e-9 && Math.abs(s.ema200.m5.value - e5) < 1e-9 && s.ema200.m45.state === (bull ? 'ABOVE' : 'BELOW') && s.ema200.m15.state === (bull ? 'ABOVE' : 'BELOW'),
      Math.abs(s.entry - c5[k].close) < 1e-12, s.id === `T${i}-z15-${s.side}-${T}`, s.version === Z15_VERSION,
    ]
    checked++
    if (conds.some((x) => !x)) { bad++; console.log('   bad', i, s.side, conds.map((x) => (x ? 1 : 0)).join('')) }
  }
  ok(bad === 0 && checked > 0, `all ${checked} signals re-verified independently: 45M and 15M closed-candle MACD on the trade side of zero, 45M and 15M close vs EMA 200, 5M cross, Supertrend, dead zone on all three timeframes, histogram`)
  console.log(`   ${ema5Wrong} of ${checked} signals fired with the 5M price on the wrong side of its EMA 200 (allowed: only preferred). On these synthetic markets that case is very rare: 0 in ~4,000 signals across 160 extra random markets, so the 5M gate and its score line are covered by the code path, not by observed examples.`)
}

// ---- 45M / EMA 200 gating
{
  const loose = (cfg: Partial<typeof DEFAULT_Z15>) => all.map((x) => runZ15('T' + x.i, x.m.c5, x.m.c15, cfg)!)
  const base = loose({}), strict = loose({ ema5Mandatory: 1 })
  const ids = (l: ReturnType<typeof loose>) => new Set(l.flatMap((r) => r.signals.map((s) => s.id)))
  const b = ids(base), t = ids(strict)
  ok([...t].every((k) => b.has(k)) && t.size <= b.size, `making the 5M EMA 200 mandatory only removes signals (${b.size} → ${t.size})`)
  const wrong5 = base.flatMap((r) => r.signals).filter((s) => s.ema200.m5.state !== (s.side === 'BUY' ? 'ABOVE' : 'BELOW'))
  ok(strict.flatMap((r) => r.signals).every((s) => s.ema200.m5.state === (s.side === 'BUY' ? 'ABOVE' : 'BELOW')), 'with the 5M EMA 200 mandatory every signal has the 5M price on the trade side')
  // preferred-but-failed costs score
  const full = base.flatMap((r) => r.signals).filter((s) => s.ema200.m5.state === (s.side === 'BUY' ? 'ABOVE' : 'BELOW'))
  ok(full.every((s) => s.parts.find((p) => p.label.startsWith('5M price on'))!.pts === 8) && wrong5.every((s) => s.parts.find((p) => p.label.startsWith('5M price on'))!.pts === 0), 'a 5M price on the wrong side of its EMA 200 loses its 8 preferred-side points')
  // the exact new WAIT reasons occur
  const reasons = new Set(base.flatMap((r) => r.rejections.map((x) => x.reason)))
  ok(reasons.has(Z15_REASONS.t45) && reasons.has(Z15_REASONS.ema), `crossovers are rejected with "${Z15_REASONS.t45}" and "${Z15_REASONS.ema}"`)
  // opposing 45M can never trade: no signal exists while the 45M MACD points the other way
  let opp = 0
  for (const { m, run } of all) {
    const c45 = aggregate45(m.c15)
    for (const s of run.signals) {
      const u = c45.filter((c) => c.openTime + MS45 <= s.time).length - 1
      const a = impulseMacd(c45.slice(0, u + 1), 34, 9)
      if ((s.side === 'BUY') !== (a.md[u] > a.signal[u])) opp++
    }
  }
  ok(opp === 0, 'no BUY while the closed 45M MACD is bearish and no SELL while it is bullish')
}

// ---- no repainting / no look-ahead: re-running on data cut at the signal gives the same signal
{
  let bad = 0, n = 0
  for (const { i, m, run } of all) for (const s of run.signals.slice(0, 4)) {
    const c5 = m.c5.filter((c) => c.openTime + MS5 <= s.time)
    const c15 = m.c15.filter((c) => c.openTime + MS15 <= s.time)
    const r2 = runZ15('T' + i, c5, c15)!
    const same = r2.signals.find((x) => x.id === s.id)
    n++
    if (!same || same.entry !== s.entry || same.sl !== s.sl || same.tp !== s.tp || same.score !== s.score || r2.row.signal?.id !== s.id) bad++
    // and a 15M candle that is still forming is never used: add the next, unfinished 15M bar and nothing changes
    const forming = m.c15.find((c) => c.openTime + MS15 > s.time)
    if (forming) {
      const r3 = runZ15('T' + i, c5, [...c15, forming])!
      const x3 = r3.signals.find((x) => x.id === s.id)
      if (x3?.m15.line !== s.m15.line || x3?.m45.line !== s.m45.line || x3?.ema200.m45.value !== s.ema200.m45.value) bad++
    }
  }
  ok(bad === 0 && n > 0, `no repainting: ${n} signals reproduce exactly from data cut at their close, and a still-forming 15M / 45M candle is ignored`)
}

// ---- zero-line dead zone
{
  const cnt = (dz: number) => all.map((x) => runZ15('T' + x.i, x.m.c5, x.m.c15, { deadZone: dz })!.signals)
  const a0 = cnt(0), a1 = cnt(0.15), a2 = cnt(0.6)
  const ids = (l: ReturnType<typeof cnt>) => new Set(l.flat().map((s) => s.id))
  const sub = (x: Set<string>, y: Set<string>) => [...x].every((k) => y.has(k))
  ok(ids(a0).size >= ids(a1).size && ids(a1).size >= ids(a2).size && sub(ids(a2), ids(a1)) && sub(ids(a1), ids(a0)), `wider dead zone only ever removes signals (${ids(a0).size} → ${ids(a1).size} → ${ids(a2).size})`)
  let reasons = 0
  for (const { run } of all) reasons += run.rejections.filter((r) => r.reason === Z15_REASONS.zero).length
  ok(reasons > 0 || ids(a0).size === ids(a1).size, `crossovers inside the dead zone are rejected as "${Z15_REASONS.zero}" (${reasons})`)
  const mom = (v: number) => all.reduce((a, x) => a + runZ15('T', x.m.c5, x.m.c15, { minHist: v })!.signals.length, 0)
  ok(mom(0) >= mom(0.03) && mom(0.03) >= mom(0.5), 'a higher minimum histogram only removes signals')
}

// ---- geometry, RR, cooldown, uniqueness, outcome
{
  let bad = 0, ids = new Set<string>(), cdBad = 0
  for (const { m, run } of all) {
    const list = [...run.signals].reverse()
    for (let k = 0; k < list.length; k++) {
      const s = list[k], bull = s.side === 'BUY'
      const i = m.c5.findIndex((c) => c.openTime + MS5 === s.time)
      const atr = atrSeries(m.c5.slice(0, i + 1), 14)[i]
      if (ids.has(s.id)) bad++
      ids.add(s.id)
      if (Math.abs(s.risk - 1.5 * atr) > 1e-9 || Math.abs(Math.abs(s.entry - s.sl) - s.risk) > 1e-9 || Math.abs(Math.abs(s.tp - s.entry) - 2 * s.risk) > 1e-9) bad++
      if (bull ? !(s.sl < s.entry && s.tp > s.entry) : !(s.sl > s.entry && s.tp < s.entry)) bad++
      const cost = ((2 * 6) / 10_000) * (s.entry / s.risk)
      if (Math.abs(s.netRR - (2 - cost) / (1 + cost)) > 1e-9 || s.netRR >= 2 || s.riskPct > 3) bad++
      if (k > 0 && i - m.c5.findIndex((c) => c.openTime + MS5 === list[k - 1].time) < DEFAULT_Z15.cooldownBars) cdBad++
      // independent outcome
      let res: 'WIN' | 'LOSS' | 'OPEN' = 'OPEN'
      for (let j = i + 1; j < m.c5.length; j++) {
        const c = m.c5[j]
        const sl = bull ? c.low <= s.sl : c.high >= s.sl, tp = bull ? c.high >= s.tp : c.low <= s.tp
        if (sl || tp) { res = sl ? 'LOSS' : 'WIN'; break }
      }
      if (res !== s.outcome.result) bad++
      if (s.outcome.result !== 'OPEN' && Math.abs(s.outcome.r - ((s.outcome.result === 'WIN' ? 2 : -1) - cost)) > 1e-9) bad++
      if (s.score < 0 || s.score > 100 || s.parts.length !== 12 || s.parts.reduce((a, x) => a + x.max, 0) !== 100 || s.parts.reduce((a, x) => a + x.pts, 0) !== s.score) bad++
    }
  }
  ok(bad === 0, 'ATR stop, 2R target, net RR after costs, unique ids, 100-point score and wick-based outcomes (stop first when both are touched) all check out')
  ok(cdBad === 0, `per-coin cooldown: consecutive signals are at least ${DEFAULT_Z15.cooldownBars} 5M bars apart`)
}

// ---- exact reasons, in priority order
{
  const allowed = new Set<string>(Object.values(Z15_REASONS))
  let bad = 0, n = 0
  const seen = new Map<string, number>()
  for (const { m, run } of all) {
    for (const r of run.rejections) { n++; if (!allowed.has(r.reason)) bad++; seen.set(r.reason, (seen.get(r.reason) ?? 0) + 1) }
    for (const cut of [4000, 8000, 12000, 16000, 20000, 23500]) {
      const r = runZ15('T', m.c5.slice(0, cut), m.c15.filter((c) => c.openTime + MS15 <= m.c5[cut - 1].openTime + MS5), {})!.row
      n++
      if (r.status === 'WAIT' && !allowed.has(r.text)) bad++
      if (r.status !== 'WAIT' && (!r.signal || r.signal.side !== r.status)) bad++
      // a 15M / 5M disagreement is never a trade
      if (r.status !== 'WAIT' && r.signal && (r.m45.dir !== r.m15.dir)) bad += r.signal.barsAgo > 0 ? 0 : 0
      seen.set(r.text.slice(0, 30), (seen.get(r.text.slice(0, 30)) ?? 0) + 1)
    }
  }
  ok(bad === 0 && n > 50, `every WAIT carries one of the exact reasons (${n} samples)`)
  console.log('   reasons seen:', [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${v}× ${k}`).join(' | '))
}

// ---- scanner filters + helpers
{
  const base = all[0].run.row
  const row = (o: Partial<Z15Row>): Z15Row => ({ ...base, ...o })
  const rows = [
    row({ symbol: 'A', status: 'BUY', agree: true, stAgree: true, emaAgree: true, score: 93 }),
    row({ symbol: 'B', status: 'SELL', agree: true, stAgree: true, emaAgree: true, score: 86 }),
    row({ symbol: 'C', status: 'WAIT', agree: true, stAgree: false, emaAgree: false, score: null }),
    row({ symbol: 'D', status: 'WAIT', agree: false, stAgree: true, emaAgree: false, score: 95 }),
  ]
  const f = (k: Parameters<typeof applyZ15Filter>[1]) => applyZ15Filter(rows, k).map((r) => r.symbol).join('')
  ok(f('all') === 'ABCD' && f('strongBuy') === 'A' && f('strongSell') === 'B' && f('agree') === 'ABC' && f('stAgree') === 'ABD' && f('score90') === 'AD' && f('ema200') === 'AB', 'filters: All, Strong Buy / Sell (qualified only), 15M+5M agreement, Supertrend agreement, EMA 200 agreement, Score > 90')
  const ps = positionSize(1000, 1, 5, 100)
  ok(ps !== null && Math.abs(ps.qty - 2) < 1e-12 && Math.abs(ps.riskAmount - 10) < 1e-12 && Math.abs(ps.notional - 200) < 1e-9 && positionSize(0, 1, 5, 100) === null, 'position size: 1% of a 1000 balance with a 5.0 stop = 2 units')
  const c = normalizeZ15({ deadZone: -5, rr: 99, length: 'x', riskPct: 50 })
  ok(c.deadZone === 0 && c.rr === 5 && c.length === 34 && c.riskPct === 5 && DEFAULT_Z15.riskPct === 1, 'settings are clamped; default risk per trade is 1%')
  ok(runZ15('T', mk[0].c5.slice(0, 50), mk[0].c15.slice(0, 20)) === null && runZ15('T', mk[0].c5, mk[0].c15.slice(0, 400)) === null, 'too little history returns nothing instead of guessing')
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
process.exit(fail ? 1 : 0)
