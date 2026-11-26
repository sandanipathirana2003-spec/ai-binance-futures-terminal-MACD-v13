'use client'

import type { Candle } from '@/lib/binance'
import { px, signed } from './macd-ui'

// Small dependency-free SVG charts (no charting library): price + EMA + Supertrend + trade levels, equity curve, P&L bars.

export interface PlanLines {
  side: 'BUY' | 'SELL'
  entry: number
  sl: number
  tp: number
}

export function PriceChart({ candles, ema, stLine, stDir, plan, bars = 90, emaLabel = 'EMA 200' }: { candles: Candle[]; ema: number[]; stLine: number[]; stDir: number[]; plan?: PlanLines | null; bars?: number; emaLabel?: string }) {
  const n = candles.length
  const from = Math.max(0, n - bars)
  const vis = candles.slice(from)
  if (vis.length < 5) return <div className="text-muted-foreground flex h-40 items-center justify-center font-mono text-xs">Not enough candles for a chart.</div>
  const W = 640
  const H = 260
  const padR = 74
  const padY = 10
  let lo = Math.min(...vis.map((c) => c.low))
  let hi = Math.max(...vis.map((c) => c.high))
  const extra = [plan?.entry, plan?.sl, plan?.tp].filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  // keep trade levels visible, but never let a far-away level flatten the candles
  const span = hi - lo || hi * 0.01
  for (const v of extra) if (v > lo - span && v < hi + span) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
  const pad = (hi - lo) * 0.06
  lo -= pad
  hi += pad
  const step = (W - padR) / vis.length
  const x = (i: number) => i * step + step / 2
  const y = (v: number) => padY + ((hi - v) / (hi - lo)) * (H - 2 * padY)
  const line = (arr: number[]) => {
    let d = ''
    let pen = false
    for (let i = 0; i < vis.length; i++) {
      const v = arr[from + i]
      if (!Number.isFinite(v)) { pen = false; continue }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `
      pen = true
    }
    return d
  }
  // Supertrend coloured by direction
  const stSegs: Array<{ d: string; up: boolean }> = []
  let cur: { d: string; up: boolean } | null = null
  for (let i = 0; i < vis.length; i++) {
    const v = stLine[from + i]
    const up = stDir[from + i] === 1
    if (!Number.isFinite(v)) { cur = null; continue }
    if (!cur || cur.up !== up) {
      cur = { d: `M${x(i).toFixed(1)} ${y(v).toFixed(1)} `, up }
      stSegs.push(cur)
    } else cur.d += `L${x(i).toFixed(1)} ${y(v).toFixed(1)} `
  }
  const lvl = (v: number, cls: string, label: string) => (
    <g key={label} className={cls}>
      <line x1={0} x2={W - padR} y1={y(v)} y2={y(v)} stroke="currentColor" strokeWidth={1.2} strokeDasharray="5 4" />
      <text x={W - padR + 4} y={y(v) + 4} fontSize={11} fill="currentColor" fontFamily="monospace" fontWeight={700}>
        {label} {px(v)}
      </text>
    </g>
  )
  const last = vis[vis.length - 1]
  return (
    <div className="min-w-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Price chart with EMA, Supertrend and trade levels">
        {vis.map((c, i) => {
          const up = c.close >= c.open
          return (
            <g key={c.openTime} className={up ? 'text-bull' : 'text-bear'}>
              <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke="currentColor" strokeWidth={1} />
              <rect x={x(i) - step * 0.3} y={Math.min(y(c.open), y(c.close))} width={step * 0.6} height={Math.max(1, Math.abs(y(c.open) - y(c.close)))} fill="currentColor" />
            </g>
          )
        })}
        <path d={line(ema)} fill="none" className="text-primary" stroke="currentColor" strokeWidth={1.6} />
        {stSegs.map((s, i) => (
          <path key={i} d={s.d} fill="none" className={s.up ? 'text-bull' : 'text-bear'} stroke="currentColor" strokeWidth={1.8} strokeOpacity={0.85} />
        ))}
        {plan ? (
          <>
            {lvl(plan.entry, 'text-foreground', 'ENTRY')}
            {lvl(plan.sl, 'text-bear', 'SL')}
            {lvl(plan.tp, 'text-bull', 'TP')}
          </>
        ) : null}
        <text x={W - padR + 4} y={y(last.close) + 4} fontSize={11} fill="currentColor" className="text-muted-foreground" fontFamily="monospace">
          {px(last.close)}
        </text>
      </svg>
      <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 font-mono text-[10px]">
        <span><span className="text-primary">━</span> {emaLabel}</span>
        <span><span className="text-bull">━</span><span className="text-bear">━</span> Supertrend 12,4</span>
        <span>closed candles only · last {vis.length}</span>
      </div>
    </div>
  )
}

export function EquityChart({ values, unit = 'R' }: { values: number[]; unit?: string }) {
  if (values.length < 2) return <div className="text-muted-foreground flex h-32 items-center justify-center font-mono text-xs">The equity curve needs at least two closed trades.</div>
  const W = 640
  const H = 180
  const pad = 8
  const all = [0, ...values]
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const rng = hi - lo || 1
  const x = (i: number) => pad + (i / (values.length - 1)) * (W - 2 * pad - 50)
  const y = (v: number) => pad + ((hi - v) / rng) * (H - 2 * pad)
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  const end = values[values.length - 1]
  const up = end >= 0
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Equity curve">
      <line x1={pad} x2={W - 50} y1={y(0)} y2={y(0)} stroke="currentColor" className="text-border" strokeDasharray="4 4" />
      <path d={`${d} L${x(values.length - 1).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`} fill="currentColor" className={up ? 'text-bull' : 'text-bear'} fillOpacity={0.12} />
      <path d={d} fill="none" stroke="currentColor" className={up ? 'text-bull' : 'text-bear'} strokeWidth={2} />
      <text x={W - 46} y={y(end) + 4} fontSize={12} fill="currentColor" className={up ? 'text-bull' : 'text-bear'} fontFamily="monospace" fontWeight={700}>
        {signed(end, 1)}{unit}
      </text>
    </svg>
  )
}

export function BarsChart({ items, unit = 'R', empty = 'No closed trades yet.' }: { items: Array<{ label: string; value: number }>; unit?: string; empty?: string }) {
  if (items.length === 0) return <div className="text-muted-foreground flex h-24 items-center justify-center font-mono text-xs">{empty}</div>
  const W = 640
  const H = 150
  const pad = 6
  const vals = items.map((i) => i.value)
  const hi = Math.max(0, ...vals)
  const lo = Math.min(0, ...vals)
  const rng = hi - lo || 1
  const step = (W - 2 * pad) / items.length
  const y = (v: number) => pad + ((hi - v) / rng) * (H - 2 * pad - 14)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Profit and loss bars">
      <line x1={pad} x2={W - pad} y1={y(0)} y2={y(0)} stroke="currentColor" className="text-border" />
      {items.map((it, i) => {
        const up = it.value >= 0
        const top = Math.min(y(0), y(it.value))
        return (
          <rect key={it.label} x={pad + i * step + step * 0.12} y={top} width={step * 0.76} height={Math.max(1.5, Math.abs(y(it.value) - y(0)))} fill="currentColor" className={up ? 'text-bull' : 'text-bear'}>
            <title>{`${it.label}: ${signed(it.value, 2)}${unit}`}</title>
          </rect>
        )
      })}
      <text x={pad} y={H - 2} fontSize={10} fill="currentColor" className="text-muted-foreground" fontFamily="monospace">{items[0].label}</text>
      <text x={W - pad} y={H - 2} fontSize={10} textAnchor="end" fill="currentColor" className="text-muted-foreground" fontFamily="monospace">{items[items.length - 1].label}</text>
    </svg>
  )
}
