// Сборка состояния, которое уходит в браузер по SSE.

import fs from 'node:fs'
import path from 'node:path'
import { TOOLS, GC, readJson, odKey, steamKey, STEAMID } from './paths.ts'
import { inv } from './steam.ts'
import { burnedCount, counterSeries, entitySpent, lastConfirmed, ratePerMinute, recentEvents, supplyRows } from './db.ts'
import { listFiles, senderState } from './sender.ts'
import { db } from './db.ts'
import { entityStat } from './queue.ts'
import { classifySupply } from './supply.ts'
import { ACCOUNT, active, list as accountList } from './accounts.ts'
import { autopilotState } from './autopilot.ts'

// Потолок и остаток считаются по локальной карте — по той же выборке,
// из которой строится очередь. Таблица supply хранит только старую оценку
// и врёт: у Ohaiyo там 0 при 1672 пригодных, у DD 1017 при 508.
//
// Запросы индексированы и стоят миллисекунды, но состояние уходит в браузер
// часто. Держим короткий кеш и сбрасываем его, когда журнал сожжённого вырос.
const statCache = new Map<string, { supply: number; burned: number; left: number }>()
let statBurned = -1
let statAt = 0
let statAccount = ''

function stat(kind: string, id: number) {
  if (kind !== 'team' && kind !== 'player') return null
  const n = burnedCount()
  if (n !== statBurned || statAccount !== ACCOUNT() || Date.now() - statAt > 10_000) {
    statCache.clear()
    statBurned = n
    statAccount = ACCOUNT()
    statAt = Date.now()
  }
  const key = kind + ':' + id
  let v = statCache.get(key)
  if (!v) { v = entityStat(db, { key, kind, id }, ACCOUNT()); statCache.set(key, v) }
  return v
}

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
    if (!groups.has(g)) groups.set(g, { gem: g, items: 0, equipped: 0, min: null as number | null, max: 0, icon: r.icon, heroes: new Set<string>(), rows: [] as any[], bare: 0 })
    const e = groups.get(g)
    e.items++
    e.rows.push({
      assetid: r.assetid, name: r.name, hero: r.hero, value: r.value,
      equipped: !!r.equipped, icon: r.icon,
      // Голый самоцвет и предмет с вставленным — разный товар и разная цена.
      carrier: r.carrier ?? 'item',
    })
    if ((r.carrier ?? 'item') === 'gem') e.bare++
    e.max = Math.max(e.max, r.value)
    e.min = e.min === null ? r.value : Math.min(e.min, r.value)
    if (r.equipped) e.equipped++
    if (r.hero) e.heroes.add(r.hero)
  }

  const mine = [...groups.values()].map(e => {
    const s = supBy.get(norm(e.gem))
    const st = s?.kind && s?.entity_id ? stat(s.kind, s.entity_id) : null
    const estimate = s?.matches ?? null
    return {
      gem: e.gem, items: e.items, equipped: e.equipped, min: e.min, max: e.max, icon: e.icon,
      heroes: [...e.heroes].join(', '),
      // Каждая вещь отдельно: группа скрывает, что у 29 предметов BZZ
      // счётчики от нуля до двенадцати, а продаётся именно предмет.
      rows: (e.rows as any[]).sort((x, y) => y.value - x.value),
      bare: e.bare,
      socketed: e.items - e.bare,
      kind: s?.kind ?? null, entityId: s?.entity_id ?? null, entityName: s?.entity_name ?? null,
      supply: st && st.supply > 0 ? st.supply : estimate,
      left: st ? st.left : null,
      spent: st ? st.burned : null,
      supplyKind: classifySupply(st?.supply ?? 0, estimate),
    }
  }).sort((a, b) => b.items - a.items || b.max - a.max)

  const cat = catalog.map(c => {
    const key = norm(c.name)
    const s = supBy.get(key)
    const own = mine.find(m => norm(m.gem) === key)
    const price = parseFloat(String(c.price).replace(/[^\d.]/g, '')) || 0
    const st = s?.kind && s?.entity_id ? stat(s.kind, s.entity_id) : null
    const measured = st && st.supply > 0 ? st.supply : (s?.matches ?? null)
    return {
      name: c.name,
      short: c.name.replace(/^(Genuine\s+)?Spectator:\s*/, '').trim() || 'без имени',
      price: c.price, listings: c.listings, icon: c.icon,
      market: 'https://steamcommunity.com/market/listings/570/' + encodeURIComponent(c.name),
      kind: s?.kind ?? null, entityId: s?.entity_id ?? null, entityName: s?.entity_name ?? null,
      supply: measured,
      supplyKind: classifySupply(st?.supply ?? 0, s?.matches ?? null),
      per1000: measured ? price / measured * 1000 : null,
      ownedItems: own?.items ?? 0, ownedValue: own?.max ?? null,
    }
  }).sort((a, b) => (b.supply ?? 0) - (a.supply ?? 0))

  // жила: сущность, чьих предметов больше всего
  const primary = mine.find(m => m.entityId && m.supply) ?? null
  let seam = null
  if (primary) {
    const spent = primary.spent ?? entitySpent(primary.kind!, primary.entityId!)
    seam = {
      gem: primary.gem,
      entity: primary.entityName ?? primary.gem,
      total: primary.supply!,
      spent,
      left: primary.left ?? Math.max(0, primary.supply! - spent),
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
    sender: senderState(active()?.id ?? 'main'),
    autopilot: autopilotState(),
    confirmed: lastConfirmed(),
    rate: ratePerMinute(),
    files: listFiles(),
    inv: { error: inv.error, age: inv.ts ? Math.round((Date.now() - inv.ts) / 1000) : null, items: inv.rows.length },
    burned: burnedCount(),
    watched: mine.reduce((a, b) => a + b.max, 0),
    keys: { opendota: !!odKey(), steam: !!steamKey() },
  }
}
