'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MACD_LABEL } from '@/lib/macdmtf'
import type { ClassicRow, ClassicSignal } from '@/lib/macd5m'
import type { PopupMode } from '@/hooks/use-macd-alerts'

const SEEN_KEY = 'classic-seen-v1'
const LOG_KEY = 'classic-alert-log-v1'
const PREFS_KEY = 'classic-alert-prefs-v1'
const TG_KEY = 'classic-telegram-v1'
const MAX_SEEN = 500
const MAX_LOG = 100

export interface ClassicPopup {
  signal: ClassicSignal
  row: ClassicRow
}

export interface ClassicLogEntry {
  id: string
  symbol: string
  side: 'BUY' | 'SELL'
  entry: number
  sl: number
  tp: number
  rr: number
  signalTime: number
  alertedAt: number
}

export interface Prefs {
  enableBuy: boolean
  enableSell: boolean
  sound: boolean
  popupMode: PopupMode
}
const DEFAULT_PREFS: Prefs = { enableBuy: true, enableSell: true, sound: true, popupMode: 'banner' }

export interface TelegramPrefs {
  enabled: boolean
  token: string
  chatId: string
}
const DEFAULT_TG: TelegramPrefs = { enabled: false, token: '', chatId: '' }

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage can be unavailable (private mode)
  }
}

const num = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(2) : Math.abs(v) >= 1 ? v.toFixed(4) : v.toPrecision(5))
const rrText = (rr: number) => `1:${Number.isInteger(rr) ? rr : rr.toFixed(2).replace(/0$/, '')}`

/** The alert text, in the format of the specification. */
export function alertMessage(s: ClassicSignal): string {
  const bull = s.side === 'BUY'
  return [
    `${s.side} SIGNAL — ${s.symbol}`,
    '',
    `${MACD_LABEL[s.confirmTf]} MACD: ${bull ? 'BULLISH' : 'BEARISH'}`,
    `${MACD_LABEL[s.entryTf]} MACD: ${bull ? 'BULLISH' : 'BEARISH'} CROSSOVER`,
    `EMA 200: ${s.ema.position}`,
    `Supertrend: ${bull ? 'BULLISH' : 'BEARISH'}`,
    '',
    `Entry: ${num(s.entry)}`,
    `Stop Loss: ${num(s.sl)}`,
    `Take Profit: ${num(s.tp)}`,
    `RR: ${rrText(s.rr)}`,
  ].join('\n')
}

async function notify(title: string, body: string, tag: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    // Phones (Android Chrome) only allow notifications through a service worker registration.
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) {
      await reg.showNotification(title, { body, tag, icon: '/icon-192.png', vibrate: [200, 100, 200] } as NotificationOptions)
      return
    }
  } catch {
    // fall through to the page-level API
  }
  try {
    new Notification(title, { body, tag })
  } catch {
    // not allowed in this context
  }
}

/**
 * Watches every refresh for a NEW confirmed signal (closed-candle signals only, so never during candle formation).
 * One alert per signal id; ids persist so a reload never repeats one. Fires: popup, sound, browser / phone notification,
 * optional Telegram message and an entry in the alert log.
 */
export function useClassicAlerts(rows: ClassicRow[] | undefined) {
  const [popups, setPopups] = useState<ClassicPopup[]>([])
  const [log, setLog] = useState<ClassicLogEntry[]>([])
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default')
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS)
  const [telegram, setTelegramState] = useState<TelegramPrefs>(DEFAULT_TG)
  const [tgStatus, setTgStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const seen = useRef<Set<string> | null>(null)
  const prefsRef = useRef<Prefs>(DEFAULT_PREFS)
  const tgRef = useRef<TelegramPrefs>(DEFAULT_TG)

  useEffect(() => {
    seen.current = new Set(read<string[]>(SEEN_KEY, []))
    setLog(read<ClassicLogEntry[]>(LOG_KEY, []))
    setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
    const p = { ...DEFAULT_PREFS, ...read<Partial<Prefs>>(PREFS_KEY, {}) }
    prefsRef.current = p
    setPrefsState(p)
    const t = { ...DEFAULT_TG, ...read<Partial<TelegramPrefs>>(TG_KEY, {}) }
    tgRef.current = t
    setTelegramState(t)
  }, [])

  const chime = useCallback((side: 'BUY' | 'SELL' | 'TEST') => {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctx()
      const notes = side === 'BUY' ? [660, 880] : side === 'SELL' ? [880, 660] : [770]
      notes.forEach((f, i) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = f
        const t = ctx.currentTime + i * 0.18
        gain.gain.setValueAtTime(0.001, t)
        gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start(t)
        osc.stop(t + 0.35)
      })
    } catch {
      // the browser may block audio until the page has been interacted with
    }
  }, [])

  /** Sends one message to the user's own Telegram bot (token and chat id live only in this browser). */
  const sendTelegram = useCallback(async (text: string) => {
    const t = tgRef.current
    if (!t.token || !t.chatId) return false
    try {
      const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(t.token)}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: t.chatId, text }),
      })
      const ok = res.ok
      setTgStatus({ ok, text: ok ? `Sent ${new Date().toLocaleTimeString([], { hour12: false })}` : `Telegram refused the message (HTTP ${res.status}) — check the token and chat id` })
      return ok
    } catch {
      setTgStatus({ ok: false, text: 'Could not reach Telegram from this browser' })
      return false
    }
  }, [])

  useEffect(() => {
    if (!rows || rows.length === 0 || !seen.current) return
    const fresh: ClassicPopup[] = []
    for (const row of rows) {
      const s = row.signal
      if (s && !seen.current.has(s.id)) {
        seen.current.add(s.id)
        const p = prefsRef.current
        if ((s.side === 'BUY' && !p.enableBuy) || (s.side === 'SELL' && !p.enableSell)) continue
        fresh.push({ signal: s, row })
      }
    }
    write(SEEN_KEY, [...seen.current].slice(-MAX_SEEN))
    if (fresh.length === 0) return
    if (prefsRef.current.popupMode !== 'off') setPopups((prev) => [...fresh, ...prev].slice(0, 8))
    const entries: ClassicLogEntry[] = fresh.map(({ signal: s }) => ({ id: s.id, symbol: s.symbol, side: s.side, entry: s.entry, sl: s.sl, tp: s.tp, rr: s.rr, signalTime: s.time, alertedAt: Date.now() }))
    setLog((prev) => {
      const next = [...entries, ...prev].slice(0, MAX_LOG)
      write(LOG_KEY, next)
      return next
    })
    for (const { signal: s } of fresh) {
      void notify(`${s.side} SIGNAL — ${s.symbol}`, alertMessage(s).split('\n').slice(2).join('\n'), s.id)
      if (tgRef.current.enabled) void sendTelegram(alertMessage(s))
    }
    if (prefsRef.current.sound) chime(fresh[0].signal.side)
    // Browsers only allow vibration after the user has interacted with the page.
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.([200, 100, 200])
  }, [rows, chime, sendTelegram])

  const setPrefs = useCallback((p: Partial<Prefs>) => {
    const next = { ...prefsRef.current, ...p }
    prefsRef.current = next
    setPrefsState(next)
    write(PREFS_KEY, next)
    if (next.popupMode === 'off') setPopups([])
  }, [])

  const setTelegram = useCallback((p: Partial<TelegramPrefs>) => {
    const next = { ...tgRef.current, ...p }
    tgRef.current = next
    setTelegramState(next)
    write(TG_KEY, next)
  }, [])

  const requestPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return
    setPermission(await Notification.requestPermission())
  }, [])

  /** Plays the sound and sends a clearly labelled TEST notification. No signal is created or logged. */
  const sendTest = useCallback(() => {
    chime('TEST')
    void notify('TEST — alerts are working', 'This is only a test. No trade signal was generated.', `test-${Date.now()}`)
  }, [chime])

  const sendTelegramTest = useCallback(() => sendTelegram('TEST — alerts are working. This is only a test, no trade signal was generated.'), [sendTelegram])

  const dismiss = useCallback((id: string) => setPopups((p) => p.filter((x) => x.signal.id !== id)), [])
  const dismissAll = useCallback(() => setPopups([]), [])
  const clearLog = useCallback(() => {
    setLog([])
    write(LOG_KEY, [])
  }, [])

  return { popups, dismiss, dismissAll, log, clearLog, permission, requestPermission, prefs, setPrefs, telegram, setTelegram, tgStatus, sendTest, sendTelegramTest }
}

export type ClassicAlerts = ReturnType<typeof useClassicAlerts>
