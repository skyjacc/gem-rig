// Связь с сервером. Одна подписка на поток, ничего не опрашиваем.

import { useEffect, useRef, useState } from 'react'

export type Kind = 'team' | 'player' | 'league' | 'studio' | 'unknown' | null
export type SupplyKind = 'measured' | 'estimated' | 'empty'

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
}

export type SendEvent = {
  ts: number
  n: number | null
  total: number | null
  match_id: string
  league_id: string
  result: 'update' | 'dup' | 'silent'
  bytes: number
}

export type Autopilot = {
  enabled: boolean
  delay: number
  goal: number
  queueLength: number
  action: 'idle' | 'start' | 'restart' | 'rebuild' | 'watch' | 'halt'
  why: string
  lastTick: number
  rebuiltAt: number
  failures: number
  objects: number
  gems: { gem: string; objects: number }[]
  log: { ts: number; action: string; why: string }[]
  etaMinutes: number
}

export type State = {
  ts: number
  steamid: string
  delay: number | null
  current: { n: number; total: number; updates: number; responses: number; match: string; league: string } | null
  events: SendEvent[]
  mine: Gem[]
  catalog: { name: string; short: string; price: string; supply: number | null; ownedItems: number }[]
  bundles: unknown[]
  sender: { running: boolean; pid: number | null; exit: string | null; lines: string[] }
  autopilot: Autopilot
  confirmed: { ts: number; match_id: string; league_id: string; bytes: number } | null
  rate: number
  inv: { error: string | null; age: number | null; items: number }
  burned: number
  watched: number
  keys: { opendota: boolean; steam: boolean }
}

export function useLive() {
  const [state, setState] = useState<State | null>(null)
  const [online, setOnline] = useState(false)
  const src = useRef<EventSource | null>(null)

  useEffect(() => {
    const es = new EventSource('/api/stream')
    src.current = es
    es.onopen = () => setOnline(true)
    es.onerror = () => setOnline(false)
    es.onmessage = e => {
      try { setState(JSON.parse(e.data)) ; setOnline(true) } catch { }
    }
    return () => es.close()
  }, [])

  return { state, online }
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
  if (s < 60) return s + ' с назад'
  if (s < 3600) return Math.round(s / 60) + ' мин назад'
  return Math.round(s / 3600) + ' ч назад'
}

export const span = (min: number) => {
  if (!min) return '—'
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? h + ' ч ' + m + ' мин' : m + ' мин'
}

export const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
