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
  // Сколько раз матч отправлялся этим аккаунтом. Нужна очереди: dup, не
  // засчитанный и после повтора, больше не гоняется по кругу.
  ['burned', 'tries', `alter table burned add column tries integer default 1`],
  // Сколько вещей изменил ответ GC — точное число отправщика (so.econModified,
  // план 2.5). У записей до этой колонки — NULL: не записывалось, а не ноль.
  ['events', 'items', `alter table events add column items integer`],
]

// Развязка ленты отправок по метке + аккаунту + матчу.
//
// Было: events.ts — первичный ключ. Одна метка времени, одна строка. Но
// отправщик закрывает молчания пачкой и выдаёт несколько записей с ОДНОЙ
// меткой, а два работника шлют одновременно. `insert or replace` в такой
// схеме молча выбрасывал всё, кроме последнего: лента врала, темп
// (ratePerMinute) занижался, и «сколько ушло молча» было неизвестно.
//
// SQLite не умеет менять первичный ключ — таблица пересобирается.
export function splitEvents(target: DatabaseSync): boolean {
  const info = target.prepare(`pragma table_info(events)`).all() as any[]
  if (!info.length) return false
  // Ключ уже составной, если ts не единственная колонка с pk = 1.
  const pk = info.filter(c => Number(c.pk) > 0).map(c => c.name)
  if (pk.length !== 1 || pk[0] !== 'ts') return false

  target.exec(`
    create table events_split (
      ts        integer not null,
      n         integer,
      total     integer,
      match_id  text,
      league_id text,
      result    text,
      bytes     integer,
      account   text,
      items     integer,
      primary key (ts, account, match_id)
    );
  `)
  const has = new Set(info.map(c => c.name))
  const account = has.has('account') ? 'account' : 'null'
  // items добавляется раньше пересборки (ADD) — её нельзя потерять здесь.
  const items = has.has('items') ? 'items' : 'null'
  target.exec(
    `insert or ignore into events_split (ts, n, total, match_id, league_id, result, bytes, account, items)
     select ts, n, total, match_id, league_id, result, bytes, ${account}, ${items} from events`,
  )
  target.exec(`drop table events; alter table events_split rename to events;`)
  target.exec(`create index if not exists idx_events_ts on events (ts desc)`)
  return true
}

// Попытки для уже накопленных dup восстанавливаются по ленте отправок:
// 22 августа часть dup уходила по пять-девять раз, и ни один не засчитался.
function backfillTries(target: DatabaseSync) {
  const ev = target.prepare(`pragma table_info(events)`).all() as any[]
  const bu = target.prepare(`pragma table_info(burned)`).all() as any[]
  // До развязки по аккаунтам сверять не с чем: такой журнал ещё не знает,
  // чей он, и после пересборки попытки начнутся с единицы.
  if (!ev.some(c => c.name === 'account') || !bu.some(c => c.name === 'account')) return
  target.exec(`
    update burned set tries = max(1, (
      select count(*) from events e
      where e.account = burned.account and e.match_id = burned.match_id and e.result = 'dup'
    ))
    where state = 'dup'
  `)
}

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
    if (table === 'burned' && column === 'tries') backfillTries(target)
  }

  // Таблицы может не быть вовсе: у обходчика своя база, а тест приносит
  // базу с одной нужной ему таблицей. Отсутствие — не повод падать.
  const hasBurned = (target.prepare(`pragma table_info(burned)`).all() as any[]).length > 0
  const bad = hasBurned
    ? target.prepare(
      `select count(*) c from burned where ts is not null and ts < ?`,
    ).get(MS_FLOOR) as { c: number }
    : { c: 0 }

  if (bad.c > 0) {
    target.prepare(`update burned set ts = null where ts is not null and ts < ?`).run(MS_FLOOR)
    applied.push(`burned.ts: обнулено ${bad.c} испорченных меток`)
  }

  if (splitEvents(target)) applied.push('events: ключ ts + аккаунт + матч')

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
  // Без аккаунта — только если приписывать нечего (свежая база на установке
  // без steamid, accounts.ts). Записи есть — отдать их некому, стоп.
  if (!firstAccount) {
    const n = (target.prepare('select count(*) c from burned').get() as { c: number }).c
    if (n > 0) throw new Error('некому приписать старый журнал: аккаунт не указан')
  }

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
