import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  allowedHosts, bearer, cookieValue, gate, hostAllowed, hostname, loadToken, loginCookie, originAllowed, sameToken,
} from './auth.ts'

const T = 'a'.repeat(48)
const A = allowedHosts({})
const req = (over: Partial<{ method: string; url: string; headers: Record<string, string> }> = {}) => ({
  method: 'GET',
  url: '/api/state',
  ...over,
  headers: { host: 'localhost:4322', ...(over.headers ?? {}) },
})

test('имя хоста без порта, в том числе IPv6', () => {
  assert.equal(hostname('localhost:4322'), 'localhost')
  assert.equal(hostname('[::1]:4322'), '::1')
  assert.equal(hostname('Rig.Tail1234.ts.net'), 'rig.tail1234.ts.net')
})

test('чужое имя хоста отбивается — защита от DNS rebinding', () => {
  assert.equal(hostAllowed('evil.example:4322', A), false)
  assert.equal(hostAllowed('localhost:4322', A), true)
  assert.equal(hostAllowed('127.0.0.1:4322', A), true)
  assert.equal(hostAllowed(undefined, A), false)
})

test('ALLOWED_HOSTS добавляет имя из tailnet', () => {
  const a = allowedHosts({ ALLOWED_HOSTS: 'rig.tail1234.ts.net, other' })
  assert.equal(hostAllowed('rig.tail1234.ts.net', a), true)
  assert.equal(hostAllowed('other:80', a), true)
})

test('Origin: свой проходит, чужой нет, без заголовка — не браузер', () => {
  assert.equal(originAllowed('http://localhost:5173', A), true)
  assert.equal(originAllowed('https://evil.example', A), false)
  assert.equal(originAllowed('null', A), false)
  assert.equal(originAllowed(undefined, A), true)
})

test('кука и Bearer читаются', () => {
  assert.equal(cookieValue('x=1; rig_auth=abc; y=2'), 'abc')
  assert.equal(cookieValue('x=1'), '')
  assert.equal(bearer('Bearer abc'), 'abc')
  assert.equal(bearer('Basic abc'), '')
})

test('сравнение токена: пустой и разной длины не проходят', () => {
  assert.equal(sameToken(T, T), true)
  assert.equal(sameToken('', ''), false)
  assert.equal(sameToken(T, T + 'x'), false)
})

test('без токена /api закрыт, статика открыта', () => {
  assert.deepEqual(gate(req(), T, A), { ok: false, code: 401, why: 'нужен вход' })
  assert.deepEqual(gate(req({ url: '/' }), T, A), { ok: true })
  assert.deepEqual(gate(req({ url: '/assets/index.js' }), T, A), { ok: true })
})

test('с кукой или Bearer /api открыт', () => {
  assert.deepEqual(gate(req({ headers: { cookie: 'rig_auth=' + T } }), T, A), { ok: true })
  assert.deepEqual(gate(req({ headers: { authorization: 'Bearer ' + T } }), T, A), { ok: true })
  assert.equal(gate(req({ headers: { cookie: 'rig_auth=wrong' } }), T, A).ok, false)
})

test('проверка и вход открыты без токена, но не с чужой страницы', () => {
  assert.deepEqual(gate(req({ url: '/api/auth' }), T, A), { ok: true })
  assert.deepEqual(gate(req({ url: '/api/login?token=x' }), T, A), { ok: true })
  const cross = gate(req({ method: 'POST', url: '/api/login', headers: { origin: 'https://evil.example' } }), T, A)
  assert.equal(cross.ok, false)
})

test('POST с чужой страницы отбивается даже с кукой', () => {
  const g = gate(req({
    method: 'POST', url: '/api/market/buy',
    headers: { cookie: 'rig_auth=' + T, origin: 'https://evil.example' },
  }), T, A)
  assert.deepEqual(g, { ok: false, code: 403, why: 'запрос с чужой страницы' })
})

test('чужой Host отбивается раньше всего, даже для статики', () => {
  assert.equal(gate(req({ url: '/', headers: { host: 'evil.example' } }), T, A).ok, false)
})

test('кука: HttpOnly и SameSite=Strict, Secure только по https', () => {
  assert.match(loginCookie(T, false), /HttpOnly; SameSite=Strict/)
  assert.doesNotMatch(loginCookie(T, false), /Secure/)
  assert.match(loginCookie(T, true), /; Secure$/)
})

test('токен создаётся один раз и дальше читается из файла', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-auth-'))
  const file = path.join(dir, 'panel.token')
  const first = loadToken({}, file)
  assert.equal(first.created, true)
  assert.ok(first.token.length >= 32)
  const again = loadToken({}, file)
  assert.equal(again.created, false)
  assert.equal(again.token, first.token)
  assert.deepEqual(loadToken({ PANEL_TOKEN: 'from-env' }, file), { token: 'from-env', created: false })
  fs.rmSync(dir, { recursive: true, force: true })
})
