// Запас сущности и остаток по нему — поверх карты, собранной обходом Valve.
//
// До обхода запас брался из чужих выгрузок и врал в обе стороны: у Ohaiyo
// показывал 0 при реальных 1672, у DD показывал 1017 при пригодных 508.
// Теперь считается локально по vmatch и vplayer, без обращений наружу.
//
// Три состояния запаса, которые нельзя показывать одинаково:
//   measured   набор матчей есть, число настоящее
//   estimated  набора нет, есть только оценка из gem-map.json
//   empty      нет ни набора, ни оценки

import type { DatabaseSync } from 'node:sqlite'

export type SupplyKind = 'measured' | 'estimated' | 'empty'
export type Entity = { kind: string; id: number; leagues?: number[] }

export function classifySupply(measured: number, estimate: number | null): SupplyKind {
  if (measured > 0) return 'measured'
  if (estimate && estimate > 0) return 'estimated'
  return 'empty'
}

const ids = (rows: unknown[]) => rows.map((r: any) => String(r.match_id))

// Матчи сущности. Команда ищется с обеих сторон карты, игрок — по связям,
// лига — по своему полю. Студия это не одна лига, а набор: у Beyond the Summit
// их 31, у Dota Cinema две.
export function entityMatchIds(target: DatabaseSync, e: Entity): string[] {
  const id = Math.trunc(Number(e.id))

  if (e.kind === 'team') {
    if (!Number.isFinite(id) || id <= 0) return []
    return ids(target.prepare(
      `select match_id from vmatch where radiant = ? or dire = ?`).all(id, id))
  }

  if (e.kind === 'player') {
    if (!Number.isFinite(id) || id <= 0) return []
    return ids(target.prepare(
      `select distinct match_id from vplayer where account_id = ?`).all(id))
  }

  if (e.kind === 'league') {
    if (!Number.isFinite(id) || id <= 0) return []
    return ids(target.prepare(
      `select match_id from vmatch where league_id = ?`).all(String(id)))
  }

  if (e.kind === 'studio') {
    const list = (e.leagues ?? []).map(Number).filter(n => Number.isFinite(n) && n > 0)
    if (!list.length) return []
    const holes = list.map(() => '?').join(',')
    return ids(target.prepare(
      `select match_id from vmatch where league_id in (${holes})`).all(...list.map(String)))
  }

  return []
}

// Остаток.
//
// confirmed вычитается: GC прислал msg 26 либо 7204, матч израсходован.
// dup НЕ вычитается: отвергнутое сообщение отвечает тем же 7204 без обновления,
//   и матч при этом остаётся целым — проверено 20 августа на 8003261364.
//   Показываем отдельным числом, чтобы было видно, что там спорно.
// reconstructed не вычитается: восстановлено арифметикой, ждёт проверки.
export function leftFor(target: DatabaseSync, e: Entity) {
  const mine = entityMatchIds(target, e)
  if (!mine.length) return { supply: 0, burned: 0, dup: 0, left: 0 }

  const holes = mine.map(() => '?').join(',')
  const row = target.prepare(
    `select
       sum(case when state = 'confirmed' then 1 else 0 end) c,
       sum(case when state = 'dup'       then 1 else 0 end) d
     from burned where match_id in (${holes})`).get(...mine) as any

  const burned = Number(row?.c) || 0
  const dup = Number(row?.d) || 0
  return { supply: mine.length, burned, dup, left: Math.max(0, mine.length - burned) }
}
