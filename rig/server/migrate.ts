// Миграции схемы. Идемпотентны: смотрим, чего не хватает, и добавляем.
// SQLite не умеет «add column if not exists», поэтому спрашиваем pragma.
//
// Три новые колонки:
//   burned.state       confirmed | ledger | reconstructed — откуда запись и верим ли ей
//   supply.supply_kind measured | estimated | empty — измерен запас или это фантом
//   counters.carrier   item | gem | bundle — чем именно несётся счётчик
//
// Плюс починка burned.ts: importLegacy писал `stat.mtimeMs | 0`, а это
// 32-битное усечение — из 1787158694876 получалось 455777412. Такие метки
// не чинятся арифметикой, поэтому обнуляются: пустое честнее ложного.

import type { DatabaseSync } from 'node:sqlite'

// Метки времени в миллисекундах. Всё, что меньше этого, — мусор
// от усечения, а не настоящая дата.
const MS_FLOOR = 1_000_000_000_000

const ADD: [string, string, string][] = [
  ['burned', 'state', `alter table burned add column state text default 'confirmed'`],
  ['supply', 'supply_kind', `alter table supply add column supply_kind text default 'measured'`],
  ['counters', 'carrier', `alter table counters add column carrier text default 'item'`],
  // Откуда пришёл матч. valve — обход первоисточника, mirror — добор из
  // OpenDota или STRATZ там, где Valve упёрся в свой потолок 500 на лигу.
  ['vmatch', 'source', `alter table vmatch add column source text default 'valve'`],
]

export function migrate(target: DatabaseSync): string[] {
  const applied: string[] = []

  for (const [table, column, sql] of ADD) {
    const info = target.prepare(`pragma table_info(${table})`).all() as any[]
    // Таблицы vmatch и vplayer создаёт обходчик. Если его ещё не запускали,
    // их нет — это нормально, мигрировать нечего.
    if (!info.length) continue
    if (info.some(c => c.name === column)) continue
    target.exec(sql)
    applied.push(`${table}.${column}`)
  }

  const bad = target.prepare(
    `select count(*) c from burned where ts is not null and ts < ?`,
  ).get(MS_FLOOR) as { c: number }

  if (bad.c > 0) {
    target.prepare(`update burned set ts = null where ts is not null and ts < ?`).run(MS_FLOOR)
    applied.push(`burned.ts: обнулено ${bad.c} испорченных меток`)
  }

  return applied
}
