import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, type Snapshot } from './worker.ts'

const base: Snapshot = {
  enabled: true,
  senderAlive: false,
  queueLength: 100,
  inventoryChanged: false,
  lastSendAt: 0,
  now: 100_000,
  failures: 0,
}

test('выключен — ничего не делаем', () => {
  assert.equal(decide({ ...base, enabled: false }).action, 'idle')
})

test('очередь есть, отправщик мёртв — запускаем', () => {
  assert.equal(decide(base).action, 'start')
})

test('отправщик жив — не трогаем', () => {
  assert.equal(decide({ ...base, senderAlive: true }).action, 'watch')
})

test('очередь пуста — ждём новых гемов, а не крутимся', () => {
  const d = decide({ ...base, queueLength: 0 })
  assert.equal(d.action, 'idle')
  assert.match(d.why, /нечего/i)
})

test('появился новый гем — пересобираем очередь', () => {
  const d = decide({ ...base, inventoryChanged: true, senderAlive: true })
  assert.equal(d.action, 'rebuild')
  assert.match(d.why, /инвентар/i)
})

test('новый гем при пустой очереди тоже пересобирает', () => {
  const d = decide({ ...base, inventoryChanged: true, queueLength: 0, senderAlive: false })
  assert.equal(d.action, 'rebuild')
})

test('отправщик молчит дольше минуты — перезапускаем', () => {
  const d = decide({ ...base, senderAlive: true, lastSendAt: 100_000 - 70_000 })
  assert.equal(d.action, 'restart')
  assert.match(d.why, /молчит/i)
})

test('отправщик недавно слал — не трогаем', () => {
  const d = decide({ ...base, senderAlive: true, lastSendAt: 100_000 - 5_000 })
  assert.equal(d.action, 'watch')
})

test('только что запущенный не считается молчащим', () => {
  const d = decide({ ...base, senderAlive: true, lastSendAt: 0 })
  assert.equal(d.action, 'watch', 'нулевая метка означает «ещё не слал», а не «молчит вечность»')
})

test('слишком много падений подряд — останавливаемся с причиной', () => {
  const d = decide({ ...base, failures: 5 })
  assert.equal(d.action, 'halt')
  assert.match(d.why, /подряд/i)
})

test('пересборка важнее запуска: сначала актуальная очередь', () => {
  const d = decide({ ...base, inventoryChanged: true, senderAlive: false, queueLength: 100 })
  assert.equal(d.action, 'rebuild')
})
