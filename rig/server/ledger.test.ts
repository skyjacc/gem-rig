import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { classify, ingestOne } from './ledger.ts'

test('update означает засчитанный матч — пишем в журнал', () => {
  assert.equal(classify('update'), 'confirmed')
})

test('dup означает, что матч уже был засчитан — тоже пишем', () => {
  assert.equal(classify('dup'), 'confirmed')
})

test('silent не даёт права писать в журнал', () => {
  assert.equal(classify('silent'), null)
})

test('неизвестный результат не даёт права писать', () => {
  assert.equal(classify('what'), null)
  assert.equal(classify(''), null)
})

function fresh() {
  const db = new DatabaseSync(':memory:')
  db.exec(`create table burned (
    match_id text primary key, league_id text, ts integer,
    source text, state text default 'confirmed')`)
  return db
}

test('update записывает матч как confirmed', () => {
  const db = fresh()
  assert.equal(ingestOne(db, { match: '111', league: '9', result: 'update', ts: 1 }), true)
  const r = db.prepare('select * from burned').all() as any[]
  assert.equal(r.length, 1)
  assert.equal(r[0].match_id, '111')
  assert.equal(r[0].league_id, '9')
  assert.equal(r[0].state, 'confirmed')
  assert.equal(r[0].source, 'live')
})

test('dup тоже записывает как confirmed', () => {
  const db = fresh()
  ingestOne(db, { match: '222', league: '9', result: 'dup', ts: 2 })
  const r = db.prepare('select state from burned').all() as any[]
  assert.equal(r[0].state, 'confirmed')
})

test('silent не записывает ничего', () => {
  const db = fresh()
  assert.equal(ingestOne(db, { match: '333', league: '9', result: 'silent', ts: 3 }), false)
  const r = db.prepare('select * from burned').all() as any[]
  assert.equal(r.length, 0)
})

test('повторный update не плодит дублей', () => {
  const db = fresh()
  ingestOne(db, { match: '444', league: '9', result: 'update', ts: 4 })
  ingestOne(db, { match: '444', league: '9', result: 'update', ts: 5 })
  const r = db.prepare('select * from burned').all() as any[]
  assert.equal(r.length, 1)
})

test('матч без лиги пишется с null, а не с пустой строкой', () => {
  const db = fresh()
  ingestOne(db, { match: '555', league: '', result: 'update', ts: 6 })
  const r = db.prepare('select league_id from burned').get() as any
  assert.equal(r.league_id, null)
})

test('дробная метка времени усекается, а не ломает вставку', () => {
  const db = fresh()
  ingestOne(db, { match: '666', league: null, result: 'update', ts: 1787232572351.9 })
  const r = db.prepare('select ts from burned').get() as any
  assert.equal(r.ts, 1787232572351)
})
