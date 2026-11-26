'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { classicKey, type ClassicConfig, type ClassicRow, type ClassicSignal } from '@/lib/macd5m'

// Signal history kept in THIS browser. Every refresh, the signals the engine found on the real candles (about 40 hours of
// 5M candles) are merged by id, so history keeps growing while the page is used and outcomes get updated when trades close.
// There is no server database: clearing site data clears the history. Settings that change what a signal is start a new list.
const KEY = 'classic-history-v1'
const MAX = 1500

interface Stored {
  cfgKey: string
  signal: ClassicSignal
}

function read(): Stored[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Stored[]) : []
  } catch {
    return []
  }
}

export function useClassicHistory(rows: ClassicRow[] | undefined, config: ClassicConfig) {
  const [all, setAll] = useState<Stored[]>([])
  const loaded = useRef(false)
  const cfgKey = classicKey(config)

  useEffect(() => {
    setAll(read())
    loaded.current = true
  }, [])

  useEffect(() => {
    if (!loaded.current || !rows || rows.length === 0) return
    setAll((prev) => {
      const map = new Map(prev.map((s) => [`${s.cfgKey}#${s.signal.id}`, s]))
      for (const r of rows) {
        // the row carries the 20 newest signals of the pair; open ones are always included
        for (const s of [...r.history, ...r.open]) map.set(`${cfgKey}#${s.id}`, { cfgKey, signal: { ...s, barsAgo: 0 } })
      }
      const next = [...map.values()].sort((a, b) => b.signal.time - a.signal.time).slice(0, MAX)
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        // storage full or unavailable: history then lives for this visit only
      }
      return next
    })
  }, [rows, cfgKey])

  const clear = useCallback(() => {
    setAll((prev) => {
      const next = prev.filter((s) => s.cfgKey !== cfgKey)
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        // ignore
      }
      return next
    })
  }, [cfgKey])

  return { signals: all.filter((s) => s.cfgKey === cfgKey).map((s) => s.signal), clear }
}
