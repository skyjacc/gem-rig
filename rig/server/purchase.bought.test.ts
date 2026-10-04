import { test, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { startPurchase, stopPurchase, purchaseState, purchaseBusy, pace } from './purchase.ts'
import { marketLimiter } from './market.ts'
import { MONEY_DDL } from './money.ts'
import { ensureJournal, recordBuy, type Bought } from './marketbuys.ts'

// Журнал закупки (план 3.1, задача 4): закупка сообщает факт «куплено»
// колбэком onBought, базу она не знает. Деньги (money_ops) закупка не пишет.
//
// Площадка подменена целиком: баланс есть, лот по 1/100 ₽, buy отвечает
// так, как задал тест.

const real = globalThis.fetch
const T = { key: 'test-key-0123456789', id: 'main', label: 'тест' }

type Buy = (n: number) => any | 'обрыв'

function market(buy: Buy, info: (n: number) => any = () => ({ success: false, error: 'not found' })) {
  let nb = 0, ni = 0
  globalThis.fetch = (async (url: any) => {
    const u = new URL(String(url))
    const m = u.pathname.split('/').pop()
    if (m === 'get-money') return Response.json({ success: true, money: '1000', currency: 'RUB' })
    if (m === 'search-item-by-hash-name') return Response.json({ success: true, data: [{ price: 1 }] })   // 1/100 ₽
    if (m === 'buy') {
      const r = buy(nb++)
      if (r === 'обрыв') throw new Error('ECONNRESET')
      return Response.json(r)
    }
    if (m === 'get-buy-info-by-custom-id') return Response.json(info(ni++))
    return Response.json({ success: false, error: 'неожиданный метод ' + m })
  }) as any
}

async function run(take: number, onBought?: (b: Bought) => void) {
  const r: any = await startPurchase([{ name: 'Spectator: Alliance', take, price: 0.01 }], 'RUB', () => { }, T, { onBought })
  assert.equal(r.started, true, JSON.stringify(r))
  for (let i = 0; i < 500 && purchaseBusy(); i++) await new Promise(res => setTimeout(res, 2))
  assert.equal(purchaseBusy(), false, 'закупка не закончилась')
  return purchaseState()
}

const saved = { ...pace }
beforeEach(() => {
  mock.method(marketLimiter, 'run', async (_k: string, send: () => unknown) => send())
  Object.assign(pace, { settle: 0, gap: 0, between: 0 })
})
afterEach(async () => {
  stopPurchase()
  for (let i = 0; i < 200 && purchaseBusy(); i++) await new Promise(res => setTimeout(res, 2))
  mock.restoreAll()
  Object.assign(pace, saved)
  globalThis.fetch = real
})

test('«куплено» — колбэк с ценой, ушедшей в buy, в мелких единицах, и id из ответа', async () => {
  market(n => ({ success: true, id: String(700 + n) }))
  const got: Bought[] = []
  await run(2, b => got.push(b))
  assert.equal(got.length, 2)
  for (const b of got) {
    assert.equal(b.accountId, 'main')
    assert.equal(b.hashName, 'Spectator: Alliance')
    assert.equal(b.askPrice, 1, 'потолок 0,01 ₽ = 1 копейка — как ушло в запрос')
    assert.equal(b.currency, 'RUB')
    assert.equal(b.how, 'buy')
    assert.equal(b.itemId, null)
    assert.match(b.customId, /^gt-\d+-\d+$/)
  }
  assert.deepEqual(got.map(b => b.buyId), ['700', '701'])
  assert.notEqual(got[0].customId, got[1].customId)
})

test('неясный ответ, подтверждённый по custom_id, — колбэк с how = custom_id и item_id из проверки', async () => {
  market(() => 'обрыв', () => ({ success: true, data: { stage: '2', paid: 0.01, item_id: '5900000001', currency: 'RUB' } }))
  const got: Bought[] = []
  await run(3, b => got.push(b))
  assert.equal(got.length, 1, 'после неясного ответа закупка встаёт — одна покупка')
  assert.equal(got[0].how, 'custom_id')
  assert.equal(got[0].itemId, '5900000001')
  assert.equal(got[0].buyId, null)
  assert.equal(got[0].askPrice, 1)
})

test('отказ площадки и «неясно» — колбэка нет', async () => {
  market(() => ({ success: false, error: 'no money' }))
  const got: Bought[] = []
  await run(2, b => got.push(b))
  market(() => 'обрыв', () => ({ success: false, error: 'not found' }))
  await run(2, b => got.push(b))
  assert.equal(got.length, 0)
})

test('колбэк бросил — закупка идёт дальше', async () => {
  market(n => ({ success: true, id: String(n) }))
  let calls = 0
  const st = await run(3, () => { calls++; throw new Error('база недоступна') })
  assert.equal(calls, 3)
  assert.equal(st.ok, 3)
})

test('прогон закупки пишет журнал закупки, а журнал денег остаётся пуст', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(MONEY_DDL)
  ensureJournal(db)
  market(n => ({ success: true, id: String(n) }))
  await run(2, b => recordBuy(db, b))
  assert.equal((db.prepare('select count(*) c from market_buys').get() as any).c, 2)
  assert.equal((db.prepare('select count(*) c from money_ops').get() as any).c, 0, 'job.log и ответ buy — не источник денег')
})
