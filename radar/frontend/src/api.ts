import { recordRequest } from './lib/diagnostics'

export type Phase = 'idle' | 'catalogue' | 'sockets' | 'orders' | 'pricing'

export type ScannerStats = {
  running: boolean
  phase: Phase
  phase_detail: string
  phase_done: number
  phase_total: number
  started_at: string
  run_id: string
  catalogue_built: string
  candidates: number
  gem_variants: number
  sweeps_done: number
  last_added: number
  last_removed: number
  last_sweep: string
  last_sweep_duration: string
  catalogue_size: number
  resolved: number
  current_resolved?: number
  current_gem_variants?: number
  steam_unknown?: number
  pending_resolve: number
  findings: number
  steam_calls: number
  last_error: string
  price_book_entries: number
}

export type Status = {
  market_key_ok: boolean
  steam_key_ok: boolean
  balance: number
  currency: string
  /** Zero time means the balance has never been read successfully. */
  balance_at: string
  balance_error?: string
  requests_last_second: number
  scanner: ScannerStats
  guard_last_run: string
  guard_error?: string
  buy_enabled: boolean
  dmarket: DMarketStats
  sources: SourceStatus[] | null
  gems_priced: number
  fx_rate: number
  fx_source: string
  /** Zero time means the rate is the built-in constant, not a measurement. */
  fx_updated: string
}

export type Finding = {
  key: string
  classid: string
  instanceid: string
  item_name: string
  item_type: string
  icon_url: string
  hero_name: string
  hero_icon: string
  rarity: string
  name_color: string
  price: number
  offers: number
  gems: string[]
  gem_value: number
  spread: number
  net_spread: number
  roi: number
  priced: boolean
  market_url: string
  inspect_url: string
  found_at: string
  source: string
  lock_days: number
  gem_prices: GemPrice[] | null
  confidence: Confidence
  deal?: Deal
}

export type Confidence = 'high' | 'medium' | 'low' | 'none'

export type Payout = 'cash' | 'wallet'
export type Speed = 'instant' | 'listed'

/** One way to turn an item or gem into money. */
export type Exit = {
  venue: string
  gross: number
  fee_percent: number
  net: number
  weighted: number
  payout: Payout
  speed: Speed
  orders?: number
  note?: string
}

/** One thing being sold: an extracted gem, or the emptied item. */
export type Leg = {
  name: string
  exits: Exit[] | null
  best?: Exit
  /** Why `exits` is empty — «никто не покупает» and «мы не спрашивали» differ. */
  reason?: string
}

/** The full buy-extract-sell plan, priced from standing buy orders. */
export type Deal = {
  buy_price: number
  extraction_cost: number
  invested: number
  gems: Leg[]
  shell?: Leg
  proceeds: number
  net: number
  roi: number
  complete: boolean
  priced: boolean
  optimistic: boolean
  unknowns?: string[]
}

export type EconomicsSettings = {
  MarketFeePercent: number
  SteamFeePercent: number
  DMarketFeePercent: number
  SteamWalletValue: number
  ExtractionCost: number
  AllowListedExit: boolean
  SteamFeeConfirmed: boolean
  DMarketFeeConfirmed: boolean
}

export type Quote = {
  source: string
  price: number
  kind: 'ask' | 'sale' | 'demand'
  volume?: number
  at: string
}

export type GemPrice = {
  name: string
  median: number
  low: number
  high: number
  sale?: number
  quotes: Quote[] | null
  confidence: Confidence
}

export type JournalEvent = {
  id: number
  at: string
  run?: string
  level: 'debug' | 'info' | 'warn' | 'error'
  kind: string
  subject?: string
  reason?: string
  message: string
  fields?: Record<string, unknown>
}

export type Coverage = {
  catalogue: {
    variants: number
    built_at: string
    candidates: number
    resolved: number
  current_resolved?: number
  current_gem_variants?: number
    pending: number
    with_gems: number
  }
  gems: { in_game: number; priced: number; unlisted: string[]; unknown: string[] | null }
  order_books: number
  sources: SourceStatus[]
  scanner: ScannerStats
}

export type SweepPoint = {
  at: string
  findings: number
  profitable: number
  priced: number
  best_net: number
  total_net: number
  catalogue: number
  candidates: number
  with_gems: number
  gems_priced: number
  order_books: number
  duration_ms: number
}

export type GemPoint = {
  at: string
  median: number
  low: number
  high: number
  order?: number
}

/** One sweep: what started it, how it ended, and what it discarded. */
export type Run = {
  id: string
  pipeline: string
  trigger: string
  started_at: string
  finished_at: string
  duration_ms: number
  outcome: 'ok' | 'error' | 'cancelled'
  error?: string
  catalogue_rows: number
  candidates: number
  from_cache: number
  requested: number
  steam_calls: number
  steam_unknown: number
  sockets_ok: number
  order_books: number
  findings: number
  priced: number
  profitable: number
  added: number
  removed: number
  excluded: Record<string, number> | null
  deferred: number
}

export type SourceStatus = {
  name: string
  gems: number
  error?: string
  at: string
  enabled: boolean
}

export type DMarketStats = {
  enabled: boolean
  running: boolean
  last_sweep: string
  offers_seen: number
  with_gems: number
  findings: number
  last_error?: string
  balance_usd?: string
  max_pages: number
  last_sweep_ms: number
}

export type Socket = {
  kind: 'kinetic' | 'spectator' | 'empty' | 'prismatic' | 'ethereal' | 'other'
  sprite: string
  icon_url: string
  name: string
  subtitle: string
}

export type ItemDetail = {
  classid: string
  instanceid: string
  name: string
  type: string
  icon_url: string
  sockets: Socket[] | null
  valve_html: string
  offers: { price: number; count: number }[] | null
  buy_orders: { price: number; count: number }[] | null
  offers_error?: string
  market_url: string
  steam_url: string
  inspect_url: string
}

export type OfferItem = {
  assetid: string
  classid: string
  instanceid: string
  name: string
  gems: string[] | null
  /** False means Steam never described this item — not that it has no gem. */
  sockets_read: boolean
  expected: boolean
  note: string
}

/** What the guard was actually able to compare behind its verdict. */
export type GuardChecked = {
  purchases: boolean
  sockets: boolean
  blockers?: string[]
}

export type TradeAlert = {
  offer_id: string
  partner: string
  /** `unknown` means a check could not run — it is not a milder `ok`. */
  severity: 'ok' | 'unknown' | 'warn' | 'critical'
  headline: string
  details: string[] | null
  items: OfferItem[] | null
  checked: GuardChecked
  checked_at: string
}

export type Settings = {
  MaxItemPrice: number
  MinSpread: number
  SaleFee: number
  Interval: number
  SteamRPS: number
  MaxSteamCallsPerSweep: number
  DataDir: string
}

async function getJSON<T>(url: string): Promise<T> {
  const started = performance.now()
  let res: Response
  try {
    res = await fetch(url)
  } catch (e) {
    // A dead server and a refused request look identical to a component; the
    // diagnostic buffer is the only place that keeps the difference.
    const message = e instanceof Error ? e.message : String(e)
    recordRequest(url, null, message, performance.now() - started)
    throw new Error(`${url}: сеть недоступна (${message})`)
  }
  if (!res.ok) {
    let body = ''
    try {
      body = (await res.clone().text()).slice(0, 200)
    } catch {
      body = ''
    }
    recordRequest(url, res.status, body || res.statusText, performance.now() - started)
    throw new Error(`${url}: HTTP ${res.status}${body ? ` — ${body}` : ''}`)
  }
  try {
    return (await res.json()) as T
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    recordRequest(url, res.status, `ответ не разобран: ${message}`, performance.now() - started)
    throw new Error(`${url}: ответ не является JSON`)
  }
}

export const api = {
  status: () => getJSON<Status>('/api/status'),
  findings: () => getJSON<{ count: number; results: Finding[] }>('/api/findings'),
  trades: () =>
    getJSON<{ alerts: TradeAlert[] | null; last_run: string; error: string }>('/api/trades'),
  settings: () => getJSON<Settings>('/api/settings'),
  economics: () =>
    getJSON<{
      settings: EconomicsSettings
      market_fee_at: string
      market_fee_error: string
      order_books: number
    }>('/api/economics'),

  async saveEconomics(patch: Record<string, number | boolean>) {
    const res = await fetch('/api/economics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) throw new Error(`economics: HTTP ${res.status}`)
    return res.json()
  },

  coverage: () => getJSON<Coverage>('/api/coverage'),
  history: (limit = 200) =>
    getJSON<{
      sweeps: SweepPoint[]
      tracked_gems: string[] | null
      retained: { sweeps: number; gems: number; points: number }
    }>(`/api/history?limit=${limit}`),
  gemHistory: (gem: string, limit = 200) =>
    getJSON<{ gem: string; points: GemPoint[] | null }>(
      `/api/history?gem=${encodeURIComponent(gem)}&limit=${limit}`,
    ),
  journalExportURL: (kind = '', level = '') =>
    `/api/journal/export?kind=${encodeURIComponent(kind)}&level=${encodeURIComponent(level)}`,

  journal: (limit = 300) =>
    getJSON<{
      count: number
      events: JournalEvent[]
      counts: Record<string, number>
      total: number
    }>(`/api/journal?limit=${limit}`),

  /** Recent sweeps, newest first, plus the one in flight. */
  runs: (limit = 20) =>
    getJSON<{ runs: Run[] | null; current?: Run; queued: boolean }>(`/api/runs?limit=${limit}`),

  /** Every journal event belonging to one sweep. */
  journalForRun: (run: string, limit = 500) =>
    getJSON<{ count: number; events: JournalEvent[] }>(
      `/api/journal?run=${encodeURIComponent(run)}&limit=${limit}`,
    ),

  /** Everything the radar recorded about one item, newest first. */
  journalFor: (subject: string, limit = 60) =>
    getJSON<{ count: number; events: JournalEvent[] }>(
      `/api/journal?subject=${encodeURIComponent(subject)}&limit=${limit}`,
    ),

  gems: () =>
    getJSON<{ count: number; results: GemPrice[]; sources: SourceStatus[] | null }>('/api/gems'),
  item: (classid: string, instanceid: string) =>
    getJSON<ItemDetail>(
      `/api/item?class=${encodeURIComponent(classid)}&instance=${encodeURIComponent(instanceid)}`,
    ),

  async saveSettings(patch: Record<string, number>): Promise<Settings> {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) throw new Error(`settings: HTTP ${res.status}`)
    return (await res.json()) as Settings
  },

  async scanNow(): Promise<void> {
    const res = await fetch('/api/scan', { method: 'POST' })
    if (!res.ok) throw new Error(`scan: HTTP ${res.status}`)
  },
}

export type StreamEvent =
  | { type: 'finding'; data: Finding }
  | { type: 'trade_alert'; data: TradeAlert }
  | { type: 'stats'; data: ScannerStats }
  | { type: 'dmarket_stats'; data: DMarketStats }
  | { type: 'journal'; data: JournalEvent }

/** Subscribes to server events. Returns an unsubscribe function. */
export function subscribe(onEvent: (e: StreamEvent) => void): () => void {
  const source = new EventSource('/api/events')
  const handler = (type: StreamEvent['type']) => (ev: MessageEvent) => {
    try {
      const parsed = JSON.parse(ev.data)
      onEvent({ type, data: parsed.data } as StreamEvent)
    } catch {
      /* a malformed frame must not kill the stream */
    }
  }
  source.addEventListener('finding', handler('finding') as EventListener)
  source.addEventListener('trade_alert', handler('trade_alert') as EventListener)
  source.addEventListener('stats', handler('stats') as EventListener)
  source.addEventListener('dmarket_stats', handler('dmarket_stats') as EventListener)
  source.addEventListener('journal', handler('journal') as EventListener)
  return () => source.close()
}

export const rub = (value: number): string =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value) + ' ₽'

export const ago = (iso: string): string => {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t) || t <= 0) return '—'
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (secs < 60) return `${secs} с назад`
  if (secs < 3600) return `${Math.round(secs / 60)} мин назад`
  return `${Math.round(secs / 3600)} ч назад`
}
