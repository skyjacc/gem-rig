import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { allowedHosts } from './auth.ts'

// Приложение собирается без запуска сервера (план 7.2): маршруты
// проверяются настоящими запросами через app.inject.
const { buildApp, prepareDb } = await import('./app.ts')
prepareDb()
const TOKEN = 't'.repeat(48)
const { app } = await buildApp({ token: TOKEN, allowed: allowedHosts({}), dist: null })
after(() => app.close())

const H = { host: 'localhost:4322', origin: 'http://localhost:4322' }

test('без входа — /api закрыт, проверка входа открыта', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/accounts', headers: H })
  assert.equal(r.statusCode, 401)
  const a = await app.inject({ method: 'GET', url: '/api/auth', headers: H })
  assert.equal(a.json().authed, false)
})

test('вход токеном — сессия в куке; с ней /api открыт', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/login', headers: H, payload: { token: TOKEN } })
  assert.equal(r.statusCode, 200)
  const cookie = String(r.headers['set-cookie']).split(';')[0]
  assert.match(cookie, /^rig_auth=[0-9a-f]{64}$/)
  const a = await app.inject({ method: 'GET', url: '/api/auth', headers: { ...H, cookie } })
  assert.equal(a.json().authed, true)
  const acc = await app.inject({ method: 'GET', url: '/api/accounts', headers: { ...H, cookie } })
  assert.equal(acc.statusCode, 200)
})
