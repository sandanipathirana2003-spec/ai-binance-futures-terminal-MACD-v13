'use client'

import { Bell, BellOff, Volume2, VolumeX, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MACD_LABEL, MACD_MS, type MacdRow } from '@/lib/macdmtf'
import type { MacdAlerts, MacdPopup, PopupMode } from '@/hooks/use-macd-alerts'
import { Chip, Pill, Row, Section, TONE, clock, coinName, dirTone, mmss, px, useNow, when } from './macd-ui'

// ------------------------------------------------------------------ popup (mounted once from the terminal shell)

const chartUrl = (symbol: string) => `https://www.binance.com/en/futures/${symbol}`

function Dirs({ s }: { s: MacdPopup['signal'] }) {
  return (
    <div className="grid grid-cols-4 gap-1">
      {(['1m', '3m', '5m', '15m'] as const).map((tf) => {
        const d = s.tfs[tf] ?? 'NEUTRAL'
        return (
          <Pill key={tf} tone={dirTone(d)} className="px-0.5 py-1 text-[10px]">
            {MACD_LABEL[tf]} MACD
            <span className="block">{d === 'BUY' ? 'BULLISH' : d === 'SELL' ? 'BEARISH' : 'NEUTRAL'}</span>
          </Pill>
        )
      })}
    </div>
  )
}

/** Banner (default, non-blocking) or full-screen popup. Shows ONE confirmed signal at a time; more wait behind it. */
export function MacdPopups({ popups, mode, onDismiss, onDismissAll, onMode, onOpen }: { popups: MacdPopup[]; mode: PopupMode; onDismiss: (id: string) => void; onDismissAll: () => void; onMode: (m: PopupMode) => void; onOpen: (s: string) => void }) {
  const now = useNow(1000)
  if (popups.length === 0 || mode === 'off') return null
  const { signal: s, row } = popups[0]
  const bull = s.side === 'BUY'
  const ms = MACD_MS[s.trigger]
  const next = ms - (now % ms)
  const btn = 'h-10 rounded-md border px-3 text-xs font-semibold'
  const actions = (
    <div className="mt-2 grid grid-cols-2 gap-1.5">
      <button type="button" onClick={() => window.open(chartUrl(s.symbol), '_blank', 'noopener,noreferrer')} className={cn(btn, 'bg-primary text-primary-foreground border-transparent')}>
        Open Chart
      </button>
      <button
        type="button"
        onClick={() => {
          onOpen(s.symbol)
          onDismiss(s.id)
        }}
        className={cn(btn, 'border-border text-foreground')}
      >
        View Setup Details
      </button>
      <button type="button" onClick={() => onDismiss(s.id)} className={cn(btn, 'border-border text-muted-foreground')}>
        Dismiss
      </button>
      <button type="button" onClick={() => onMode('off')} className={cn(btn, 'border-border text-muted-foreground')} title="Stop showing popups (sound, notifications and the log stay on)">
        Mute
      </button>
    </div>
  )
  const waiting = popups.length > 1 ? (
    <button type="button" onClick={onDismissAll} className="text-primary mt-1.5 w-full text-center font-mono text-[11px] font-bold">
      +{popups.length - 1} more waiting · dismiss all
    </button>
  ) : null

  if (mode === 'banner') {
    // Small, non-blocking card: no backdrop, sits above the phone tab bar, everything behind stays usable.
    return (
      <div className="pointer-events-none fixed inset-x-2 bottom-20 z-50 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-80">
        <article className={cn('bg-card pointer-events-auto rounded-xl border-2 p-2.5 shadow-2xl', bull ? 'border-bull' : 'border-bear')}>
          <header className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className={cn('text-base font-extrabold leading-tight', bull ? 'text-bull' : 'text-bear')}>MACD PRECISION {s.side}</div>
              <div className="font-mono text-xs font-bold">
                {coinName(s.symbol)}/USDT · quality {s.score}/100 · next 1M candle {mmss(next)}
              </div>
            </div>
            <button type="button" onClick={() => onDismiss(s.id)} aria-label="Dismiss" className="text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
              <X className="size-4" />
            </button>
          </header>
          <div className="mt-1 font-mono text-[11px]">
            Entry {px(s.entry)} · <span className="text-bear">SL {px(s.sl)}</span> · <span className="text-bull">TP {px(s.tp)}</span> · 1:2 · risk {s.riskPct.toFixed(2)}%
          </div>
          {actions}
          {waiting}
        </article>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-2 sm:items-start sm:justify-end sm:bg-transparent sm:pointer-events-none">
      <article className={cn('bg-card pointer-events-auto my-auto w-full max-w-md rounded-xl border-2 p-3 shadow-2xl sm:my-0', bull ? 'border-bull' : 'border-bear')}>
        <header className="flex items-start justify-between gap-2">
          <div>
            <div className={cn('text-2xl font-extrabold leading-tight', bull ? 'text-bull' : 'text-bear')}>MACD PRECISION {s.side}</div>
            <div className="font-mono text-sm font-bold">{coinName(s.symbol)}/USDT · 1M entry</div>
          </div>
          <button type="button" onClick={() => onDismiss(s.id)} aria-label="Dismiss" className="text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-md">
            <X className="size-5" />
          </button>
        </header>

        <div className="mt-2 grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-muted-foreground font-mono text-[10px] uppercase">Entry</div>
            <div className="font-mono text-lg font-extrabold">{px(s.entry)}</div>
          </div>
          <div>
            <div className="text-bear font-mono text-[10px] uppercase">Stop loss</div>
            <div className="text-bear font-mono text-lg font-extrabold">{px(s.sl)}</div>
          </div>
          <div>
            <div className="text-bull font-mono text-[10px] uppercase">Take profit</div>
            <div className="text-bull font-mono text-lg font-extrabold">{px(s.tp)}</div>
          </div>
        </div>

        <div className="mt-2">
          <Row k="Risk-to-reward" v={`gross 1 : 2 · net 1 : ${s.netRR.toFixed(2)} after costs`} />
          <Row k="Estimated risk" v={`${s.riskPct.toFixed(2)}% of price`} />
          <Row k="Signal quality score" v={`${s.score} / 100`} cls="text-primary" />
        </div>
        <div className="text-muted-foreground font-mono text-[10px] leading-snug">The score counts how many conditions line up. It is not a probability of winning.</div>

        <div className="mt-1.5">
          <Dirs s={s} />
        </div>

        <div className="mt-1.5">
          <Row k="5M EMA 200" v={`PRICE ${s.ema200.position} · ${bull ? 'BULLISH' : 'BEARISH'}`} cls={bull ? 'text-bull' : 'text-bear'} />
          <Row k="EMA ribbon" v={s.ribbon.state === 'MIXED' ? `MOSTLY ${bull ? 'BULLISH' : 'BEARISH'} (${s.ribbon.stack}/3)` : s.ribbon.state} />
          <Row k="Supertrend 12,4" v={`1M ${s.supertrend.dir === 'BUY' ? 'BULL' : 'BEAR'} · 3M ${s.st3.dir === 'BUY' ? 'BULL' : 'BEAR'} · 5M ${s.st5.dir === 'BUY' ? 'BULL' : 'BEAR'}`} cls={bull ? 'text-bull' : 'text-bear'} />
          <Row k="Signal time (UTC)" v={`${new Date(s.time).toISOString().slice(0, 16).replace('T', ' ')} UTC`} />
          <Row k="Signal time (local)" v={when(s.time)} />
          <Row k="Live price now" v={px(row.price)} />
        </div>

        <div className={cn('mt-2 rounded border px-2 py-1.5 text-center font-mono text-xs font-bold', TONE.primary)}>Next 1M candle in {mmss(next)}</div>
        {actions}
        {waiting}
        <p className="text-muted-foreground mt-1.5 font-mono text-[10px] leading-snug">A filter, not a prediction. Entry is the candle close, not an executed fill: check the live price before ordering.</p>
      </article>
    </div>
  )
}

// ------------------------------------------------------------------ MACD PRECISION ALERTS tab

export function AlertsTab({ rows, alerts, onSelect }: { rows: MacdRow[]; alerts: MacdAlerts; onSelect: (s: string) => void }) {
  const fresh = rows.filter((r) => r.signal)
  const rejected = rows.flatMap((r) => r.rejections).sort((a, b) => b.time - a.time)
  const developing = rows.filter((r) => !r.signal && r.status.state.startsWith('EARLY'))
  return (
    <div className="flex flex-col gap-3">
      <Section title="MACD precision alerts">
        <p className="text-muted-foreground font-mono text-[11px] leading-snug">
          A popup appears only when every rule is satisfied and the quality score reaches your minimum: once per crossover, with a cooldown per coin, never while a candle is still forming, and never for disagreeing timeframes, a failed EMA 200 / ribbon / Supertrend check, or a sideways / weak market. Alerts work while this page is open; a phone only gets a notification
          while the browser or installed app is running.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          <button type="button" onClick={alerts.toggleSound} className={cn('flex h-11 items-center justify-center gap-2 rounded-md border text-xs font-semibold', alerts.soundEnabled ? TONE.bull : TONE.muted)}>
            {alerts.soundEnabled ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
            Sound {alerts.soundEnabled ? 'ON' : 'OFF'}
          </button>
          {alerts.permission === 'unsupported' ? (
            <div className={cn('flex h-11 items-center justify-center rounded-md border text-xs font-semibold', TONE.muted)}>Notifications unsupported here</div>
          ) : (
            <button
              type="button"
              onClick={alerts.requestPermission}
              disabled={alerts.permission !== 'default'}
              className={cn('flex h-11 items-center justify-center gap-2 rounded-md border text-xs font-semibold', alerts.permission === 'granted' ? TONE.bull : alerts.permission === 'denied' ? TONE.bear : TONE.warn)}
            >
              {alerts.permission === 'granted' ? <Bell className="size-4" /> : <BellOff className="size-4" />}
              {alerts.permission === 'granted' ? 'Notifications ON' : alerts.permission === 'denied' ? 'Blocked in browser settings' : 'Enable notifications'}
            </button>
          )}
          <div className="border-border flex flex-col gap-1 rounded-md border p-1.5 sm:col-span-3">
            <div className="text-muted-foreground font-mono text-[10px] uppercase">Popup style (sound, notification and the log work in every mode)</div>
            <div className="grid grid-cols-3 gap-1.5">
              {([['full', 'Full popup'], ['banner', 'Small banner'], ['off', 'No popup']] as Array<[PopupMode, string]>).map(([m, label]) => (
                <button key={m} type="button" onClick={() => alerts.setPopupMode(m)} className={cn('h-10 rounded-md border text-xs font-semibold', alerts.popupMode === m ? TONE.primary : TONE.muted)}>
                  {label}
                </button>
              ))}
            </div>
            <label className="text-muted-foreground mt-1 flex items-center justify-between gap-2 font-mono text-[11px]">
              Skip alerts whose stop is wider than (% of price, 0 = never skip)
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step={0.5}
                value={alerts.maxRiskPct}
                onChange={(e) => alerts.setMaxRiskPct(Number(e.target.value))}
                className="border-border bg-background text-foreground h-9 w-20 rounded-md border px-2 text-sm"
              />
            </label>
          </div>
          <button type="button" onClick={alerts.sendTest} className="border-border text-muted-foreground h-11 rounded-md border text-xs font-semibold">
            Send test alert (no signal)
          </button>
        </div>
      </Section>

      <Section title={`Confirmed now (${fresh.length})`}>
        {fresh.length === 0 ? (
          <p className="text-muted-foreground font-mono text-xs">No pair has a fresh confirmed signal. WAIT — NO VALID ENTRY.</p>
        ) : (
          <ul className="divide-border/60 divide-y">
            {fresh.map((r) => (
              <li key={r.symbol}>
                <button type="button" onClick={() => onSelect(r.symbol)} className="flex min-h-11 w-full items-center justify-between gap-2 py-2 text-left">
                  <span className="flex items-center gap-2">
                    <Chip tone={r.signal!.side === 'BUY' ? 'bull' : 'bear'}>{r.signal!.side}</Chip>
                    <span className="font-mono text-sm font-bold">{coinName(r.symbol)}</span>
                  </span>
                  <span className="text-muted-foreground font-mono text-[10px]">
                    {px(r.signal!.entry)} · SL {px(r.signal!.sl)} · TP {px(r.signal!.tp)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Rejected signals (${rejected.length})`}>
        {rejected.length === 0 ? (
          <p className="text-muted-foreground font-mono text-xs">No rejected crossovers in the loaded window.</p>
        ) : (
          <ul className="divide-border/60 divide-y">
            {rejected.slice(0, 40).map((x) => (
              <li key={x.id} className="py-1.5 font-mono text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span><span className={x.side === 'BUY' ? 'text-bull font-bold' : 'text-bear font-bold'}>{x.side}</span> {x.symbol.replace('USDT', '')} · {when(x.time)}</span>
                  <span className="text-warn text-right font-bold">{x.reason}</span>
                </div>
                {x.failed.length > 1 ? <div className="text-muted-foreground text-[10px]">Also failed: {x.failed.filter((f) => !x.reason.toLowerCase().includes(f.toLowerCase())).slice(0, 5).join(' · ')}</div> : null}
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground font-mono text-[10px]">Every fresh 1M crossover that did not become a signal is listed with the first rule it failed (newest 15 per coin from the scanner).</p>
      </Section>
      <Section title={`Early setups, wait for confirmation (${developing.length})`}>
        {developing.length === 0 ? (
          <p className="text-muted-foreground font-mono text-xs">No early setups right now.</p>
        ) : (
          <ul className="divide-border/60 divide-y">
            {developing.slice(0, 15).map((r) => (
              <li key={r.symbol}>
                <button type="button" onClick={() => onSelect(r.symbol)} className="flex min-h-11 w-full flex-col items-start gap-0.5 py-2 text-left">
                  <span className="flex items-center gap-2">
                    <Chip tone={dirTone(r.status.side ?? 'NEUTRAL')}>{r.status.state}</Chip>
                    <span className="font-mono text-sm font-bold">{coinName(r.symbol)}</span>
                  </span>
                  <span className="text-muted-foreground font-mono text-[10px] leading-snug">{r.status.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground font-mono text-[10px]">Early setups never trigger a popup, sound or notification.</p>
      </Section>

      <Section title={`Alert log (${alerts.log.length})`}>
        {alerts.log.length === 0 ? (
          <p className="text-muted-foreground font-mono text-xs">No confirmed alert has fired in this browser yet.</p>
        ) : (
          <>
            <ul className="divide-border/60 divide-y">
              {alerts.log.map((a) => (
                <li key={a.id} className="py-2">
                  <button type="button" onClick={() => onSelect(a.symbol)} className="flex min-h-9 w-full items-center justify-between gap-2 text-left">
                    <span className="flex items-center gap-2">
                      <Chip tone={a.side === 'BUY' ? 'bull' : 'bear'}>{a.side}</Chip>
                      <span className="font-mono text-sm font-bold">{coinName(a.symbol)}</span>
                      <span className="text-muted-foreground font-mono text-[10px]">{a.trigger}</span>
                    </span>
                    <span className="text-muted-foreground font-mono text-[10px]">{when(a.signalTime)}</span>
                  </button>
                  <div className="text-muted-foreground font-mono text-[10px]">
                    Entry {px(a.entry)} · SL {px(a.sl)} · TP {px(a.tp)} · alerted {clock(a.alertedAt)}
                  </div>
                </li>
              ))}
            </ul>
            <button type="button" onClick={alerts.clearLog} className="border-border text-muted-foreground h-10 rounded-md border text-xs font-semibold">
              Clear log
            </button>
          </>
        )}
      </Section>
    </div>
  )
}

