import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { buildQueue, entityStat, queueFor, rotate, sendsNeeded, type Pick } from './queue.ts'

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
    create table burned (account text, match_id text, league_id text, ts integer,
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
  const q = queueFor(fresh(), [EMPIRE], 'A')
  assert.deepEqual(q.map(r => r.match).sort(), ['1', '2'], 'матч 4 без турнира отброшен')
})

test('игрок собирается по связям', () => {
  const q = queueFor(fresh(), [PLAYER], 'A')
  assert.deepEqual(q.map(r => r.match).sort(), ['1', '2'])
})

test('две сущности сливаются, общий матч получает вес 2', () => {
  const q = queueFor(fresh(), [EMPIRE, NAVI], 'A')
  assert.equal(q.length, 2, 'матчи 1 и 2, без повторов')
  assert.equal(q[0].match, '1', 'общий идёт первым')
  assert.equal(q[0].weight, 2)
})

test('подтверждённо сожжённое вычитается', () => {
  const db = fresh()
  db.prepare('insert into burned values (?,?,?,?,?,?)').run('A', '1', null, 1, 'live', 'confirmed')
  assert.deepEqual(queueFor(db, [EMPIRE], 'A').map(r => r.match), ['2'])
})

test('спорное НЕ вычитается — оно может быть живым', () => {
  const db = fresh()
  db.prepare('insert into burned values (?,?,?,?,?,?)').run('A', '1', null, 1, 'live', 'dup')
  assert.deepEqual(queueFor(db, [EMPIRE], 'A').map(r => r.match).sort(), ['1', '2'])
})

test('неизвестная сущность не роняет сборку', () => {
  assert.deepEqual(queueFor(fresh(), [{ key: 'X', kind: 'team', id: 99999 }], 'A'), [])
  assert.deepEqual(queueFor(fresh(), [], 'A'), [])
})

// ── потолок по сущности ──

test('потолок считается по карте, а не по чужой оценке', () => {
  const s = entityStat(fresh(), EMPIRE, 'A')
  assert.equal(s.supply, 2, 'матч 4 без турнира отправить нельзя — в потолок не идёт')
  assert.equal(s.burned, 0)
  assert.equal(s.left, 2)
})

test('сожжённое вычитается из остатка, но не из потолка', () => {
  const db = fresh()
  db.prepare('insert into burned values (?,?,?,?,?,?)').run('A', '1', null, 1, 'live', 'confirmed')
  const s = entityStat(db, EMPIRE, 'A')
  assert.equal(s.supply, 2)
  assert.equal(s.burned, 1)
  assert.equal(s.left, 1)
})

test('спорное не уменьшает остаток', () => {
  const db = fresh()
  db.prepare('insert into burned values (?,?,?,?,?,?)').run('A', '1', null, 1, 'live', 'dup')
  assert.equal(entityStat(db, EMPIRE, 'A').left, 2)
})

test('у неизвестной сущности потолок ноль', () => {
  assert.deepEqual(entityStat(fresh(), { key: 'X', kind: 'team', id: 99999 }, 'A'), { supply: 0, burned: 0, left: 0 })
})

test('круг: за один проход каждая сущность получает по матчу', () => {
  const rows = buildQueue(new Map([
    ['A', [{ match: '1', league: '1' }, { match: '2', league: '1' }, { match: '3', league: '1' }]],
    ['B', [{ match: '7', league: '1' }, { match: '8', league: '1' }, { match: '9', league: '1' }]],
  ]), new Set())

  const order = rotate(rows).map(r => r.entities.join('+'))
  assert.deepEqual(order, ['A', 'B', 'A', 'B', 'A', 'B'])
})

test('круг: общий матч засчитывается обоим и второй раз в круге не берётся', () => {
  const rows = buildQueue(new Map([
    ['A', [{ match: '5', league: '1' }, { match: '1', league: '1' }]],
    ['B', [{ match: '5', league: '1' }, { match: '9', league: '1' }]],
  ]), new Set())

  const order = rotate(rows).map(r => r.match)
  // Общий матч идёт первым и закрывает круг для обоих.
  assert.deepEqual(order, ['5', '1', '9'])
})

test('круг: закончившаяся сущность не мешает остальным', () => {
  const rows = buildQueue(new Map([
    ['A', [{ match: '1', league: '1' }]],
    ['B', [{ match: '7', league: '1' }, { match: '8', league: '1' }, { match: '9', league: '1' }]],
  ]), new Set())

  assert.deepEqual(rotate(rows).map(r => r.match), ['1', '7', '8', '9'])
})

test('круг: ни один матч не теряется и не удваивается', () => {
  const rows = buildQueue(new Map([
    ['A', [{ match: '1', league: '1' }, { match: '2', league: '1' }, { match: '5', league: '1' }]],
    ['B', [{ match: '5', league: '1' }, { match: '6', league: '1' }]],
    ['C', [{ match: '9', league: '1' }]],
  ]), new Set())

  const out = rotate(rows)
  assert.equal(out.length, rows.length)
  assert.equal(new Set(out.map(r => r.match)).size, rows.length)
})

test('долг: считается по очереди, а общий матч закрывает долг обоим', () => {
  const rows = buildQueue(new Map([
    ['A', [{ match: '5', league: '1' }, { match: '1', league: '1' }]],
    ['B', [{ match: '5', league: '1' }, { match: '9', league: '1' }]],
  ]), new Set())

  // Обоим нужно по одной — хватит одного общего матча.
  assert.equal(sendsNeeded(rotate(rows), new Map([['A', 1], ['B', 1]])), 1)
  // Обоим по две — общий плюс по своему.
  assert.equal(sendsNeeded(rotate(rows), new Map([['A', 2], ['B', 2]])), 3)
})

test('долг: запаса не хватает — отдаём всю очередь, а не выдуманное число', () => {
  const rows = buildQueue(new Map([['A', [{ match: '1', league: '1' }]]]), new Set())
  assert.equal(sendsNeeded(rotate(rows), new Map([['A', 900]])), 1)
})

test('долг: никому ничего не должны — ноль отправок', () => {
  const rows = buildQueue(new Map([['A', [{ match: '1', league: '1' }]]]), new Set())
  assert.equal(sendsNeeded(rotate(rows), new Map([['A', 0]])), 0)
  assert.equal(sendsNeeded(rotate(rows), new Map()), 0)
})

test('долг: чего нет в запасе, того и не ждём', () => {
  const rows = buildQueue(new Map([
    ['A', [{ match: '1', league: '1' }, { match: '2', league: '1' }, { match: '3', league: '1' }]],
    ['B', [{ match: '7', league: '1' }]],
  ]), new Set())

  // B хочет сотню, а матч у него один: считаем по тому, что есть.
  // A получает свои два за два круга, B закрывается в первом же.
  assert.equal(sendsNeeded(rotate(rows), new Map([['A', 2], ['B', 100]])), 3)
})

test('долг: дошедший выбывает и больше не занимает круг', () => {
  // A нужен один матч, B — три. После первого круга A выбывает,
  // и B добирает своё подряд: всего четыре отправки, а не шесть.
  const rows = buildQueue(new Map([
    ['A', [{ match: '1', league: '1' }, { match: '2', league: '1' }]],
    ['B', [{ match: '7', league: '1' }, { match: '8', league: '1' }, { match: '9', league: '1' }]],
  ]), new Set())

  assert.equal(sendsNeeded(rows, new Map([["A", 1], ["B", 3]])), 4)
})

test('уже пробованное уходит в хвост, но из очереди не выбывает', () => {
  const rows = buildQueue(
    new Map([['A', [{ match: '1', league: '1' }, { match: '2', league: '1' }, { match: '3', league: '1' }]]]),
    new Set(),
    new Set(['1', '2']),
  )

  assert.deepEqual(rows.map(r => r.match), ['3', '1', '2'])
  assert.equal(rows.length, 3, 'спорные остаются в работе')
})

test('общий матч всё равно впереди нетронутого одиночного', () => {
  const rows = buildQueue(new Map([
    ['A', [{ match: '5', league: '1' }, { match: '9', league: '1' }]],
    ['B', [{ match: '5', league: '1' }]],
  ]), new Set(), new Set())

  assert.equal(rows[0].match, '5')
})

test('пробованный общий матч уступает нетронутому одиночному', () => {
  const rows = buildQueue(new Map([
    ['A', [{ match: '5', league: '1' }, { match: '9', league: '1' }]],
    ['B', [{ match: '5', league: '1' }]],
  ]), new Set(), new Set(['5']))

  assert.deepEqual(rows.map(r => r.match), ['9', '5'])
})

// ── повторы dup ──

test('dup после второй безответной попытки из очереди выходит', () => {
  const db = fresh()
  db.exec(`alter table burned add column tries integer default 1`)
  db.prepare('insert into burned values (?,?,?,?,?,?,?)').run('A', '1', null, 1, 'live', 'dup', 2)
  assert.deepEqual(queueFor(db, [EMPIRE], 'A').map(r => r.match), ['2'])
})

test('dup с одной попыткой ещё повторяется — в хвосте', () => {
  const db = fresh()
  db.exec(`alter table burned add column tries integer default 1`)
  db.prepare('insert into burned values (?,?,?,?,?,?,?)').run('A', '1', null, 1, 'live', 'dup', 1)
  assert.deepEqual(queueFor(db, [EMPIRE], 'A').map(r => r.match), ['2', '1'])
})