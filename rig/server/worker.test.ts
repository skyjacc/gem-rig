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
  displaced: 0,
  until: 0,
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
  const d = decide({ ...base, now: 1_000_000, senderAlive: true, lastSendAt: 0, senderStartedAt: 1_000_000 - 400_000 })
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

// ── минута годилась не для всех случаев ──
//
// Один порог обслуживал два разных положения, и обоим он не подходил.
//
// Аккаунт занят другой сессией: вход УДАЁТСЯ, выбивают после — поэтому
// счётчик попыток отправщика сбрасывается, и он стучится каждые пятнадцать
// секунд вечно, не наращивая паузу. Ждать тут нечего: пока человек
// не освободит Steam, ничего не изменится, а двадцать входов за пять минут
// — это шум на ровном месте.
//
// Обрыв связи: там лестница растёт — 15, 30, 60, 120 секунд. Минута рубила
// отправщик посреди законного отхода, когда он вот-вот бы поднялся.

test('дважды выбило чужой сессией — ждать нечего, это до человека', () => {
  const d = decide({ ...base, senderAlive: true, lastSendAt: 0, senderStartedAt: 99_000, displaced: 2 })
  assert.equal(d.action, 'halt')
  assert.match(d.why, /занят|другой сессией/i)
})

test('один раз выбило — бывает, не паникуем', () => {
  const d = decide({ ...base, senderAlive: true, lastSendAt: 0, senderStartedAt: 99_000, displaced: 1 })
  assert.equal(d.action, 'watch')
})

test('молчит после успешных отправок — прежняя минута', () => {
  const d = decide({ ...base, senderAlive: true, lastSendAt: 100_000 - 70_000, senderStartedAt: 10_000 })
  assert.equal(d.action, 'restart')
})

test('не вошёл ни разу: минуты мало, ждём дольше', () => {
  const d = decide({ ...base, senderAlive: true, lastSendAt: 0, senderStartedAt: 100_000 - 90_000 })
  assert.equal(d.action, 'watch', 'лестница отправщика доходит до двух минут')
})

test('не вошёл за пять минут — сдаёмся', () => {
  const d = decide({ ...base, now: 1_000_000, senderAlive: true, lastSendAt: 0, senderStartedAt: 1_000_000 - 310_000 })
  assert.equal(d.action, 'halt')
  assert.match(d.why, /не смог войти/i)
})

// ── работа до срока ──
//
// «До десяти утра» — это время, а не число отправок. Ночной прогон
// удобнее задавать сроком: сколько успеется, столько и хорошо.

test('срок вышел — встаём', () => {
  const d = decide({ ...base, senderAlive: true, until: 99_000 })
  assert.equal(d.action, 'halt')
  assert.match(d.why, /срок|время/i)
})

test('до срока работаем', () => {
  assert.equal(decide({ ...base, senderAlive: true, until: 200_000 }).action, 'watch')
})

test('без срока — как раньше', () => {
  assert.equal(decide({ ...base, senderAlive: true, until: 0 }).action, 'watch')
})

test('срок важнее пересборки: вышел — встали', () => {
  const d = decide({ ...base, inventoryChanged: true, until: 99_000 })
  assert.equal(d.action, 'halt')
})

// ── остановка ──
//
// Работник обязан вставать сам. Каждая отправка необратима, поэтому «не
// остановился вовремя» стоит дороже, чем «встал раньше времени».

test('остановка: цель достигнута — встаём, даже если очередь полна', () => {
  const d = decide({ ...base, senderAlive: true, target: 500, done: 500, queueLength: 20_000 })
  assert.equal(d.action, 'halt')
})

test('остановка: цель перевыполнена — тоже встаём', () => {
  const d = decide({ ...base, senderAlive: true, target: 500, done: 517, queueLength: 20_000 })
  assert.equal(d.action, 'halt')
})

test('остановка: срок вышел — встаём, даже если цель не достигнута', () => {
  const now = 1_700_000_000_000
  const d = decide({ ...base, senderAlive: true, now, until: now - 1, target: 500, done: 12 })
  assert.equal(d.action, 'halt')
})

test('остановка: очередь опустела — не встаём, а ждём новых гемов', () => {
  const d = decide({ ...base, queueLength: 0 })
  assert.equal(d.action, 'idle')
})

test('остановка: выключен человеком — ничего не делаем', () => {
  const d = decide({ ...base, senderAlive: true, enabled: false })
  assert.equal(d.action, 'idle')
})

test('остановка: цель важнее пустой очереди и мёртвого отправщика', () => {
  const d = decide({ ...base, target: 100, done: 100, queueLength: 0 })
  assert.equal(d.action, 'halt')
})

test('остановка: без цели и без срока сами не встаём', () => {
  const d = decide({ ...base, senderAlive: true, target: null, until: 0, done: 99_999 })
  assert.notEqual(d.action, 'halt')
})

test('остановка: цель ещё не взята — продолжаем', () => {
  const d = decide({ ...base, senderAlive: true, target: 500, done: 499 })
  assert.notEqual(d.action, 'halt')
})

test('очередь пройдена — пересобираем, а не ждём тишины', () => {
  const d = decide({ ...base, senderAlive: true, drained: true, lastSendAt: 90_000, senderStartedAt: 1 })
  assert.equal(d.action, 'rebuild')
})

test('пройденная очередь не отменяет срок', () => {
  assert.equal(decide({ ...base, drained: true, until: 50_000 }).action, 'halt')
})