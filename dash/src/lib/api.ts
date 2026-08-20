// Связь с сервером. Одна подписка на поток, ничего не опрашиваем.

import { useEffect, useRef, useState } from 'react'

export type Kind = 'team' | 'player' | 'league' | 'studio' | 'unknown' | null
export type SupplyKind = 'measured' | 'estimated' | 'empty'
export type ActionId = 'idle' | 'start' | 'restart' | 'rebuild' | 'watch' | 'halt'

export type Gem = {
  gem: string
  items: number
  equipped: number
  min: number | null
  max: number
  icon: string
  heroes: string
  kind: Kind
  entityId: number | null
  entityName: string | null
  supply: number | null
  left: number | null
  spent: number | null
  supplyKind: SupplyKind
  rows: { assetid: string; name: string; hero: string; value: number; equipped: boolean; icon: string }[]
}

export type CatalogRow = {
  name: string
  short: string
  price: string
  listings: number
  icon: string
  market: string
  kind: Kind
  entityName: string | null
  supply: number | null
  supplyKind: SupplyKind
  per1000: number | null
  ownedItems: number
  ownedValue: number | null
}

export type SendEvent = {
  ts: number
  n: number | null
  total: number | null
  match_id: string
  league_id: string
  result: 'update' | 'dup' | 'silent'
  bytes: number
  account?: string | null
}

export type Unit = {
  id: string
  label: string
  steamid: string
  enabled: boolean
  delay: number
  auto: boolean
  target: number | null
  done: number
  queueLength: number
  action: ActionId
  why: string
  lastTick: number
  rebuiltAt: number
  failures: number
  running: boolean
  pid: number | null
  exit: string | null
  lines: string[]
  burned: number
  etaMinutes: number
  log: { ts: number; action: string; why: string }[]
  ordered?: number | null
  waves?: number
  plan?: Wave[]
  nextWave?: Wave | null
}

export type Pace = { suggest: number; why: string; measured: number; silent: number; atDelay: number }

export type Wave = { index: number; addAt: number; value: number }

export type Autopilot = Unit & {
  goal: number
  objects: number
  gems: { gem: string; objects: number }[]
  units: Unit[]
  pace: Pace | null
}

export type State = {
  ts: number
  steamid: string
  events: SendEvent[]
  mine: Gem[]
  catalog: CatalogRow[]
  bundles: { def: number; name: string; partner: string; hero: string; price_cents: number | null; pieces: number }[]
  sender: { running: boolean; pid: number | null; exit: string | null; lines: string[] }
  autopilot: Autopilot
  confirmed: { ts: number; match_id: string; league_id: string; bytes: number } | null
  rate: number
  inv: { error: string | null; age: number | null; items: number }
  burned: number
  watched: number
  keys: { opendota: boolean; steam: boolean }
}

export type AccountRow = {
  id: string
  label: string
  steamid: string
  token: string
  added: number
  session: boolean
  burned: number
}

export type Accounts = {
  active: string | null
  link: { id: string; label: string; url: string | null; steamid: string | null; error: string | null; done: boolean; lines: string[] } | null
  list: AccountRow[]
}

export type GraphData = {
  scope: 'owned' | 'all'
  nodes: { key: string; kind: string; id: number; owned: number; pool: number; burned: number; price: number | null; counter: number; icon: string }[]
  edges: { a: string; b: string; shared: number }[]
}

export type QueueData = {
  total: number
  weight2: number
  rows: { match: string; league: string; weight: number; entities: string[] }[]
}

export function useLive() {
  const [state, setState] = useState<State | null>(null)
  const [online, setOnline] = useState(false)
  const es = useRef<EventSource | null>(null)

  useEffect(() => {
    const s = new EventSource('/api/stream')
    es.current = s
    s.onopen = () => setOnline(true)
    s.onerror = () => setOnline(false)
    s.onmessage = e => {
      try { setState(JSON.parse(e.data)); setOnline(true) } catch { }
    }
    return () => s.close()
  }, [])

  return { state, online }
}

// Запрос, который сам обновляется по тику потока состояния.
export function useJson<T>(url: string | null, dep: unknown): { data: T | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!url) return
    let alive = true
    setLoading(true)
    fetch(url)
      .then(r => r.json())
      .then(d => { if (alive) setData(d) })
      .catch(() => { })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [url, dep])
  return { data, loading }
}

export async function post(url: string, body: unknown) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json().catch(() => ({}))
}

// ── формат ──

export const nf = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

export const ago = (ts: number, now: number) => {
  if (!ts) return 'никогда'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return s + ' с'
  if (s < 3600) return Math.round(s / 60) + ' мин'
  return Math.round(s / 3600) + ' ч'
}

export const span = (min: number) => {
  if (!min) return '—'
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? h + ' ч ' + m + ' мин' : m + ' мин'
}

export const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

// Настоящая картинка предмета из Steam. В инвентаре лежит только хеш.
export const icon = (hash: string, size = 96) =>
  hash ? `https://community.akamai.steamstatic.com/economy/image/${hash}/${size}fx${size}f` : ''
