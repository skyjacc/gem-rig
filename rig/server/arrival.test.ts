import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  ARRIVALS_DDL, arrivalsOf, asideSet, expectedFor, ingestArrivals, judge, setAside,
} from './arrival.ts'

function fresh() {
  const db = new DatabaseSync(':memory:')
  db.exec(ARRIVALS_DDL)
  db.exec(`create table burned (
    account text not null, match_id text not null, league_id text, ts integer,
    source text, state text default 'confirmed', primary key (account, match_id))`)
  db.exec(`create table counters (
    ts integer, gem text, assetid text, item text, value integer, carrier text default 'item',
    primary key (ts, assetid))`)
  db.exec(`create table supply (gem text primary key, kind text, entity_id integer)`)
  db.exec(`create table vmatch (match_id text primary key, league_id text, radiant integer, dire integer)`)
  db.exec(`create table vplayer (match_id text, account_id integer, primary key (match_id, account_id))`)
  return db
}

const burn = (db: DatabaseSync, match: string, ts: number, state = 'confirmed', account = 'A') =>
  db.prepare(`insert into burned (account, match_id, league_id, ts, source, state) values (?,?,?,?,?,?)`)
    .run(account, match, '9', ts, 'test', state)

// ── судья ──

test('нулевой приход — чистое сырьё фарма', () => {
  assert.equal(judge(0, 0), 'чисто')
  assert.equal(judge(0, 100), 'чисто')
})

test('число в пределах нашего вклада — «наш»', () => {
  assert.equal(judge(30, 0), 'наш')
  assert.equal(judge(100, 100), 'наш')
})

test('чужое число сверх вклада — выигрыш', () => {
  assert.equal(judge(730, 10), 'выигрыш')
  assert.equal(judge(100, 0), 'выигрыш')
})

test('порог выигрыша можно поднять', () => {
  assert.equal(judge(60, 0, 100), 'наш')
  assert.equal(judge(160, 0, 100), 'выигрыш')
})

// ── наш вклад ──

test('вклад считается только по матчам сущности и только в окне', () => {
  const db = fresh()
  db.prepare(`insert into supply values ('Spectator: Alliance', 'team', 1)`).run()
  db.prepare(`insert into vmatch values ('1', '9', 1, 2)`).run()
  db.prepare(`insert into vmatch values ('2', '9', 1, 2)`).run()
  db.prepare(`insert into vmatch values ('3', '9', 2, 3)`).run()

  const now = Date.now()
  burn(db, '1', now - 60_000)         // наш матч в окне — считается
  burn(db, '3', now - 60_000)         // чужой матч в окне — нет
  burn(db, '2', now - 30 * 60_000)    // наш матч вне окна — нет
  burn(db, '4', now - 60_000, 'dup')  // наш, но спорный — не подтверждение

  assert.equal(expectedFor(db, 'A', 'Alliance', now - 15 * 60_000, now), 1)
})

test('неизвестная сущность — верхняя граница по всем отправкам', () => {
  const db = fresh()
  const now = Date.now()
  burn(db, '1', now - 60_000)
  burn(db, '2', now - 60_000)
  burn(db, '3', now - 60_000, 'dup')
  assert.equal(expectedFor(db, 'A', 'Кто-то', now - 15 * 60_000, now), 2)
})

test('вклад чужого аккаунта не считается', () => {
  const db = fresh()
  const now = Date.now()
  burn(db, '1', now - 60_000, 'confirmed', 'B')
  assert.equal(expectedFor(db, 'A', 'Кто-то', now - 15 * 60_000, now), 0)
})

// ── ингест ──

test('первый запуск застёгивает историю как старое и не трогает её дальше', () => {
  const db = fresh()
  db.prepare(`insert into counters values (1, 'Alliance', 'old-1', 'Spectator: Alliance', 1200, 'item')`).run()

  ingestArrivals(db, 'A', [{ assetid: 'old-1', gem: 'Alliance', name: 'Spectator: Alliance', value: 1200 }])
  const rows = db.prepare(`select * from arrivals`).all() as any[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].verdict, 'старое')
  // старое не попадает в список панели
  assert.equal(arrivalsOf(db).length, 0)
})

test('новая вещь с нулём — чисто, с чужим числом — выигрыш', () => {
  const db = fresh()
  db.prepare(`insert into counters values (1, 'Alliance', 'old-1', 'Spectator: Alliance', 0, 'item')`).run()
  ingestArrivals(db, 'A', [{ assetid: 'old-1', gem: 'Alliance', name: 'Spectator: Alliance', value: 0 }])

  const wins = ingestArrivals(db, 'A', [
    { assetid: 'new-1', gem: 'Alliance', name: 'Spectator: Alliance', value: 0 },
    { assetid: 'new-2', gem: 'Alliance', name: 'Spectator: Alliance', value: 730 },
  ])
  assert.equal(wins, 1)

  const by = new Map(arrivalsOf(db).map(r => [r.assetid, r]))
  assert.equal(by.get('new-1')?.verdict, 'чисто')
  assert.equal(by.get('new-2')?.verdict, 'выигрыш')
  assert.equal(by.get('new-2')?.unexplained, 730)
})

test('наши отправки в окне объясняют число и гасят ложный выигрыш', () => {
  const db = fresh()
  db.prepare(`insert into counters values (1, 'Alliance', 'old-1', 'Spectator: Alliance', 0, 'item')`).run()
  ingestArrivals(db, 'A', [{ assetid: 'old-1', gem: 'Alliance', name: 'Spectator: Alliance', value: 0 }])

  // сущность известна, в окне — сорок наших матчей
  db.prepare(`insert into supply values ('Spectator: Alliance', 'team', 1)`).run()
  const now = Date.now()
  const ins = db.prepare(`insert into vmatch values (?, '9', 1, 2)`)
  for (let i = 0; i < 40; i++) { ins.run('match-' + i); burn(db, 'match-' + i, now - 60_000) }

  ingestArrivals(db, 'A', [
    { assetid: 'mid', gem: 'Alliance', name: 'Spectator: Alliance', value: 40 },
    { assetid: 'big', gem: 'Alliance', name: 'Spectator: Alliance', value: 730 },
  ])
  const by = new Map(arrivalsOf(db).map(r => [r.assetid, r]))
  // сорок объяснимы нашей работой — не находка
  assert.equal(by.get('mid')?.verdict, 'наш')
  assert.equal(by.get('mid')?.expected, 40)
  // а 730 при сорока наших — всё равно выигрыш
  assert.equal(by.get('big')?.verdict, 'выигрыш')
  assert.equal(by.get('big')?.unexplained, 690)
})

test('повторный ингест не плодит дублей — рестарт ничего не объявляет приходом', () => {
  const db = fresh()
  const rows = [{ assetid: 'a1', gem: 'X', name: 'Spectator: X', value: 0 }]
  ingestArrivals(db, 'A', rows)
  ingestArrivals(db, 'A', rows)
  assert.equal((db.prepare(`select count(*) c from arrivals`).get() as any).c, 1)
})

// ── отложенное ──

test('отложенное видно множеством и возвращается назад', () => {
  const db = fresh()
  db.prepare(`insert into counters values (1, 'X', 'old-1', 'Spectator: X', 0, 'item')`).run()
  ingestArrivals(db, 'A', [
    { assetid: 'old-1', gem: 'X', name: 'Spectator: X', value: 0 },
    { assetid: 'win', gem: 'X', name: 'Spectator: X', value: 900 },
  ])

  assert.equal(asideSet(db, 'A').size, 0)
  setAside(db, 'win', true)
  assert.deepEqual([...asideSet(db, 'A')], ['win'])

  const row = arrivalsOf(db).find(r => r.assetid === 'win')
  assert.equal(row?.aside, true)

  setAside(db, 'win', false)
  assert.equal(asideSet(db, 'A').size, 0)
})
