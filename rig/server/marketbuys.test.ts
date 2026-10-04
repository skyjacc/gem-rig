import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MONEY_DDL, addOp, listOps, type NewOp } from './money.ts'
import type { Cancelled } from './markethistory.ts'
import {
  cancelKey, ensureJournal, journalStart, moneySync, reconcile, reconcileCancellations, recordBuy, type Bought,
} from './marketbuys.ts'

const KEY = 'SECRET-KEY-123'
const DAY_MS = 86_400_000
const START = 1_790_000_000_000

function fresh(start = START) {
  const db = new DatabaseSync(':memory:')
  db.exec(MONEY_DDL)
  ensureJournal(db, start)
  return db
}
const count = (db: DatabaseSync, t: string) => (db.prepare(`select count(*) c from ${t}`).get() as any).c as number

const bought = (over: Partial<Bought> = {}): Bought => ({
  accountId: 'main', customId: 'gt-1-1', hashName: 'Spectator: Alliance', askPrice: 50, currency: 'RUB',
  buyId: '700', itemId: null, how: 'buy', at: START + 1000, ...over,
})
const op = (cid: string | null, over: Partial<NewOp> = {}): NewOp => ({
  accountId: 'main', type: 'покупка гема', source: 'market.dota2.net',
  externalId: cid ? 'buy:cid:' + cid : 'buy:item:1:2', happenedAt: START + 2000,
  currency: 'RUB', gross: 44, net: -44, status: 'передан', createdBy: 'импорт истории площадки', ...over,
})
const cancelled = (cid: string | null, over: Partial<Cancelled> = {}): Cancelled => ({
  customId: cid, itemId: '5900000009', time: START + 3000, raw: JSON.stringify({ event: 'buy', stage: '5', item_id: '5900000009' }), ...over,
})

// ── начало журнала ──

test('JOURNAL_START пишется при первом создании, повторное создание его не меняет; правка и удаление запрещены', () => {
  const db = fresh()
  assert.equal(journalStart(db), START)
  ensureJournal(db, START + 999)
  assert.equal(journalStart(db), START)
  assert.throws(() => db.prepare(`update market_meta set value = '1' where key = 'journal_start'`).run())
  assert.throws(() => db.prepare(`delete from market_meta where key = 'journal_start'`).run())
})

// ── журнал закупки ──

test('журнал закупки: запись, дубль custom_id не вставляется, правка и удаление запрещены', () => {
  const db = fresh()
  assert.deepEqual(recordBuy(db, bought()), { inserted: true })
  assert.deepEqual(recordBuy(db, bought({ askPrice: 99 })), { inserted: false })
  assert.equal(count(db, 'market_buys'), 1)
  assert.equal((db.prepare('select ask_price from market_buys').get() as any).ask_price, 50)
  assert.throws(() => db.prepare('update market_buys set ask_price = 1').run())
  assert.throws(() => db.prepare('delete from market_buys').run())
  assert.equal(count(db, 'money_ops'), 0)
})

test('журнал закупки: цена — целое в мелких единицах, без custom_id не пишется', () => {
  const db = fresh()
  assert.ok('error' in recordBuy(db, bought({ askPrice: 0.5 })))
  assert.ok('error' in recordBuy(db, bought({ customId: '' })))
  assert.equal(count(db, 'market_buys'), 0)
})

// ── отмены ──

function asker(answer: (cid: string, n: number) => any) {
  const calls: string[] = []
  const ask = async (key: string, cid: string) => {
    assert.equal(key, KEY)
    calls.push(cid)
    return answer(cid, calls.length - 1)
  }
  return { ask, calls }
}

test('ключ отмены: по custom_id, без него — item_id и время', () => {
  assert.equal(cancelKey(cancelled('gt-5-5')), 'cid:gt-5-5')
  assert.equal(cancelKey(cancelled(null)), 'item:5900000009:' + (START + 3000))
})

test('новая отмена — один запрос, строка с причиной; повторная сверка — ноль запросов; в деньги ничего', async () => {
  const db = fresh()
  const { ask, calls } = asker(() => ({ success: true, data: { stage: '5', causer: 'buyer', cancellation_reason: 'buyer_cancelled', item_id: '5900000009' } }))
  const a = await reconcileCancellations(db, { accountId: 'main', key: KEY, cancelled: [cancelled('gt-5-5')], ask, now: START + 5000 })
  assert.equal(calls.length, 1)
  assert.equal(a.stored, 1)
  const row = db.prepare('select * from market_cancellations').get() as any
  assert.equal(row.causer, 'buyer')
  assert.equal(row.cancellation_reason, 'buyer_cancelled')
  assert.equal(row.checked_at, START + 5000)
  assert.ok(!String(row.raw_ref).includes(KEY))
  const b = await reconcileCancellations(db, { accountId: 'main', key: KEY, cancelled: [cancelled('gt-5-5')], ask })
  assert.equal(calls.length, 1, 'повторно площадку не спрашиваем')
  assert.equal(b.known, 1)
  assert.equal(count(db, 'money_ops'), 0)
})

test('одна отмена дважды во входе — один запрос', async () => {
  const db = fresh()
  const { ask, calls } = asker(() => ({ success: true, data: { causer: 'seller', cancellation_reason: 'seller_cancelled' } }))
  await reconcileCancellations(db, { accountId: 'main', key: KEY, cancelled: [cancelled('gt-5-5'), cancelled('gt-5-5')], ask })
  assert.equal(calls.length, 1)
  assert.equal(count(db, 'market_cancellations'), 1)
})

test('площадка не ответила — строки нет, отмена в «не проверено», следующий запуск спрашивает снова', async () => {
  const db = fresh()
  let up = false
  const { ask, calls } = asker(() => (up ? { success: true, data: { causer: 'seller', cancellation_reason: 'seller_cancelled' } } : { success: false, error: 'нет связи' }))
  const a = await reconcileCancellations(db, { accountId: 'main', key: KEY, cancelled: [cancelled('gt-5-5')], ask })
  assert.equal(count(db, 'market_cancellations'), 0)
  assert.equal(a.unchecked.length, 1)
  assert.match(a.unchecked[0].error, /нет связи/)
  up = true
  await reconcileCancellations(db, { accountId: 'main', key: KEY, cancelled: [cancelled('gt-5-5')], ask })
  assert.equal(calls.length, 2)
  assert.equal(count(db, 'market_cancellations'), 1)
})

test('ответ без причины — строка пишется как проверенная', async () => {
  const db = fresh()
  const { ask } = asker(() => ({ success: true, data: { stage: '5' } }))
  await reconcileCancellations(db, { accountId: 'main', key: KEY, cancelled: [cancelled('gt-5-5')], ask, now: 7 })
  const row = db.prepare('select * from market_cancellations').get() as any
  assert.equal(row.checked_at, 7)
  assert.equal(row.causer, null)
  assert.equal(row.cancellation_reason, null)
})

test('отмена без custom_id — строка без запроса, в raw_ref — строка истории', async () => {
  const db = fresh()
  const { ask, calls } = asker(() => ({ success: true }))
  await reconcileCancellations(db, { accountId: 'main', key: KEY, cancelled: [cancelled(null)], ask })
  assert.equal(calls.length, 0)
  const row = db.prepare('select * from market_cancellations').get() as any
  assert.equal(row.checked_at, null)
  assert.equal(JSON.parse(row.raw_ref).stage, '5')
})

test('больше 20 новых — 20 запросов, остальные «не проверено»', async () => {
  const db = fresh()
  const { ask, calls } = asker(() => ({ success: true, data: { causer: 'seller', cancellation_reason: 'seller_cancelled' } }))
  const many = Array.from({ length: 25 }, (_, i) => cancelled('gt-9-' + i))
  const r = await reconcileCancellations(db, { accountId: 'main', key: KEY, cancelled: many, ask })
  assert.equal(calls.length, 20)
  assert.equal(r.stored, 20)
  assert.equal(r.unchecked.length, 5)
})

test('отмены: правка и удаление запрещены', async () => {
  const db = fresh()
  const { ask } = asker(() => ({ success: true, data: { causer: 'seller', cancellation_reason: 'seller_cancelled' } }))
  await reconcileCancellations(db, { accountId: 'main', key: KEY, cancelled: [cancelled('gt-5-5')], ask })
  assert.throws(() => db.prepare(`update market_cancellations set causer = 'buyer'`).run())
  assert.throws(() => db.prepare('delete from market_cancellations').run())
})

// ── сверка ──

test('сверка: (а) наша покупка без истории, (б) до журнала / нет в журнале / не через Gemtrack', () => {
  const db = fresh()
  recordBuy(db, bought({ customId: 'gt-a-1' }))                                   // (а): в истории нет
  addOp(db, op('gt-old-1', { happenedAt: START - DAY_MS }))                       // (б) до журнала
  addOp(db, op('gt-new-1', { happenedAt: START + DAY_MS }))                       // (б) после — нет в журнале
  addOp(db, op(null, { happenedAt: START + DAY_MS }))                             // (б) без custom_id
  addOp(db, op('their-1', { happenedAt: START + DAY_MS }))                        // (б) чужой custom_id
  const r = reconcile(db, 'main', START + 2 * DAY_MS)
  assert.deepEqual(r.missingInHistory.map(x => x.customId), ['gt-a-1'])
  assert.equal(r.beforeJournal, 1)
  assert.deepEqual(r.notInJournal.map(x => x.customId), ['gt-new-1'])
  assert.equal(r.notGemtrack, 2)
})

test('сверка суммы: gross ≤ ask_price — сверено (дешевле — счётчик), дороже или другая валюта — расхождение', () => {
  const db = fresh()
  for (const [cid, ask, gross, cur] of [['gt-eq', 44, 44, 'RUB'], ['gt-lo', 50, 44, 'RUB'], ['gt-hi', 40, 44, 'RUB'], ['gt-cur', 44, 44, 'USD']] as const) {
    recordBuy(db, bought({ customId: cid, askPrice: ask }))
    addOp(db, op(cid, { gross, net: -gross, currency: cur }))
  }
  const r = reconcile(db, 'main', START + DAY_MS)
  assert.equal(r.reconciled, 2)
  assert.equal(r.cheaper, 1)
  assert.deepEqual(r.mismatch.map(x => x.customId).sort(), ['gt-cur', 'gt-hi'])
  const at = (cid: string) => listOps(db).find(o => o.external_id === 'buy:cid:' + cid)!.reconciled_at
  assert.ok(at('gt-eq') && at('gt-lo'))
  assert.equal(at('gt-hi'), null)
  assert.equal(at('gt-cur'), null)
  const again = reconcile(db, 'main', START + 2 * DAY_MS)
  assert.equal(again.reconciled, 0, 'повторная сверка ничего не меняет')
  assert.equal(at('gt-eq'), START + DAY_MS)
})

test('сверка: отмены по причинам и риск отмен покупателем за 30 дней', async () => {
  const db = fresh()
  const reasons: Record<string, any> = {
    'gt-s': { causer: 'seller', cancellation_reason: 'seller_cancelled' },
    'gt-b': { causer: 'buyer', cancellation_reason: 'buyer_cancelled' },
    'gt-b-old': { causer: 'buyer', cancellation_reason: 'buyer_cancelled' },
    'gt-u': {},
  }
  const { ask } = asker(cid => ({ success: true, data: reasons[cid] }))
  const now = START + 40 * DAY_MS
  await reconcileCancellations(db, {
    accountId: 'main', key: KEY, ask,
    cancelled: [
      cancelled('gt-s', { time: now - DAY_MS }), cancelled('gt-b', { time: now - DAY_MS }),
      cancelled('gt-b-old', { time: now - 35 * DAY_MS }), cancelled('gt-u', { time: now - DAY_MS }),
      cancelled(null, { time: now - DAY_MS, itemId: '42' }),
    ],
  })
  // Отмена покупки, которая есть в журнале закупки, не попадает в «нет в истории».
  recordBuy(db, bought({ customId: 'gt-s' }))
  const r = reconcile(db, 'main', now)
  const by = Object.fromEntries(r.cancellations.map(c => [c.cancelKey, c.reason]))
  assert.equal(by['cid:gt-s'], 'отменил продавец')
  assert.equal(by['cid:gt-b'], 'отменил покупатель')
  assert.equal(by['cid:gt-u'], 'причина неизвестна')
  assert.equal(by['item:42:' + (now - DAY_MS)], 'нет custom_id — площадку не спросить')
  assert.ok(r.cancellations.every(c => /возврат денег по API не подтверждён/.test(c.money)))
  assert.equal(r.buyerCancelled30d, 1)
  assert.match(r.buyerWarning, /со слов владельца/)
  assert.deepEqual(r.missingInHistory, [])
  assert.equal(count(db, 'money_ops'), 0)
})

// ── импорт для маршрута ──

test('импорт для маршрута: дни режутся до 180, отмены проверяются, ключа в ответе нет', async () => {
  const db = fresh()
  const windows: { from: number; to: number }[] = []
  const read = async (_k: string, from: number, to: number) => {
    windows.push({ from, to })
    return { success: true, data: windows.length === 1 ? [{ event: 'buy', stage: '5', custom_id: 'gt-c-1', item_id: '1', time: '1789000000', market_hash_name: 'Spectator: Alliance', paid: '44', currency: 'RUB' }] : [] }
  }
  const { ask, calls } = asker(() => ({ success: true, data: { causer: 'seller', cancellation_reason: 'seller_cancelled' } }))
  const now = START + 400 * DAY_MS
  const r = await moneySync(db, { accountId: 'main', key: KEY, days: 9999, now, read, ask })
  assert.equal(r.days, 180)
  assert.equal(Math.round((windows.at(-1)!.to - windows[0].from) / 86_400), 180)
  assert.equal(calls.length, 1)
  assert.equal(r.cancellations.stored, 1)
  assert.ok(!JSON.stringify(r).includes(KEY))
  const d = await moneySync(db, { accountId: 'main', key: KEY, now, read, ask })
  assert.equal(d.days, 30)
})
