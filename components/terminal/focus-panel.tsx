'use client'

import { useState } from 'react'
import { Target } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DEFAULT_WATCHLIST, MAX_FOCUS, normalizeWatchlist, type FocusConfig, type FocusPlan } from '@/lib/focus'
import type { MacdRow } from '@/lib/macdmtf'
import { useLivePrice } from '@/hooks/use-live-price'
import { Chip, Pill, Row, Section, TONE, coinName, dirTone, px, type Tone } from './macd-ui'

export interface FocusApi {
  config: FocusConfig
  setConfig: (c: Partial<FocusConfig>) => void
  plan: FocusPlan
}

const word = (d: string) => (d === 'BUY' || d === 'BULLISH' ? 'BULLISH' : d === 'SELL' || d === 'BEARISH' ? 'BEARISH' : 'NEUTRAL')

/** The five statuses of the spec. WATCH = everything lines up except the fresh 1M crossover (an early setup). */
export function focusStatus(r: MacdRow): { text: string; tone: Tone } {
  if (r.signal) return { text: `MACD PRECISION ${r.signal.side}`, tone: r.signal.side === 'BUY' ? 'bull' : 'bear' }
  if (r.early) return { text: `WATCH ${r.early.side}`, tone: r.early.side === 'BUY' ? 'bull' : 'bear' }
  return { text: 'WAIT — NO TRADE', tone: 'muted' }
}

function CoinCard({ r, primary, onOpen }: { r: MacdRow; primary: boolean; onOpen: () => void }) {
  const live = useLivePrice(r.symbol)
  const st = focusStatus(r)
  const plan = r.signal ?? r.plan
  const t1 = r.tfs['1m']
  const t5 = r.tfs['5m']
  const t15 = r.tfs['15m']
  const stack = r.ribbon.stackBull === 3 ? 'BULLISH' : r.ribbon.stackBear === 3 ? 'BEARISH' : r.ribbon.state === 'MIXED' ? 'MIXED' : r.ribbon.state
  return (
    <button type="button" onClick={onOpen} className={cn('flex min-h-11 flex-col gap-2 rounded-lg border-2 p-3 text-left', TONE[st.tone], primary ? 'ring-primary ring-2' : '')}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-base font-extrabold">{coinName(r.symbol)}</span>
        <span className="font-mono text-sm font-bold">{px(live.price ?? t1?.close)}</span>
      </div>
      <div className="font-mono text-sm font-extrabold">{st.text}</div>
      <div className="grid grid-cols-3 gap-1">
        <Pill tone={dirTone(t1?.dir ?? 'NEUTRAL')}>1M {word(t1?.dir ?? '')}</Pill>
        <Pill tone={dirTone(t5?.dir ?? 'NEUTRAL')}>5M {word(t5?.dir ?? '')}</Pill>
        <Pill tone={dirTone(t15?.dir ?? 'NEUTRAL')}>15M {word(t15?.dir ?? '')}</Pill>
      </div>
      <div className="grid grid-cols-2 gap-x-3">
        <Row k="1M RSI" v={t1 && Number.isFinite(t1.rsi) ? t1.rsi.toFixed(1) : '—'} />
        <Row k="5M ribbon" v={stack} />
        <Row k="1M Supertrend" v={word(r.supertrend.dir)} />
        <Row k="5M Supertrend" v={word(r.st5.dir)} />
        <Row k="Quality" v={r.score === null ? '—' : `${r.score}/100`} />
        <Row k="RR" v={plan ? `1:2 (net ${plan.netRR.toFixed(2)})` : '—'} />
        <Row k="Entry" v={plan ? px(r.signal ? r.signal.entry : t1?.close) : '—'} />
        <Row k="Stop loss" v={plan ? px(plan.sl) : '—'} />
        <Row k="Take profit" v={plan ? px(plan.tp) : '—'} />
      </div>
      {!r.signal ? <div className="text-muted-foreground font-mono text-[10px]">{r.early ? 'Early setup — wait for the fresh 1M crossover.' : r.status.text}</div> : null}
    </button>
  )
}

function Watchlist({ focus }: { focus: FocusApi }) {
  const [draft, setDraft] = useState('')
  const list = focus.config.watchlist
  const add = () => {
    if (!draft.trim() || list.length >= MAX_FOCUS) return
    focus.setConfig({ watchlist: normalizeWatchlist([...list, ...draft.split(/[\s,]+/)]) })
    setDraft('')
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {list.map((s) => (
          <span key={s} className="border-border bg-muted flex h-11 items-center gap-2 rounded-md border pl-3 font-mono text-xs font-bold">
            {coinName(s)}
            <button type="button" aria-label={`Remove ${s}`} disabled={list.length <= 1} onClick={() => focus.setConfig({ watchlist: list.filter((x) => x !== s) })} className="text-muted-foreground size-11 text-base disabled:opacity-30">
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} disabled={list.length >= MAX_FOCUS} placeholder={list.length >= MAX_FOCUS ? 'Maximum 5 coins reached' : 'Add a coin, e.g. DOGE'} className="border-border bg-background h-11 min-w-0 flex-1 rounded-md border px-3 font-mono text-sm" />
        <button type="button" onClick={add} disabled={list.length >= MAX_FOCUS || !draft.trim()} className="border-border h-11 rounded-md border px-4 font-mono text-xs font-bold disabled:opacity-40">
          Add
        </button>
        <button type="button" onClick={() => focus.setConfig({ watchlist: [...DEFAULT_WATCHLIST] })} className="border-border h-11 rounded-md border px-4 font-mono text-xs font-bold">
          Reset to default
        </button>
      </div>
      <p className="text-muted-foreground font-mono text-[10px]">Precision Mode never scans or shows more than {MAX_FOCUS} coins. Coins Binance does not list as USDT-M perpetuals are simply not shown.</p>
    </div>
  )
}

export function FocusTab({ focus, isLoading, onOpen }: { focus: FocusApi; isLoading: boolean; onOpen: (symbol: string) => void }) {
  const { config, plan } = focus
  const missing = config.watchlist.filter((s) => !plan.rows.some((r) => r.symbol === s))
  const primary = plan.primary
  const num = (label: string, key: 'maxConcurrent' | 'dailyLimit' | 'lossCooldownMin', hint: string) => (
    <label className="flex flex-col gap-1 font-mono text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <input type="number" inputMode="numeric" min={0} value={config[key]} onChange={(e) => focus.setConfig({ [key]: Number(e.target.value) })} className="border-border bg-background h-11 rounded-md border px-3 text-sm" />
      <span className="text-muted-foreground text-[10px]">{hint}</span>
    </label>
  )
  return (
    <div className="flex flex-col gap-3">
      <Section title="5-Coin Focus Mode">
        <label className="flex min-h-11 items-center gap-3 font-mono text-xs font-bold">
          <input type="checkbox" className="size-6" checked={config.enabled} onChange={(e) => focus.setConfig({ enabled: e.target.checked })} />
          Focus Mode on — only the selected coins are scanned, shown and alerted
        </label>
        {config.enabled ? <Watchlist focus={focus} /> : <p className="text-muted-foreground font-mono text-xs">Focus Mode is off: the scanner covers the 50 most liquid pairs.</p>}
      </Section>

      {config.enabled ? (
        <>
          <section className={cn('rounded-xl border-2 p-4 text-center', primary ? TONE[primary.signal!.side === 'BUY' ? 'bull' : 'bear'] : plan.blocked ? TONE.warn : TONE.muted)}>
            <div className="text-muted-foreground mb-1 flex items-center justify-center gap-1 font-mono text-[10px] font-bold uppercase">
              <Target className="size-3" /> Primary opportunity
            </div>
            {primary ? (
              <>
                <div className="font-mono text-2xl font-extrabold">
                  MACD PRECISION {primary.signal!.side} — {coinName(primary.symbol)}
                </div>
                <div className="mt-1 font-mono text-xs">
                  Quality {primary.signal!.score}/100 · Entry {px(primary.signal!.entry)} · SL {px(primary.signal!.sl)} · TP {px(primary.signal!.tp)} · net 1:{primary.signal!.netRR.toFixed(2)}
                </div>
                {plan.ranked.length > 1 ? <div className="text-muted-foreground mt-1 font-mono text-[10px]">{plan.ranked.length - 1} other setup{plan.ranked.length === 2 ? '' : 's'} ranked lower by quality, liquidity and net RR — take one trade, not all.</div> : null}
              </>
            ) : plan.blocked ? (
              <>
                <div className="font-mono text-xl font-extrabold">SETUP FOUND — STAND ASIDE</div>
                <div className="mt-1 font-mono text-xs font-bold">{plan.gate.reason}</div>
              </>
            ) : (
              <div className="font-mono text-2xl font-extrabold">{isLoading ? 'LOADING…' : 'NO SETUP — WAIT PATIENTLY'}</div>
            )}
            <div className="text-muted-foreground mt-2 font-mono text-[10px]">
              Open positions {plan.gate.open}/{config.maxConcurrent} · Trades today {plan.gate.today}
              {config.dailyLimit ? `/${config.dailyLimit}` : ''} · Signals only, no automatic orders. A setup is not a prediction.
            </div>
          </section>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {plan.rows.map((r) => (
              <CoinCard key={r.symbol} r={r} primary={primary?.symbol === r.symbol} onOpen={() => onOpen(r.symbol)} />
            ))}
          </div>
          {missing.length ? (
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
              <Chip tone="warn">No data</Chip> {missing.map(coinName).join(', ')} — {isLoading ? 'loading' : 'not listed as a USDT-M perpetual, or the candles are incomplete'}.
            </div>
          ) : null}

          <Section title="Discipline limits">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {num('Max concurrent positions', 'maxConcurrent', 'Default 1. Counts OPEN trades in your journal.')}
              {num('Daily trade limit', 'dailyLimit', '0 = no limit. Counts trades opened today.')}
              {num('Cooldown after a loss (minutes)', 'lossCooldownMin', '0 = off (default).')}
            </div>
            <p className="text-muted-foreground font-mono text-[10px]">
              Focus Mode only reduces how much you have to look at. It does not remove risk, predict outcomes or make a losing streak impossible.
            </p>
          </Section>
        </>
      ) : null}
    </div>
  )
}
