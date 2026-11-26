'use client'

import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { DEFAULT_Z15, Z15_VERSION, applyZ15Filter, positionSize, type Dir, type EmaStatus, type Z15Config, type Z15Filter, type Z15Row, type Z15Signal } from '@/lib/zero15'
import type { Z15Response } from '@/app/api/z15/route'
import type { Z15Alerts, Z15Popup } from '@/hooks/use-z15-alerts'
import { Chip, Pill, Row, Section, TONE, clock, coinName, dirTone, px, small, when, type Tone } from './macd-ui'

const FILTERS: Array<{ key: Z15Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'strongBuy', label: 'Strong Buy' },
  { key: 'strongSell', label: 'Strong Sell' },
  { key: 'agree', label: '15M + 5M Agreement' },
  { key: 'stAgree', label: 'Supertrend Agreement' },
  { key: 'ema200', label: 'EMA 200 Agreement (45M·15M·5M)' },
  { key: 'score90', label: 'Score > 90' },
]

const dirTxt = (d: Dir | 'BULLISH' | 'BEARISH') => d
const zeroTone = (z: Z15Row['zero']): Tone => (z === 'CLEAR' ? 'bull' : 'warn')
const emaTone = (e: EmaStatus): Tone => (e.state === 'ABOVE' ? 'bull' : e.state === 'BELOW' ? 'bear' : 'muted')
const sigTone = (s: Z15Row['status']): Tone => (s === 'BUY' ? 'bull' : s === 'SELL' ? 'bear' : 'muted')

// ---------------------------------------------------------------- popup
export function Z15Popups({ popups, onDismiss, onOpen }: { popups: Z15Popup[]; onDismiss: (id: string) => void; onOpen: (symbol: string) => void }) {
  const top = popups[0]
  if (!top) return null
  const s = top.signal
  const bull = s.side === 'BUY'
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-50 flex justify-center px-2">
      <div role="alert" className={cn('pointer-events-auto w-full max-w-md rounded-xl border-2 p-3 shadow-xl backdrop-blur', TONE[bull ? 'bull' : 'bear'], 'bg-background/95')}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-mono text-lg font-extrabold">
              {s.side} — {coinName(s.symbol)}
            </div>
            <div className="text-muted-foreground font-mono text-[10px]">5M candle closed {when(s.time)} · quality {s.score}/100</div>
          </div>
          {popups.length > 1 ? <Chip tone="muted">+{popups.length - 1} more</Chip> : null}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-3">
          <Row k="Entry" v={px(s.entry)} />
          <Row k="Stop loss" v={px(s.sl)} cls="text-bear" />
          <Row k="Take profit" v={px(s.tp)} cls="text-bull" />
          <Row k="Risk : reward" v={`1 : ${s.rr} (net ${s.netRR.toFixed(2)})`} />
          <Row k="45M · 15M trend" v={bull ? 'BULLISH' : 'BEARISH'} />
          <Row k="EMA 200 45M·15M·5M" v={`${s.ema200.m45.state} · ${s.ema200.m15.state} · ${s.ema200.m5.state}`} />
          <Row k="5M cross" v="confirmed" />
          <Row k="Supertrend" v={`15M ${s.stBull15 === bull ? '✓' : '✗'} · 5M ${s.stBull5 === bull ? '✓' : '✗'}`} />
          <Row k="Hist 15M·5M" v={`${small(s.m15.hist)} · ${small(s.m5.hist)}`} />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => { onOpen(s.symbol); onDismiss(top.id) }} className="border-border h-11 rounded-md border font-mono text-xs font-bold">
            Open setup
          </button>
          <button type="button" onClick={() => onDismiss(top.id)} className="border-border h-11 rounded-md border font-mono text-xs font-bold">
            Dismiss
          </button>
        </div>
        <p className="text-muted-foreground mt-1 font-mono text-[10px]">Signal only — nothing is traded automatically. Not a prediction.</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- scanner
function Cell({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <Pill tone={tone}>{children}</Pill>
}

function ScannerTable({ rows, selected, onPick }: { rows: Z15Row[]; selected: string; onPick: (s: string) => void }) {
  if (!rows.length) return <p className="text-muted-foreground font-mono text-xs">No coins match this filter.</p>
  return (
    <>
      <div className="border-border hidden overflow-hidden rounded-lg border md:block">
        <div className="bg-muted text-muted-foreground grid grid-cols-[1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1.1fr] gap-1.5 px-3 py-2 font-mono text-[9px] font-bold uppercase">
          <span>Coin</span>
          <span>45M IMACD</span>
          <span>15M IMACD</span>
          <span>5M IMACD</span>
          <span>15M Supertrend</span>
          <span>5M Supertrend</span>
          <span>EMA200 45M</span>
          <span>EMA200 15M</span>
          <span>EMA200 5M</span>
          <span>Zero filter</span>
          <span>Signal</span>
        </div>
        {rows.map((r) => (
          <button key={r.symbol} type="button" onClick={() => onPick(r.symbol)} className={cn('border-border/60 grid min-h-11 w-full grid-cols-[1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1.1fr] items-center gap-1.5 border-t px-3 py-2 text-left font-mono text-[10px]', selected === r.symbol ? 'bg-primary/10' : '')}>
            <span className="font-bold">{coinName(r.symbol)}</span>
            <Cell tone={dirTone(r.m45.dir)}>{dirTxt(r.m45.dir)}</Cell>
            <Cell tone={dirTone(r.m15.dir)}>{dirTxt(r.m15.dir)}</Cell>
            <Cell tone={dirTone(r.m5.dir)}>{dirTxt(r.m5.dir)}</Cell>
            <Cell tone={dirTone(r.st15)}>{r.st15}</Cell>
            <Cell tone={dirTone(r.st5)}>{r.st5}</Cell>
            <Cell tone={emaTone(r.ema200.m45)}>{r.ema200.m45.state}</Cell>
            <Cell tone={emaTone(r.ema200.m15)}>{r.ema200.m15.state}</Cell>
            <Cell tone={emaTone(r.ema200.m5)}>{r.ema200.m5.state}</Cell>
            <Cell tone={zeroTone(r.zero)}>{r.zero === 'CLEAR' ? 'CLEAR' : r.zero === 'NEAR ZERO' ? 'NEAR ZERO' : 'OPPOSITE'}</Cell>
            <Cell tone={sigTone(r.status)}>{r.status}</Cell>
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2 md:hidden">
        {rows.map((r) => (
          <button key={r.symbol} type="button" onClick={() => onPick(r.symbol)} className={cn('flex min-h-11 flex-col gap-2 rounded-lg border-2 p-3 text-left', TONE[sigTone(r.status)], selected === r.symbol ? 'ring-primary ring-2' : '')}>
            <div className="flex items-center justify-between">
              <span className="font-mono text-base font-extrabold">{coinName(r.symbol)}</span>
              <span className="font-mono text-lg font-extrabold">{r.status}</span>
            </div>
            <div className="grid grid-cols-2 gap-1">
              <Row k="45M IMACD" v={r.m45.dir} />
              <Row k="15M IMACD" v={r.m15.dir} />
              <Row k="5M IMACD" v={r.m5.dir} />
              <Row k="15M Supertrend" v={r.st15} />
              <Row k="5M Supertrend" v={r.st5} />
              <Row k="EMA200 45M" v={r.ema200.m45.state} />
              <Row k="EMA200 15M" v={r.ema200.m15.state} />
              <Row k="EMA200 5M" v={r.ema200.m5.state} />
              <Row k="Zero filter" v={r.zero} />
              <Row k="Score" v={r.score === null ? '—' : `${r.score}`} />
            </div>
          </button>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- detail
function Detail({ r, config }: { r: Z15Row; config: Z15Config }) {
  const [balance, setBalance] = useState('')
  useEffect(() => {
    try {
      setBalance(window.localStorage.getItem('z15-balance') ?? '')
    } catch {
      // storage unavailable
    }
  }, [])
  const s: Z15Signal | null = r.signal
  const size = s ? positionSize(Number(balance), config.riskPct, s.risk, s.entry) : null
  return (
    <Section title={`${coinName(r.symbol)} — ${r.status === 'WAIT' ? r.text : `${r.status} confirmed`}`}>
      <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2 lg:grid-cols-3">
        <Row k="Price" v={px(r.price)} />
        <Row k="45M line / signal" v={`${small(r.m45.line)} / ${small(r.m45.signal)}`} />
        <Row k="15M line / signal" v={`${small(r.m15.line)} / ${small(r.m15.signal)}`} />
        <Row k="5M line / signal" v={`${small(r.m5.line)} / ${small(r.m5.signal)}`} />
        <Row k="Hist 45M / 15M / 5M" v={`${small(r.m45.hist)} / ${small(r.m15.hist)} / ${small(r.m5.hist)}`} />
      </div>
      <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-3">
        {([['45M', r.ema200.m45], ['15M', r.ema200.m15], ['5M', r.ema200.m5]] as Array<[string, EmaStatus]>).map(([tf, e]) => (
          <Row key={tf} k={`EMA 200 ${tf}`} v={Number.isFinite(e.value) ? `${e.state} · ${px(e.value)} (${e.distPct >= 0 ? '+' : ''}${e.distPct.toFixed(2)}%)` : 'n/a'} cls={e.state === 'ABOVE' ? 'text-bull' : e.state === 'BELOW' ? 'text-bear' : ''} />
        ))}
      </div>
      {s ? (
        <>
          <div className="grid grid-cols-2 gap-x-3 sm:grid-cols-4">
            <Row k="Entry" v={px(s.entry)} />
            <Row k="Stop loss" v={px(s.sl)} cls="text-bear" />
            <Row k="Take profit" v={px(s.tp)} cls="text-bull" />
            <Row k="Risk" v={`${s.riskPct.toFixed(2)}% of price`} />
            <Row k="Risk : reward" v={`1 : ${s.rr} (net ${s.netRR.toFixed(2)})`} />
            <Row k="Quality" v={`${s.score}/100`} />
            <Row k="Hist expanding" v={s.histExpanding ? 'yes' : 'no'} />
            <Row k="Signal candle closed" v={clock(s.time)} />
          </div>
          <label className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
            Account balance (USDT) for the size hint
            <input type="number" inputMode="decimal" min={0} value={balance} onChange={(e) => { setBalance(e.target.value); try { window.localStorage.setItem('z15-balance', e.target.value) } catch { /* ignore */ } }} className="border-border bg-background h-11 w-32 rounded-md border px-3" />
          </label>
          <p className="font-mono text-[11px]">{size ? `Risking ${config.riskPct}% (${size.riskAmount.toFixed(2)} USDT) means about ${size.qty.toPrecision(4)} units (${size.notional.toFixed(2)} USDT notional) at this stop. A hint only.` : `Risk per trade is ${config.riskPct}% of your balance; enter a balance for a size hint.`}</p>
          <details>
            <summary className="min-h-11 cursor-pointer py-2 font-mono text-xs font-bold">Quality score breakdown</summary>
            <ul className="font-mono text-[11px]">
              {s.parts.map((p) => (
                <li key={p.label} className="flex justify-between gap-2">
                  <span>{p.label}</span>
                  <span className="font-bold">{p.pts}/{p.max}</span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground font-mono text-[10px]">The score rates setup quality. It is not a win probability.</p>
          </details>
        </>
      ) : null}
      <ul className="divide-border/60 divide-y">
        {r.checks.map((c, k) => (
          <li key={`${c.key}-${k}`} className="flex items-start gap-2 py-1.5 font-mono text-[11px]">
            <span className={c.ok ? 'text-bull' : 'text-bear'}>{c.ok ? '✓' : '✗'}</span>
            <span className="min-w-0">
              <span className="font-bold">{c.label}</span>
              <span className="text-muted-foreground block break-words">{c.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

// ---------------------------------------------------------------- tab
type NumKey = Exclude<keyof Z15Config, never>
const FIELDS: Array<{ key: NumKey; label: string; step: number; hint?: string }> = [
  { key: 'length', label: 'Impulse MACD length', step: 1 },
  { key: 'signal', label: 'Signal length', step: 1 },
  { key: 'stPeriod', label: 'Supertrend ATR period', step: 1 },
  { key: 'stMult', label: 'Supertrend multiplier', step: 0.5 },
  { key: 'deadZone', label: 'Zero-line dead zone (ATR)', step: 0.05, hint: 'Both lines must be at least this many ATRs away from zero, on 45M, 15M and 5M. 0 = off.' },
  { key: 'minHist', label: 'Minimum histogram (ATR)', step: 0.01, hint: 'Weaker momentum is rejected.' },
  { key: 'atrSl', label: 'Stop loss (× 5M ATR)', step: 0.1 },
  { key: 'rr', label: 'Take profit (R multiple)', step: 0.5 },
  { key: 'maxRiskPct', label: 'Reject stops wider than (% of price)', step: 0.1 },
  { key: 'cooldownBars', label: 'Cooldown per coin (5M bars)', step: 1, hint: '3 bars = 15 minutes.' },
  { key: 'freshBars', label: 'Signal stays "fresh" for (5M bars)', step: 1 },
  { key: 'feeBps', label: 'Fee (bps per side)', step: 1 },
  { key: 'slipBps', label: 'Slippage (bps per side)', step: 1 },
  { key: 'riskPct', label: 'Risk per trade (% of balance)', step: 0.1, hint: 'Default 1%. Used for the size hint only.' },
  { key: 'ema5Mandatory', label: '5M EMA 200 mandatory (0 = preferred, 1 = mandatory)', step: 1, hint: '45M and 15M EMA 200 are always mandatory. The 5M EMA 200 is preferred and scored by default.' },
]

export interface Z15PanelProps {
  data: Z15Response | undefined
  isLoading: boolean
  isError: boolean
  config: Z15Config
  onConfig: (c: Partial<Z15Config>) => void
  alerts: Z15Alerts
  focusOn: boolean
}

export function Z15Tab({ data, isLoading, isError, config, onConfig, alerts, focusOn }: Z15PanelProps) {
  const [filter, setFilter] = useState<Z15Filter>('all')
  const [sel, setSel] = useState('')
  const [draft, setDraft] = useState<Z15Config>(config)
  useEffect(() => setDraft(config), [config])
  const rows = useMemo(() => data?.rows ?? [], [data])
  const shown = useMemo(() => applyZ15Filter(rows, filter), [rows, filter])
  const row = rows.find((r) => r.symbol === sel) ?? shown[0] ?? rows[0]
  const rejected = useMemo(() => rows.flatMap((r) => r.rejections).sort((a, b) => b.time - a.time).slice(0, 25), [rows])
  const counts = { buy: rows.filter((r) => r.status === 'BUY').length, sell: rows.filter((r) => r.status === 'SELL').length }

  return (
    <div className="flex flex-col gap-3">
      <Section title="45M + 15M trend / 5M entry — Impulse MACD + EMA 200 + Supertrend + zero-line filter">
        <p className="text-muted-foreground font-mono text-[11px] leading-snug">
          A BUY needs all of this on closed candles: 45M and 15M Impulse MACD above their signal with both lines above zero and positive histogram; the 45M and 15M closes above their EMA 200; 15M Supertrend 12,4 bullish; a fresh 5M cross above the signal with both lines above zero, positive histogram and bullish Supertrend; and all three timeframes clear of the zero-line dead zone with enough momentum. The 5M price should also be above its EMA 200 (scored, mandatory only if you switch it on). SELL is the mirror image. 45M candles are built from three closed 15M candles because Binance has no 45M interval. Strategy {Z15_VERSION}. SAFE MODE · SIGNALS ONLY.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={counts.buy ? 'bull' : 'muted'}>{counts.buy} BUY</Chip>
          <Chip tone={counts.sell ? 'bear' : 'muted'}>{counts.sell} SELL</Chip>
          {focusOn ? <Chip tone="primary">Focus: {rows.length} coins</Chip> : <Chip tone="muted">{rows.length} coins</Chip>}
          {data?.computedAt ? <span className="text-muted-foreground font-mono text-[10px]">updated {clock(data.computedAt)}</span> : null}
        </div>
      </Section>

      {isLoading && !data ? <div className="text-muted-foreground p-6 text-center font-mono text-sm">Loading 5M / 15M / 45M candles…</div> : null}
      {data && !data.live ? <div className="border-bear/30 bg-bear/10 text-bear rounded-lg border p-3 font-mono text-xs">Binance data is unavailable{data.error ? `: ${data.error}` : ''}. No signals are shown rather than guessed.</div> : null}
      {isError && !data ? <div className="border-bear/30 bg-bear/10 text-bear rounded-lg border p-3 font-mono text-xs">Could not load the scanner.</div> : null}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" onClick={() => setFilter(f.key)} className={cn('min-h-11 rounded-md border px-3 font-mono text-[11px] font-bold', filter === f.key ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground')}>
            {f.label}
          </button>
        ))}
      </div>
      <ScannerTable rows={shown} selected={row?.symbol ?? ''} onPick={setSel} />
      {filter === 'strongBuy' || filter === 'strongSell' ? <p className="text-muted-foreground font-mono text-[10px]">Only fully qualified signals appear here.</p> : null}

      {row ? <Detail r={row} config={config} /> : null}

      <Section title={`Alert history (${alerts.log.length})`}>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={alerts.toggleSound} className="border-border min-h-11 rounded-md border px-3 font-mono text-xs font-bold">
            Sound {alerts.sound ? 'ON' : 'OFF'}
          </button>
          <button type="button" onClick={alerts.togglePopup} className="border-border min-h-11 rounded-md border px-3 font-mono text-xs font-bold">
            Popup {alerts.popupOn ? 'ON' : 'OFF'}
          </button>
          <button type="button" onClick={() => { try { void Notification.requestPermission() } catch { /* unsupported */ } }} className="border-border min-h-11 rounded-md border px-3 font-mono text-xs font-bold">
            Enable notifications
          </button>
          <span className="text-muted-foreground font-mono text-[10px]">One alert per confirmed 5M crossover, never while a candle is forming. Alerts need this page (or the installed app) to be open.</span>
        </div>
        {alerts.log.length === 0 ? (
          <p className="text-muted-foreground font-mono text-xs">No alerts yet.</p>
        ) : (
          <ul className="divide-border/60 divide-y">
            {alerts.log.slice(0, 30).map((l) => (
              <li key={l.id} className="flex justify-between gap-2 py-1.5 font-mono text-[11px]">
                <span><span className={l.side === 'BUY' ? 'text-bull font-bold' : 'text-bear font-bold'}>{l.side}</span> {coinName(l.symbol)} · {when(l.time)}</span>
                <span className="text-right">{px(l.entry)} · q{l.score}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Why 5M crossovers were rejected (${rejected.length})`}>
        {rejected.length === 0 ? (
          <p className="text-muted-foreground font-mono text-xs">None in the loaded window.</p>
        ) : (
          <ul className="divide-border/60 divide-y">
            {rejected.map((x) => (
              <li key={x.id} className="flex justify-between gap-2 py-1.5 font-mono text-[11px]">
                <span><span className={x.side === 'BUY' ? 'text-bull font-bold' : 'text-bear font-bold'}>{x.side}</span> {coinName(x.symbol)} · {when(x.time)}</span>
                <span className="text-warn text-right font-bold">{x.reason.replace('WAIT / NO TRADE — ', '')}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Settings">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 font-mono text-[11px]">
              <span className="text-muted-foreground">{f.label}</span>
              <input type="number" inputMode="decimal" step={f.step} value={draft[f.key]} onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })} className="border-border bg-background h-11 rounded-md border px-3 text-sm" />
              {f.hint ? <span className="text-muted-foreground text-[10px]">{f.hint}</span> : null}
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => onConfig(draft)} className="border-primary bg-primary/15 text-primary h-11 rounded-md border px-4 font-mono text-xs font-bold">
            Save settings
          </button>
          <button type="button" onClick={() => onConfig(DEFAULT_Z15)} className="border-border h-11 rounded-md border px-4 font-mono text-xs font-bold">
            Reset to defaults
          </button>
        </div>
        <p className="text-muted-foreground font-mono text-[10px]">Past performance does not guarantee future results. Nothing here is financial advice, and no signal is a prediction.</p>
      </Section>
    </div>
  )
}
