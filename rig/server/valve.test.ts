import { test } from 'node:test'
import assert from 'node:assert/strict'
import { historyUrl, parseHistory, ANON } from './valve.ts'

test('адрес запроса содержит лигу, размер страницы и ключ', () => {
  const u = historyUrl('KEY', 16710, null)
  assert.match(u, /league_id=16710/)
  assert.match(u, /matches_requested=100/)
  assert.match(u, /key=KEY/)
  assert.doesNotMatch(u, /start_at_match_id/)
})

test('курсор пагинации подставляется, когда он есть', () => {
  assert.match(historyUrl('KEY', 16710, '8003648005'), /start_at_match_id=8003648005/)
})

test('лига приводится к числу — в адрес не уходит строка', () => {
  // Number() на такой строке даёт NaN, значит подставляется 0 и запрос вернёт
  // пустоту. Частичного разбора нет — это строже, чем parseInt, и так надёжнее.
  assert.match(historyUrl('KEY', '16710 or 1=1' as any, null), /league_id=0&/)
  assert.match(historyUrl('KEY', Number.NaN, null), /league_id=0&/)
  assert.match(historyUrl('KEY', -5, null), /league_id=0&/)
  assert.match(historyUrl('KEY', 16710, null), /league_id=16710&/)
})

const sample = {
  result: {
    status: 1,
    results_remaining: 0,
    matches: [
      {
        match_id: 8003648006, start_time: 1729800000, lobby_type: 2,
        radiant_team_id: 9498970, dire_team_id: 9572001,
        players: [
          { account_id: 111, player_slot: 0 },
          { account_id: 222, player_slot: 1 },
          { account_id: ANON, player_slot: 2 },
        ],
      },
    ],
  },
}

test('разбор достаёт матч, команды и игроков', () => {
  const r = parseHistory(sample, 16710)
  assert.equal(r.matches.length, 1)
  const m = r.matches[0]
  assert.equal(m.matchId, '8003648006')
  assert.equal(m.leagueId, '16710')
  assert.equal(m.radiant, 9498970)
  assert.equal(m.dire, 9572001)
})

test('анонимные аккаунты выбрасываются — по ним ничего не сопоставить', () => {
  const r = parseHistory(sample, 16710)
  assert.deepEqual(r.matches[0].players, [111, 222])
})

test('курсор — предыдущий id последнего матча страницы', () => {
  const r = parseHistory(sample, 16710)
  assert.equal(r.next, '8003648005')
})

test('неполная страница означает конец лиги', () => {
  assert.equal(parseHistory(sample, 16710).done, true)
})

test('полная страница означает, что надо идти дальше', () => {
  const full = { result: { status: 1, matches: Array.from({ length: 100 }, (_, i) => ({
    match_id: 1000 - i, radiant_team_id: 1, dire_team_id: 2, players: [],
  })) } }
  const r = parseHistory(full, 1)
  assert.equal(r.done, false)
  assert.equal(r.next, '900')
})

test('пустой и битый ответ не роняют разбор', () => {
  for (const bad of [null, {}, { result: {} }, { result: { matches: [] } }, { result: { matches: 'nope' } }]) {
    const r = parseHistory(bad, 1)
    assert.deepEqual(r.matches, [])
    assert.equal(r.done, true)
  }
})

test('отказ Valve виден в поле error, а не молчанием', () => {
  const r = parseHistory({ result: { status: 15, statusDetail: 'Match data disabled' } }, 1)
  assert.equal(r.matches.length, 0)
  assert.equal(r.done, true)
  assert.match(String(r.error), /15/)
})

test('матч без команд сохраняется — участники всё равно важны', () => {
  const r = parseHistory({ result: { matches: [{ match_id: 5, players: [{ account_id: 9 }] }] } }, 3)
  assert.equal(r.matches[0].radiant, 0)
  assert.equal(r.matches[0].dire, 0)
  assert.deepEqual(r.matches[0].players, [9])
})
