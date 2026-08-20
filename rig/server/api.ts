// Обработчики, которые не про поток состояния: аккаунты, граф, очередь.
// Держим отдельно от index.ts, чтобы тот остался про сборку сервера.

import fs from 'node:fs'
import path from 'node:path'
import { GC, TOOLS, readJson } from './paths.ts'
import { db } from './db.ts'
import { ACCOUNT, active, hasSession, linkCancel, linkStart, linkState, list, rename, setActive, unlink } from './accounts.ts'
import { buildGraph, type GraphEntity } from './graph.ts'
import { queueFor } from './queue.ts'
import { inv } from './steam.ts'
import { picks } from './autopilot.ts'

const norm = (s: string) => String(s ?? '').replace(/^(Genuine\s+)?Spectator:\s*/, '').trim()

export function accountList() {
  return {
    active: active()?.id ?? null,
    link: linkState(),
    list: list().map(a => ({
      id: a.id,
      label: a.label,
      steamid: a.steamid,
      token: a.token,
      added: a.added,
      session: hasSession(a),
      burned: (db.prepare(`select count(*) c from burned where account = ?`).get(a.steamid) as any).c,
    })),
  }
}

export const accountsApi = { linkStart, linkCancel, setActive, unlink, rename }

// ── граф ──
//
// Узлы — сущности, рёбра — общие матчи. Считается по локальной карте,
// поэтому дорого: держим кеш, пока не поменялся состав или журнал.
let gCache: any = null
let gKey = ''

export function graph(scope: 'owned' | 'all' = 'owned') {
  const map = readJson<any[]>(path.join(TOOLS, 'gem-map.json'), [])
  const gems = readJson<any[]>(path.join(TOOLS, 'gems.json'), [])
  const priceBy = new Map<string, number>()
  const iconBy = new Map<string, string>()
  for (const g of gems) {
    const key = norm(g.name)
    const p = parseFloat(String(g.price).replace(/[^\d.]/g, ''))
    if (Number.isFinite(p)) priceBy.set(key, p)
    if (g.icon) iconBy.set(key, g.icon)
  }

  const owned = new Map<string, { items: number; max: number; icon: string }>()
  for (const r of inv.rows) {
    if (!r.gem || r.gem === '—') continue
    const e = owned.get(r.gem) ?? { items: 0, max: 0, icon: r.icon }
    e.items++
    e.max = Math.max(e.max, r.value)
    owned.set(r.gem, e)
  }

  const key = scope + '|' + [...owned.keys()].sort().join(',') + '|' + ACCOUNT() +
    '|' + (db.prepare(`select count(*) c from burned where account = ?`).get(ACCOUNT()) as any).c
  if (gCache && gKey === key) return gCache

  const entities: GraphEntity[] = []
  for (const g of map) {
    const name = norm(g.name)
    const own = owned.get(name)
    if (scope === 'owned' && !own) continue
    if (!g.entity_id && g.kind !== 'studio') continue
    entities.push({
      key: name,
      kind: g.kind,
      id: Number(g.entity_id) || 0,
      leagues: g.leagues,
      owned: own?.items ?? 0,
      counter: own?.max ?? 0,
      price: priceBy.get(name) ?? null,
      icon: own?.icon ?? iconBy.get(name) ?? '',
    })
  }

  gCache = { ...buildGraph(db, entities, ACCOUNT()), scope, ts: Date.now() }
  gKey = key
  return gCache
}

// ── очередь ──
//
// То же, что уйдёт в отправщик, но без записи файла: посмотреть, что будет
// сожжено и в каком порядке, не запуская ничего.
export function queuePreview(limit = 200) {
  const list = picks()
  if (!list.length) return { total: 0, rows: [], weight2: 0 }
  const rows = queueFor(db, list, ACCOUNT())
  return {
    total: rows.length,
    weight2: rows.filter(r => r.weight > 1).length,
    rows: rows.slice(0, limit),
  }
}

// Файлы очередей на диске — на случай разбора.
export function queueFiles() {
  if (!fs.existsSync(GC)) return []
  return fs.readdirSync(GC).filter(f => f.endsWith('.csv')).map(f => ({
    name: f,
    size: fs.statSync(path.join(GC, f)).size,
  }))
}
