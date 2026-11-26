'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatPct } from '@/lib/format'
import { MACD_LABEL, MACD_MS, tfList, type CheckItem, type MacdConfig, type MacdRow, type MacdTf, type ScorePart, type TfView, type TradePlan } from '@/lib/macdmtf'
import type { Side } from '@/lib/impulse5m'
import type { MacdResponse } from '@/app/api/macd/route'
import type { MacdAlerts } from '@/hooks/use-macd-alerts'
import { useLivePrice } from '@/hooks/use-live-price'
import { AlertsTab } from './macd-alerts'
import { BacktestTab, PerformanceTab } from './macd-perf'
import { FocusTab, type FocusApi } from './focus-panel'
import { Z15Tab, type Z15PanelProps } from './z15-panel'
import { SettingsTab } from './macd-settings'
import { Chip, Pill, Row, Section, TONE, clock, coinName, dirTone, mmss, px, signed, small, useNow, when, type Tone } from './macd-ui'

type Sub = 'focus' | 'z15' | 'dashboard' | 'scanner' | 'alerts' | 'active' | 'performance' | 'backtest' | 'settings'
const SUBS: Array<{ key: Sub; label: string }> = [
  { key: 'focus', label: '5-Coin Focus' },
  { key: 'z15', label: '45M·15M·5M EMA200' },
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'scanner', label: 'Precision Scanner' },
  { key: 'alerts', label: 'Precision Alerts' },
  { key: 'active', label: 'Active Trades' },
  { key: 'performance', label: 'Performance' },
  { key: 'backtest', label: 'Backtesting' },
  { key: 'settings', label: 'Settings' },
]

function stateTone(r: MacdRow): Tone {
  const s = r.status.state
  if (s === 'CONFIRMED BUY') return 'bull'
  if (s === 'CONFIRMED SELL') return 'bear'
  if (s === 'EARLY BUY') return 'bull'
  if (s === 'EARLY SELL') return 'bear'
  return r.status.blocker ? 'warn' : 'muted'
}

/** Short label for lists. */
function shortStatus(r: MacdRow): string {
  const s = r.status.state
  if (s !== 'WAIT') return s
  if (r.agreement.side) return r.status.blocker ? 'WAIT — BLOCKED' : `ALL ${r.agreement.side === 'BUY' ? 'BULLISH' : 'BEARISH'}`
  return `WAIT ${Math.max(r.agreement.bull, r.agreement.bear)}/${r.agreement.total}`
}

// ------------------------------------------------------------------ MACD timeframe card

const ROLE: Partial<Record<MacdTf, string>> = { '1m': 'ENTRY', '3m': 'EARLY MOMENTUM', '5m': 'TREND', '15m': 'HTF FILTER' }

function TfCard({ t }: { t: TfView }) {
  const tone: Tone = dirTone(t.dir)
  const crossText = t.cross ? `${t.cross.type} CROSS CONFIRMED · ${t.cross.barsAgo === 0 ? 'this candle' : `${t.cross.barsAgo} bar${t.cross.barsAgo === 1 ? '' : 's'} ago`}` : 'no recent crossover'
  return (
    <div className={cn('min-w-0 rounded-lg border p-2', TONE[tone])}>
      <div className="flex items-center justify-between gap-1">
        <span className="font-mono text-sm font-extrabold">{MACD_LABEL[t.tf]} MACD</span>
        <span className="font-mono text-xs font-extrabold">{t.dir === 'BUY' ? 'BULLISH ↑' : t.dir === 'SELL' ? 'BEARISH ↓' : 'NEUTRAL'}</span>
      </div>
      <div className="text-foreground mt-1 font-mono text-[10px] leading-snug">
        <div className="opacity-80">{ROLE[t.tf] ?? 'OPTIONAL: must not strongly oppose'}</div>
        <div>
          Blue {small(t.line)} · Signal {small(t.signal)}
        </div>
        <div>
          Hist {small(t.hist)} · {t.momentum.toLowerCase()}{Number.isFinite(t.rsi) ? ` · RSI ${t.rsi.toFixed(1)}` : ''}
        </div>
        <div>{crossText}</div>
        <div className="opacity-80">
          {t.zero.toLowerCase()} zero · line {t.moving.toLowerCase()}
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ trade plan

function PlanCard({ side, entry, plan, price, now, time, preview }: { side: Side; entry: number; plan: TradePlan; price: number; now: number; time?: number; preview?: boolean }) {
  const bull = side === 'BUY'
  const ms = MACD_MS['1m']
  return (
    <div className={cn('rounded-lg border-2 p-3', preview ? 'border-border bg-card' : bull ? 'border-bull bg-bull/10' : 'border-bear bg-bear/10')}>
      {preview ? <div className="text-warn mb-1 font-mono text-[10px] font-bold uppercase">Preview only — this is where the trade would sit if a fresh 1M crossover confirms now. Not a signal.</div> : null}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-muted-foreground font-mono text-[10px] uppercase">Entry {preview ? '(last close)' : '(signal price)'}</div>
          <div className="font-mono text-base font-extrabold sm:text-xl">{px(entry)}</div>
        </div>
        <div>
          <div className="text-bear font-mono text-[10px] uppercase">Stop loss</div>
          <div className="text-bear font-mono text-base font-extrabold sm:text-xl">{px(plan.sl)}</div>
        </div>
        <div>
          <div className="text-bull font-mono text-[10px] uppercase">Take profit</div>
          <div className="text-bull font-mono text-base font-extrabold sm:text-xl">{px(plan.tp)}</div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 sm:grid-cols-3">
        <Row k="Risk" v={`${px(plan.risk)} (${plan.riskPct.toFixed(2)}%)`} />
        <Row k="Reward" v={`${px(plan.reward)} (${plan.rewardPct.toFixed(2)}%)`} />
        <Row k="Risk : reward" v={`1 : 2 (net ${plan.netRR.toFixed(2)})`} />
        <Row k="Live price" v={px(price)} />
        <Row k="Fees + slippage" v={`≈ ${plan.costR.toFixed(2)}R`} />
        <Row k="Next 1M candle" v={mmss(ms - (now % ms))} />
      </div>
      <div className="text-muted-foreground mt-1 font-mono text-[10px] leading-snug">
        Stop = beyond the 1M swing {bull ? 'low' : 'high'} ({px(plan.swing)}) plus an ATR buffer, checked against the 5M Supertrend. {time ? `Candle closed ${when(time)}. ` : ''}Entry is the 1M candle close, not an executed fill: check the live price and slippage before ordering.
      </div>
    </div>
  )
}

function ScoreCard({ score, parts, min }: { score: number; parts: ScorePart[]; min: number }) {
  const pass = score >= min
  return (
    <Section title="Signal quality">
      <div className="flex items-baseline justify-between gap-2">
        <div className={cn('font-mono text-3xl font-extrabold', pass ? 'text-bull' : 'text-warn')}>
          {score}
          <span className="text-muted-foreground text-base font-bold"> / 100</span>
        </div>
        <div className="text-muted-foreground text-right font-mono text-[10px] leading-snug">
          minimum {min} for an alert
          <br />
          setup quality, not a win probability
        </div>
      </div>
      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {parts.map((p) => (
          <div key={p.label} className="min-w-0">
            <div className="flex justify-between font-mono text-[10px]">
              <span className="text-muted-foreground truncate">{p.label}</span>
              <span className="font-bold">
                {p.pts}/{p.max}
              </span>
            </div>
            <div className="bg-secondary h-1.5 overflow-hidden rounded">
              <div className={cn('h-full', p.pts / p.max >= 0.7 ? 'bg-bull' : p.pts / p.max >= 0.4 ? 'bg-warn' : 'bg-bear')} style={{ width: `${(p.pts / p.max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

function Checklist({ checks, side }: { checks: CheckItem[]; side: Side | null }) {
  return (
    <Section title="Entry checklist (priority order)">
      {checks.length === 0 ? (
        <p className="text-muted-foreground font-mono text-xs">15M and 5M MACD do not point the same way, so nothing further is evaluated. WAIT — NO TRADE.</p>
      ) : (
        <ul className="divide-border/60 divide-y">
          {checks.map((c, i) => (
            <li key={c.key} className="flex items-start gap-2 py-1.5">
              <span className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-extrabold', c.ok ? 'bg-bull/20 text-bull' : 'bg-bear/20 text-bear')}>{c.ok ? '✓' : '✗'}</span>
              <span className="min-w-0">
                <span className="block text-xs font-bold">
                  {i + 1}. {c.label}
                </span>
                <span className="text-muted-foreground block font-mono text-[10px] leading-snug">{c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {side ? <p className="text-muted-foreground font-mono text-[10px]">Checked for a {side === 'BUY' ? 'long' : 'short'} because the 15M and 5M MACD both point that way.</p> : null}
    </Section>
  )
}

// ------------------------------------------------------------------ pair list (used by the dashboard and the scanner)

type Filter = 'ALL' | 'CONFIRMED' | 'EARLY' | 'BULL' | 'BEAR'
const rank = (r: MacdRow) => (r.signal ? 4 : r.status.state.startsWith('EARLY') ? 3 : r.agreement.side ? 2 : Math.max(r.agreement.bull, r.agreement.bear) >= r.agreement.total - 1 ? 1 : 0)

function PairList({ rows, selected, onPick, compact }: { rows: MacdRow[]; selected: string; onPick: (s: string) => void; compact?: boolean }) {
  const [filter, setFilter] = useState<Filter>('ALL')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(compact ? 12 : 25)
  const list = useMemo(() => {
    const t = q.trim().toUpperCase()
    return rows
      .filter((r) => (t ? r.symbol.includes(t) : true))
      .filter((r) =>
        filter === 'CONFIRMED' ? r.signal : filter === 'EARLY' ? r.status.state.startsWith('EARLY') : filter === 'BULL' ? r.agreement.side === 'BUY' : filter === 'BEAR' ? r.agreement.side === 'SELL' : true,
      )
      .sort((a, b) => rank(b) - rank(a) || a.symbol.localeCompare(b.symbol))
  }, [rows, filter, q])
  useEffect(() => setLimit(compact ? 12 : 25), [filter, q, compact])
  return (
    <section className="border-border bg-card flex min-w-0 flex-col gap-2 rounded-xl border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold">{compact ? 'Live coin scanner' : 'Precision scanner'} ({list.length})</h3>
        <label className="border-border bg-background flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2 sm:max-w-48">
          <Search className="text-muted-foreground size-3.5 shrink-0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pair" className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none" />
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(['ALL', 'CONFIRMED', 'EARLY', 'BULL', 'BEAR'] as Filter[]).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} className={cn('h-8 rounded-md border px-2.5 font-mono text-[11px] font-semibold', filter === f ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground')}>
            {f === 'BULL' ? 'ALL BULLISH' : f === 'BEAR' ? 'ALL BEARISH' : f}
          </button>
        ))}
      </div>
      <ul className="divide-border/60 divide-y">
        {list.slice(0, limit).map((r) => (
          <li key={r.symbol}>
            <button type="button" onClick={() => onPick(r.symbol)} className={cn('flex min-h-11 w-full flex-col gap-1.5 px-1 py-2 text-left', r.symbol === selected && 'bg-accent/40')}>
              <span className="flex items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-mono text-sm font-bold">{coinName(r.symbol)}</span>{' '}
                  <span className="text-muted-foreground font-mono text-[10px]">
                    ${px(r.price)} <span className={r.change24h >= 0 ? 'text-bull' : 'text-bear'}>{formatPct(r.change24h)}</span>
                  </span>
                </span>
                <Chip tone={stateTone(r)}>{shortStatus(r)}</Chip>
              </span>
              <span className="grid gap-1" style={{ gridTemplateColumns: `repeat(${tfList(r).length}, minmax(0, 1fr))` }}>
                {tfList(r).map((t) => (
                  <span key={t.tf} className={cn('rounded border px-0.5 py-0.5 text-center font-mono text-[9px] font-bold leading-tight', TONE[dirTone(t.dir)])}>
                    {MACD_LABEL[t.tf]}
                    <span className="block">{t.dir === 'BUY' ? '▲ BUY' : t.dir === 'SELL' ? '▼ SELL' : '—'}</span>
                  </span>
                ))}
              </span>
              {!compact ? (
                <span className="text-muted-foreground flex flex-wrap gap-x-3 font-mono text-[10px]">
                  <span>EMA200: {r.ema200.near ? 'CLOSE — WAIT' : r.ema200.position}</span>
                  <span>Ribbon: {r.ribbon.state === 'MIXED' ? 'MIXED' : r.ribbon.state === 'BULLISH STACK' ? 'BULL' : 'BEAR'}</span>
                  <span>ST 12,4: {r.supertrend.dir}</span>
                  {r.score !== null ? <span>Q {r.score}</span> : null}
                  <span className="min-w-0 basis-full truncate">{r.status.text}</span>
                </span>
              ) : null}
            </button>
          </li>
        ))}
        {list.length === 0 ? <li className="text-muted-foreground p-4 text-center font-mono text-xs">No pairs match.</li> : null}
      </ul>
      {list.length > limit ? (
        <button type="button" onClick={() => setLimit((l) => l + 25)} className="border-border text-muted-foreground h-10 rounded-md border text-xs font-semibold">
          Show more
        </button>
      ) : null}
    </section>
  )
}

// ------------------------------------------------------------------ dashboard

function Dashboard({ row, rows, data, isError, config, onPick }: { row: MacdRow; rows: MacdRow[]; data: MacdResponse | undefined; isError: boolean; config: MacdConfig; onPick: (s: string) => void }) {
  const now = useNow(1000)
  const ws = useLivePrice(row.symbol)
  const wsFresh = ws.status === 'live' && ws.at !== null && now - ws.at < 15_000
  const price = wsFresh && ws.price !== null ? ws.price : row.price
  const ageS = data ? Math.max(0, Math.round((now - data.computedAt) / 1000)) : 0
  const conn: { tone: Tone; text: string } = isError
    ? { tone: 'bear', text: 'DISCONNECTED — retrying' }
    : ageS > 180
      ? { tone: 'bear', text: `STALE DATA (${ageS}s)` }
      : ageS > 90
        ? { tone: 'warn', text: `DATA DELAYED (${ageS}s)` }
        : { tone: 'bull', text: 'CONNECTED' }
  const g = row.agreement
  const e = row.ema200
  const rb = row.ribbon
  const tone = stateTone(row)
  const sig = row.signal
  const bullAll = rows.filter((r) => r.agreement.side === 'BUY').length
  const bearAll = rows.filter((r) => r.agreement.side === 'SELL').length
  const btc = rows.find((r) => r.symbol === 'BTCUSDT')
  const developing = row.status.state.startsWith('EARLY')
  return (
    <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_21rem]">
      <div className="flex min-w-0 flex-col gap-3">
        <section className="border-border bg-card rounded-xl border-2 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 className="font-mono text-xl font-extrabold sm:text-2xl">
              {coinName(row.symbol)}
              <span className="text-muted-foreground text-sm font-normal">/USDT · {config.indicator === 'impulse' ? 'Impulse MACD' : 'MACD'} · 1M entry · 3M early · 5M + 15M confirm</span>
            </h2>
            <div className="font-mono text-base sm:text-lg">
              ${px(price)} <span className={cn('text-xs', row.change24h >= 0 ? 'text-bull' : 'text-bear')}>{formatPct(row.change24h)} 24h</span>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Chip tone={conn.tone}>{conn.text}</Chip>
            <Chip tone={wsFresh ? 'bull' : ws.status === 'connecting' ? 'muted' : 'warn'} title="Live last price over the Binance WebSocket. Signals never use it: they use closed candles only.">
              PRICE {wsFresh ? `LIVE · ${Math.max(0, Math.round((now - (ws.at ?? now)) / 1000))}s` : ws.status === 'connecting' ? 'CONNECTING' : 'POLLING'}
            </Chip>
            <Chip tone="muted">CANDLES UPDATED {data ? clock(data.computedAt) : '—'}</Chip>
            <Chip tone="muted">LAST CLOSED 1M {clock(row.barTime)}</Chip>
          </div>
        </section>

        <section className={cn('rounded-xl border-2 p-3 text-center', TONE[tone])}>
          <div className="font-mono text-[10px] uppercase opacity-80">Signal status</div>
          <div className="text-xl font-extrabold leading-tight sm:text-3xl">{sig ? `MACD PRECISION ${sig.side}` : developing ? row.status.text : row.sideways.sideways ? 'SIDEWAYS MARKET — WAIT' : 'WAIT — NO TRADE'}</div>
          <div className="mt-1 font-mono text-[11px] font-bold leading-snug opacity-90 sm:text-xs">{row.status.text}</div>
        </section>

        {sig ? <PlanCard side={sig.side} entry={sig.entry} plan={sig} price={price} now={now} time={sig.time} /> : developing && row.plan ? <PlanCard side={row.plan.side} entry={row.price} plan={row.plan} price={price} now={now} preview /> : null}

        {row.score !== null && row.scoreParts.length ? <ScoreCard score={row.score} parts={row.scoreParts} min={config.minScore} /> : null}
        <Checklist checks={row.checks} side={row.checks.length ? row.status.side : null} />

        <Section title="MACD 12/26/9 by timeframe">
          <div className={cn('rounded-lg border p-2 text-center font-mono text-xs font-extrabold', TONE[g.side ? dirTone(g.side) : 'warn'])}>
            {g.side ? `ALL ${g.total} CHECKED TIMEFRAMES ${g.side === 'BUY' ? 'BULLISH' : 'BEARISH'}` : `NOT AGREEING — ${g.bull} BULLISH / ${g.bear} BEARISH${g.disagreeing.length ? ` · ${g.disagreeing.map((t) => MACD_LABEL[t]).join(', ')} disagree` : ''}`}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {tfList(row).map((t) => (
              <TfCard key={t.tf} t={t} />
            ))}
          </div>
        </Section>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Section title="5M EMA 200">
            <div>
              <Row k="Current price" v={px(price)} />
              <Row k="EMA 200 (5M)" v={px(e.value)} cls="text-primary" />
              <Row k="Price vs EMA 200" v={`${e.position} · ${signed(e.distPct)}% · ${e.distAtr.toFixed(1)} ATR`} cls={e.near ? 'text-warn' : e.position === 'ABOVE' ? 'text-bull' : 'text-bear'} />
              <Row k="Trend status" v={e.trend} cls={e.trend === 'BULLISH' ? 'text-bull' : e.trend === 'BEARISH' ? 'text-bear' : 'text-warn'} />
              <Row k="EMA 200 slope" v={e.slope} cls={e.slope === 'RISING' ? 'text-bull' : e.slope === 'FALLING' ? 'text-bear' : 'text-warn'} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Pill tone={e.buyValid ? 'bull' : 'muted'}>BUY {e.buyValid ? 'VALID' : 'BLOCKED'}</Pill>
              <Pill tone={e.sellValid ? 'bear' : 'muted'}>SELL {e.sellValid ? 'VALID' : 'BLOCKED'}</Pill>
            </div>
            <div className="text-muted-foreground font-mono text-[10px]">{e.label}</div>
          </Section>
          <Section title="EMA ribbon (5M)">
            <Pill tone={rb.state === 'BULLISH STACK' ? 'bull' : rb.state === 'BEARISH STACK' ? 'bear' : 'warn'}>{rb.label}</Pill>
            <div>
              <Row k="EMA 20" v={px(rb.e20)} />
              <Row k="EMA 50" v={px(rb.e50)} />
              <Row k="EMA 100" v={px(rb.e100)} />
              <Row k="EMA 200" v={px(rb.e200)} cls="text-primary" />
              <Row k="Stacked for BUY / SELL" v={`${rb.stackBull}/3 · ${rb.stackBear}/3`} />
            </div>
            <div className="text-muted-foreground font-mono text-[10px]">A trade needs {config.ribbonMin} of the 3 pairs (20/50, 50/100, 100/200) stacked its way; mixed = WAIT.</div>
          </Section>
          <Section title={`Supertrend ${config.stPeriod},${config.stMult}`}>
            <div className="grid grid-cols-2 gap-2">
              <Pill tone={dirTone(row.supertrend.dir)}>1M {row.supertrend.dir === 'BUY' ? 'BULLISH' : 'BEARISH'}</Pill>
              <Pill tone={dirTone(row.st3.dir)}>3M {row.st3.dir === 'BUY' ? 'BULLISH' : 'BEARISH'}</Pill>
              <Pill tone={dirTone(row.st5.dir)}>5M {row.st5.dir === 'BUY' ? 'BULLISH' : 'BEARISH'}</Pill>
              <Pill tone={dirTone(row.st15.dir)}>15M {row.st15.dir === 'BUY' ? 'BULLISH' : 'BEARISH'}</Pill>
            </div>
            <div>
              <Row k="1M line (entry confirmation)" v={px(row.supertrend.line)} />
              <Row k="1M last flip" v={row.supertrend.flipBarsAgo === null ? 'none in window' : `${row.supertrend.flipBarsAgo} bar${row.supertrend.flipBarsAgo === 1 ? '' : 's'} ago`} />
              <Row k="5M line (stop reference)" v={px(row.st5.line)} />
              <Row k="5M distance" v={`${signed(row.st5.distPct)}%`} />
            </div>
            <div className="text-muted-foreground font-mono text-[10px]">1M and 5M must agree with the trade; 3M (early) and 15M (context) add to the score. A flip alone never creates a signal.</div>
          </Section>
        </div>

        <Section title={`Market state · ${row.sideways.sideways ? 'SIDEWAYS MARKET — WAIT' : 'not sideways'}`}>
          <div className="grid grid-cols-2 gap-x-3 sm:grid-cols-4">
            <Row k="Market direction" v={g.overall} cls={g.overall === 'BULLISH' ? 'text-bull' : g.overall === 'BEARISH' ? 'text-bear' : 'text-warn'} />
            <Row k="Signal quality" v={row.score === null ? '—' : `${row.score}/100`} />
            <Row k="Sideways tests hit" v={`${row.sideways.hits}/${row.sideways.of} (limit ${config.sidewaysHits})`} cls={row.sideways.sideways ? 'text-warn' : ''} />
            <Row k="Strategy" v={row.version} />
          </div>
          <ul className="grid gap-x-3 sm:grid-cols-2">
            {row.sideways.tests.map((q) => (
              <li key={q.key} className="flex justify-between gap-2 font-mono text-[10px]">
                <span className={q.hit ? 'text-warn' : 'text-muted-foreground'}>{q.hit ? '● ' : '○ '}{q.label}</span>
                <span>{q.value}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Active TP / SL">
          {row.open.length === 0 ? (
            <p className="text-muted-foreground font-mono text-xs">No open signal on {coinName(row.symbol)}. WAIT — NO VALID ENTRY.</p>
          ) : (
            <ul className="divide-border/60 divide-y">
              {row.open.map((s) => (
                <li key={s.id} className="py-1.5">
                  <div className="flex items-center gap-2">
                    <Chip tone={s.side === 'BUY' ? 'bull' : 'bear'}>{s.side}</Chip>
                    <span className="text-muted-foreground font-mono text-[10px]">
                      {when(s.time)} · quality {s.score}
                    </span>
                  </div>
                  <div className="font-mono text-[11px]">
                    Entry {px(s.entry)} · <span className="text-bear">SL {px(s.sl)}</span> · <span className="text-bull">TP {px(s.tp)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <Section title="Market direction">
          <Pill tone={g.side ? dirTone(g.side) : 'warn'} className="text-sm">
            {coinName(row.symbol)}: {g.overall}
          </Pill>
          <Row k="BTC (all checked timeframes)" v={btc ? (btc.agreement.side === 'BUY' ? 'ALL BULLISH' : btc.agreement.side === 'SELL' ? 'ALL BEARISH' : `MIXED ${btc.agreement.bull}↑ ${btc.agreement.bear}↓`) : '—'} cls={btc?.agreement.side ? (btc.agreement.side === 'BUY' ? 'text-bull' : 'text-bear') : 'text-warn'} />
          <Row k="Pairs all-timeframe bullish" v={`${bullAll} / ${rows.length}`} cls="text-bull" />
          <Row k="Pairs all-timeframe bearish" v={`${bearAll} / ${rows.length}`} cls="text-bear" />
          <Row k="Liquidity (this pair)" v={`$${Math.round(row.liquidityUsd).toLocaleString('en-US')} / min`} />
        </Section>
        <PairList rows={rows} selected={row.symbol} onPick={onPick} compact />
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ active trades

function ActiveTrades({ rows, onSelect }: { rows: MacdRow[]; onSelect: (s: string) => void }) {
  const open = useMemo(() => rows.flatMap((r) => r.open.map((s) => ({ s, price: r.price }))).sort((a, b) => b.s.time - a.s.time), [rows])
  return (
    <Section title={`Active trades (${open.length})`}>
      <p className="text-muted-foreground font-mono text-[10px] leading-snug">
        Confirmed signals whose stop-loss and take-profit have not been touched yet, tracked on the real candles since the signal. A trade closes the moment a candle&apos;s high or low reaches SL or TP. These are signals, not orders placed on your account.
      </p>
      {open.length === 0 ? (
        <p className="text-muted-foreground font-mono text-xs">No open signals. WAIT — NO VALID ENTRY.</p>
      ) : (
        <ul className="divide-border/60 divide-y">
          {open.map(({ s, price }) => {
            const bull = s.side === 'BUY'
            const unreal = ((bull ? price - s.entry : s.entry - price) / s.risk)
            const toSl = (Math.abs(price - s.sl) / price) * 100
            const toTp = (Math.abs(s.tp - price) / price) * 100
            return (
              <li key={s.id} className="py-2">
                <button type="button" onClick={() => onSelect(s.symbol)} className="flex min-h-9 w-full items-center justify-between gap-2 text-left">
                  <span className="flex items-center gap-2">
                    <Chip tone={bull ? 'bull' : 'bear'}>{s.side}</Chip>
                    <span className="font-mono text-sm font-bold">{coinName(s.symbol)}</span>
                    <span className="text-muted-foreground font-mono text-[10px]">{MACD_LABEL[s.trigger]} · {when(s.time)}</span>
                  </span>
                  <span className={cn('font-mono text-xs font-extrabold', unreal >= 0 ? 'text-bull' : 'text-bear')}>{signed(unreal, 2)}R</span>
                </button>
                <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-4">
                  <Row k="Entry" v={px(s.entry)} />
                  <Row k="SL" v={`${px(s.sl)} (${toSl.toFixed(2)}% away)`} cls="text-bear" />
                  <Row k="TP" v={`${px(s.tp)} (${toTp.toFixed(2)}% away)`} cls="text-bull" />
                  <Row k="Live price" v={px(price)} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <p className="text-muted-foreground font-mono text-[10px]">Unrealised R uses the live price and ignores fees; the Performance tab includes fees and slippage.</p>
    </Section>
  )
}

// ------------------------------------------------------------------ panel

export interface MacdPanelProps {
  data: MacdResponse | undefined
  isLoading: boolean
  isError: boolean
  config: MacdConfig
  onConfig: (c: Partial<MacdConfig>) => void
  selected: string
  onSelect: (s: string) => void
  onOpenTerminal: (s: string) => void
  alerts: MacdAlerts
  focus: FocusApi
  z15: Z15PanelProps
}

export function MacdPanel({ data, isLoading, isError, config, onConfig, selected, onSelect, onOpenTerminal, alerts, focus, z15 }: MacdPanelProps) {
  const [sub, setSub] = useState<Sub>('focus')
  const rows = useMemo(() => data?.rows ?? [], [data])
  const row = rows.find((r) => r.symbol === selected) ?? rows.find((r) => r.symbol === 'BTCUSDT') ?? rows[0]
  const pick = (s: string) => {
    onSelect(s)
    setSub('dashboard')
  }
  const confirmed = rows.filter((r) => r.signal).length

  const body = () => {
    // the 45M/15M/5M scanner has its own data feed and reports its own errors, so it is not hidden behind the 1M feed
    if (sub === 'z15') return <Z15Tab {...z15} />
    if (isLoading && !data) return <div className="text-muted-foreground p-6 text-center font-mono text-sm">Loading 1M / 5M / 15M candles…</div>
    if (data && !data.live) {
      return (
        <div className="border-bear/30 bg-bear/10 text-bear rounded-lg border p-3 font-mono text-xs">
          Binance data is unavailable right now ({data.error ?? 'unknown error'}). No signals are shown — retrying automatically, nothing fake is being displayed.
        </div>
      )
    }
    if (isError && !data) return <div className="border-bear/30 bg-bear/10 text-bear rounded-lg border p-3 font-mono text-xs">Could not reach the MACD data service. Retrying automatically.</div>
    switch (sub) {
      case 'settings':
        return <SettingsTab config={config} onApply={onConfig} />
      case 'backtest':
        return <BacktestTab config={config} onDone={() => undefined} />
      case 'performance':
        return <PerformanceTab rows={rows} config={config} />
      case 'alerts':
        return <AlertsTab rows={rows} alerts={alerts} onSelect={pick} />
      case 'active':
        return <ActiveTrades rows={rows} onSelect={pick} />
      case 'focus':
        return <FocusTab focus={focus} isLoading={isLoading} onOpen={pick} />
      case 'scanner':
        return <PairList rows={rows} selected={row?.symbol ?? ''} onPick={pick} />
      default:
        return row ? (
          <Dashboard row={row} rows={rows} data={data} isError={isError} config={config} onPick={onSelect} />
        ) : (
          <div className="text-muted-foreground p-6 text-center font-mono text-sm">No pairs have enough candle history yet.</div>
        )
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 p-2 sm:p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-extrabold sm:text-lg">MACD Precision Entry &amp; Risk Management</h1>
          <p className="text-muted-foreground font-mono text-[10px]">
            {rows.length} pairs · 1M entry · 3M early · 5M trend · 15M filter · closed candles only · fewer, higher-quality signals (score ≥ {config.minScore})
          </p>
        </div>
        {confirmed > 0 ? <Chip tone="bull">{confirmed} CONFIRMED NOW</Chip> : null}
      </header>

      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-7">
        {SUBS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSub(s.key)}
            className={cn('h-10 rounded-md border px-2 font-mono text-[11px] font-semibold leading-tight', sub === s.key ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground')}
          >
            {s.label}
            {s.key === 'alerts' && alerts.popups.length > 0 ? ` (${alerts.popups.length})` : ''}
          </button>
        ))}
      </div>

      <label className={cn('text-muted-foreground flex flex-col gap-1 font-mono text-[10px] uppercase lg:hidden', sub !== 'dashboard' && 'hidden')}>
        Trading pair
        <select value={row?.symbol ?? ''} onChange={(e) => onSelect(e.target.value)} className="border-border bg-card text-foreground h-11 rounded-md border px-2 font-mono text-sm">
          {[...rows].sort((a, b) => a.symbol.localeCompare(b.symbol)).map((r) => (
            <option key={r.symbol} value={r.symbol}>
              {coinName(r.symbol)}
              {r.signal ? ` — CONFIRMED ${r.signal.side}` : r.status.state.startsWith('EARLY') ? ` — ${r.status.state.toLowerCase()}` : ''}
            </option>
          ))}
        </select>
      </label>

      {body()}

      {row && sub === 'dashboard' ? (
        <div className={cn('sticky bottom-16 z-20 flex items-center justify-between gap-2 rounded-lg border-2 px-3 py-2 font-mono text-xs font-extrabold backdrop-blur sm:hidden', TONE[stateTone(row)])}>
          <span>{coinName(row.symbol)}</span>
          <span className="min-w-0 truncate text-right">{row.signal ? `PRECISION ${row.signal.side}` : row.sideways.sideways ? 'SIDEWAYS — WAIT' : row.status.text}</span>
        </div>
      ) : null}

      {row && sub === 'dashboard' ? (
        <button type="button" onClick={() => onOpenTerminal(row.symbol)} className="border-border text-muted-foreground h-11 w-full rounded-md border text-xs font-semibold">
          Open {coinName(row.symbol)} in Live Terminal
        </button>
      ) : null}
    </div>
  )
}
