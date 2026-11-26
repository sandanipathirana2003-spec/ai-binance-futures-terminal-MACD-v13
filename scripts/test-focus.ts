import { DEFAULT_FOCUS, DEFAULT_WATCHLIST, MAX_FOCUS, focusGate, normalizeFocus, normalizeWatchlist, rankSetups, type JournalTrade } from '../lib/focus'

let fail = 0
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fail++ }

ok(normalizeWatchlist(undefined).join() === DEFAULT_WATCHLIST.join(), 'default watchlist is BTC, ETH, SOL, BNB, XRP')
ok(normalizeWatchlist(['btc', 'eth/usdt', 'SOLUSDT', 'doge', 'avax', 'link', 'ada']).length === MAX_FOCUS, 'never more than 5 coins, however many are given')
ok(normalizeWatchlist('btc,btc,BTCUSDT,,usdt,<script>').join() === 'BTCUSDT,SCRIPTUSDT', 'duplicates, empty and the bare "USDT" are dropped, symbols are cleaned')
ok(normalizeWatchlist([]).join() === DEFAULT_WATCHLIST.join() && normalizeWatchlist(['!!!']).length === 5, 'an empty or invalid list falls back to the default')
const c = normalizeFocus({ maxConcurrent: 99, dailyLimit: -4, lossCooldownMin: 'x', watchlist: ['a', 'b', 'c', 'd', 'e', 'f'] })
ok(c.maxConcurrent === 5 && c.dailyLimit === 0 && c.lossCooldownMin === 0 && c.watchlist.length === 5, 'limits are clamped; garbage falls back to defaults')
ok(DEFAULT_FOCUS.maxConcurrent === 1 && DEFAULT_FOCUS.lossCooldownMin === 0, 'default: 1 concurrent position, loss cooldown off')

const now = new Date(2026, 10, 24, 12, 0, 0).getTime()
const t = (o: Partial<JournalTrade>): JournalTrade => ({ status: 'CLOSED', side: 'LONG', entry: 100, exit: 101, openedAt: now - 3600_000, closedAt: now - 3000_000, ...o })
ok(focusGate(DEFAULT_FOCUS, [], now).allowed, 'no trades: allowed')
ok(focusGate(DEFAULT_FOCUS, [t({ status: 'OPEN', exit: null, closedAt: null })], now).reason?.startsWith('MAX 1 OPEN') === true, 'one open position blocks a second (default max 1)')
ok(focusGate({ ...DEFAULT_FOCUS, maxConcurrent: 2 }, [t({ status: 'OPEN', exit: null, closedAt: null })], now).allowed, 'max concurrent 2 allows a second')
ok(focusGate({ ...DEFAULT_FOCUS, dailyLimit: 2 }, [t({}), t({})], now).reason?.includes('DAILY LIMIT') === true, 'daily limit blocks after N trades today')
ok(focusGate({ ...DEFAULT_FOCUS, dailyLimit: 2 }, [t({ openedAt: now - 3 * 86400_000, closedAt: now - 3 * 86400_000 + 1000 }), t({})], now).allowed, 'yesterday\'s trades do not count today')
const loss = t({ exit: 99, closedAt: now - 10 * 60_000 })
ok(focusGate({ ...DEFAULT_FOCUS, lossCooldownMin: 30 }, [loss], now).reason?.includes('20 MIN LEFT') === true, 'loss cooldown blocks and says how long is left')
ok(focusGate({ ...DEFAULT_FOCUS, lossCooldownMin: 5 }, [loss], now).allowed, 'loss cooldown expires')
ok(focusGate(DEFAULT_FOCUS, [loss], now).allowed, 'cooldown off by default')
ok(focusGate({ ...DEFAULT_FOCUS, lossCooldownMin: 30 }, [t({ side: 'SHORT', entry: 100, exit: 99, closedAt: now - 60_000 })], now).allowed, 'a winning short does not trigger the cooldown')

const r = rankSetups([
  { symbol: 'A', score: 88, netRR: 1.9, liquidity: 5 },
  { symbol: 'B', score: 92, netRR: 1.5, liquidity: 1 },
  { symbol: 'C', score: 92, netRR: 1.4, liquidity: 9 },
  { symbol: 'D', score: 92, netRR: 1.8, liquidity: 9 },
  { symbol: 'E', score: null, netRR: null, liquidity: 99 },
])
ok(r.map((x) => x.symbol).join('') === 'DCBAE', 'ranking: score, then liquidity, then net RR')
console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
process.exit(fail ? 1 : 0)
