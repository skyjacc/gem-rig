import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './migrate.ts'

function old() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    create table burned (match_id text primary key, league_id text, ts integer, source text);
    create table supply (gem text primary key, kind text, entity_id integer,
      entity_name text, matches integer, confidence text, updated integer);
    create table counters (ts integer, gem text, assetid text, item text, value integer,
      primary key (ts, assetid));`)
  return db
}
const cols = (db: any, t: string) =>
  (db.prepare(`pragma table_info(${t})`).all() as any[]).map(c => c.name)

test('добавляет три недостающие колонки', () => {
  const db = old()
  migrate(db)
  assert.ok(cols(db, 'burned').includes('state'))
  assert.ok(cols(db, 'supply').includes('supply_kind'))
  assert.ok(cols(db, 'counters').includes('carrier'))
})

test('у новых колонок правильные значения по умолчанию', () => {
  const db = old()
  db.prepare('insert into burned values (?,?,?,?)').run('1', null, 1787158694876, 'live')
  migrate(db)
  const r = db.prepare('select state from burned').get() as any
  assert.equal(r.state, 'confirmed')
})

test('повторный запуск ничего не ломает', () => {
  const db = old()
  migrate(db)
  const applied = migrate(db)
  assert.deepEqual(applied, [])
})

test('чинит метки времени, испорченные 32-битным усечением', () => {
  const db = old()
  db.prepare('insert into burned values (?,?,?,?)').run('1', null, 455777412, 'empire.csv')
  db.prepare('insert into burned values (?,?,?,?)').run('2', null, 1787158694876, 'live')
  migrate(db)
  const r = db.prepare('select match_id, ts from burned order by match_id').all() as any[]
  assert.equal(r[0].ts, null, 'мусорная метка обнуляется, а не остаётся ложной')
  assert.equal(r[1].ts, 1787158694876, 'правдоподобная метка не трогается')
})

test('сообщает, что именно применила', () => {
  const db = old()
  db.prepare('insert into burned values (?,?,?,?)').run('1', null, 455777412, 'x')
  const applied = migrate(db)
  assert.ok(applied.includes('burned.state'))
  assert.ok(applied.includes('supply.supply_kind'))
  assert.ok(applied.includes('counters.carrier'))
  assert.ok(applied.some(a => a.startsWith('burned.ts')))
})

test('пустой журнал не вызывает ложной починки меток', () => {
  const db = old()
  const applied = migrate(db)
  assert.equal(applied.some(a => a.startsWith('burned.ts')), false)
})

test('таблицы обходчика мигрируются, когда они есть', () => {
  const db = old()
  db.exec(`create table vmatch (match_id text primary key, league_id text,
    radiant integer, dire integer, start_time integer, lobby_type integer)`)
  migrate(db)
  assert.ok(cols(db, 'vmatch').includes('source'))
})

test('отсутствие таблиц обходчика не ломает миграцию', () => {
  const db = old()
  const applied = migrate(db)
  assert.equal(applied.includes('vmatch.source'), false)
  assert.ok(applied.includes('burned.state'), 'остальное всё равно применилось')
})

// ── лента отправок ──
//
// Ключом была одна метка времени. Но отправщик закрывает молчания пачкой
// и выдаёт несколько записей с ОДНОЙ меткой, а два работника шлют
// одновременно. `insert or replace` в такой схеме молча выбрасывал всё,
// кроме последнего: лента врала, темп занижался, и «сколько ушло молча»
// было неизвестно вовсе.

function oldEvents() {
  const db = new DatabaseSync(':memory:')
  db.exec(`create table events (
    ts integer primary key, n integer, total integer,
    match_id text, league_id text, result text, bytes integer)`)
  return db
}

const pk = (db: any) =>
  (db.prepare(`pragma table_info(events)`).all() as any[]).filter(c => c.pk > 0).map(c => c.name)

test('ключ ленты становится составным', () => {
  const db = oldEvents()
  assert.deepEqual(pk(db), ['ts'])
  migrate(db)
  assert.deepEqual(pk(db).sort(), ['account', 'match_id', 'ts'])
})

test('старые записи переезжают все до одной', () => {
  const db = oldEvents()
  const ins = db.prepare(`insert into events (ts, match_id, result) values (?,?,?)`)
  for (let i = 0; i < 25; i++) ins.run(1_700_000_000_000 + i, 'm' + i, 'update')
  migrate(db)
  assert.equal((db.prepare(`select count(*) c from events`).get() as any).c, 25)
})

test('две отправки в одну миллисекунду больше не затирают друг друга', () => {
  const db = oldEvents()
  migrate(db)
  const ins = db.prepare(
    `insert or ignore into events (ts, n, total, match_id, league_id, result, bytes, account) values (?,?,?,?,?,?,?,?)`)
  ins.run(1_700_000_000_000, 1, 2, 'A', '1', 'silent', 0, 'acc1')
  ins.run(1_700_000_000_000, 2, 2, 'B', '1', 'silent', 0, 'acc1')
  // тот же матч, но с другого аккаунта — это другое событие
  ins.run(1_700_000_000_000, 1, 2, 'A', '1', 'update', 500, 'acc2')
  assert.equal((db.prepare(`select count(*) c from events`).get() as any).c, 3)
})

test('повторный разбор того же отчёта ничего не удваивает', () => {
  const db = oldEvents()
  migrate(db)
  const ins = db.prepare(
    `insert or ignore into events (ts, n, total, match_id, league_id, result, bytes, account) values (?,?,?,?,?,?,?,?)`)
  for (let i = 0; i < 3; i++) ins.run(1_700_000_000_000, 1, 1, 'A', '1', 'update', 500, 'acc1')
  assert.equal((db.prepare(`select count(*) c from events`).get() as any).c, 1)
})

test('миграция ленты идемпотентна', () => {
  const db = oldEvents()
  migrate(db)
  assert.equal(migrate(db).length, 0)
})

// Сколько вещей изменил ответ GC (план 2.5, решение 1): новая колонка
// events.items. У записей до неё — NULL («не записывалось»), не 0.

test('самая старая лента: колонка items переживает пересборку, строки на месте, items у них NULL', () => {
  const db = oldEvents()
  db.prepare(`insert into events (ts, match_id, result, bytes) values (?,?,?,?)`).run(1_700_000_000_000, 'm1', 'update', 907)
  migrate(db)
  assert.ok(cols(db, 'events').includes('items'), 'пересборка ключа не должна терять новую колонку')
  const rows = db.prepare(`select match_id, bytes, items from events`).all() as any[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].bytes, 907)
  assert.equal(rows[0].items, null)
})

test('нынешняя лента без items: колонка добавляется, строка на месте, items NULL; повтор — без изменений', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`create table events (
    ts integer not null, n integer, total integer, match_id text, league_id text,
    result text, bytes integer, account text, primary key (ts, account, match_id))`)
  db.prepare(`insert into events (ts, match_id, result, bytes, account) values (?,?,?,?,?)`).run(1_700_000_000_000, 'm1', 'update', 97, 'acc1')
  migrate(db)
  assert.ok(cols(db, 'events').includes('items'))
  assert.equal((db.prepare(`select items from events`).get() as any).items, null)
  assert.deepEqual(migrate(db), [], 'второй раз делать нечего')
  assert.equal((db.prepare(`select count(*) c from events`).get() as any).c, 1)
})
