// База пульта. Встроенный node:sqlite — нативных сборок не требуется.
// При первом запуске переносит сюда всё, что накопилось в JSON-файлах старой панели.

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { TOOLS, GC, SNAPS, readJson } from './paths.ts'
import { migrate, splitByAccount } from './migrate.ts'
import { ACCOUNT } from './accounts.ts'

export const db = new DatabaseSync(path.join(TOOLS, 'rig.db'))

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
  create table if not exists events (
    ts        integer primary key,
    n         integer,
    total     integer,
    match_id  text,
    league_id text,
    result    text,
    bytes     integer
  );

  create index if not exists idx_em on entity_matches (kind, entity_id);
  create index if not exists idx_counters_gem on counters (gem, ts);
`)

// Схема догоняется до текущей при каждом старте. Идемпотентно.
const migrated = migrate(db)
if (migrated.length) console.log('миграция:', migrated.join(', '))

// Журнал расхода развязывается по аккаунтам. Всё, что накоплено до этого,
// принадлежит первому аккаунту — другого тогда не было.
if (splitByAccount(db, ACCOUNT())) console.log('миграция: журнал расхода развязан по аккаунтам')

const meta = db.prepare(`select count(*) c from burned`).get() as { c: number }

// ── перенос из JSON старой панели, один раз ──
export function importLegacy() {
  if (meta.c > 0) return { skipped: true }

  const insBurn = db.prepare(`insert or ignore into burned (account, match_id, league_id, ts, source) values (?,?,?,?,?)`)
  let burned = 0
  if (fs.existsSync(GC)) {
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
export const isBurned = (id: string) =>
  !!db.prepare(`select 1 from burned where account = ? and match_id = ?`).get(ACCOUNT(), id)

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

export function entitySpent(kind: string, id: number) {
  const r = db.prepare(`
    select count(*) c from entity_matches em
    join burned b on b.match_id = em.match_id and b.account = ?
    where em.kind = ? and em.entity_id = ?`).get(ACCOUNT(), kind, id) as { c: number }
  return r.c
}

export function saveSnapshot(rows: { gem: string; assetid: string; name: string; value: number }[]) {
  const ts = Date.now()
  const ins = db.prepare(`insert or ignore into counters (ts, gem, assetid, item, value) values (?,?,?,?,?)`)
  for (const r of rows) ins.run(ts, r.gem, r.assetid, r.name, r.value)
}

// Ряды для графика: максимум по гему на каждый срез.
export function counterSeries() {
  const rows = db.prepare(`
    select ts, gem, max(value) v from counters group by ts, gem order by ts`).all() as { ts: number; gem: string; v: number }[]
  const stamps = [...new Set(rows.map(r => r.ts))]
  const gems = [...new Set(rows.map(r => r.gem))]
  const byKey = new Map(rows.map(r => [r.ts + '|' + r.gem, r.v]))
  return {
    stamps,
    series: gems.map(g => ({ gem: g, points: stamps.map(t => byKey.get(t + '|' + g) ?? null) }))
      .filter(s => s.points.some(p => (p ?? 0) > 0)),
  }
}

export function pushEvent(e: any, account = ACCOUNT()) {
  db.prepare(`insert or replace into events (ts, n, total, match_id, league_id, result, bytes, account) values (?,?,?,?,?,?,?,?)`)
    .run(e.ts, e.n ?? null, e.total ?? null, String(e.match), String(e.league ?? ''), e.result, e.bytes ?? 0, String(account))
}

export function recentEvents(limit = 240) {
  return db.prepare(`select * from events order by ts desc limit ?`).all(limit) as any[]
}

export function supplyRows() {
  return db.prepare(`select * from supply`).all() as any[]
}

// Последняя отправка, которую Valve засчитала. Пульту нужна одна строка:
// «последнее подтверждение N секунд назад» отвечает на «оно вообще живое?».
export function lastConfirmed() {
  return db.prepare(`select ts, match_id, league_id, bytes from events where result = 'update' order by ts desc limit 1`).get() as any ?? null
}

// Сколько отправок засчитано за последние N минут — текущий темп по факту,
// а не по настройке паузы.
export function ratePerMinute(windowMs = 120_000) {
  const since = Date.now() - windowMs
  const r = db.prepare(`select count(*) c from events where ts >= ? and result in ('update','dup')`).get(since) as any
  return Math.round((r?.c ?? 0) / (windowMs / 60_000))
}
