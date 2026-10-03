import { test, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startPurchase, stopPurchase, purchaseState, purchaseBusy, pace } from './purchase.ts'
import { marketLimiter } from './market.ts'

// С9: ответ на покупку потерялся. Заново не покупаем — спрашиваем площадку
// по custom_id. Что бы она ни ответила, второго buy нет: закупка стоит.
//
// Площадка подменена целиком: баланс есть, лот один по цене плана,
// buy обрывается (неясный ответ), а проверка отвечает тем, что задал тест.

const real = globalThis.fetch
const T = { key: 'test-key-0123456789', id: 'main', label: 'тест' }
const LINES = [{ name: 'Spectator: Alliance', take: 3, price: 0.01 }]

type Reply = (n: number) => any   // n — номер проверки, с нуля

let n = { buy: 0, info: 0 }
let ids = { buy: [] as string[], info: [] as string[] }

function market(reply: Reply) {
  n = { buy: 0, info: 0 }
  ids = { buy: [], info: [] }
  globalThis.fetch = (async (url: any) => {
    const u = new URL(String(url))
    const m = u.pathname.split('/').pop()
    if (m === 'get-money') return Response.json({ success: true, money: '1000', currency: 'RUB' })
    if (m === 'search-item-by-hash-name') return Response.json({ success: true, data: [{ price: 1 }] })   // 1/100 ₽ = 0,01
    if (m === 'buy') {
      n.buy++
      ids.buy.push(String(u.searchParams.get('custom_id')))
      throw new Error('ECONNRESET')                                      // ответ потерялся
    }
    if (m === 'get-buy-info-by-custom-id') {
      ids.info.push(String(u.searchParams.get('custom_id')))
      return Response.json(reply(n.info++))
    }
    return Response.json({ success: false, error: 'неожиданный метод ' + m })
  }) as any
}

async function runOnce(reply: Reply) {
  market(reply)
  const r: any = await startPurchase(LINES, 'RUB', () => { }, T)
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

const stage = (s: string, paid = 0.01) => () => ({ success: true, data: { stage: s, paid, currency: 'RUB' } })
const VARIANTS: Record<string, Reply> = {
  'stage 1': stage('1'),
  'stage 2': stage('2'),
  'stage 5': stage('5'),
  'not found': () => ({ success: false, error: 'not found' }),
  'сбой связи': () => { throw new Error('ECONNRESET') },
  'неизвестный stage': stage('9'),
}

for (const [name, reply] of Object.entries(VARIANTS)) {
  test('неясный buy, проверка «' + name + '» — второго buy нет, закупка встала', async () => {
    const s = await runOnce(reply)
    assert.equal(n.buy, 1, 'buy после неясного ответа повторился')
    assert.equal(s.active, false)
    assert.equal(s.log.length, 1, 'по одному лоту — одна запись, итог переписывает её на месте')
  })
}

test('проверка спрашивает тот же custom_id, с которым ушёл buy, и он есть в журнале', async () => {
  const s = await runOnce(stage('1'))
  assert.match(ids.buy[0], /^gt-/)
  assert.deepEqual(ids.info, [ids.buy[0]])
  assert.equal(s.log[0].customId, ids.buy[0])
})

test('stage 1 — лот засчитан: «куплено», цена из ответа площадки', async () => {
  const s = await runOnce(stage('1', 0.012))
  assert.equal(s.log[0].reason, 'куплено')
  assert.equal(s.log[0].ok, true)
  assert.equal(s.log[0].price, 0.012)
  assert.equal(s.ok, 1)
  assert.equal(s.spent, 0.012)
  assert.equal(s.positions[0].got, 1)
})

test('stage 5 — «отказ»: площадка сама сказала, что трейд отменён', async () => {
  const s = await runOnce(stage('5'))
  assert.equal(s.log[0].reason, 'отказ')
  assert.equal(s.ok, 0)
  assert.equal(s.spent, 0)
})

test('not found во всех трёх проверках — «неясно», а не отказ', async () => {
  const s = await runOnce(() => ({ success: false, error: 'not found' }))
  assert.equal(n.info, 3)
  assert.equal(s.log[0].reason, 'неясно')
  assert.match(String(s.log[0].detail), /сверьте историю/)
  assert.equal(s.ok, 0)
})

test('not found, потом stage 1 — «куплено»; повторная проверка не покупает', async () => {
  const s = await runOnce(i => (i === 0 ? { success: false, error: 'not found' } : { success: true, data: { stage: '1', paid: 0.01 } }))
  assert.equal(n.info, 2)
  assert.equal(n.buy, 1)
  assert.equal(s.log[0].reason, 'куплено')
})

test('сбой проверки — «неясно», как раньше, и проверка не повторяется вслепую', async () => {
  const s = await runOnce(() => { throw new Error('ECONNRESET') })
  assert.equal(n.info, 1)
  assert.equal(s.log[0].reason, 'неясно')
  assert.match(String(s.log[0].detail), /сверьте историю/)
})

test('если проверка бросит исключение — «неясно», а не обрыв закупки', async () => {
  const { resolveAmbiguous } = await import('./purchase.ts')
  let asked = 0
  const v = await resolveAmbiguous(T.key, 'gt-1-1', async () => { asked++; throw new Error('boom') })
  assert.equal(v.reason, 'неясно')
  assert.match(v.detail, /boom/)
  assert.equal(asked, 1, 'после сбоя проверка не повторяется вслепую')
})
