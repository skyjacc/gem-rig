import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// Реестр уже есть — он и читается, откуда бы ни брался steamid для
// первого аккаунта (здесь его нет вовсе). Все id вымышленные.
process.env.STEAMID = 'нет'
const REG = {
  active: 'vtoroy',
  list: [
    { id: 'main', label: 'основной', steamid: '76561190000000001', token: 'token.json', added: 1 },
    { id: 'vtoroy', label: 'второй', steamid: '76561190000000002', token: 'token-vtoroy.json', added: 2 },
  ],
}
fs.writeFileSync(process.env.ACCOUNTS_FILE!, JSON.stringify(REG))

const accounts = await import('./accounts.ts')

test('существующий реестр грузится как есть, без steamid снаружи', () => {
  assert.deepEqual(accounts.list().map(a => a.id), ['main', 'vtoroy'])
  assert.equal(accounts.activeId(), 'vtoroy')
  assert.equal(accounts.ACCOUNT(), '76561190000000002')
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.ACCOUNTS_FILE!, 'utf8')), REG, 'файл не переписан')
})
