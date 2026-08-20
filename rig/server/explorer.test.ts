import { test } from 'node:test'
import assert from 'node:assert/strict'
import { playerSql, teamSql, leagueSql, parseRows } from './explorer.ts'

test('запрос по игроку джойнит matches и требует настоящую лигу', () => {
  const sql = playerSql(93616251)
  assert.match(sql, /player_matches/)
  assert.match(sql, /account_id = 93616251/)
  assert.match(sql, /leagueid > 0/)
})

test('запрос по команде смотрит обе стороны', () => {
  const sql = teamSql(111474)
  assert.match(sql, /radiant_team_id = 111474/)
  assert.match(sql, /dire_team_id = 111474/)
  assert.match(sql, /leagueid > 0/)
})

test('запрос по лиге фильтрует по ней самой', () => {
  assert.match(leagueSql(19944), /leagueid = 19944/)
})

test('идентификаторы приводятся к числу — в SQL не уходит строка', () => {
  assert.match(playerSql('93616251; drop table matches' as any), /account_id = 0/)
  assert.match(teamSql(Number.NaN), /radiant_team_id = 0/)
  assert.match(leagueSql(-5), /leagueid = 0/)
})

test('разбор ответа даёт строковые id и строковые лиги', () => {
  const rows = parseRows({ rows: [{ match_id: 26819809, leagueid: 7 }] })
  assert.deepEqual(rows, [{ id: '26819809', league: '7' }])
})

test('большие match_id не теряют точность', () => {
  const rows = parseRows({ rows: [{ match_id: 8942262723, leagueid: 19944 }] })
  assert.equal(rows[0].id, '8942262723')
})

test('строки без лиги отбрасываются — их всё равно нельзя отправить', () => {
  const rows = parseRows({ rows: [{ match_id: 1, leagueid: 0 }, { match_id: 2, leagueid: null }] })
  assert.deepEqual(rows, [])
})

test('ошибка и мусор дают пустой список, а не падение', () => {
  assert.deepEqual(parseRows({ err: 'syntax error' }), [])
  assert.deepEqual(parseRows(null), [])
  assert.deepEqual(parseRows(undefined), [])
  assert.deepEqual(parseRows({ rows: 'nope' }), [])
  assert.deepEqual(parseRows({ rows: [] }), [])
})
