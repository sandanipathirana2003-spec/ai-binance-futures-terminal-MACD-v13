'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Z15Row, Z15Signal } from '@/lib/zero15'

const SEEN_KEY = 'z15-seen-v1'
const SOUND_KEY = 'z15-sound-v1'
const LOG_KEY = 'z15-log-v1'
const POPUP_KEY = 'z15-popup-v1'

export interface Z15Popup {
  id: string
  signal: Z15Signal
}

export interface Z15LogEntry {
  id: string
  symbol: string
  side: 'BUY' | 'SELL'
  time: number
  entry: number
  sl: number
  tp: number
  score: number
}

function read<T>(k: string, d: T): T {
  try {
    const v = window.localStorage.getItem(k)
    return v ? (JSON.parse(v) as T) : d
  } catch {
    return d
  }
}
function write(k: string, v: unknown) {
  try {
    window.localStorage.setItem(k, JSON.stringify(v))
  } catch {
    // storage unavailable
  }
}

function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.connect(g)
    g.connect(ctx.destination)
    o.frequency.value = 880
    g.gain.value = 0.08
    o.start()
    o.stop(ctx.currentTime + 0.18)
  } catch {
    // audio blocked until the first user gesture
  }
}

/** One popup per confirmed 5M crossover: the signal id (which contains the cross time) is remembered, so reloads and refreshes never repeat it. */
export function useZ15Alerts(rows: Z15Row[] | undefined) {
  const [popups, setPopups] = useState<Z15Popup[]>([])
  const [log, setLog] = useState<Z15LogEntry[]>([])
  const [sound, setSound] = useState(true)
  const [popupOn, setPopupOn] = useState(true)
  const popupRef = useRef(true)
  const seen = useRef<Set<string> | null>(null)
  const soundRef = useRef(true)

  useEffect(() => {
    seen.current = new Set(read<string[]>(SEEN_KEY, []))
    setLog(read<Z15LogEntry[]>(LOG_KEY, []))
    const s = read<boolean>(SOUND_KEY, true)
    setSound(s)
    soundRef.current = s
    const pp = read<boolean>(POPUP_KEY, true)
    setPopupOn(pp)
    popupRef.current = pp
  }, [])

  useEffect(() => {
    if (!rows || !seen.current) return
    const fresh: Z15Signal[] = []
    for (const r of rows) if (r.signal && !seen.current.has(r.signal.id)) fresh.push(r.signal)
    if (!fresh.length) return
    for (const s of fresh) seen.current.add(s.id)
    write(SEEN_KEY, [...seen.current].slice(-300))
    if (popupRef.current) setPopups((p) => [...fresh.map((signal) => ({ id: signal.id, signal })), ...p].slice(0, 6))
    setLog((l) => {
      const next = [...fresh.map((s) => ({ id: s.id, symbol: s.symbol, side: s.side, time: s.time, entry: s.entry, sl: s.sl, tp: s.tp, score: s.score })), ...l].slice(0, 200)
      write(LOG_KEY, next)
      return next
    })
    if (soundRef.current) beep()
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') for (const s of fresh) new Notification(`${s.side} ${s.symbol.replace('USDT', '')}`, { body: `Entry ${s.entry} · SL ${s.sl.toPrecision(6)} · TP ${s.tp.toPrecision(6)}`, tag: s.id })
    } catch {
      // notifications unsupported
    }
  }, [rows])

  const dismiss = useCallback((id: string) => setPopups((p) => p.filter((x) => x.id !== id)), [])
  const toggleSound = useCallback(() => {
    setSound((v) => {
      write(SOUND_KEY, !v)
      soundRef.current = !v
      return !v
    })
  }, [])
  const togglePopup = useCallback(() => {
    setPopupOn((v) => {
      write(POPUP_KEY, !v)
      popupRef.current = !v
      if (v) setPopups([])
      return !v
    })
  }, [])
  return { popups, log, sound, toggleSound, dismiss, popupOn, togglePopup }
}

export type Z15Alerts = ReturnType<typeof useZ15Alerts>
