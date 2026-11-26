'use client'

import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_FOCUS, normalizeFocus, type FocusConfig } from '@/lib/focus'

const KEY = 'focus-config-v1'

export function useFocus() {
  const [config, setConfigState] = useState<FocusConfig>(DEFAULT_FOCUS)
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY)
      if (raw) setConfigState(normalizeFocus(JSON.parse(raw)))
    } catch {
      // corrupt storage: keep the defaults
    }
  }, [])
  const setConfig = useCallback((next: Partial<FocusConfig>) => {
    setConfigState((prev) => {
      const merged = normalizeFocus({ ...prev, ...next })
      try {
        window.localStorage.setItem(KEY, JSON.stringify(merged))
      } catch {
        // storage unavailable: settings last for this visit only
      }
      return merged
    })
  }, [])
  return { config, setConfig }
}
