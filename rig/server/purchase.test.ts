import { test } from 'node:test'
import assert from 'node:assert/strict'
import { after, decideBuy, lowest } from './purchase.ts'

// Цена берётся у площадки прямо перед покупкой, а не из списка: список
// живёт до двух минут, а дешёвые лоты кончаются по мере скупки, и цена
// ползёт вверх прямо во время закупки.

test('лучшая цена — минимальная среди предложений', () => {
  assert.equal(lowest({ success: true, currency: 'RUB', data: [
    { price: 440 }, { price: 400 }, { price: 900 },
  ] }, 'RUB'), 4)
})

test('пустой ответ означает «лотов нет», а не ноль', () => {
  assert.equal(lowest({ success: true, data: [] }, 'RUB'), null)
  assert.equal(lowest({ success: false }, 'RUB'), null)
})

test('мелкая единица зависит от валюты', () => {
  assert.equal(lowest({ success: true, data: [{ price: 1000 }] }, 'USD'), 1)
  assert.equal(lowest({ success: true, data: [{ price: 100 }] }, 'RUB'), 1)
})

test('цена та же — берём', () => {
  assert.deepEqual(decideBuy(0.44, 0.44, 0), { buy: true, price: 0.44 })
})

test('цена упала — берём по новой, дешевле', () => {
  assert.deepEqual(decideBuy(0.44, 0.30, 0), { buy: true, price: 0.30 })
})

test('цена выросла — не берём', () => {
  const d = decideBuy(0.44, 0.50, 0)
  assert.equal(d.buy, false)
  assert.equal(d.price, 0.50)
})

test('допуск разрешает небольшой рост', () => {
  assert.equal(decideBuy(0.44, 0.48, 0.10).buy, true)
  assert.equal(decideBuy(0.44, 0.49, 0.10).buy, false)
})

test('лотов нет — не берём', () => {
  assert.equal(decideBuy(0.44, null, 0).buy, false)
})

test('допуск не может быть отрицательным', () => {
  assert.equal(decideBuy(0.44, 0.45, -1).buy, false)
})

// ── что делать после неудачи ──
//
// Живая закупка 22 августа: 118 куплено из 250, пять сбоев. Каждый сбой
// убивал позицию целиком — площадка один раз не ответила на запрос цены,
// и остальные её лоты не покупались вовсе.
//
// Беды разной природы, и обращаться с ними надо по-разному.

test('кончились деньги — останавливаем всё', () => {
  assert.equal(after('нет денег', 1), 'стоп')
})

test('цена выросла — бросаем позицию, остальные лоты стоят столько же', () => {
  assert.equal(after('цена выросла', 1), 'позиция')
})

test('лотов не осталось — тоже бросаем позицию', () => {
  assert.equal(after('нет лотов', 1), 'позиция')
})

test('площадка не ответила — пробуем ещё, это не приговор', () => {
  assert.equal(after('отказ', 1), 'ещё')
  assert.equal(after('отказ', 2), 'ещё')
})

test('но не бесконечно: после трёх подряд идём дальше по списку', () => {
  assert.equal(after('отказ', 3), 'дальше')
})

test('отказ по цене при покупке — позиция', () => {
  assert.equal(after('цена ушла', 1), 'позиция')
})

test('успех обнуляет счёт неудач', () => {
  assert.equal(after('куплено', 9), 'дальше')
})

test('неясный ответ площадки останавливает закупку — лот мог уже списаться', () => {
  assert.equal(after('неясно', 0), 'стоп')
  assert.equal(after('неясно', 5), 'стоп')
})
// ── сверка заказа с площадкой ──

import { vetLines } from './purchase.ts'

const SEEN = new Map([['Spectator: Alliance', 0.5], ['Spectator: NaVi', 1]])

test('заказ по увиденной цене проходит', () => {
  const r = vetLines([{ name: 'Spectator: Alliance', take: 10, price: 0.5 }], SEEN, 0, 100)
  assert.deepEqual(r, { lines: [{ name: 'Spectator: Alliance', take: 10, price: 0.5 }] })
})

test('незнакомое имя не покупается', () => {
  const r = vetLines([{ name: 'Arcana', take: 1, price: 1 }], SEEN, 0, 100)
  assert.ok('error' in r)
})

test('цена выше увиденной отбивается, допуск её пропускает', () => {
  assert.ok('error' in vetLines([{ name: 'Spectator: NaVi', take: 1, price: 1.05 }], SEEN, 0, 100))
  assert.ok('lines' in vetLines([{ name: 'Spectator: NaVi', take: 1, price: 1.05 }], SEEN, 0.1, 100))
})

test('потолок суммы обязателен: сверх него и без него закупка не начинается', () => {
  const lines = [{ name: 'Spectator: NaVi', take: 30, price: 1 }]
  assert.ok('error' in vetLines(lines, SEEN, 0, 20))
  assert.ok('lines' in vetLines(lines, SEEN, 0, 30))
  const none = vetLines(lines, SEEN, 0, 0)
  assert.ok('error' in none && /потолок/.test(none.error), 'ноль — потолок не задан, закупка не начинается')
})

test('пустые и нулевые строки отбрасываются', () => {
  assert.ok('error' in vetLines([], SEEN, 0, 0))
  assert.ok('error' in vetLines([{ name: 'Spectator: NaVi', take: 0, price: 1 }], SEEN, 0, 0))
})