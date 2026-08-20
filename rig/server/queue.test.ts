import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { buildQueue, queueFor, type Pick } from './queue.ts'

const M = (match: string, league: string) => ({ match, league })

test('одна сущность — все её матчи с весом 1', () => {
  const q = buildQueue(new Map([['A', [M('1', '10'), M('2', '10')]]]), new Set())
  assert.equal(q.length, 2)
  assert.ok(q.every(r => r.weight === 1))
  assert.ok(q.every(r => r.league === '10'))
})

test('общий матч встречается один раз и получает вес 2', () => {
  const q = buildQueue(new Map([
    ['A', [M('1', '10'), M('2', '10')]],
    ['B', [M('2', '10'), M('3', '11')]],
  ]), new Set())
  assert.equal(q.length, 3, 'матч 2 не задвоился')
  const two = q.find(r => r.match === '2')!
  assert.equal(two.weight, 2)
  assert.deepEqual([...two.entities].sort(), ['A', 'B'])
})

test('тяжёлые матчи идут первыми', () => {
  const q = buildQueue(new Map([
    ['A', [M('1', '10'), M('9', '10')]],
    ['B', [M('9', '10')]],
    ['C', [M('9', '10')]],
  ]), new Set())
  assert.equal(q[0].match, '9')
  assert.equal(q[0].weight, 3)
})

test('сожжённые исключаются', () => {
  const q = buildQueue(new Map([['A', [M('1', '10'), M('2', '10'), M('3', '10')]]]), new Set(['2']))
  assert.deepEqual(q.map(r => r.match), ['1', '3'])
})

test('матч без номера турнира выбрасывается — GC его молча отвергнет', () => {
  const q = buildQueue(new Map([['A', [M('1', '10'), M('2', ''), M('3', '0'), M('4', '11')]]]), new Set())
  assert.deepEqual(q.map(r => r.match), ['1', '4'])
})

test('порядок устойчив при равном весе', () => {
  const a = buildQueue(new Map([['A', [M('3', '10'), M('1', '10'), M('2', '10')]]]), new Set())
  const b = buildQueue(new Map([['A', [M('2', '10'), M('3', '10'), M('1', '10')]]]), new Set())
  assert.deepEqual(a.map(r => r.match), b.map(r => r.match))
})

test('пустой вход даёт пустую очередь', () => {
  assert.deepEqual(buildQueue(new Map(), new Set()), [])
  assert.deepEqual(buildQueue(new Map([['A', []]]), new Set()), [])
})

test('всё сожжено — очередь пуста', () => {
  assert.deepEqual(buildQueue(new Map([['A', [M('1', '10')]]]), new Set(['1'])), [])
})

// ── выборка из карты ──

function fresh() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    create table vmatch (match_id text primary key, league_id text,
      radiant integer, dire integer, start_time integer, lobby_type integer);
    create table vplayer (match_id text, account_id integer, primary key (match_id, account_id));
    create table burned (match_id text primary key, league_id text, ts integer,
      source text, state text default 'confirmed');`)
  const m = db.prepare('insert into vmatch values (?,?,?,?,?,?)')
  const p = db.prepare('insert into vplayer values (?,?)')
  m.run('1', '100', 46, 36, 0, 2)   // Empire против NaVi
  m.run('2', '100', 46, 99, 0, 2)   // Empire против чужих
  m.run('3', '200', 77, 88, 0, 2)   // без наших
  m.run('4', '', 46, 55, 0, 2)      // Empire, но турнир неизвестен
  p.run('1', 555); p.run('2', 555); p.run('3', 777)
  return db
}

const EMPIRE: Pick = { key: 'Empire', kind: 'team', id: 46 }
const NAVI: Pick = { key: 'NaVi', kind: 'team', id: 36 }
const PLAYER: Pick = { key: 'Игрок', kind: 'player', id: 555 }

test('команда собирается с обеих сторон карты', () => {
  const q = queueFor(fresh(), [EMPIRE])
  assert.deepEqual(q.map(r => r.match).sort(), ['1', '2'], 'матч 4 без турнира отброшен')
})

test('игрок собирается по связям', () => {
  const q = queueFor(fresh(), [PLAYER])
  assert.deepEqual(q.map(r => r.match).sort(), ['1', '2'])
})

test('две сущности сливаются, общий матч получает вес 2', () => {
  const q = queueFor(fresh(), [EMPIRE, NAVI])
  assert.equal(q.length, 2, 'матчи 1 и 2, без повторов')
  assert.equal(q[0].match, '1', 'общий идёт первым')
  assert.equal(q[0].weight, 2)
})

test('подтверждённо сожжённое вычитается', () => {
  const db = fresh()
  db.prepare('insert into burned values (?,?,?,?,?)').run('1', null, 1, 'live', 'confirmed')
  assert.deepEqual(queueFor(db, [EMPIRE]).map(r => r.match), ['2'])
})

test('спорное НЕ вычитается — оно может быть живым', () => {
  const db = fresh()
  db.prepare('insert into burned values (?,?,?,?,?)').run('1', null, 1, 'live', 'dup')
  assert.deepEqual(queueFor(db, [EMPIRE]).map(r => r.match).sort(), ['1', '2'])
})

test('неизвестная сущность не роняет сборку', () => {
  assert.deepEqual(queueFor(fresh(), [{ key: 'X', kind: 'team', id: 99999 }]), [])
  assert.deepEqual(queueFor(fresh(), []), [])
})
