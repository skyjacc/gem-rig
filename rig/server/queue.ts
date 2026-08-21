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
// Вторая — порядок. Внутри сущности матчи идут от самых полезных к самым
// дешёвым, чтобы прерванный прогон обрывался на хвосте, а не на ценном куске.
// А между сущностями порядок круговой: один круг — по одному матчу каждой.
//
// Без круга список уходил по номеру матча, то есть по времени. Alliance
// и NaVi играли в 2013-м, Ohaiyo и BZZ — недавно, поэтому старые команды
// забирали весь прогон себе: Virtus.pro доходил до 206, а Ohaiyo стоял на 0.
// С кругом счётчики поднимаются вместе.
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

// Подтверждённо израсходованное ЭТИМ аккаунтом. Спорное НЕ вычитается:
// отвергнутый матч отвечает тем же, что и настоящий дубль, и вполне может
// быть живым.
//
// Пул матчей общий на все аккаунты, журнал расхода — у каждого свой.
// Отсюда весь смысл второго аккаунта: он жжёт тот же пул с нуля.
export function burnedSet(target: DatabaseSync, account: string): Set<string> {
  const rows = target.prepare(
    `select match_id from burned where account = ? and state = 'confirmed'`).all(String(account)) as any[]
  return new Set(rows.map(r => String(r.match_id)))
}

// Круговая раздача: за один круг каждая сущность получает ровно один матч.
//
// Матч, входящий в наборы двух сущностей, поднимает обе разом — поэтому
// тот, кого уже обслужили чужим матчем, свой в этом круге не берёт. Иначе
// пересечение Empire и BZZ дало бы им вдвое больше остальных.
export function rotate(rows: QueueRow[]): QueueRow[] {
  const by = new Map<string, QueueRow[]>()
  for (const r of rows) {
    for (const e of r.entities) {
      const l = by.get(e)
      if (l) l.push(r)
      else by.set(e, [r])
    }
  }

  const keys = [...by.keys()].sort()
  const at = new Map<string, number>(keys.map(k => [k, 0]))
  const taken = new Set<string>()
  const out: QueueRow[] = []

  while (out.length < rows.length) {
    const served = new Set<string>()
    let moved = false

    for (const k of keys) {
      if (served.has(k)) continue
      const list = by.get(k)!
      let i = at.get(k)!
      while (i < list.length && taken.has(list[i].match)) i++
      at.set(k, i)
      if (i >= list.length) continue

      const row = list[i]
      at.set(k, i + 1)
      taken.add(row.match)
      out.push(row)
      for (const e of row.entities) served.add(e)
      moved = true
    }

    if (!moved) break
  }

  return out
}

export function queueFor(target: DatabaseSync, picks: Pick[], account: string): QueueRow[] {
  const sets = new Map<string, Match[]>()
  for (const p of picks) sets.set(p.key, matchesOf(target, p))
  return rotate(buildQueue(sets, burnedSet(target, account)))
}

// Потолок сущности — не оценка со стороны, а число матчей, которые реально
// можно отправить: они есть в карте и у них известен турнир.
//
// Старая таблица supply врала в обе стороны: у Ohaiyo показывала 0 при 1672
// пригодных, у DD — 1017 при 508. Считаем по той же выборке, из которой
// строится очередь, иначе панель обещает то, чего отправщик не сделает.
export function entityStat(target: DatabaseSync, p: Pick, account: string) {
  const rows = matchesOf(target, p).filter(m => usable(m.league))
  if (!rows.length) return { supply: 0, burned: 0, left: 0 }

  const burnedIds = burnedSet(target, account)
  let burned = 0
  for (const m of rows) if (burnedIds.has(m.match)) burned++
  return { supply: rows.length, burned, left: rows.length - burned }
}
