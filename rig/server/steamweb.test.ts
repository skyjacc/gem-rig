import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { GC } from './paths.ts'
import { checkSession, parseSession, sessionFromToken, sessionStatus, validUntil, webCookieHeader, webTokenFile } from './steamweb.ts'

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

// ── пара токенов (план 3.3, задача 0) ──
//
// С 2025-04-30 Steam отвечает AccessDenied на refreshAccessToken() и
// getWebCookies() для SteamClient-токена вне CM-сессии (документация
// steam-session). Значит, этим методом жив ли игровой токен — не узнать.

const jwt = (payload: object) =>
  [{ typ: 'JWT', alg: 'EdDSA' }, payload].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.') + '.подпись'
const NOW = 1_790_000_000_000

test('срок токена — из exp самого токена; не JWT — неизвестен', () => {
  assert.equal(validUntil(jwt({ exp: 1_800_000_000 })), 1_800_000_000_000)
  assert.equal(validUntil('не-токен'), null)
  assert.equal(validUntil(jwt({ sub: '1' })), null)
})

test('игровой токен: не истёк — «неизвестно» с пояснением, не «отозвана»', () => {
  const s = sessionFromToken(JSON.stringify({ refreshToken: jwt({ exp: 1_800_000_000 }) }), NOW)
  assert.equal(s.state, 'unknown')
  assert.match(String(s.error), /недоступна/)
  assert.equal(s.validUntil, 1_800_000_000_000)
})

test('игровой токен: истёк — «отозвана» с причиной; нет файла — missing; битый — error', () => {
  const s = sessionFromToken(JSON.stringify({ refreshToken: jwt({ exp: 1_780_000_000 }) }), NOW)
  assert.equal(s.state, 'revoked')
  assert.match(String(s.error), /срок токена истёк/)
  assert.equal(sessionFromToken(null, NOW).state, 'missing')
  assert.equal(sessionFromToken('{не json', NOW).state, 'error')
  assert.equal(sessionFromToken(JSON.stringify({}), NOW).state, 'error')
})

test('проверка игровой сессии читает файл и не говорит «отозвана» живому токену', async () => {
  const id = 'tst' + Date.now()
  const file = path.join(GC, 'token-' + id + '.json')
  fs.writeFileSync(file, JSON.stringify({ refreshToken: jwt({ exp: Math.trunc(Date.now() / 1000) + 3600 }) }))
  try {
    const s = await checkSession({ ...A, id, token: 'token-' + id + '.json' })
    assert.equal(s.state, 'unknown')
    assert.ok(s.validUntil && s.validUntil > Date.now())
  } finally { fs.rmSync(file, { force: true }) }
})

test('веб-токен — свой файл, не игровой', () => {
  assert.equal(webTokenFile(A), 'token-web-main.json')
  assert.notEqual(webTokenFile(A), A.token)
})

test('нет веб-токена — понятная ошибка, без обращения к Steam', async () => {
  await assert.rejects(webCookieHeader({ ...A, id: 'нет-такого-' + Date.now() }), /нет веб-сессии/)
})
