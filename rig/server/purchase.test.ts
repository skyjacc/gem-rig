import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideBuy, lowest } from './purchase.ts'

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
