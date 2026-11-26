// 5-coin Focus Mode. Pure logic (no I/O): watchlist rules, discipline limits and ranking.
// The point is fewer decisions, not more profit: nothing here predicts or promises anything.

export const MAX_FOCUS = 5
export const DEFAULT_WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT']

export interface FocusConfig {
  enabled: boolean
  /** At most MAX_FOCUS USDT-M perpetuals. */
  watchlist: string[]
  /** Open positions allowed at once (journal trades with status OPEN). */
  maxConcurrent: number
  /** New trades allowed per local day (0 = no limit). */
  dailyLimit: number
  /** Minutes to stand aside after a losing trade (0 = off). */
  lossCooldownMin: number
}

export const DEFAULT_FOCUS: FocusConfig = { enabled: true, watchlist: DEFAULT_WATCHLIST, maxConcurrent: 1, dailyLimit: 3, lossCooldownMin: 0 }

/** "doge", "DOGE/USDT", "dogeusdt" -> "DOGEUSDT". Invalid entries are dropped, duplicates removed, never more than MAX_FOCUS. */
export function normalizeWatchlist(input: unknown): string[] {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : []
  const out: string[] = []
  for (const x of list) {
    let s = String(x ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!s || s.length > 20) continue
    if (!s.endsWith('USDT')) s += 'USDT'
    if (s === 'USDT' || out.includes(s)) continue
    out.push(s)
    if (out.length === MAX_FOCUS) break
  }
  return out.length ? out : [...DEFAULT_WATCHLIST]
}

export function normalizeFocus(p: Partial<Record<keyof FocusConfig, unknown>> = {}): FocusConfig {
  const n = (v: unknown, lo: number, hi: number, d: number) => {
    const x = Number(v)
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d
  }
  return {
    enabled: p.enabled === undefined ? DEFAULT_FOCUS.enabled : p.enabled === true || p.enabled === 'true',
    watchlist: p.watchlist === undefined ? [...DEFAULT_WATCHLIST] : normalizeWatchlist(p.watchlist),
    maxConcurrent: n(p.maxConcurrent, 1, 5, DEFAULT_FOCUS.maxConcurrent),
    dailyLimit: n(p.dailyLimit, 0, 50, DEFAULT_FOCUS.dailyLimit),
    lossCooldownMin: n(p.lossCooldownMin, 0, 1440, DEFAULT_FOCUS.lossCooldownMin),
  }
}

export interface JournalTrade {
  status: string
  side: string
  entry: number
  exit: number | null
  openedAt: number
  closedAt: number | null
}

export interface Gate {
  allowed: boolean
  reason: string | null
  open: number
  today: number
  cooldownUntil: number | null
}

const lost = (t: JournalTrade) => t.exit !== null && (t.side === 'LONG' ? t.exit < t.entry : t.exit > t.entry)

/** May a NEW trade be taken right now? Checks concurrent positions, the daily limit and the optional loss cooldown. */
export function focusGate(cfg: FocusConfig, trades: JournalTrade[], now: number): Gate {
  const d = new Date(now)
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const open = trades.filter((t) => t.status === 'OPEN').length
  const today = trades.filter((t) => t.openedAt >= dayStart).length
  const lastLoss = trades.filter((t) => t.status === 'CLOSED' && t.closedAt !== null && lost(t)).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))[0]
  const cooldownUntil = cfg.lossCooldownMin > 0 && lastLoss?.closedAt ? lastLoss.closedAt + cfg.lossCooldownMin * 60_000 : null
  let reason: string | null = null
  if (open >= cfg.maxConcurrent) reason = `MAX ${cfg.maxConcurrent} OPEN POSITION${cfg.maxConcurrent === 1 ? '' : 'S'} REACHED`
  else if (cfg.dailyLimit > 0 && today >= cfg.dailyLimit) reason = `DAILY LIMIT OF ${cfg.dailyLimit} TRADES REACHED`
  else if (cooldownUntil !== null && cooldownUntil > now) reason = `COOLING DOWN AFTER A LOSS (${Math.ceil((cooldownUntil - now) / 60_000)} MIN LEFT)`
  return { allowed: reason === null, reason, open, today, cooldownUntil: cooldownUntil !== null && cooldownUntil > now ? cooldownUntil : null }
}

export interface Rankable {
  symbol: string
  score: number | null
  netRR: number | null
  liquidity: number
}

/** Quality score first, then liquidity, then net RR (all descending); stable for ties. */
export function rankSetups<T extends Rankable>(items: T[]): T[] {
  return items
    .map((x, i) => ({ x, i }))
    .sort((a, b) => (b.x.score ?? -1) - (a.x.score ?? -1) || b.x.liquidity - a.x.liquidity || (b.x.netRR ?? -1) - (a.x.netRR ?? -1) || a.i - b.i)
    .map((q) => q.x)
}

import type { MacdRow } from './macdmtf'

export interface FocusPlan {
  /** Rows of the selected coins only, in watchlist order. */
  rows: MacdRow[]
  /** Fresh confirmed setups, best first. */
  ranked: MacdRow[]
  /** The single best active setup (null = NO SETUP — WAIT PATIENTLY). */
  primary: MacdRow | null
  /** The setup is real but the discipline limits say stand aside. */
  blocked: boolean
  gate: Gate
}

export function buildFocusPlan(rows: MacdRow[] | undefined, cfg: FocusConfig, trades: JournalTrade[], now: number): FocusPlan {
  const mine = cfg.watchlist.map((s) => (rows ?? []).find((r) => r.symbol === s)).filter((r): r is MacdRow => Boolean(r))
  const ranked = rankSetups(
    mine
      .filter((r) => r.signal)
      .map((r) => Object.assign(r, { score: r.signal!.score, netRR: r.signal!.netRR, liquidity: r.liquidityUsd }) as MacdRow & Rankable),
  )
  const gate = focusGate(cfg, trades, now)
  return { rows: mine, ranked, primary: ranked[0] && gate.allowed ? ranked[0] : null, blocked: ranked.length > 0 && !gate.allowed, gate }
}
