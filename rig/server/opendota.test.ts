import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usableOnly } from './opendota.ts'

test('матчи без лиги отбрасываются — их нельзя отправить', () => {
  const rows = usableOnly([
    { id: '1', league: '16710' },
    { id: '2', league: '' },
    { id: '3', league: '0' },
    { id: '4', league: '19944' },
  ])
  assert.deepEqual(rows.map(r => r.id), ['1', '4'])
})

test('мусор в поле лиги не проходит', () => {
  const rows = usableOnly([
    { id: '1', league: 'undefined' },
    { id: '2', league: 'null' },
    { id: '3', league: '-5' },
    { id: '4', league: '16710' },
  ])
  assert.deepEqual(rows.map(r => r.id), ['4'])
})

test('пустой вход не падает', () => {
  assert.deepEqual(usableOnly([]), [])
})
