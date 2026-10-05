import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startPurchase, stopPurchase, purchaseState, purchaseBusy, purchaseHooks, pace } from './purchase.ts'
import { asUser } from './ctx.ts'

// Закупка по пользователю (план 7.2, решения 7 и 10). Площадка подменена:
// баланс есть, лот по 1/100 ₽, buy отвечает «куплено».

const real = globalThis.fetch
const T = { key: 'test-key-0123456789', id: 'b1', label: 'бэ' }
let buys = 0
let onBuy: (() => void) | null = null

beforeEach(() => {
  buys = 0
  onBuy = null
  Object.assign(pace, { settle: 0, gap: 0, tries: 1, between: 0 })
  globalThis.fetch = (async (url: any) => {
    const m = new URL(String(url)).pathname.split('/').pop()
    if (m === 'get-money') return Response.json({ success: true, money: '1000', currency: 'RUB' })
    if (m === 'search-item-by-hash-name') return Response.json({ success: true, data: [{ price: 1 }] })
    if (m === 'buy') { buys++; onBuy?.(); return Response.json({ success: true, id: 'lot-' + buys, price: 1 }) }
    return Response.json({ success: false, error: 'неожиданный метод ' + m })
  }) as any
})
afterEach(() => { globalThis.fetch = real; purchaseHooks.userActive = () => true })

const settle = async (user: string) => {
  for (let i = 0; i < 500 && asUser(user, () => purchaseBusy()); i++) await new Promise(r => setTimeout(r, 2))
}

test('у каждого своя закупка: B идёт — A может начать свою; остановить чужую нельзя', async () => {
  const rb: any = await asUser('u2', () => startPurchase([{ name: 'Spectator: Alliance', take: 3, price: 0.01 }], 'RUB', () => { }, T))
  assert.equal(rb.started, true, JSON.stringify(rb))
  assert.equal(asUser('owner', () => purchaseState()).active, false, 'у A своей нет')
  assert.match(String((asUser('owner', () => stopPurchase()) as any).error), /не идёт/, 'A не останавливает закупку B')
  await settle('u2')
  assert.equal(asUser('u2', () => purchaseState()).ok, 3)
  assert.equal(asUser('owner', () => purchaseState()).ok, 0)
})

test('отключили посреди закупки: отправленная покупка доведена и учтена, новых нет', async () => {
  let disabled = false
  purchaseHooks.userActive = u => !(u === 'u2' && disabled)
  onBuy = () => { disabled = true }       // отключили, пока первая покупка в пути
  const bought: string[] = []
  const r: any = await asUser('u2', () => startPurchase([{ name: 'Spectator: Alliance', take: 5, price: 0.01 }], 'RUB', () => { }, T, {
    onBought: b => bought.push(String(b.customId)),
  }))
  assert.equal(r.started, true, JSON.stringify(r))
  await settle('u2')
  const s = asUser('u2', () => purchaseState())
  assert.equal(buys, 1, 'на площадку ушла одна покупка')
  assert.equal(s.ok, 1, 'она учтена')
  assert.equal(bought.length, 1, 'и записана в журнал')
  assert.ok(s.log.some(e => e.reason === 'остановлено'), 'дальше — остановлено')
})
