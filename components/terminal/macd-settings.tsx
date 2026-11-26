'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { CORE_TFS, DEFAULT_MACD, STRATEGY_VERSION, EXTRA_TFS, MACD_LABEL, RR, normalizeMacdConfig, type MacdConfig, type MacdTf } from '@/lib/macdmtf'
import { Section } from './macd-ui'

type NumKey = 'fast' | 'slow' | 'signal' | 'stPeriod' | 'stMult' | 'minScore' | 'minNetRR' | 'maxRiskPct' | 'maxCrossAge' | 'cooldownBars' | 'nearEmaAtr' | 'minLiqUsd' | 'feeBps' | 'slipBps' | 'impLen' | 'rsiLen' | 'rsiBull' | 'latencyMs' | 'sidewaysHits' | 'adxMax' | 'squeezePct' | 'atrContract' | 'volContract' | 'rangeAtr'
const NUM_FIELDS: Array<{ key: NumKey; label: string; step: number; hint?: string }> = [
  { key: 'minScore', label: 'Minimum quality score (0-100)', step: 1, hint: 'Alerts need at least this score. Default 85.' },
  { key: 'minNetRR', label: 'Minimum net RR after fees', step: 0.05, hint: 'The target is always 1:2 gross. This rejects stops so tight that fees eat the trade.' },
  { key: 'maxRiskPct', label: 'Widest stop (% of price)', step: 0.1 },
  { key: 'cooldownBars', label: 'Cooldown per coin (minutes)', step: 1, hint: 'Default 15. One 1M bar = one minute.' },
  { key: 'maxCrossAge', label: '1M crossover max age (bars)', step: 1, hint: '0 = the crossover must be on the signal candle (no late entries)' },
  { key: 'nearEmaAtr', label: '5M EMA 200 "too close" (ATR)', step: 0.05 },
  { key: 'minLiqUsd', label: 'Min liquidity (USDT / minute)', step: 500 },
  { key: 'feeBps', label: 'Fee (bps per side)', step: 1 },
  { key: 'slipBps', label: 'Slippage (bps per side)', step: 1 },
  { key: 'latencyMs', label: 'Execution latency (ms)', step: 100, hint: 'Expected adverse drift while the order is placed, added to the trade cost.' },
  { key: 'sidewaysHits', label: 'Sideways: tests that must hit (of 8)', step: 1 },
  { key: 'adxMax', label: 'Sideways: 5M ADX below', step: 1 },
  { key: 'squeezePct', label: 'Sideways: ribbon spread below (%)', step: 0.05 },
  { key: 'atrContract', label: 'Sideways: ATR below x of average', step: 0.05 },
  { key: 'volContract', label: 'Sideways: volume below x of average', step: 0.05 },
  { key: 'rangeAtr', label: 'Sideways: 30-bar range below (ATR)', step: 0.5 },
  { key: 'impLen', label: 'Impulse MACD length', step: 1, hint: 'LazyBear: smma of high / low and zlema of close, default 34' },
  { key: 'rsiLen', label: 'RSI length', step: 1 },
  { key: 'rsiBull', label: 'RSI threshold (BUY above, SELL below 100 minus this)', step: 1 },
  { key: 'fast', label: 'Classic MACD fast', step: 1 },
  { key: 'slow', label: 'Classic MACD slow', step: 1 },
  { key: 'signal', label: 'MACD signal length', step: 1 },
  { key: 'stPeriod', label: 'Supertrend ATR period', step: 1 },
  { key: 'stMult', label: 'Supertrend multiplier', step: 0.5 },
]

export function SettingsTab({ config, onApply }: { config: MacdConfig; onApply: (c: Partial<MacdConfig>) => void }) {
  const [d, setD] = useState<MacdConfig>(config)
  useEffect(() => setD(config), [config])
  const lab = 'text-muted-foreground flex flex-col gap-1 font-mono text-[10px] uppercase'
  const toggle = (tf: MacdTf) => setD({ ...d, tfs: d.tfs.includes(tf) ? d.tfs.filter((t) => t !== tf) : [...d.tfs, tf] })
  const preview = normalizeMacdConfig(d)
  return (
    <div className="flex flex-col gap-3">
      <Section title="Strategy settings">
        <div>
          <div className="text-muted-foreground mb-1 font-mono text-[10px] uppercase">Timeframes</div>
          <div className="grid grid-cols-5 gap-1.5">
            {(['1m', '3m', '5m', '15m', '30m'] as MacdTf[]).map((tf) => {
              const core = CORE_TFS.includes(tf)
              const on = preview.tfs.includes(tf)
              return (
                <button
                  key={tf}
                  type="button"
                  disabled={core}
                  onClick={() => toggle(tf)}
                  className={cn('h-11 rounded-md border font-mono text-xs font-bold', on ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground', core && 'opacity-80')}
                >
                  {MACD_LABEL[tf]}
                </button>
              )
            })}
          </div>
          <p className="text-muted-foreground mt-1 font-mono text-[10px] leading-snug">
            1M = entry timing, 3M = early momentum, 5M = trend confirmation (MACD, EMA 200, ribbon, stop reference), 15M = higher-timeframe filter. These four are always on. {EXTRA_TFS.map((t) => MACD_LABEL[t]).join(' and ')} are optional: when enabled, their MACD must not strongly oppose the trade.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {NUM_FIELDS.map((f) => (
            <label key={f.key} className={lab} title={f.hint}>
              {f.label}
              <input
                type="number"
                inputMode="decimal"
                step={f.step}
                value={d[f.key]}
                onChange={(e) => setD({ ...d, [f.key]: Number(e.target.value) })}
                className="border-border bg-background text-foreground h-10 rounded-md border px-2 text-sm normal-case"
              />
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-3 font-mono text-[11px]">
          <label className="flex items-center gap-2">Indicator
            <select value={d.indicator} onChange={(e) => setD({ ...d, indicator: e.target.value === 'normal' ? 'normal' : 'impulse' })} className="border-border bg-background h-10 rounded-md border px-2"><option value="impulse">LazyBear Impulse MACD</option><option value="normal">Classic MACD 12/26/9</option></select>
          </label>
          <label className="flex items-center gap-2"><input type="checkbox" className="size-5" checked={d.rsiOn} onChange={(e) => setD({ ...d, rsiOn: e.target.checked })} /> RSI confirmation (1M / 5M / 15M)</label>
          <label className="flex items-center gap-2"><input type="checkbox" className="size-5" checked={d.sidewaysOn} onChange={(e) => setD({ ...d, sidewaysOn: e.target.checked })} /> Sideways filter on</label>
          <label className="flex items-center gap-2">Ribbon pairs needed
            <select value={d.ribbonMin} onChange={(e) => setD({ ...d, ribbonMin: Number(e.target.value) === 2 ? 2 : 3 })} className="border-border bg-background h-10 rounded-md border px-2"><option value={3}>3 (full stack)</option><option value={2}>2 (mostly stacked)</option></select>
          </label>
          <span className="text-muted-foreground">Strategy version {STRATEGY_VERSION}</span>
        </div>
        <div className="border-border text-muted-foreground rounded-md border p-2 font-mono text-[11px] leading-snug">
          Risk : reward is fixed at 1 : {RR}. The stop sits beyond the latest 1M swing low / high (plus an ATR buffer, never inside a noise floor) and is checked against the 5M Supertrend. Fees matter a lot on a 1M entry: with {preview.feeBps + preview.slipBps} bps per side a stop
          needs to be roughly {(((2 * (preview.feeBps + preview.slipBps)) / 100) * ((1 + preview.minNetRR) / (RR - preview.minNetRR))).toFixed(2)}% of price or wider to keep a net RR of {preview.minNetRR}. Quiet coins therefore show WAIT.
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => onApply(d)} className="bg-primary text-primary-foreground h-10 flex-1 rounded-md text-sm font-semibold">
            Apply
          </button>
          <button type="button" onClick={() => onApply({})} className="border-border text-muted-foreground h-10 rounded-md border px-4 text-sm font-semibold">
            Reset defaults ({DEFAULT_MACD.minScore}+ score)
          </button>
        </div>
        <p className="text-muted-foreground font-mono text-[10px] leading-snug">
          The priority order is fixed: 15M MACD, 5M MACD, fresh 1M crossover, 5M EMA 200, EMA ribbon, Supertrend 12,4, stop validated by structure, 1:2 target, risk filters, sideways filter, quality score, cooldown. If any critical check fails the dashboard shows WAIT — NO TRADE. Sound, popup style and
          notifications are on the Alerts tab. Settings are saved in this browser.
        </p>
      </Section>
    </div>
  )
}
