import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, freshSendAt, type Snapshot } from './worker.ts'

const base: Snapshot = {
  enabled: true,
  senderAlive: false,
  queueLength: 100,
  inventoryChanged: false,
  lastSendAt: 0,
  now: 100_000,
  failures: 0,
  target: null,
  done: 0,
  senderStartedAt: 0,
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

// ── цель прогона ──
//
// Тумблер «включить и жечь всё» — не единственный режим. Человек может
// захотеть ровно N отправок: проверить темп, добить один гем до круглого
// числа, потратить остаток вечера и не больше.

test('цель достигнута — останавливаемся сами', () => {
  const d = decide({ ...base, senderAlive: true, target: 100, done: 100 })
  assert.equal(d.action, 'halt')
  assert.match(d.why, /цель/i)
})

test('цель перевыполнена — тоже стоп, а не «почти»', () => {
  assert.equal(decide({ ...base, senderAlive: true, target: 100, done: 137 }).action, 'halt')
})

test('до цели ещё далеко — работаем', () => {
  assert.equal(decide({ ...base, senderAlive: true, target: 100, done: 99 }).action, 'watch')
})

test('без цели считаем до конца очереди', () => {
  assert.equal(decide({ ...base, senderAlive: true, target: null, done: 9999 }).action, 'watch')
})

test('цель важнее пересборки: досчитали — встали', () => {
  const d = decide({ ...base, inventoryChanged: true, target: 10, done: 10 })
  assert.equal(d.action, 'halt', 'иначе купленный в последнюю секунду гем продлит прогон')
})

// ── чужая метка времени ──
//
// 21 августа проверочный прогон встал намертво: status.json остался
// со вчерашнего запуска, работник прочитал оттуда метку 23:22 и посчитал,
// что отправщик молчит 22 часа. Убивал и поднимал его каждые двадцать
// секунд; новый вход выбивал предыдущий, и ни одна отправка не ушла.
//
// Отметка годится, только если сделана нынешним процессом.

test('метка старше запуска отправщика не считается — это чужая', () => {
  assert.equal(freshSendAt(1000, 5000), 0)
})

test('метка после запуска — своя, её и берём', () => {
  assert.equal(freshSendAt(7000, 5000), 7000)
})

test('ровно в момент запуска — ещё не отправка', () => {
  assert.equal(freshSendAt(5000, 5000), 0)
})

test('отправщик не запускался — метки нет', () => {
  assert.equal(freshSendAt(9999, 0), 0)
})

test('пустая метка остаётся пустой', () => {
  assert.equal(freshSendAt(0, 5000), 0)
})

test('чужая метка не приводит к перезапуску', () => {
  const stale = freshSendAt(100_000 - 80_000_000, 99_000)
  const d = decide({ ...base, senderAlive: true, lastSendAt: stale })
  assert.equal(d.action, 'watch', 'иначе работник убивает отправщик каждый такт')
})

// ── отправщик, который не может войти ──
//
// 21 августа: аккаунт был занят игрой, отправщик входил и каждые пятнадцать
// секунд получал LoggedInElsewhere. Процесс жив, значит «жив» — и работник
// три минуты докладывал «работает», пока не уходило ни одной отправки.
//
// Защита от нулевой метки («запустился, но ещё не слал») тут оборачивалась
// против нас: не слал он никогда. Значит нужен предел и на разогрев.

test('живой, но ни одной отправки дольше предела — это не работа', () => {
  const d = decide({ ...base, senderAlive: true, lastSendAt: 0, senderStartedAt: 100_000 - 70_000 })
  assert.equal(d.action, 'halt')
  assert.match(d.why, /войти|не отправил/i)
})

test('разогрев в пределах срока не трогаем', () => {
  const d = decide({ ...base, senderAlive: true, lastSendAt: 0, senderStartedAt: 100_000 - 10_000 })
  assert.equal(d.action, 'watch')
})

test('успел отправить — обычные правила молчания', () => {
  const d = decide({ ...base, senderAlive: true, lastSendAt: 100_000 - 5_000, senderStartedAt: 100_000 - 70_000 })
  assert.equal(d.action, 'watch')
})

test('без метки запуска разогрев не судим', () => {
  const d = decide({ ...base, senderAlive: true, lastSendAt: 0, senderStartedAt: 0 })
  assert.equal(d.action, 'watch')
})
