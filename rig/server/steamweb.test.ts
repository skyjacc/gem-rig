import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSession, sessionStatus } from './steamweb.ts'

const A = { id: 'main', label: 'основной', steamid: '76561198000000001', token: 'token.json', added: 0 }

test('живая сессия', () => {
  assert.deepEqual(parseSession(['SESSION ok']), { state: 'ok', error: null })
})

test('отозванная сессия — отдельное состояние, с причиной', () => {
  assert.deepEqual(parseSession(['SESSION revoked AccessDenied']), { state: 'revoked', error: 'AccessDenied' })
})

test('сбой проверки — не «отозвана»: сессия может быть живой', () => {
  assert.equal(parseSession(['SESSION error ETIMEDOUT']).state, 'error')
  assert.equal(parseSession([]).state, 'error')
})

test('нет файла токена — missing, не проверялась — unknown', () => {
  assert.equal(sessionStatus(A, false).state, 'missing')
  assert.equal(sessionStatus(A, true).state, 'unknown')
})
