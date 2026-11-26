'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ClassicRow, ClassicSignal } from '@/lib/macd5m'
import { Chip, Row, Section, coinName, px, signed, when } from './macd-ui'

// ------------------------------------------------------------------ account settings (kept in this browser)

export interface Account {
  balance: number
  riskPct: number
  leverage: number
  /** 'risk' = size the position from the risk amount and the stop; 'margin' = size it from a margin you choose. */
  mode: 'risk' | 'margin'
  margin: number
  takerFeeBps: number
}
export const DEFAULT_ACCOUNT: Account = { balance: 1000, riskPct: 1, leverage: 10, mode: 'risk', margin: 100, takerFeeBps: 5 }
const KEY = 'classic-account-v1'

export function useAccount() {
  const [account, setAccountState] = useState<Account>(DEFAULT_ACCOUNT)
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY)
      if (raw) setAccountState({ ...DEFAULT_ACCOUNT, ...(JSON.parse(raw) as Partial<Account>) })
    } catch {
      // ignore corrupt storage
    }
  }, [])
  const setAccount = useCallback((p: Partial<Account>) => {
    setAccountState((prev) => {
      const next = { ...prev, ...p }
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        // storage unavailable: lasts for this visit only
      }
      return next
    })
  }, [])
  return { account, setAccount }
}

/** Maintenance margin rate assumed for the liquidation estimate (Binance tiers differ; this is a rough, conservative figure). */
const MMR = 0.005

export interface Sizing {
  riskAmount: number
  qty: number
  notional: number
  margin: number
  fees: number
  slPct: number
  rrText: string
  liq: number
  liqBeforeSl: boolean
  marginTooBig: boolean
}

/** Position sizing. The risk amount includes round-trip fees, so a stop-out loses what you chose to risk, not more. */
export function sizePosition(a: Account, bull: boolean, entry: number, sl: number, tp: number): Sizing | null {
  const dist = Math.abs(entry - sl)
  if (!(entry > 0) || !(dist > 0) || !Number.isFinite(sl)) return null
  const feeRate = (2 * a.takerFeeBps) / 10_000
  let qty: number
  let riskAmount: number
  if (a.mode === 'risk') {
    riskAmount = (a.balance * a.riskPct) / 100
    qty = riskAmount / (dist + entry * feeRate)
  } else {
    qty = (a.margin * a.leverage) / entry
    riskAmount = qty * (dist + entry * feeRate)
  }
  const notional = qty * entry
  const margin = notional / a.leverage
  const liq = bull ? entry * (1 - 1 / a.leverage + MMR) : entry * (1 + 1 / a.leverage - MMR)
  const reward = Math.abs(tp - entry)
  return {
    riskAmount,
    qty,
    notional,
    margin,
    fees: notional * feeRate,
    slPct: (dist / entry) * 100,
    rrText: reward > 0 ? `1 : ${(reward / dist).toFixed(2)}` : '—',
    liq,
    liqBeforeSl: bull ? liq >= sl : liq <= sl,
    marginTooBig: margin > a.balance,
  }
}

const usd = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 })}`

function NumInput({ label, value, onChange, step = 1, suffix }: { label: string; value: number | string; onChange: (v: string) => void; step?: number; suffix?: string }) {
  return (
    <label className="text-muted-foreground flex flex-col gap-1 font-mono text-[10px] uppercase">
      {label}
      <span className="border-border bg-background flex h-10 items-center rounded-md border px-2">
        <input type="number" inputMode="decimal" step={step} value={value} onChange={(e) => onChange(e.target.value)} className="text-foreground min-w-0 flex-1 bg-transparent text-sm normal-case outline-none" />
        {suffix ? <span className="text-muted-foreground ml-1 text-[11px] normal-case">{suffix}</span> : null}
      </span>
    </label>
  )
}

// ------------------------------------------------------------------ panel

export function TradeManagement({ rows, selected, account, onAccount }: { rows: ClassicRow[]; selected: string; account: Account; onAccount: (p: Partial<Account>) => void }) {
  const open = useMemo(() => rows.flatMap((r) => r.open.map((s) => ({ s, price: r.price }))).sort((a, b) => b.s.time - a.s.time), [rows])
  const [src, setSrc] = useState<string>('manual')
  const picked: { s: ClassicSignal; price: number } | undefined = open.find((o) => o.s.id === src)
  const row = rows.find((r) => r.symbol === (picked?.s.symbol ?? selected))
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [entry, setEntry] = useState('')
  const [sl, setSl] = useState('')
  const [tp, setTp] = useState('')

  // loading a setup (or the first time the manual form is used) fills in its levels
  useEffect(() => {
    if (picked) {
      setSide(picked.s.side)
      setEntry(String(picked.s.entry))
      setSl(String(picked.s.sl))
      setTp(String(picked.s.tp))
    }
  }, [picked?.s.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const bull = side === 'BUY'
  const e = Number(entry)
  const stop = Number(sl)
  const target = Number(tp)
  const live = row?.price ?? NaN
  const size = entry && sl && tp ? sizePosition(account, bull, e, stop, target) : null
  const validSide = size !== null && (bull ? stop < e && target > e : stop > e && target < e)
  const dirK = bull ? 1 : -1
  const pnl = size && Number.isFinite(live) ? dirK * (live - e) * size.qty : NaN
  const pnlPct = size && Number.isFinite(pnl) ? (pnl / size.margin) * 100 : NaN
  const curR = size && Number.isFinite(live) ? (dirK * (live - e)) / Math.abs(e - stop) : NaN
  const sym = picked?.s.symbol ?? selected

  const fillFromRow = () => {
    const s = row?.signal
    if (s) {
      setSide(s.side)
      setEntry(String(s.entry))
      setSl(String(s.sl))
      setTp(String(s.tp))
      setSrc('manual')
    }
  }

  return (
    <div className="grid min-w-0 gap-3 lg:grid-cols-2">
      <Section title="Position calculator">
        <label className="text-muted-foreground flex flex-col gap-1 font-mono text-[10px] uppercase">
          Setup
          <select value={src} onChange={(ev) => setSrc(ev.target.value)} className="border-border bg-background text-foreground h-10 rounded-md border px-2 font-mono text-sm normal-case">
            <option value="manual">Manual entry — {coinName(selected)}</option>
            {open.map(({ s }) => (
              <option key={s.id} value={s.id}>
                {s.side} {coinName(s.symbol)} @ {px(s.entry)} · {when(s.time)}
              </option>
            ))}
          </select>
        </label>
        {src === 'manual' && row?.signal ? (
          <button type="button" onClick={fillFromRow} className="border-primary/40 bg-primary/10 text-primary h-9 rounded-md border text-xs font-semibold">
            Use the confirmed {row.signal.side} signal on {coinName(row.symbol)}
          </button>
        ) : null}
        <div className="grid grid-cols-2 gap-1.5">
          {(['BUY', 'SELL'] as const).map((d) => (
            <button key={d} type="button" onClick={() => setSide(d)} className={cn('h-10 rounded-md border text-xs font-bold', side === d ? (d === 'BUY' ? 'border-bull/40 bg-bull/15 text-bull' : 'border-bear/40 bg-bear/15 text-bear') : 'border-border text-muted-foreground')}>
              {d === 'BUY' ? 'LONG / BUY' : 'SHORT / SELL'}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <NumInput label="Entry" value={entry} onChange={setEntry} step={0.0001} />
          <NumInput label="Stop loss" value={sl} onChange={setSl} step={0.0001} />
          <NumInput label="Take profit" value={tp} onChange={setTp} step={0.0001} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NumInput label="Account balance" value={account.balance} onChange={(v) => onAccount({ balance: Math.max(0, Number(v)) })} suffix="USDT" />
          <NumInput label="Leverage" value={account.leverage} onChange={(v) => onAccount({ leverage: Math.min(125, Math.max(1, Number(v) || 1)) })} suffix="x" />
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {(['risk', 'margin'] as const).map((m) => (
            <button key={m} type="button" onClick={() => onAccount({ mode: m })} className={cn('h-9 rounded-md border text-[11px] font-semibold', account.mode === m ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground')}>
              {m === 'risk' ? 'Size by risk %' : 'Size by margin'}
            </button>
          ))}
        </div>
        {account.mode === 'risk' ? (
          <NumInput label="Risk per trade" value={account.riskPct} onChange={(v) => onAccount({ riskPct: Math.min(100, Math.max(0, Number(v))) })} step={0.25} suffix="% of balance" />
        ) : (
          <NumInput label="Margin to use" value={account.margin} onChange={(v) => onAccount({ margin: Math.max(0, Number(v)) })} suffix="USDT" />
        )}
        <NumInput label="Taker fee per side" value={account.takerFeeBps} onChange={(v) => onAccount({ takerFeeBps: Math.min(50, Math.max(0, Number(v))) })} suffix="bps" />
        <p className="text-muted-foreground font-mono text-[10px] leading-snug">Leverage only sets how much margin is locked, it does not change the risk: the risk is the amount you lose if the stop is hit (fees included). Your account settings are saved in this browser.</p>
      </Section>

      <div className="flex min-w-0 flex-col gap-3">
        <Section title="Position size & risk">
          {!size ? (
            <p className="text-muted-foreground font-mono text-xs">Enter entry, stop loss and take profit to size the position.</p>
          ) : (
            <>
              {!validSide ? (
                <div className="border-warn/50 bg-warn/10 text-warn flex items-start gap-1.5 rounded-md border p-2 font-mono text-[11px] font-bold">
                  <AlertTriangle className="mt-px size-3.5 shrink-0" />
                  {bull ? 'For a BUY the stop must be below and the target above the entry.' : 'For a SELL the stop must be above and the target below the entry.'}
                </div>
              ) : null}
              <div>
                <Row k="Risk amount (stop hit, fees included)" v={usd(size.riskAmount)} cls="text-bear" />
                <Row k="Stop distance" v={`${px(Math.abs(e - stop))} (${size.slPct.toFixed(2)}%)`} />
                <Row k="Position size" v={`${size.qty >= 1 ? size.qty.toFixed(3) : size.qty.toPrecision(4)} ${coinName(sym)}`} />
                <Row k="Position value (notional)" v={usd(size.notional)} />
                <Row k={`Margin at ${account.leverage}x`} v={usd(size.margin)} cls={size.marginTooBig ? 'text-bear' : ''} />
                <Row k="Round-trip taker fees" v={usd(size.fees)} />
                <Row k="Risk : reward" v={size.rrText} />
                <Row k="Estimated profit at target" v={usd(Math.abs(target - e) * size.qty - size.fees)} cls="text-bull" />
                <Row k="Estimated liquidation price (isolated)" v={px(size.liq)} cls="text-warn" />
              </div>
              {size.marginTooBig ? <p className="text-bear font-mono text-[11px] font-bold">The margin needed is more than your balance. Lower the risk, the stop distance or raise the leverage.</p> : null}
              {size.liqBeforeSl && validSide ? (
                <div className="border-bear/40 bg-bear/10 text-bear flex items-start gap-1.5 rounded-md border p-2 font-mono text-[11px] font-bold">
                  <AlertTriangle className="mt-px size-3.5 shrink-0" />
                  At {account.leverage}x the estimated liquidation price is reached BEFORE your stop. Lower the leverage.
                </div>
              ) : null}
              <p className="text-muted-foreground font-mono text-[10px] leading-snug">The liquidation price is a rough estimate (isolated margin, 0.5% maintenance rate). Binance uses margin tiers, cross margin and funding, so check the real figure on the exchange before trading.</p>
            </>
          )}
        </Section>

        <Section title="Active trade">
          {!size || !validSide ? (
            <p className="text-muted-foreground font-mono text-xs">Pick an open setup above, or enter a manual trade, to follow its P&L.</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Chip tone={bull ? 'bull' : 'bear'}>{side}</Chip>
                <span className="font-mono text-sm font-bold">{coinName(sym)}</span>
                <span className="text-muted-foreground font-mono text-[10px]">live {px(live)}</span>
              </div>
              <div>
                <Row k="Entry / SL / TP" v={`${px(e)} / ${px(stop)} / ${px(target)}`} />
                <Row k="Unrealised P&L" v={Number.isFinite(pnl) ? `${pnl >= 0 ? '+' : ''}${usd(pnl)} (${signed(pnlPct, 1)}% of margin)` : '—'} cls={pnl >= 0 ? 'text-bull' : 'text-bear'} />
                <Row k="Current RR" v={Number.isFinite(curR) ? `${signed(curR, 2)}R` : '—'} cls={curR >= 0 ? 'text-bull' : 'text-bear'} />
                <Row k="Distance to SL / TP" v={Number.isFinite(live) ? `${((Math.abs(live - stop) / live) * 100).toFixed(2)}% / ${((Math.abs(target - live) / live) * 100).toFixed(2)}%` : '—'} />
                <Row k="Leverage / margin" v={`${account.leverage}x / ${usd(size.margin)}`} />
                <Row k="Risk amount" v={usd(size.riskAmount)} />
              </div>
              <p className="text-muted-foreground font-mono text-[10px]">The dashboard does not place orders. This follows the numbers you entered against the live price (fees not included in the unrealised figure).</p>
            </>
          )}
        </Section>
      </div>
    </div>
  )
}
