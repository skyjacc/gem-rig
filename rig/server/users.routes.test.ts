import { test, after } from 'node:test'
import assert from 'node:assert/strict'

// Маршруты приглашений, входа и допуска (план 7.3) — настоящими запросами.
const { allowedHosts } = await import('./auth.ts')
const { buildApp, prepareDb } = await import('./app.ts')
const { db } = await import('./db.ts')
const users = await import('./users.ts')
prepareDb()
db.prepare('update users set steamid = ? where id = ?').run('76561190000000042', users.OWNER_ID)
const sessA = users.newSession(db, users.OWNER_ID, 'токен').token
const { app } = await buildApp({ token: 'x'.repeat(48), allowed: allowedHosts({}), dist: null })
after(() => app.close())

const H = (s?: string) => ({ host: 'localhost:4322', origin: 'http://localhost:4322', ...(s ? { cookie: 'rig_auth=' + s } : {}) })
const owner = (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, headers: H(sessA), ...(payload ? { payload } : {}) })
const anon = (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, headers: H(), ...(payload ? { payload } : {}) })

test('приглашение: ссылка — один раз; без входа проверяется; отозванное — 404', async () => {
  const r = await owner('POST', '/api/users/invite', { name: 'Дима', days: 7, limits: { accounts: 2, senders: 1 } })
  const link: string = r.json().link
  assert.match(link, /\/i\/[A-Za-z0-9_-]{43}$/)
  const token = link.split('/i/')[1]
  const list = await owner('GET', '/api/users/invites')
  assert.equal(list.body.includes(token), false, 'в списке ссылки нет')
  const ok = await anon('GET', '/api/invite?token=' + token)
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(ok.json().name, 'Дима')
  assert.equal(ok.json().open, false, 'вход для приглашённых закрыт')
  await owner('POST', '/api/users/invite/revoke', { id: r.json().id })
  assert.equal((await anon('GET', '/api/invite?token=' + token)).statusCode, 404)
})

test('проверка ссылки без входа — не чаще 5 раз в минуту с адреса', async () => {
  const codes: number[] = []
  for (let i = 0; i < 6; i++) codes.push((await anon('GET', '/api/invite?token=неверный-' + i)).statusCode)
  assert.ok(codes.includes(429), JSON.stringify(codes))
})

test('вход по приглашению при закрытом входе не начинается', async () => {
  const inv = (await owner('POST', '/api/users/invite', { name: 'Саша', days: 1 })).json()
  const token = inv.link.split('/i/')[1]
  const r = await anon('POST', '/api/auth/steam/start', { purpose: 'приглашение', invite: token })
  assert.ok(r.json().error, r.body)
})

test('допуск: Steam владельца нельзя; один на 24 ч; снятие', async () => {
  const self = await owner('POST', '/api/users/permit', { steamid: '76561190000000042' })
  assert.match(self.json().error, /Steam владельца/)
  const p = await owner('POST', '/api/users/permit', { steamid: '76561190000000077' })
  assert.equal(p.json().ok, true, p.body)
  assert.match((await owner('POST', '/api/users/permit', { steamid: '76561190000000078' })).json().error, /уже есть действующий/)
  const u = (await owner('GET', '/api/users')).json()
  assert.ok(u.permit, 'допуск виден')
  assert.equal(u.permit.steamid.includes('76561190000000077'), false, 'steamid — с маской')
  assert.equal((await owner('POST', '/api/users/permit/revoke')).json().ok, true)
  assert.equal((await owner('GET', '/api/users')).json().permit, null)
})

test('вход для приглашённых: открывает и закрывает только владелец', async () => {
  assert.equal((await owner('POST', '/api/users/entry', { open: true })).json().open, true)
  assert.equal((await owner('GET', '/api/users')).json().entryOpen, true)
  assert.equal((await owner('POST', '/api/users/entry', { open: false })).json().open, false)
  assert.equal((await anon('POST', '/api/users/entry', { open: true })).statusCode, 401)
})
