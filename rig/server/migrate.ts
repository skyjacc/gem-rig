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
  // Кто отправил. Лента у аккаунтов общая по времени, но видеть, чей это
  // был матч, нужно: два работника идут одновременно.
  ['events', 'account', `alter table events add column account text`],
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

// Развязка журнала расхода по аккаунтам.
//
// Было: burned.match_id — первичный ключ, одна строка на всю базу. Значит
// второй аккаунт унаследовал бы расход первого и получил бы пустую очередь,
// хотя у него все матчи свежие. Матч расходуется у каждого аккаунта отдельно —
// проверено 20 августа: пять матчей NaVi, посланных повторно через 26 часов,
// вернули пять dup на том же аккаунте.
//
// SQLite не умеет менять первичный ключ, поэтому таблица пересобирается.
// Всё, что было накоплено, приписывается первому аккаунту: другого тогда
// не было, и это не догадка, а факт.
export function splitByAccount(target: DatabaseSync, firstAccount: string): boolean {
  const info = target.prepare(`pragma table_info(burned)`).all() as any[]
  if (!info.length) return false
  if (info.some(c => c.name === 'account')) return false
  if (!firstAccount) throw new Error('некому приписать старый журнал: аккаунт не указан')

  target.exec(`
    create table burned_split (
      account   text not null,
      match_id  text not null,
      league_id text,
      ts        integer,
      source    text,
      state     text default 'confirmed',
      primary key (account, match_id)
    );
  `)
  target.prepare(
    `insert into burned_split (account, match_id, league_id, ts, source, state)
     select ?, match_id, league_id, ts, source, coalesce(state, 'confirmed') from burned`,
  ).run(String(firstAccount))
  target.exec(`drop table burned; alter table burned_split rename to burned;`)
  target.exec(`create index if not exists idx_burned_account on burned (account, state)`)
  return true
}
