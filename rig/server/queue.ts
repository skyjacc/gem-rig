// Сборка списка матчей для отправщика.
//
// В очередь кладутся сущности, разворачиваются в матчи здесь.
//
// Две вещи, ради которых это отдельный модуль.
//
// Первая — слияние. Одно сообщение поднимает ВСЕ подходящие гемы разом,
// поэтому матч, входящий в наборы двух сущностей, отправляется один раз
// и засчитывается обеим. У Empire и BZZ таких 209 штук: без слияния они
// уходят дважды и половина времени тратится впустую.
//
// Вторая — порядок. Сортировка по числу обслуживаемых сущностей не ускоряет
// прогон, но делает так, что прерванный прогон обрывается на дешёвом хвосте,
// а не на самом ценном куске.
//
// Матч без номера турнира сюда не попадает вовсе: GC такое молча отвергает,
// а снаружи это неотличимо от «уже использован».

import type { DatabaseSync } from 'node:sqlite'

export type Match = { match: string; league: string }
export type QueueRow = { match: string; league: string; weight: number; entities: string[] }

// Что жжём: имя для отчёта плюс адрес сущности в карте.
export type Pick = { key: string; kind: 'team' | 'player'; id: number }

const usable = (league: string) => /^[0-9]{1,10}$/.test(String(league)) && Number(league) > 0

export function buildQueue(sets: Map<string, Match[]>, burned: Set<string>): QueueRow[] {
  const by = new Map<string, { league: string; entities: string[] }>()

  for (const [entity, matches] of sets) {
    for (const m of matches) {
      if (burned.has(m.match)) continue
      if (!usable(m.league)) continue
      const cur = by.get(m.match)
      if (cur) cur.entities.push(entity)
      else by.set(m.match, { league: String(m.league), entities: [entity] })
    }
  }

  return [...by.entries()]
    .map(([match, v]) => ({ match, league: v.league, weight: v.entities.length, entities: v.entities }))
    .sort((a, b) => b.weight - a.weight || (a.match < b.match ? -1 : a.match > b.match ? 1 : 0))
}

// Матчи сущности из локальной карты. Команда ищется с обеих сторон,
// игрок — по связям «кто в каком матче играл».
export function matchesOf(target: DatabaseSync, p: Pick): Match[] {
  const id = Math.trunc(Number(p.id))
  if (!Number.isFinite(id) || id <= 0) return []

  const rows = p.kind === 'team'
    ? target.prepare(
      `select match_id, league_id from vmatch where radiant = ? or dire = ?`).all(id, id)
    : target.prepare(
      `select v.match_id, v.league_id from vmatch v
       join vplayer p on p.match_id = v.match_id
       where p.account_id = ?`).all(id)

  return (rows as any[]).map(r => ({ match: String(r.match_id), league: String(r.league_id ?? '') }))
}

// Подтверждённо израсходованное. Спорное НЕ вычитается: отвергнутый матч
// отвечает тем же, что и настоящий дубль, и вполне может быть живым.
export function burnedSet(target: DatabaseSync): Set<string> {
  const rows = target.prepare(
    `select match_id from burned where state = 'confirmed'`).all() as any[]
  return new Set(rows.map(r => String(r.match_id)))
}

export function queueFor(target: DatabaseSync, picks: Pick[]): QueueRow[] {
  const sets = new Map<string, Match[]>()
  for (const p of picks) sets.set(p.key, matchesOf(target, p))
  return buildQueue(sets, burnedSet(target))
}
