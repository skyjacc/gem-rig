import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { GC } from './paths.ts'
import {
  checkSession, checkWeb, cookiesFor, exchange, forgetWeb, gameStatus, parseSession, sessionFromToken, sessionStatus, validUntil, webCookieHeader, webStatus, webTokenFile,
} from './steamweb.ts'

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

test('в заголовок — только куки нужного домена: steamLoginSecure приходит по разу на каждый сайт Steam', () => {
  const list = [
    'steamLoginSecure=STORE; Path=/; Domain=store.steampowered.com; Secure',
    'steamLoginSecure=COMM; Path=/; Domain=steamcommunity.com; Secure',
    'sessionid=S1; Path=/; Domain=store.steampowered.com',
    'sessionid=S2; Path=/; Domain=steamcommunity.com',
    'steamCountry=X; Path=/; Domain=.steampowered.com',
    'steamRefresh_steam=R; Path=/; Domain=login.steampowered.com',
    'ak_bmsc=A; Path=/',
  ]
  assert.equal(cookiesFor(list, 'steamcommunity.com'), 'steamLoginSecure=COMM; sessionid=S2')
  assert.equal(cookiesFor(list, 'store.steampowered.com'), 'steamLoginSecure=STORE; sessionid=S1; steamCountry=X')
  assert.equal(cookiesFor(['a=1'], 'steamcommunity.com'), '', 'кука без домена — не наша: не угадываем')
})

// ── две сессии раздельно (план 2.4, решение 1) ──
//
// Игровая и веб — разные токены и разные проверки. Список аккаунтов
// показывает обе сразу и при этом в Steam не ходит: обмен веб-токена на
// куки (webcookies.js) — только по кнопке «проверить».

const tok = (exp: number) => JSON.stringify({ refreshToken: jwt({ exp }) })
// Позже и NOW, и настоящего «сейчас»: проверка веба смотрит на часы.
const LATER = Math.trunc(Math.max(NOW, Date.now()) / 1000) + 30 * 86_400
const BEFORE = Math.trunc(NOW / 1000) - 86_400

function account(game: string | null, web: string | null) {
  const id = 'two' + Math.random().toString(36).slice(2, 8)
  const a = { ...A, id, token: 'token-' + id + '.json' }
  if (game != null) fs.writeFileSync(path.join(GC, a.token), game)
  if (web != null) fs.writeFileSync(path.join(GC, webTokenFile(a)), web)
  return a
}

function spy(answer: () => Promise<string[]>) {
  const calls: string[][] = []
  mock.method(exchange, 'run', (token: string, args: string[]) => { calls.push([token, ...args]); return answer() })
  return calls
}

test('игровая сессия для списка — из файла и сразу со сроком; в Steam не ходит', () => {
  mock.restoreAll()
  const calls = spy(async () => { throw new Error('не должен вызываться') })
  const live = gameStatus(account(tok(LATER), null), NOW)
  assert.equal(live.state, 'unknown')
  assert.equal(live.validUntil, LATER * 1000)
  assert.equal(gameStatus(account(tok(BEFORE), null), NOW).state, 'revoked')
  assert.equal(gameStatus(account(null, null), NOW).state, 'missing')
  assert.equal(gameStatus(account('{битый', null), NOW).state, 'error')
  assert.equal(calls.length, 0)
})

test('веб-сессия без сети: нет файла, истёк, не проверялся, битый файл', () => {
  mock.restoreAll()
  const calls = spy(async () => { throw new Error('не должен вызываться') })
  assert.equal(webStatus(account(null, null), NOW).state, 'missing')
  const old = webStatus(account(null, tok(BEFORE)), NOW)
  assert.equal(old.state, 'expired')
  assert.equal(old.validUntil, BEFORE * 1000)
  const fresh = webStatus(account(null, tok(LATER)), NOW)
  assert.equal(fresh.state, 'unchecked')
  assert.equal(fresh.validUntil, LATER * 1000)
  assert.equal(webStatus(account(null, '{битый'), NOW).state, 'error')
  assert.equal(calls.length, 0)
})

test('проверка веба: «работает» — только по факту полученных кук; имён и значений кук в ответе нет', async () => {
  mock.restoreAll()
  const calls = spy(async () => ['COOKIES ' + JSON.stringify(['steamLoginSecure=СЕКРЕТ; Path=/; Domain=steamcommunity.com', 'sessionid=S; Domain=steamcommunity.com'])])
  const a = account(tok(LATER), tok(LATER))
  const r = await checkWeb(a)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], webTokenFile(a), 'обмен — веб-токена, не игрового')
  assert.equal(r.state, 'ok')
  assert.ok(r.checkedAt > 0)
  assert.doesNotMatch(JSON.stringify(r), /steamLoginSecure|sessionid|СЕКРЕТ/)
  assert.equal(webStatus(a).state, 'ok')
})

test('проверка веба: сбой обмена — «не работает» с текстом, не «работает»', async () => {
  mock.restoreAll()
  spy(async () => { throw new Error('AccessDenied') })
  const a = account(null, tok(LATER))
  const r = await checkWeb(a)
  assert.equal(r.state, 'error')
  assert.match(String(r.error), /AccessDenied/)
})

test('веб и игра не влияют друг на друга', async () => {
  mock.restoreAll()
  spy(async () => ['COOKIES ' + JSON.stringify(['steamLoginSecure=X; Domain=steamcommunity.com'])])
  const a = account(tok(BEFORE), tok(LATER))
  await checkWeb(a)
  assert.equal(webStatus(a).state, 'ok')
  assert.equal(gameStatus(a).state, 'revoked', 'веб работает — игровой токен от этого не ожил')
  await checkSession(a)
  assert.equal(webStatus(a).state, 'ok', 'перечитанная игровая сессия не сбрасывает веб')

  const b = account(tok(LATER), tok(LATER))
  mock.restoreAll()
  spy(async () => { throw new Error('AccessDenied') })
  await checkWeb(b)
  assert.equal(webStatus(b).state, 'error')
  assert.equal(gameStatus(b).state, 'unknown', 'веб не работает — игровой не стал «отозванным»')
})

test('забыть веб — снова «не проверен», а не прежнее «работает»', async () => {
  mock.restoreAll()
  spy(async () => ['COOKIES ' + JSON.stringify(['steamLoginSecure=X; Domain=steamcommunity.com'])])
  const a = account(null, tok(LATER))
  await checkWeb(a)
  forgetWeb(a.id)
  assert.equal(webStatus(a).state, 'unchecked')
})
