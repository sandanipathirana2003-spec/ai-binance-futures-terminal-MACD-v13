// Back-test the MACD multi-timeframe confirmation strategy on real Binance futures history.
//
//   npx tsx scripts/backtest-macd.ts --symbols BTCUSDT,ETHUSDT,SOLUSDT --days 14
//
// Options: --fee 4 --slip 2 (bps per side)  --min-score 85  --csv trades.csv
// Both variants (Precision = all rules, Basic = MACD + EMA 200 + Supertrend + stop only) run on the same window.
// Entry = 1M candle close; SL = 1M swing low / high (+ATR buffer); TP = 1:2; SL/TP in one candle -> stop first.
import { writeFileSync } from 'node:fs'
import { WARMUP_DAYS, backtestSymbol, defaultVariants, fetchHistory } from '../lib/macd-backtest'
import { buildPerfReport } from '../lib/macd-perf'
import { normalizeMacdConfig, type MacdSignal, type MacdTf } from '../lib/macdmtf'

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > 0 ? process.argv[i + 1] : d
}

async function main() {
  const symbols = (arg('symbols', 'BTCUSDT,ETHUSDT,SOLUSDT') as string).split(',').map((s) => s.trim().toUpperCase())
  const days = Number(arg('days', '14'))
  const base = { feeBps: Number(arg('fee', '4')), slipBps: Number(arg('slip', '2')), ...(arg('min-score') ? { minScore: Number(arg('min-score')) } : {}) }
  const need = normalizeMacdConfig(base).tfs
  const windowStart = Date.now() - days * 86_400_000
  const variants = defaultVariants()
  const all = variants.map(() => [] as MacdSignal[])

  for (const symbol of symbols) {
    const data: Partial<Record<MacdTf, Awaited<ReturnType<typeof fetchHistory>>>> = {}
    for (const tf of need) data[tf] = await fetchHistory(symbol, tf, days + WARMUP_DAYS)
    backtestSymbol(symbol, data, base, windowStart, variants).forEach((r, i) => all[i].push(...r.signals))
    console.log(`fetched ${symbol}`)
  }

  console.log('\nvariant                                  trades  win%    PF    netR   maxDD(R)  avgHold(min)')
  variants.forEach((v, i) => {
    const p = buildPerfReport(all[i])
    const name = v.label.slice(0, 38).padEnd(38)
    console.log(`${name} ${String(p.closed).padStart(5)} ${p.winRate.toFixed(1).padStart(6)} ${(p.profitFactor === null ? '-' : p.profitFactor.toFixed(2)).padStart(5)} ${p.netR.toFixed(2).padStart(7)} ${p.maxDrawdownR.toFixed(2).padStart(8)} ${p.avgHoldMin.toFixed(0).padStart(10)}`)
  })

  const csv = arg('csv')
  if (csv) {
    const rows = ['symbol,side,variant,time,entry,sl,tp,score,result,r']
    variants.forEach((v, i) => all[i].forEach((s) => rows.push([s.symbol, s.side, v.key, new Date(s.time).toISOString(), s.entry, s.sl, s.tp, s.score, s.outcome.result, s.outcome.r.toFixed(3)].join(','))))
    writeFileSync(csv, rows.join('\n'))
    console.log(`wrote ${csv}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
