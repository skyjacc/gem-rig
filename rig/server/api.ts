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

// ── дерево ──
//
// Аккаунт → гем → турниры, откуда у этой сущности матчи. Даёт то, чего
// не даёт сеть пересечений: видно, из чего вообще состоит потолок гема
// и какой турнир кормит его больше всех.

let leagueNames: Map<string, string> | null = null
function leagueName(id: string): string {
  if (!leagueNames) {
    leagueNames = new Map()
    for (const l of readJson<any[]>(path.join(TOOLS, 'leagues.json'), [])) {
      if (l?.id) leagueNames.set(String(l.id), String(l.name ?? ''))
    }
  }
  return leagueNames.get(String(id)) || 'турнир ' + id
}

export type TreeNode = {
  id: string
  label: string
  kind: 'root' | 'gem' | 'league'
  value: number
  burned?: number
  counter?: number
  icon?: string
  children?: TreeNode[]
}

let tCache: TreeNode | null = null
let tKey = ''

export function tree(top = 12): TreeNode {
  const acc = active()
  const list = picks()
  const key = acc?.id + '|' + list.map(p => p.key).join(',') + '|' + top
  if (tCache && tKey === key) return tCache

  const owned = new Map<string, { items: number; max: number; icon: string }>()
  for (const r of inv.rows) {
    if (!r.gem || r.gem === '—') continue
    const e = owned.get(r.gem) ?? { items: 0, max: 0, icon: r.icon }
    e.items++
    e.max = Math.max(e.max, r.value)
    owned.set(r.gem, e)
  }

  const spent = new Set<string>(
    (db.prepare(`select match_id from burned where account = ? and state = 'confirmed'`)
      .all(acc?.steamid ?? '') as any[]).map(r => String(r.match_id)),
  )

  const gems: TreeNode[] = []
  for (const p of list) {
    const rows = p.kind === 'team'
      ? db.prepare(`select match_id, league_id from vmatch where radiant = ? or dire = ?`).all(p.id, p.id)
      : db.prepare(`select v.match_id, v.league_id from vmatch v join vplayer pl on pl.match_id = v.match_id where pl.account_id = ?`).all(p.id)

    const byLeague = new Map<string, { n: number; burned: number }>()
    let burned = 0
    for (const r of rows as any[]) {
      const lg = String(r.league_id ?? '')
      if (!/^[0-9]{1,10}$/.test(lg) || Number(lg) <= 0) continue
      const e = byLeague.get(lg) ?? { n: 0, burned: 0 }
      e.n++
      if (spent.has(String(r.match_id))) { e.burned++; burned++ }
      byLeague.set(lg, e)
    }

    const own = owned.get(p.key)
    const children = [...byLeague.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, top)
      .map(([lg, v]) => ({
        id: p.key + ':' + lg,
        label: leagueName(lg),
        kind: 'league' as const,
        value: v.n,
        burned: v.burned,
      }))

    const rest = [...byLeague.values()].reduce((n, v) => n + v.n, 0) - children.reduce((n, c) => n + c.value, 0)
    if (rest > 0) {
      children.push({ id: p.key + ':rest', label: 'ещё ' + (byLeague.size - children.length) + ' турниров', kind: 'league', value: rest, burned: 0 })
    }

    gems.push({
      id: p.key,
      label: p.key,
      kind: 'gem',
      value: [...byLeague.values()].reduce((n, v) => n + v.n, 0),
      burned,
      counter: own?.max ?? 0,
      icon: own?.icon ?? '',
      children,
    })
  }

  gems.sort((a, b) => b.value - a.value)
  tCache = {
    id: 'root',
    label: acc?.label ?? 'аккаунт',
    kind: 'root',
    value: gems.reduce((n, g) => n + g.value, 0),
    children: gems,
  }
  tKey = key
  return tCache
}
