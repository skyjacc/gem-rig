import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startPurchase, stopPurchase, purchaseState, purchaseBusy, purchaseHooks, pace } from './purchase.ts'
import { buyOne } from './market.ts'
import { asUser } from './ctx.ts'

// Закупка по пользователю (план 7.2, решения 7 и 10; ревью PR #33).
// Площадка подменена: баланс есть, лот по 1/100 ₽, buy отвечает «куплено».
// У каждого теста свой пользователь: закупка одного теста не мешает другому.

const real = globalThis.fetch
const T = { key: 'test-key-0123456789', id: 'b1', label: 'бэ' }
let buys = 0
let onSearch: (() => void) | null = null
let onBuy: (() => void) | null = null

beforeEach(() => {
  buys = 0
  onSearch = null
  onBuy = null
  Object.assign(pace, { settle: 0, gap: 0, tries: 1, between: 0 })
  globalThis.fetch = (async (url: any) => {
    const m = new URL(String(url)).pathname.split('/').pop()
    if (m === 'get-money') return Response.json({ success: true, money: '1000', currency: 'RUB' })
    if (m === 'search-item-by-hash-name') { onSearch?.(); return Response.json({ success: true, data: [{ price: 1 }] }) }
    if (m === 'buy') { buys++; onBuy?.(); return Response.json({ success: true, id: 'lot-' + buys, price: 1 }) }
    return Response.json({ success: false, error: 'неожиданный метод ' + m })
  }) as any
})
afterEach(() => { globalThis.fetch = real; purchaseHooks.userActive = () => true })

// Ограничитель площадки — 4 запроса в секунду на ключ: на медленной машине
// закупка из трёх лотов идёт дольше секунды. Ждём до 20 с и проверяем, что
// закупка действительно закончилась.
async function settle(user: string) {
  const until = Date.now() + 20_000
  while (asUser(user, () => purchaseBusy()) && Date.now() < until) await new Promise(r => setTimeout(r, 10))
  assert.equal(asUser(user, () => purchaseBusy()), false, 'закупка не закончилась за 20 с')
}

const start = (user: string, take: number, hooks = {}) =>
  asUser(user, () => startPurchase([{ name: 'Spectator: Alliance', take, price: 0.01 }], 'RUB', () => { }, T, hooks)) as Promise<any>

test('у каждого своя закупка: B идёт — у A своей нет; остановить чужую нельзя', async () => {
  const rb = await start('u-own-1', 3)
  assert.equal(rb.started, true, JSON.stringify(rb))
  assert.equal(asUser('owner', () => purchaseState()).active, false, 'у A своей нет')
  assert.match(String((asUser('owner', () => stopPurchase()) as any).error), /не идёт/, 'A не останавливает закупку B')
  await settle('u-own-1')
  assert.equal(asUser('u-own-1', () => purchaseState()).ok, 3)
  assert.equal(asUser('owner', () => purchaseState()).ok, 0)
})

test('отключили, пока покупка в пути: она доведена и учтена, новых нет', async () => {
  let disabled = false
  purchaseHooks.userActive = u => !(u === 'u-dis-1' && disabled)
  onBuy = () => { disabled = true }
  const bought: string[] = []
  const r = await start('u-dis-1', 5, { onBought: (b: any) => bought.push(String(b.customId)) })
  assert.equal(r.started, true, JSON.stringify(r))
  await settle('u-dis-1')
  const s = asUser('u-dis-1', () => purchaseState())
  assert.equal(buys, 1, 'на площадку ушла одна покупка')
  assert.equal(s.ok, 1, 'она учтена')
  assert.equal(bought.length, 1, 'и записана в журнал')
  assert.ok(s.log.some(e => e.reason === 'остановлено'))
})

test('отключили, пока узнавали цену: покупка не уходит', async () => {
  let disabled = false
  purchaseHooks.userActive = u => !(u === 'u-dis-2' && disabled)
  onSearch = () => { disabled = true }
  const r = await start('u-dis-2', 2)
  assert.equal(r.started, true, JSON.stringify(r))
  await settle('u-dis-2')
  assert.equal(buys, 0, 'buy не отправлен')
  // Остановлено сразу после цены — в очередь ограничителя покупка не вставала.
  assert.ok(asUser('u-dis-2', () => purchaseState()).log.some(e => e.reason === 'остановлено' && e.detail === undefined))
})

test('остановили, пока узнавали цену: покупка не уходит', async () => {
  onSearch = () => { asUser('u-stop-1', () => stopPurchase()) }
  const r = await start('u-stop-1', 2)
  assert.equal(r.started, true, JSON.stringify(r))
  await settle('u-stop-1')
  assert.equal(buys, 0, 'buy не отправлен')
})

test('остановили в самый момент отправки (после проверок, в очереди ограничителя): покупка не уходит', async () => {
  // Проверки «активен ли» по порядку для первого лота: начало прохода по
  // списку, начало шага, после цены, в момент отправки. Четвёртая — та, что
  // внутри очереди ограничителя.
  let calls = 0
  purchaseHooks.userActive = u => (u === 'u-dis-3' ? ++calls < 4 : true)
  const r = await start('u-dis-3', 1)
  assert.equal(r.started, true, JSON.stringify(r))
  await settle('u-dis-3')
  assert.equal(buys, 0, 'buy не отправлен')
  const log = asUser('u-dis-3', () => purchaseState()).log
  assert.ok(log.some(e => e.reason === 'остановлено' && e.detail === 'покупка не отправлена'), JSON.stringify(log))
})

test('отправка покупки: «нельзя» в момент отправки — запроса к площадке нет, ответ — «не отправлено», не «неясно»', async () => {
  let asked = 0
  globalThis.fetch = (async () => { asked++; return Response.json({ success: true }) }) as any
  const r: any = await buyOne(T.key, 'Spectator: Alliance', 0.01, 'RUB', 'gt-x', () => false)
  assert.equal(asked, 0)
  assert.equal(r.notSent, true)
  assert.equal(r.ambiguous, undefined)
})
