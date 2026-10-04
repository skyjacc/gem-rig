import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// Свежий checkout: tools/accounts.json в репозитории больше нет (.gitignore),
// реестр сервер заводит сам при первой загрузке. Реестр тестов — свой,
// во временной папке (testenv.ts, ACCOUNTS_FILE); рабочий не трогается.

test('нет реестра — сервер заводит основной аккаунт из STEAMID и записывает файл', async () => {
  const file = process.env.ACCOUNTS_FILE!
  assert.ok(file && !file.endsWith('tools\\accounts.json') && !file.endsWith('tools/accounts.json'), 'тест не должен видеть рабочий реестр')
  fs.rmSync(file, { force: true })

  const { STEAMID } = await import('./paths.ts')
  const accounts = await import('./accounts.ts')

  const list = accounts.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'main')
  assert.equal(list[0].steamid, STEAMID)
  assert.equal(list[0].token, 'token.json')
  assert.equal(accounts.activeId(), 'main')
  assert.ok(fs.existsSync(file), 'реестр записан на диск')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).list[0].steamid, STEAMID)
})
