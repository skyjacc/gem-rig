import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { judgeKey, keyFile, keyFor, validKey } from './marketkeys.ts'

const SID = '76561198000000001'

test('файл ключа: основной — прежний market.key, прочие — свой', () => {
  assert.equal(keyFile('main'), 'market.key')
  assert.equal(keyFile('second'), 'market-second.key')
})

test('ключ читается по аккаунту, MARKET_KEY — только для основного', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-mk-'))
  fs.writeFileSync(path.join(dir, 'market.key'), 'main-key-0123456789\n')
  fs.writeFileSync(path.join(dir, 'market-second.key'), 'second-key-0123456789\n')
  assert.equal(keyFor({ id: 'main' }, {}, dir), 'main-key-0123456789')
  assert.equal(keyFor({ id: 'second' }, {}, dir), 'second-key-0123456789')
  assert.equal(keyFor({ id: 'third' }, {}, dir), null)
  assert.equal(keyFor({ id: 'main' }, { MARKET_KEY: 'env-key-0123456789' }, dir), 'env-key-0123456789')
  assert.equal(keyFor({ id: 'second' }, { MARKET_KEY: 'env-key-0123456789' }, dir), 'second-key-0123456789',
    'переменная окружения не должна подменять ключ другого аккаунта')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('формат ключа: без пробелов, путей и прочего мусора', () => {
  assert.equal(validKey('A1b2C3d4E5f6G7h8'), true)
  assert.equal(validKey('short'), false)
  assert.equal(validKey('../../etc/passwd-aaaaaaaa'), false)
  assert.equal(validKey('key with spaces 123456'), false)
})

test('ключ того же аккаунта — можно покупать', () => {
  assert.equal(judgeKey({ success: true, steamid64: SID }, SID).state, 'ok')
})

test('ключ чужого Steam — mismatch, и видно, чей он', () => {
  const v = judgeKey({ success: true, steamid64: '76561198000000002' }, SID)
  assert.equal(v.state, 'mismatch')
  assert.equal(v.marketSteamid, '76561198000000002')
})

test('площадка отвергла ключ — invalid', () => {
  assert.equal(judgeKey({ success: false, error: 'Bad KEY' }, SID).state, 'invalid')
})

test('нет связи — не invalid, а «не проверен»: ключ может быть исправным', () => {
  assert.equal(judgeKey({ success: false, ambiguous: true, error: 'нет связи' }, SID).state, 'unchecked')
  assert.equal(judgeKey({ success: true }, SID).state, 'unchecked', 'без steamid судить не о чем')
})
