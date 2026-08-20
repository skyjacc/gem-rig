import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { classifySupply, entityMatchIds, leftFor } from './supply.ts'

// ── классификация запаса ──

test('непустой набор — measured', () => {
  assert.equal(classifySupply(2340, 2340), 'measured')
  assert.equal(classifySupply(1, null), 'measured')
})

test('пустой набор при наличии оценки — estimated', () => {
  assert.equal(classifySupply(0, 1672), 'estimated')
})

test('пустой набор без оценки — empty', () => {
  assert.equal(classifySupply(0, null), 'empty')
  assert.equal(classifySupply(0, 0), 'empty')
})

// ── выборка матчей сущности из карты Valve ──

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
  //  матч  лига  radiant  dire
  m.run('1', '100', 46, 36, 0, 2)   // Empire против NaVi
  m.run('2', '100', 46, 99, 0, 2)   // Empire против чужих
  m.run('3', '200', 77, 88, 0, 2)   // без наших команд
  p.run('1', 555); p.run('1', 666)
  p.run('2', 555)
  p.run('3', 777)
  return db
}

test('команда собирается с обеих сторон карты', () => {
  assert.deepEqual(entityMatchIds(fresh(), { kind: 'team', id: 46 }).sort(), ['1', '2'])
  assert.deepEqual(entityMatchIds(fresh(), { kind: 'team', id: 36 }), ['1'])
})

test('игрок собирается по связям', () => {
  assert.deepEqual(entityMatchIds(fresh(), { kind: 'player', id: 555 }).sort(), ['1', '2'])
  assert.deepEqual(entityMatchIds(fresh(), { kind: 'player', id: 777 }), ['3'])
})

test('лига собирается по своему полю', () => {
  assert.deepEqual(entityMatchIds(fresh(), { kind: 'league', id: 100 }).sort(), ['1', '2'])
})

test('студия — это набор лиг, а не одна', () => {
  const r = entityMatchIds(fresh(), { kind: 'studio', id: 0, leagues: [100, 200] })
  assert.deepEqual(r.sort(), ['1', '2', '3'])
})

test('студия без списка лиг даёт пусто, а не всё подряд', () => {
  assert.deepEqual(entityMatchIds(fresh(), { kind: 'studio', id: 0 }), [])
})

test('неизвестная сущность даёт пусто', () => {
  assert.deepEqual(entityMatchIds(fresh(), { kind: 'unknown', id: 46 }), [])
  assert.deepEqual(entityMatchIds(fresh(), { kind: 'team', id: 12345 }), [])
})

// ── остаток ──

test('остаток = запас минус подтверждённо сожжённое', () => {
  const db = fresh()
  db.prepare('insert into burned values (?,?,?,?,?,?)').run('A', '1', null, 1, 'live', 'confirmed')
  assert.deepEqual(leftFor(db, { kind: 'team', id: 46 }, 'A'), { supply: 2, burned: 1, dup: 0, left: 1 })
})

test('dup считается отдельно и остаток не уменьшает', () => {
  const db = fresh()
  db.prepare('insert into burned values (?,?,?,?,?,?)').run('A', '1', null, 1, 'live', 'dup')
  // dup означает «счётчика не будет», но не доказывает, что матч израсходован:
  // отвергнутое сообщение отвечает тем же. Матч остаётся в очереди.
  assert.deepEqual(leftFor(db, { kind: 'team', id: 46 }, 'A'), { supply: 2, burned: 0, dup: 1, left: 2 })
})

test('reconstructed не вычитается — его ещё надо проверить', () => {
  const db = fresh()
  db.prepare('insert into burned values (?,?,?,?,?,?)').run('A', '1', null, 1, 'recon', 'reconstructed')
  assert.deepEqual(leftFor(db, { kind: 'team', id: 46 }, 'A'), { supply: 2, burned: 0, dup: 0, left: 2 })
})

test('сожжённое чужой сущности остаток не трогает', () => {
  const db = fresh()
  db.prepare('insert into burned values (?,?,?,?,?,?)').run('A', '3', null, 1, 'live', 'confirmed')
  assert.deepEqual(leftFor(db, { kind: 'team', id: 46 }, 'A'), { supply: 2, burned: 0, dup: 0, left: 2 })
})

test('пустая сущность даёт нули, а не падение', () => {
  assert.deepEqual(leftFor(fresh(), { kind: 'team', id: 999 }, 'A'), { supply: 0, burned: 0, dup: 0, left: 0 })
})
