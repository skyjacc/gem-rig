// Сборка состояния, которое уходит в браузер по SSE.

import fs from 'node:fs'
import path from 'node:path'
import { TOOLS, GC, readJson, odKey, steamKey, STEAMID } from './paths.ts'
import { inv } from './steam.ts'
import { burnedCount, counterSeries, entitySpent, recentEvents, supplyRows } from './db.ts'
import { listFiles, senderState } from './sender.ts'

const norm = (s: string) => String(s ?? '').replace(/^(Genuine\s+)?Spectator:\s*/, '').trim().toLowerCase()

export type State = ReturnType<typeof buildState>

export function buildState() {
  const catalog = readJson<any[]>(path.join(TOOLS, 'gems.json'), [])
  const bundles = readJson<any[]>(path.join(TOOLS, 'gem-bundles.json'), [])
  const supply = supplyRows()
  const supBy = new Map(supply.map(s => [norm(s.gem), s]))

  let delay: number | null = null
  try { delay = Number(fs.readFileSync(path.join(GC, 'delay.txt'), 'utf8').trim()) } catch { }
  const status = readJson<any>(path.join(GC, 'status.json'), { current: null, recent: [] })

  // мои гемы
  const groups = new Map<string, any>()
  for (const r of inv.rows) {
    const g = r.gem || '—'
    if (!groups.has(g)) groups.set(g, { gem: g, items: 0, equipped: 0, min: null as number | null, max: 0, icon: r.icon, heroes: new Set<string>() })
    const e = groups.get(g)
    e.items++
    e.max = Math.max(e.max, r.value)
    e.min = e.min === null ? r.value : Math.min(e.min, r.value)
    if (r.equipped) e.equipped++
    if (r.hero) e.heroes.add(r.hero)
  }

  const mine = [...groups.values()].map(e => {
    const s = supBy.get(norm(e.gem))
    return {
      gem: e.gem, items: e.items, equipped: e.equipped, min: e.min, max: e.max, icon: e.icon,
      heroes: [...e.heroes].join(', '),
      kind: s?.kind ?? null, entityId: s?.entity_id ?? null, entityName: s?.entity_name ?? null,
      supply: s?.matches ?? null,
    }
  }).sort((a, b) => b.items - a.items || b.max - a.max)

  const cat = catalog.map(c => {
    const key = norm(c.name)
    const s = supBy.get(key)
    const own = mine.find(m => norm(m.gem) === key)
    const price = parseFloat(String(c.price).replace(/[^\d.]/g, '')) || 0
    return {
      name: c.name,
      short: c.name.replace(/^(Genuine\s+)?Spectator:\s*/, '').trim() || 'без имени',
      price: c.price, listings: c.listings, icon: c.icon,
      market: 'https://steamcommunity.com/market/listings/570/' + encodeURIComponent(c.name),
      kind: s?.kind ?? null, entityId: s?.entity_id ?? null, entityName: s?.entity_name ?? null,
      supply: s?.matches ?? null,
      per1000: s?.matches ? price / s.matches * 1000 : null,
      ownedItems: own?.items ?? 0, ownedValue: own?.max ?? null,
    }
  }).sort((a, b) => (b.supply ?? 0) - (a.supply ?? 0))

  // жила: сущность, чьих предметов больше всего
  const primary = mine.find(m => m.entityId && m.supply) ?? null
  let seam = null
  if (primary) {
    const spent = entitySpent(primary.kind!, primary.entityId!)
    seam = {
      gem: primary.gem,
      entity: primary.entityName ?? primary.gem,
      total: primary.supply!,
      spent,
      left: Math.max(0, primary.supply! - spent),
      items: primary.items,
    }
  }

  return {
    ts: Date.now(),
    steamid: STEAMID,
    delay,
    current: status.current ?? null,
    events: recentEvents(240),
    seam,
    mine,
    catalog: cat,
    bundles,
    chart: counterSeries(),
    sender: senderState(),
    files: listFiles(),
    inv: { error: inv.error, age: inv.ts ? Math.round((Date.now() - inv.ts) / 1000) : null, items: inv.rows.length },
    burned: burnedCount(),
    watched: mine.reduce((a, b) => a + b.max, 0),
    keys: { opendota: !!odKey(), steam: !!steamKey() },
  }
}
