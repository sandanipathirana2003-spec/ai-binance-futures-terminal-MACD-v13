'use client'

import { useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { MACD_LABEL, STRATEGY_VERSION, normalizeMacdConfig, type MacdConfig, type MacdRow, type MacdSignal, type MacdTf } from '@/lib/macdmtf'
import { buildPerfReport, type Bucket, type PerfReport } from '@/lib/macd-perf'
import { WARMUP_DAYS, backtestSymbol, defaultVariants, fetchHistory, type VariantResult } from '@/lib/macd-backtest'
import { Section, Stat, signed } from './macd-ui'

// ------------------------------------------------------------------ last back-test, kept while the tab is switched

export interface BacktestResult {
  symbols: string[]
  days: number
  finishedAt: number
  windowStart: number
  config: MacdConfig
  results: VariantResult[]
  version: string
}
let lastBacktest: BacktestResult | null = null

const fmtR = (v: number) => `${signed(v, 1)}R`
const pf = (r: PerfReport) => (r.closed === 0 ? '—' : r.profitFactor === null ? (r.wins > 0 ? '∞' : '—') : r.profitFactor.toFixed(2))

// ------------------------------------------------------------------ breakdown table

function Breakdown({ title, rows, empty }: { title: string; rows: Bucket[]; empty?: string }) {
  const [limit, setLimit] = useState(8)
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground mb-1 font-mono text-[10px] font-bold uppercase">{title}</div>
      {rows.length === 0 ? (
        <div className="text-muted-foreground font-mono text-[11px]">{empty ?? 'No closed trades yet.'}</div>
      ) : (
        <div className="border-border overflow-hidden rounded-lg border">
          <div className="bg-secondary/40 text-muted-foreground grid grid-cols-[minmax(0,1.4fr)_2.5rem_3rem_3.5rem_4rem] gap-1 px-2 py-1 font-mono text-[9px] uppercase">
            <span>Period</span>
            <span className="text-right">Trades</span>
            <span className="text-right">Win%</span>
            <span className="text-right">Net R</span>
            <span className="text-right">Net %</span>
          </div>
          {rows.slice(0, limit).map((b) => (
            <div key={b.key} className="border-border/60 grid grid-cols-[minmax(0,1.4fr)_2.5rem_3rem_3.5rem_4rem] gap-1 border-t px-2 py-1.5 font-mono text-[11px]">
              <span className="truncate font-semibold">{b.key}</span>
              <span className="text-right">{b.trades}</span>
              <span className="text-right">{Math.round((b.wins / b.trades) * 100)}%</span>
              <span className={cn('text-right font-bold', b.r >= 0 ? 'text-bull' : 'text-bear')}>{signed(b.r, 1)}</span>
              <span className={cn('text-right', b.pct >= 0 ? 'text-bull' : 'text-bear')}>{signed(b.pct, 1)}%</span>
            </div>
          ))}
          {rows.length > limit ? (
            <button type="button" onClick={() => setLimit((l) => l + 10)} className="text-muted-foreground border-border/60 h-9 w-full border-t text-[11px] font-semibold">
              Show more
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ performance tab

export function PerformanceTab({ rows, config }: { rows: MacdRow[]; config: MacdConfig }) {
  const bt = lastBacktest
  const [source, setSource] = useState<'live' | 'backtest'>(bt ? 'backtest' : 'live')
  const [variant, setVariant] = useState<'precision' | 'basic'>('precision')
  const mode = source === 'backtest' && bt ? 'backtest' : 'live'

  const { main, label } = useMemo(() => {
    if (mode === 'backtest' && bt) {
      const sigs = bt.results.filter((r) => r.key === variant).flatMap((r) => r.signals)
      return {
        main: buildPerfReport(sigs),
        label: `BACK-TEST · ${bt.symbols.join(', ')} · last ${bt.days} days of real Binance candles · ${variant === 'precision' ? 'Precision strategy (all rules)' : 'Basic variant (no ribbon / quality filters / score gate)'}`,
      }
    }
    const sigs = rows.flatMap((r) => r.history)
    return { main: buildPerfReport(sigs), label: `LIVE REPLAY · ${rows.length} scanned pairs · only the newest 20 signals per pair over ~16 h of real 1M candles` }
  }, [mode, bt, rows, variant])

  const done = main.closed > 0
  return (
    <div className="flex flex-col gap-3">
      <Section title="Performance analytics">
        <div className="flex flex-wrap gap-1.5">
          {(['live', 'backtest'] as const).map((s) => (
            <button
              key={s}
              type="button"
              disabled={s === 'backtest' && !bt}
              onClick={() => setSource(s)}
              className={cn('h-9 rounded-md border px-3 font-mono text-[11px] font-semibold disabled:opacity-40', mode === s ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground')}
            >
              {s === 'live' ? 'Live replay' : bt ? 'Back-test' : 'Back-test (run one first)'}
            </button>
          ))}
          {mode === 'backtest' ? (
            <select value={variant} onChange={(e) => setVariant(e.target.value as 'precision' | 'basic')} className="border-border bg-background h-9 rounded-md border px-2 font-mono text-[11px]">
              <option value="precision">Precision (all rules)</option>
              <option value="basic">Basic (ablation)</option>
            </select>
          ) : null}
        </div>
        <p className="text-muted-foreground font-mono text-[10px] leading-snug">
          {label}. Fees {config.feeBps} bps + slippage {config.slipBps} bps per side are inside every number. If SL and TP fall in the same candle the stop counts first. Nothing here is made up: every figure is computed from real candles, and past results do not predict
          future results.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat k="Total BUY signals" v={String(main.buys)} cls="text-bull" />
          <Stat k="Total SELL signals" v={String(main.sells)} cls="text-bear" />
          <Stat k="Total confirmed" v={String(main.total)} />
          <Stat k="Win rate" v={done ? `${main.winRate.toFixed(1)}%` : '—'} />
          <Stat k="Winning trades" v={String(main.wins)} cls="text-bull" />
          <Stat k="Losing trades" v={String(main.losses)} cls="text-bear" />
          <Stat k="Net P&L (R)" v={done ? fmtR(main.netR) : '—'} cls={main.netR >= 0 ? 'text-bull' : 'text-bear'} />
          <Stat k="Net P&L (price %)" v={done ? `${signed(main.netPct, 1)}%` : '—'} cls={main.netPct >= 0 ? 'text-bull' : 'text-bear'} />
          <Stat k="Average profit" v={main.wins ? `${fmtR(main.avgWinR)} · ${signed(main.avgWinPct)}%` : '—'} />
          <Stat k="Average loss" v={main.losses ? `${fmtR(main.avgLossR)} · ${signed(main.avgLossPct)}%` : '—'} />
          <Stat k="Profit factor" v={pf(main)} />
          <Stat k="Max drawdown" v={done ? `${main.maxDrawdownR.toFixed(1)}R · ${main.maxDrawdownPct.toFixed(1)}%` : '—'} cls="text-bear" />
          <Stat k="TP hits" v={String(main.tpHits)} cls="text-bull" />
          <Stat k="SL hits" v={String(main.slHits)} cls="text-bear" />
          <Stat k="Still open" v={String(main.open)} />
          <Stat k="Average R per trade" v={done ? fmtR(main.netR / main.closed) : '—'} cls={main.netR >= 0 ? 'text-bull' : 'text-bear'} />
          <Stat k="Planned net RR (avg)" v={main.avgNetRR ? `1 : ${main.avgNetRR.toFixed(2)}` : '—'} />
          <Stat k="Average holding time" v={done ? (main.avgHoldMin >= 90 ? `${(main.avgHoldMin / 60).toFixed(1)} h` : `${main.avgHoldMin.toFixed(0)} min`) : '—'} />
        </div>
        {main.total === 0 ? <div className="border-border bg-muted text-muted-foreground rounded-md border p-3 text-center font-mono text-xs font-bold">NO BACKTEST DATA AVAILABLE</div> : null}
        {main.total > 0 && !done ? <p className="text-muted-foreground font-mono text-[11px]">No closed trades yet, so win rate, P&amp;L and drawdown are not shown rather than guessed.</p> : null}
      </Section>

      <Section title="Timeframe-wise & quality-wise performance">
        <p className="text-muted-foreground font-mono text-[10px] leading-snug">
          Every trade enters on the 1M close with the 5M and 15M MACD already on the trade side, so timeframe-wise results are one block. The score bands show whether a higher quality score really went with better results; if they do not, the score is only decoration.
        </p>
        <Breakdown title="By quality score" rows={main.byScore} empty="No scored closed trades yet." />
        <Breakdown title="By entry timeframe" rows={main.byTrigger.map((b) => ({ ...b, key: `${MACD_LABEL[b.key as MacdTf] ?? b.key} entry · 5M + 15M confirm` }))} />
      </Section>
      <Section title="Coin-wise performance">
        <Breakdown title="By coin" rows={main.byCoin} />
      </Section>
      <Section title="Daily · weekly · monthly">
        <div className="grid gap-3 lg:grid-cols-3">
          <Breakdown title="Daily (UTC)" rows={main.daily} />
          <Breakdown title="Weekly (week starting Monday, UTC)" rows={main.weekly} />
          <Breakdown title="Monthly (UTC)" rows={main.monthly} />
        </div>
      </Section>
    </div>
  )
}

// ------------------------------------------------------------------ back-test tab

function csvEscape(v: string | number) {
  const t = String(v)
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}

/** Equity curve (cumulative R), trade list, rejection reasons, CSV export and the disclaimer for one back-test variant. */
function BacktestDetail({ r, result }: { r: VariantResult; result: BacktestResult }) {
  const [limit, setLimit] = useState(15)
  const closed = useMemo(() => r.signals.filter((s) => s.outcome.result !== 'OPEN').sort((a, b) => (a.outcome.closedAt ?? 0) - (b.outcome.closedAt ?? 0)), [r])
  const curve = useMemo(() => {
    let c = 0
    return closed.map((s) => (c += s.outcome.r))
  }, [closed])
  const reasons = useMemo(() => {
    const m = new Map<string, number>()
    for (const x of r.rejections) m.set(x.reason, (m.get(x.reason) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [r])
  const trades = useMemo(() => [...r.signals].sort((a, b) => b.time - a.time), [r])
  function exportCsv() {
    const head = ['strategy_version', 'symbol', 'side', 'signal_time_utc', 'entry', 'sl', 'tp', 'risk_pct', 'gross_rr', 'net_rr', 'score', 'result', 'r_multiple', 'closed_at_utc']
    const lines = [head.join(',')]
    for (const s of trades)
      lines.push([s.version, s.symbol, s.side, new Date(s.time).toISOString(), s.entry, s.sl, s.tp, s.riskPct.toFixed(3), s.grossRR, s.netRR.toFixed(3), s.score, s.outcome.result, s.outcome.r.toFixed(3), s.outcome.closedAt ? new Date(s.outcome.closedAt).toISOString() : ''].map(csvEscape).join(','))
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `macd-precision-backtest-${result.version}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }
  const W = 320
  const H = 110
  const lo = Math.min(0, ...curve)
  const hi = Math.max(0, ...curve)
  const span = hi - lo || 1
  const pts = curve.map((v, i) => `${curve.length === 1 ? W / 2 : (i / (curve.length - 1)) * W},${H - ((v - lo) / span) * (H - 8) - 4}`).join(' ')
  const zeroY = H - ((0 - lo) / span) * (H - 8) - 4
  return (
    <div className="flex flex-col gap-3">
      <div className="text-muted-foreground font-mono text-[10px]">Strategy version {result.version} · Precision variant · {r.signals.length} signals · {r.rejections.length} rejected fresh crossovers</div>
      <div>
        <div className="text-muted-foreground mb-1 font-mono text-[10px] font-bold uppercase">Equity curve (cumulative R, closed trades in order)</div>
        {curve.length === 0 ? (
          <div className="text-muted-foreground font-mono text-[11px]">NO BACKTEST DATA AVAILABLE — no closed trades in this run.</div>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} className="border-border bg-card h-28 w-full rounded-lg border" preserveAspectRatio="none" role="img" aria-label="Equity curve in R">
            <line x1="0" x2={W} y1={zeroY} y2={zeroY} stroke="currentColor" strokeOpacity="0.3" strokeDasharray="3 3" />
            <polyline points={pts} fill="none" stroke={curve[curve.length - 1] >= 0 ? 'var(--color-bull, #16a34a)' : 'var(--color-bear, #dc2626)'} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
        )}
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="text-muted-foreground font-mono text-[10px] font-bold uppercase">Trade list ({trades.length})</div>
          <button type="button" onClick={exportCsv} disabled={trades.length === 0} className="border-border h-9 rounded-md border px-3 font-mono text-[11px] font-semibold disabled:opacity-40">
            Export CSV
          </button>
        </div>
        {trades.length === 0 ? (
          <div className="text-muted-foreground font-mono text-[11px]">No trades.</div>
        ) : (
          <div className="border-border divide-border/60 divide-y overflow-hidden rounded-lg border">
            {trades.slice(0, limit).map((s) => (
              <div key={s.id} className="grid grid-cols-[3.2rem_minmax(0,1fr)_3.4rem_3.4rem] items-center gap-1 px-2 py-1.5 font-mono text-[10px]">
                <span className={s.side === 'BUY' ? 'text-bull font-bold' : 'text-bear font-bold'}>{s.side}</span>
                <span className="min-w-0 truncate">{s.symbol.replace('USDT', '')} · {new Date(s.time).toISOString().slice(5, 16).replace('T', ' ')}Z · q{s.score}</span>
                <span className="text-right">{s.outcome.result}</span>
                <span className={cn('text-right font-bold', s.outcome.r >= 0 ? 'text-bull' : 'text-bear')}>{signed(s.outcome.r, 2)}R</span>
              </div>
            ))}
            {trades.length > limit ? (
              <button type="button" onClick={() => setLimit((l) => l + 25)} className="text-muted-foreground h-9 w-full text-[11px] font-semibold">
                Show more
              </button>
            ) : null}
          </div>
        )}
      </div>
      <div>
        <div className="text-muted-foreground mb-1 font-mono text-[10px] font-bold uppercase">Why crossovers were rejected</div>
        {reasons.length === 0 ? <div className="text-muted-foreground font-mono text-[11px]">None logged.</div> : <ul className="font-mono text-[11px]">{reasons.slice(0, 12).map(([k, v]) => <li key={k} className="flex justify-between gap-2"><span className="truncate">{k}</span><span className="font-bold">{v}</span></li>)}</ul>}
      </div>
      <p className="text-warn font-mono text-[10px] font-bold">Past performance does not guarantee future results.</p>
    </div>
  )
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

export function BacktestTab({ config, onDone }: { config: MacdConfig; onDone: () => void }) {
  const [symbolsText, setSymbolsText] = useState('BTCUSDT,ETHUSDT,SOLUSDT')
  const [days, setDays] = useState(14)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BacktestResult | null>(lastBacktest)
  const abort = useRef<AbortController | null>(null)

  async function run() {
    const symbols = [...new Set(symbolsText.toUpperCase().split(/[\s,]+/).filter(Boolean))].slice(0, 10).map((s) => (s.endsWith('USDT') ? s : `${s}USDT`))
    if (symbols.length === 0) {
      setError('Enter at least one symbol, e.g. BTCUSDT.')
      return
    }
    setError(null)
    setRunning(true)
    const ctrl = new AbortController()
    abort.current = ctrl
    const base = normalizeMacdConfig(config)
    const windowStart = Math.floor(Date.now() / 60_000) * 60_000 - days * 86_400_000
    const results = new Map<string, VariantResult>()
    try {
      for (let si = 0; si < symbols.length; si++) {
        const sym = symbols[si]
        const data: Partial<Record<MacdTf, Awaited<ReturnType<typeof fetchHistory>>>> = {}
        for (const tf of base.tfs) {
          setProgress(`${sym} (${si + 1}/${symbols.length}): downloading ${MACD_LABEL[tf]} candles…`)
          data[tf] = await fetchHistory(sym, tf, days + WARMUP_DAYS, { signal: ctrl.signal })
        }
        setProgress(`${sym} (${si + 1}/${symbols.length}): testing ${defaultVariants().length} variants…`)
        await tick()
        for (const r of backtestSymbol(sym, data, base, windowStart)) {
          const k = r.key
          const prev = results.get(k)
          results.set(k, { ...r, signals: [...(prev?.signals ?? []), ...r.signals], rejections: [...(prev?.rejections ?? []), ...r.rejections] })
        }
        await tick()
      }
      const out: BacktestResult = { symbols, days, finishedAt: Date.now(), windowStart, config: base, results: [...results.values()], version: STRATEGY_VERSION }
      lastBacktest = out
      setResult(out)
      setProgress('')
      onDone()
    } catch (e) {
      setError(ctrl.signal.aborted ? 'Cancelled.' : e instanceof Error ? `${e.message}. If Binance is unreachable from this network, nothing was tested.` : 'Back-test failed.')
      setProgress('')
    } finally {
      setRunning(false)
    }
  }

  const table = useMemo(() => {
    if (!result) return []
    return result.results.map((r) => ({ r, rep: buildPerfReport(r.signals) }))
  }, [result])

  const inputCls = 'border-border bg-background h-10 rounded-md border px-2 font-mono text-sm'
  return (
    <div className="flex flex-col gap-3">
      <Section title="Back-test on real Binance history">
        <p className="text-muted-foreground font-mono text-[11px] leading-snug">
          Downloads real futures candles (1M, 3M, 5M, 15M) straight from Binance in your browser (nothing is stored anywhere), then replays the exact live rules candle by candle, with fees and slippage included. Two variants run on the same period: the full Precision strategy and a Basic
          one without the ribbon, entry-quality filters, support / resistance check, score gate and cooldown, so you can see what those extra rules add (or cost).
        </p>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_auto]">
          <label className="text-muted-foreground flex flex-col gap-1 font-mono text-[10px] uppercase">
            Symbols (up to 10, comma separated)
            <input value={symbolsText} onChange={(e) => setSymbolsText(e.target.value)} className={cn(inputCls, 'text-foreground normal-case')} />
          </label>
          <label className="text-muted-foreground flex flex-col gap-1 font-mono text-[10px] uppercase">
            Period
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={cn(inputCls, 'text-foreground')}>
              {[7, 14, 21, 30].map((d) => (
                <option key={d} value={d}>
                  Last {d} days
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-2">
            {running ? (
              <button type="button" onClick={() => abort.current?.abort()} className="border-bear/40 text-bear h-10 rounded-md border px-4 text-sm font-semibold">
                Cancel
              </button>
            ) : (
              <button type="button" onClick={run} className="bg-primary text-primary-foreground h-10 rounded-md px-5 text-sm font-semibold">
                Run back-test
              </button>
            )}
          </div>
        </div>
        {running ? <div className="text-primary font-mono text-xs font-bold">{progress || 'Starting…'}</div> : null}
        {error ? <div className="border-bear/30 bg-bear/10 text-bear rounded-md border p-2 font-mono text-xs">{error}</div> : null}
        <p className="text-muted-foreground font-mono text-[10px] leading-snug">
          MACD {config.fast}/{config.slow}/{config.signal}, Supertrend {config.stPeriod},{config.stMult}, strict 1:2 with the 1M swing stop, minimum score {config.minScore}. The first {WARMUP_DAYS} days downloaded are only indicator warm-up (5M EMA 200, 15M MACD) and are not traded. Longer periods
          download more data and take longer.
        </p>
      </Section>

      {result ? (
        <Section title="Results">
          <p className="text-muted-foreground font-mono text-[10px] leading-snug">
            {result.symbols.join(', ')} · last {result.days} days · finished {new Date(result.finishedAt).toLocaleString([], { hour12: false })}. Open trades are left out of win rate and R. A good result on a short sample is not proof of an edge: repeat with other
            symbols and periods before trusting it.
          </p>
          <div className="border-border overflow-hidden rounded-lg border">
            <div className="bg-secondary/40 text-muted-foreground grid grid-cols-[minmax(0,1.6fr)_2.2rem_2.6rem_2.8rem_3rem_3rem] gap-1 px-2 py-1.5 font-mono text-[9px] uppercase sm:grid-cols-[minmax(0,1.6fr)_3rem_3rem_3.2rem_4rem_4rem_3rem_3.5rem]">
              <span>Variant</span>
              <span className="text-right">Sig</span>
              <span className="text-right">Win%</span>
              <span className="text-right">Avg R</span>
              <span className="text-right">Net R</span>
              <span className="text-right">Max DD</span>
              <span className="hidden text-right sm:block">PF</span>
              <span className="hidden text-right sm:block">Open</span>
            </div>
            {table.map(({ r, rep }) => (
              <div
                key={r.key}
                className={cn(
                  'border-border/60 grid grid-cols-[minmax(0,1.6fr)_2.2rem_2.6rem_2.8rem_3rem_3rem] gap-1 border-t px-2 py-1.5 font-mono text-[11px] sm:grid-cols-[minmax(0,1.6fr)_3rem_3rem_3.2rem_4rem_4rem_3rem_3.5rem]',
                  r.key === 'precision' && 'bg-primary/5',
                )}
              >
                <span className="min-w-0 leading-tight">
                  <span className="font-bold">{r.key === 'precision' ? 'Precision' : 'Basic'}</span> <span className="text-muted-foreground text-[10px]">{r.key === 'precision' ? 'all rules' : 'no ribbon / filters / score'}</span>
                </span>
                <span className="text-right">{rep.total}</span>
                <span className="text-right">{rep.closed ? `${rep.winRate.toFixed(0)}%` : '—'}</span>
                <span className="text-right">{rep.closed ? signed(rep.netR / rep.closed, 2) : '—'}</span>
                <span className={cn('text-right font-bold', rep.netR >= 0 ? 'text-bull' : 'text-bear')}>{rep.closed ? signed(rep.netR, 1) : '—'}</span>
                <span className="text-bear text-right">{rep.closed ? rep.maxDrawdownR.toFixed(1) : '—'}</span>
                <span className="hidden text-right sm:block">{pf(rep)}</span>
                <span className="text-muted-foreground hidden text-right sm:block">{rep.open}</span>
              </div>
            ))}
          </div>
          {table.filter((x) => x.r.key === 'precision').map(({ r }) => <BacktestDetail key={r.key} r={r} result={result} />)}
          <p className="text-muted-foreground font-mono text-[10px] leading-snug">
            Sig = confirmed signals · Avg R = expectancy per closed trade (net of fees and slippage) · PF = profit factor · the shaded row is the strategy. Open the Performance tab for coin-wise, daily, weekly and monthly breakdowns of this run.
          </p>
        </Section>
      ) : null}
    </div>
  )
}

export type { MacdSignal }
