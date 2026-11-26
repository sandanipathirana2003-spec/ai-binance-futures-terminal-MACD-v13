'use client'

import { useCallback, useEffect, useState } from 'react'
import useSWR from 'swr'
import { DEFAULT_CLASSIC, normalizeClassic, type ClassicConfig } from '@/lib/macd5m'
import type { ClassicResponse } from '@/app/api/classic/route'

const KEY = 'classic-config-v1'

const fetcher = async (url: string): Promise<ClassicResponse> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error('Failed to load 5M MACD data')
  return res.json()
}

/** Only settings that differ from the defaults go into the URL (keeps the SWR key short and stable). */
function toQuery(cfg: ClassicConfig): string {
  const q = new URLSearchParams()
  for (const k of Object.keys(DEFAULT_CLASSIC) as Array<keyof ClassicConfig>) {
    if (JSON.stringify(cfg[k]) !== JSON.stringify(DEFAULT_CLASSIC[k])) q.set(k, String(cfg[k]))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** `enabled = false` stops all fetching (only the strategy that is on screen polls Binance). */
export function useClassic(enabled = true) {
  const [config, setConfigState] = useState<ClassicConfig>(DEFAULT_CLASSIC)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY)
      if (raw) setConfigState(normalizeClassic(JSON.parse(raw)))
    } catch {
      // ignore corrupt storage
    }
  }, [])

  const setConfig = useCallback((next: Partial<ClassicConfig>) => {
    const merged = normalizeClassic(next)
    setConfigState(merged)
    try {
      window.localStorage.setItem(KEY, JSON.stringify(merged))
    } catch {
      // storage can be unavailable (private mode): settings then last for this visit only
    }
  }, [])

  const { data, error, isLoading } = useSWR<ClassicResponse>(enabled ? `/api/classic${toQuery(config)}` : null, fetcher, {
    refreshInterval: 20000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  })
  return { data, isLoading: enabled && isLoading, isError: Boolean(error), config, setConfig }
}
