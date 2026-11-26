'use client'

import { useEffect, useState } from 'react'
import type { Candle } from '@/lib/binance'
import { MACD_MS, type MacdTf } from '@/lib/macdmtf'

/**
 * Closed candles of ONE symbol for the price chart, fetched straight from Binance by the browser (public, CORS-enabled).
 * The forming candle is dropped so the chart only ever shows what the signals are built from.
 */
export function useChartCandles(symbol: string | undefined, tf: MacdTf, bars = 300) {
  const [candles, setCandles] = useState<Candle[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!symbol) return
    let stop = false
    const load = async () => {
      try {
        const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${tf}&limit=${bars + 1}`)
        if (!res.ok) throw new Error(String(res.status))
        const raw = (await res.json()) as unknown[][]
        const ms = MACD_MS[tf]
        const list = raw
          .map((k) => ({ openTime: k[0] as number, open: +(k[1] as string), high: +(k[2] as string), low: +(k[3] as string), close: +(k[4] as string), volume: +(k[5] as string) }))
          .filter((c) => c.openTime + ms <= Date.now())
        if (!stop) {
          setCandles(list)
          setError(false)
        }
      } catch {
        if (!stop) setError(true)
      }
    }
    setCandles(null)
    void load()
    const id = setInterval(load, 15_000)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [symbol, tf, bars])

  return { candles, error }
}
