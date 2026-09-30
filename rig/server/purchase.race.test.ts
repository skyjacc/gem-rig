import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startPurchase, stopPurchase, purchaseState, purchaseBusy } from './purchase.ts'

// Единственная дверь к тратам денег должна быть одна.
//
// Проверка «закупка уже идёт» стояла до похода за балансом, а флаг
// поднимался после — между ними лежал сетевой запрос на сотни миллисекунд.
// Два нажатия подряд, два открытых окна панели или повтор запроса при
// обрыве связи проходили проверку оба, пока флаг ещё не поднят, и оба
// уходили покупать. Деньги списываются дважды, лоты уже куплены,
// вернуть нельзя.

const real = globalThis.fetch

// Ключ подставной: тест не должен читать настоящий tools/market.key.
const T = { key: 'test-key-0123456789', id: 'main', label: 'тест' }

// Закупка живёт своим чередом после ответа, поэтому между проверками её
// надо дожидаться: иначе состояние протекает в следующий тест.
async function settle() {
  stopPurchase()
  for (let i = 0; i < 200 && purchaseBusy(); i++) await new Promise(r => setTimeout(r, 10))
}

// Площадка, которая отвечает не мгновенно: без задержки гонки не видно.
function slowMarket(delayMs: number, calls: { n: number }) {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('get-money')) {
      await new Promise(r => setTimeout(r, delayMs))
      return new Response(JSON.stringify({ success: true, money: '1000', currency: 'RUB' }))
    }
    if (u.includes('buy')) calls.n++
    // Дальше закупка ходит за ценой и покупает; отвечаем отказом, чтобы
    // работа быстро закончилась — нас интересует только число заходов.
    return new Response(JSON.stringify({ success: false, error: 'no item' }))
  }) as any
}

test('два одновременных запуска дают одну закупку, а не две', async () => {
  const calls = { n: 0 }
  slowMarket(60, calls)
  try {
    const lines = [{ name: 'Spectator: Alliance', take: 1, price: 0.01 }]
    const [a, b]: any[] = await Promise.all([
      startPurchase(lines, 'RUB', () => { }, T),
      startPurchase(lines, 'RUB', () => { }, T),
    ])
    const started = [a, b].filter(r => r?.started).length
    const refused = [a, b].filter(r => r?.error === 'закупка уже идёт').length
    assert.equal(started, 1, 'запуститься должна ровно одна')
    assert.equal(refused, 1, 'вторая обязана получить отказ, а не тихо уйти покупать')
  } finally {
    await settle()
    globalThis.fetch = real
  }
})

test('пока идут проверки, закупка уже считается занятой', async () => {
  const calls = { n: 0 }
  slowMarket(80, calls)
  try {
    const lines = [{ name: 'Spectator: Alliance', take: 1, price: 0.01 }]
    const first = startPurchase(lines, 'RUB', () => { }, T)
    // Флаг job.active ещё не поднят — работа стоит на балансе.
    assert.equal(purchaseState().active, false)
    assert.equal(purchaseBusy(), true, 'замок держится с первой строки, а не с job.active')
    const second: any = await startPurchase(lines, 'RUB', () => { }, T)
    assert.equal(second?.error, 'закупка уже идёт')
    await first
  } finally {
    await settle()
    globalThis.fetch = real
  }
})

test('отказ на проверках снимает замок — следующая попытка возможна', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ success: false, error: 'нет ответа' }))) as any
  try {
    const lines = [{ name: 'Spectator: Alliance', take: 1, price: 0.01 }]
    const a: any = await startPurchase(lines, 'RUB', () => { }, T)
    assert.ok(a?.error, 'площадка не отдала баланс — запуска нет')
    assert.equal(purchaseBusy(), false, 'замок обязан сняться, иначе закупка мертва до перезапуска панели')
    const b: any = await startPurchase(lines, 'RUB', () => { }, T)
    assert.ok(b?.error, 'вторая попытка доходит до той же проверки, а не до «уже идёт»')
    assert.notEqual(b?.error, 'закупка уже идёт')
  } finally {
    await settle()
    globalThis.fetch = real
  }
})

test('пустой список денег не тратит', async () => {
  const r: any = await startPurchase([], 'RUB', () => { }, T)
  assert.equal(r?.error, 'нечего покупать')
  assert.equal(purchaseBusy(), false)
})
