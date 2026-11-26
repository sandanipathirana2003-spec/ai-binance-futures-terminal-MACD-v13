'use client'

import { useCallback, useEffect, useState } from 'react'
import useSWR from 'swr'
import { DEFAULT_Z15, normalizeZ15, type Z15Config } from '@/lib/zero15'
import type { Z15Response } from '@/app/api/z15/route'

const KEY = 'z15-config-v1'

const fetcher = async (url: string): Promise<Z15Response> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error('Failed to load 15M/5M data')
  return res.json()
}

function toQuery(cfg: Z15Config, symbols?: string[]): string {
  const q = new URLSearchParams()
  for (const k of Object.keys(DEFAULT_Z15) as Array<keyof Z15Config>) if (cfg[k] !== DEFAULT_Z15[k]) q.set(k, String(cfg[k]))
  if (symbols && symbols.length) q.set('symbols', symbols.slice(0, 5).join(','))
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** `symbols` = the Focus Mode watchlist (max 5); without it the 50 most liquid pairs are scanned. */
export function useZ15(symbols?: string[]) {
  const [config, setConfigState] = useState<Z15Config>(DEFAULT_Z15)
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY)
      if (raw) setConfigState(normalizeZ15(JSON.parse(raw)))
    } catch {
      // corrupt storage: defaults
    }
  }, [])
  const setConfig = useCallback((next: Partial<Z15Config>) => {
    setConfigState((prev) => {
      const merged = normalizeZ15({ ...prev, ...next })
      try {
        window.localStorage.setItem(KEY, JSON.stringify(merged))
      } catch {
        // storage unavailable
      }
      return merged
    })
  }, [])
  const { data, error, isLoading } = useSWR<Z15Response>(`/api/z15${toQuery(config, symbols)}`, fetcher, { refreshInterval: 30000, revalidateOnFocus: true, keepPreviousData: true })
  return { data, isLoading, isError: Boolean(error), config, setConfig }
}
