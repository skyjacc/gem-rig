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
