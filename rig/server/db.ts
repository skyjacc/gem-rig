// База пульта. Встроенный node:sqlite — нативных сборок не требуется.
// При первом запуске переносит сюда всё, что накопилось в JSON-файлах старой панели.

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { TOOLS, GC, SNAPS, readJson } from './paths.ts'
import { migrate, splitByAccount } from './migrate.ts'
import { ARRIVALS_DDL } from './arrival.ts'
import { ACCOUNT } from './accounts.ts'

// Рабочая база — или та, что назвали в RIG_DB.
//
// Модуль открывает базу прямо при импорте, и это тянет за собой всё, что
// его импортирует: любой тест, который случайно коснулся steam.ts или
// autopilot.ts, открывал живой rig.db на 250 МБ, гонял по нему миграции
// и конкурировал за WAL-замок с работающей панелью. Тесты от этого падали
// через раз, а данные оказывались в руках у процесса, которому они не нужны.
export const DB_FILE = process.env.RIG_DB || path.join(TOOLS, 'rig.db')

export const db = new DatabaseSync(DB_FILE)

db.exec(`
  pragma journal_mode = wal;

  -- сожжённые матчи: аккаунт засчитывает каждый ровно один раз
  create table if not exists burned (
    match_id  text primary key,
    league_id text,
    ts        integer,
    source    text
  );

  -- запас матчей у сущности гема
  create table if not exists supply (
    gem         text primary key,
    kind        text,
    entity_id   integer,
    entity_name text,
    matches     integer,
    confidence  text,
    updated     integer
  );

  -- матчи сущности, чтобы не дёргать OpenDota на каждый чих
  create table if not exists entity_matches (
    kind      text,
    entity_id integer,
    match_id  text,
    league_id text,
    primary key (kind, entity_id, match_id)
  );

  -- история счётчиков: один ряд на предмет на срез
  create table if not exists counters (
    ts      integer,
    gem     text,
    assetid text,
    item    text,
    value   integer,
    primary key (ts, assetid)
  );

  -- лента отправок
  --
  -- Ключ составной. По одной метке времени он быть не может: отправщик
  -- закрывает молчания пачкой и выдаёт несколько записей с одной меткой,
  -- а два работника шлют одновременно. С ключом по ts такие записи молча
  -- затирали друг друга — лента и темп занижались.
  create table if not exists events (
    ts        integer not null,
    n         integer,
    total     integer,
    match_id  text,
    league_id text,
    result    text,
    bytes     integer,
    account   text,
    primary key (ts, account, match_id)
  );

  -- приход каждой вещи: с каким числом приехала и чем оно объясняется.
  -- Заводится сканером прихода (arrival.ts) при первом взгляде на вещь.
  ${ARRIVALS_DDL}

  create index if not exists idx_em on entity_matches (kind, entity_id);
  create index if not exists idx_counters_gem on counters (gem, ts);
  create index if not exists idx_counters_ts on counters (ts);
  create index if not exists idx_events_ts on events (ts desc);
  create index if not exists idx_arrivals_aside on arrivals (aside, account);
`)

// Схема догоняется до текущей при каждом старте. Идемпотентно.
const migrated = migrate(db)
if (migrated.length) console.log('миграция:', migrated.join(', '))

// Журнал расхода развязывается по аккаунтам. Всё, что накоплено до этого,
// принадлежит первому аккаунту — другого тогда не было.
if (splitByAccount(db, ACCOUNT())) console.log('миграция: журнал расхода развязан по аккаунтам')

// Лента до появления колонки account — тоже первого аккаунта. Без этого
// она пропала бы из панели, когда лента стала показываться по аккаунту.
// Аккаунта ещё нет (свежая установка без steamid) — приписывать некому, ждём.
if (ACCOUNT()) {
  const orphan = db.prepare(`update events set account = ? where account is null`).run(String(ACCOUNT()))
  if (Number(orphan.changes) > 0) console.log('миграция: ленте без аккаунта приписан первый, строк ' + orphan.changes)
}

const meta = db.prepare(`select count(*) c from burned`).get() as { c: number }

// ── перенос из JSON старой панели, один раз ──
export function importLegacy() {
  if (meta.c > 0) return { skipped: true }

  const insBurn = db.prepare(`insert or ignore into burned (account, match_id, league_id, ts, source) values (?,?,?,?,?)`)
  let burned = 0
  // Без аккаунта старый расход приписать некому — не переносим, а не пишем
  // с пустым steamid (тот же журнал перенесётся, когда аккаунт появится).
  if (ACCOUNT() && fs.existsSync(GC)) {
    for (const f of fs.readdirSync(GC)) {
      const m = f.match(/^sent-(.+)\.json$/)
      if (!m) continue
      const list = readJson<string[]>(path.join(GC, f), [])
      const stat = fs.statSync(path.join(GC, f))
      // Math.trunc, а не `| 0`: побитовое И усекает до 32 бит, и метка
      // 1787158694876 превращалась в 455777412 — дату из 1984 года.
      for (const id of list) { insBurn.run(ACCOUNT(), String(id), null, Math.trunc(stat.mtimeMs), m[1]); burned++ }
    }
  }

  const map = readJson<any[]>(path.join(TOOLS, 'gem-map.json'), [])
  const sup = readJson<Record<string, number>>(path.join(TOOLS, 'gem-supply.json'), {})
  const insSup = db.prepare(`insert or replace into supply (gem, kind, entity_id, entity_name, matches, confidence, updated) values (?,?,?,?,?,?,?)`)
  for (const g of map) {
    const measured = sup[g.name]
    insSup.run(g.name, g.kind ?? null, g.entity_id ?? null, g.entity_name ?? null,
      measured ?? g.matches_estimate ?? null, g.confidence ?? null, Date.now())
  }

  const insCnt = db.prepare(`insert or ignore into counters (ts, gem, assetid, item, value) values (?,?,?,?,?)`)
  let snaps = 0
  if (fs.existsSync(SNAPS)) {
    for (const f of fs.readdirSync(SNAPS).filter(x => x.endsWith('.json'))) {
      const s = readJson<any>(path.join(SNAPS, f), null)
      if (!s?.rows) continue
      const ts = Date.parse(s.ts)
      for (const r of s.rows) {
        const v = r.counters?.games_watched
        if (v === undefined) continue
        insCnt.run(ts, r.gem || '—', r.assetid, r.name, v)
      }
      snaps++
    }
  }

  return { skipped: false, burned, gems: map.length, snaps }
}

// ── операции ──
export const burnedCount = (account = ACCOUNT()) =>
  (db.prepare(`select count(*) c from burned where account = ?`).get(String(account)) as { c: number }).c

// markBurned удалён намеренно. Он писал в журнал без разбора результата,
// и через него silent помечал матч сожжённым. Единственная точка записи —
// ingestOne из ledger.ts, она принимает только update и dup.

export function saveEntityMatches(kind: string, id: number, rows: { id: string; league: string }[]) {
  const ins = db.prepare(`insert or ignore into entity_matches (kind, entity_id, match_id, league_id) values (?,?,?,?)`)
  for (const r of rows) ins.run(kind, id, r.id, r.league)
}

export function entityMatchesFromDb(kind: string, id: number) {
  return db.prepare(`select match_id as id, league_id as league from entity_matches where kind = ? and entity_id = ?`)
    .all(kind, id) as { id: string; league: string }[]
}

export function saveSnapshot(rows: { gem: string; assetid: string; name: string; value: number }[]) {
  const ts = Date.now()
  const ins = db.prepare(`insert or ignore into counters (ts, gem, assetid, item, value) values (?,?,?,?,?)`)
  for (const r of rows) ins.run(ts, r.gem, r.assetid, r.name, r.value)
}

// Одно событие отправщика в ленту. Повтор безвреден: при перезапуске панели
// отчёт разбирается заново с начала, и ignore делает это бесплатным.
export function pushEvent(e: any, account = ACCOUNT()) {
  db.prepare(`insert or ignore into events (ts, n, total, match_id, league_id, result, bytes, account) values (?,?,?,?,?,?,?,?)`)
    .run(Math.trunc(Number(e.ts) || 0), e.n ?? null, e.total ?? null, String(e.match), String(e.league ?? ''), e.result, e.bytes ?? 0, String(account))
}

// Лента, последнее подтверждение и темп — по аккаунту. Общими они
// смешивали два работника: панель показывала темп первого, пока
// второй стоял, и «последнее подтверждение» чужого аккаунта.
export function recentEvents(limit = 240, account = ACCOUNT()) {
  return db.prepare(`select * from events where account = ? order by ts desc limit ?`).all(String(account), limit) as any[]
}

export function supplyRows() {
  return db.prepare(`select * from supply`).all() as any[]
}

// Последняя отправка, которую Valve засчитала. Пульту нужна одна строка:
// «последнее подтверждение N секунд назад» отвечает на «оно вообще живое?».
export function lastConfirmed(account = ACCOUNT()) {
  return db.prepare(`select ts, match_id, league_id, bytes from events where account = ? and result = 'update' order by ts desc limit 1`).get(String(account)) as any ?? null
}

// Сколько отправок засчитано за последние N минут — текущий темп по факту,
// а не по настройке паузы.
export function ratePerMinute(windowMs = 120_000, account = ACCOUNT()) {
  const since = Date.now() - windowMs
  const r = db.prepare(`select count(*) c from events where account = ? and ts >= ? and result in ('update','dup')`).get(String(account), since) as any
  return Math.round((r?.c ?? 0) / (windowMs / 60_000))
}

// Рост счётчиков по вещам, а не по гемам.
//
// По гемам график врал: показывал максимум и умалчивал, что под ним
// у Liquid`ixmike88 одна вещь на 7, одна на 3, одна на 1 и девять на нуле.
// Продаётся вещь, значит и смотреть надо на вещь.
//
// Сто двенадцать линий читать нельзя, поэтому одинаковые ветки сливаются
// в одну с числом вещей: «BZZ ×70» вместо семидесяти совпадающих кривых.
export function counterLines() {
  // Двести ПОСЛЕДНИХ срезов, а не первых.
  //
  // Было `order by ts asc limit 200` — то есть самые старые. Срез пишется
  // при каждом изменении счётчиков, значит за несколько часов работы их
  // набирается больше двухсот, и график навсегда застывал на первом дне:
  // он показывал начало истории и молчал про то, что происходит сейчас.
  const stamps = (db.prepare(
    `select ts from (select distinct ts from counters order by ts desc limit 200) order by ts asc`)
    .all() as any[]).map(r => r.ts as number)
  if (!stamps.length) return { stamps: [], lines: [] as any[] }

  const at = new Map(stamps.map((t, i) => [t, i]))
  // Берём только те срезы, что рисуем. Полный проход по таблице ради
  // двухсот столбцов дорожал с каждым днём работы.
  const rows = db.prepare(
    `select ts, gem, assetid, value from counters where ts >= ? order by ts asc`)
    .all(stamps[0]) as any[]

  const byAsset = new Map<string, { gem: string; points: (number | null)[] }>()
  for (const r of rows) {
    const i = at.get(r.ts as number)
    if (i === undefined) continue
    let e = byAsset.get(r.assetid)
    if (!e) { e = { gem: r.gem, points: Array(stamps.length).fill(null) }; byAsset.set(r.assetid, e) }
    e.points[i] = r.value
  }

  const groups = new Map<string, { gem: string; points: (number | null)[]; items: number }>()
  for (const e of byAsset.values()) {
    const key = e.gem + '|' + e.points.join(',')
    const g = groups.get(key)
    if (g) g.items++
    else groups.set(key, { gem: e.gem, points: e.points, items: 1 })
  }

  const last = (p: (number | null)[]) => [...p].reverse().find(v => v != null) ?? 0
  return {
    stamps,
    lines: [...groups.values()].sort((a, b) => last(b.points) - last(a.points) || b.items - a.items),
  }
}
