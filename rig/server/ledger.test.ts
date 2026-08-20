import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { classify, ingestOne } from './ledger.ts'
import { splitByAccount } from './migrate.ts'

test('update означает засчитанный матч — пишем в журнал', () => {
  assert.equal(classify('update'), 'confirmed')
})

// Раньше здесь стояло classify('dup') === 'confirmed'. Замер 20 августа
// на матче 8003261364 это опроверг: отвергнутое сообщение отвечает тем же dup,
// а матч остаётся целым. Подтверждением считается только update.
test('dup пишется, но своим состоянием — это не подтверждение', () => {
  assert.equal(classify('dup'), 'dup')
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
    account text not null, match_id text not null, league_id text, ts integer,
    source text, state text default 'confirmed', primary key (account, match_id))`)
  return db
}

test('update записывает матч как confirmed', () => {
  const db = fresh()
  assert.equal(ingestOne(db, { match: '111', league: '9', result: 'update', ts: 1 }, 'A'), true)
  const r = db.prepare('select * from burned').all() as any[]
  assert.equal(r.length, 1)
  assert.equal(r[0].match_id, '111')
  assert.equal(r[0].league_id, '9')
  assert.equal(r[0].state, 'confirmed')
  assert.equal(r[0].source, 'live')
})

test('dup записывается состоянием dup, а не confirmed', () => {
  const db = fresh()
  ingestOne(db, { match: '222', league: '9', result: 'dup', ts: 2 }, 'A')
  const r = db.prepare('select state from burned').all() as any[]
  assert.equal(r[0].state, 'dup')
})

test('silent не записывает ничего', () => {
  const db = fresh()
  assert.equal(ingestOne(db, { match: '333', league: '9', result: 'silent', ts: 3 }, 'A'), false)
  const r = db.prepare('select * from burned').all() as any[]
  assert.equal(r.length, 0)
})

test('повторный update не плодит дублей', () => {
  const db = fresh()
  ingestOne(db, { match: '444', league: '9', result: 'update', ts: 4 }, 'A')
  ingestOne(db, { match: '444', league: '9', result: 'update', ts: 5 }, 'A')
  const r = db.prepare('select * from burned').all() as any[]
  assert.equal(r.length, 1)
})

test('матч без лиги пишется с null, а не с пустой строкой', () => {
  const db = fresh()
  ingestOne(db, { match: '555', league: '', result: 'update', ts: 6 }, 'A')
  const r = db.prepare('select league_id from burned').get() as any
  assert.equal(r.league_id, null)
})

test('дробная метка времени усекается, а не ломает вставку', () => {
  const db = fresh()
  ingestOne(db, { match: '666', league: null, result: 'update', ts: 1787232572351.9 }, 'A')
  const r = db.prepare('select ts from burned').get() as any
  assert.equal(r.ts, 1787232572351)
})

test('dup НЕ равен confirmed — отвергнутый матч не должен считаться сожжённым', () => {
  assert.equal(classify('dup'), 'dup')
  assert.notEqual(classify('dup'), classify('update'))
})

test('update остаётся единственным надёжным подтверждением', () => {
  assert.equal(classify('update'), 'confirmed')
})

test('dup пишется в журнал, но своим состоянием', () => {
  const db = fresh()
  ingestOne(db, { match: '777', league: '9', result: 'dup', ts: 7 }, 'A')
  const r = db.prepare('select state from burned').get() as any
  assert.equal(r.state, 'dup')
})

// ── развязка по аккаунтам ──
//
// Журнал был общим: burned.match_id — первичный ключ на всю базу. Второй
// аккаунт унаследовал бы расход первого и получил бы пустую очередь.

function shared() {
  const db = new DatabaseSync(':memory:')
  db.exec(`create table burned (
    match_id text primary key, league_id text, ts integer, source text,
    state text default 'confirmed')`)
  const ins = db.prepare('insert into burned values (?,?,?,?,?)')
  ins.run('1', '10', 100, 'live', 'confirmed')
  ins.run('2', '10', 101, 'live', 'dup')
  return db
}

test('старый журнал приписывается первому аккаунту', () => {
  const db = shared()
  splitByAccount(db, '765')
  const rows = db.prepare('select account, match_id, state from burned order by match_id').all() as any[]
  assert.deepEqual(rows.map(r => r.account), ['765', '765'])
  assert.deepEqual(rows.map(r => r.state), ['confirmed', 'dup'])
})

test('после развязки один матч живёт у каждого аккаунта отдельно', () => {
  const db = shared()
  splitByAccount(db, '765')
  ingestOne(db, { match: '1', league: '10', ts: 200, result: 'update' }, '999')
  const rows = db.prepare('select account, state from burned where match_id = ? order by account').all('1') as any[]
  assert.equal(rows.length, 2, 'матч сожжён на 765 и отдельно на 999')
  assert.deepEqual(rows.map(r => r.account), ['765', '999'])
})

test('повторная развязка ничего не ломает', () => {
  const db = shared()
  splitByAccount(db, '765')
  const again = splitByAccount(db, '765')
  assert.equal(again, false, 'второй раз делать нечего')
  assert.equal((db.prepare('select count(*) c from burned').get() as any).c, 2)
})

test('без аккаунта запись не принимается — иначе журнал снова общий', () => {
  const db = shared()
  splitByAccount(db, '765')
  assert.throws(() => ingestOne(db, { match: '3', league: '10', ts: 1, result: 'update' }, ''))
})

test('silent по-прежнему ничего не пишет', () => {
  const db = shared()
  splitByAccount(db, '765')
  assert.equal(ingestOne(db, { match: '9', league: '10', ts: 1, result: 'silent' }, '765'), false)
  assert.equal((db.prepare('select count(*) c from burned').get() as any).c, 2)
})
