import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// Свежий checkout без steamid снаружи (ни STEAMID, ни tools/steamid):
// первый аккаунт не выдумывается — реестр пуст, панель зовёт привязать
// по QR, сервер не падает. Неверная переменная = «нет», настоящий
// tools/steamid тогда не читается. Пишется до импорта accounts.ts.
process.env.STEAMID = 'нет'
fs.rmSync(process.env.ACCOUNTS_FILE!, { force: true })

const accounts = await import('./accounts.ts')
const { STEAMID } = await import('./paths.ts')

test('нет steamid и нет реестра — пустой реестр, файл не пишется, аккаунта с пустым steamid нет', () => {
  assert.equal(STEAMID, '')
  assert.deepEqual(accounts.list(), [])
  assert.equal(fs.existsSync(process.env.ACCOUNTS_FILE!), false)
  assert.equal(accounts.ACCOUNT(), '')
})

test('состояние панели собирается и без аккаунтов', async () => {
  const { buildState } = await import('./state.ts')
  assert.doesNotThrow(() => buildState())
})

test('первый привязанный аккаунт становится активным', () => {
  const r = accounts.addAccount({ id: 'perviy', label: 'первый', steamid: '76561190000000009', token: 'token-perviy.json', added: 1 })
  assert.deepEqual(r, { ok: true })
  assert.equal(accounts.activeId(), 'perviy')
  assert.equal(accounts.ACCOUNT(), '76561190000000009')
  assert.equal(JSON.parse(fs.readFileSync(process.env.ACCOUNTS_FILE!, 'utf8')).active, 'perviy')
})
