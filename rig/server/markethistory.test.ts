import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MONEY_DDL, listOps } from './money.ts'
import { externalId, parseHistory, syncHistory, windows, WINDOW_DAYS } from './markethistory.ts'

const DAY = 86_400

// ── окна ──

test('период режется на окна не длиннее 7 суток, без дыр и наложений', () => {
  const from = 1_790_000_000
  const to = from + 30 * DAY + 123
  const w = windows(from, to)
  assert.equal(w.length, 5)
  assert.equal(w[0].from, from)
  assert.equal(w[w.length - 1].to, to)
  for (const x of w) assert.ok(x.to - x.from <= WINDOW_DAYS * DAY && x.to > x.from)
  for (let i = 1; i < w.length; i++) assert.equal(w[i].from, w[i - 1].to)
})

test('ровно 7 суток — одно окно; пустой и обратный период — ни одного', () => {
  assert.deepEqual(windows(0, 7 * DAY), [{ from: 0, to: 7 * DAY }])
  assert.deepEqual(windows(10, 10), [])
  assert.deepEqual(windows(20, 10), [])
})

test('дробные секунды отбрасываются', () => {
  assert.deepEqual(windows(1.9, 5.2), [{ from: 1, to: 5 }])
})

// ── разбор ──
//
// Строки — обезличенные, той же формы, что пришла вживую (план 3.1,
// «Проверено вживую»): у buy нет price/received, сумма — paid, строкой
// с целым в мелких единицах; id у buy нет.

const buy = (over: Record<string, unknown> = {}) => ({
  time: '1787350000',
  event: 'buy',
  item_id: '5900000001',
  assetid: '30000000001',
  class: '230751401',
  instance: '560741488',
  market_hash_name: 'Spectator: Alliance',
  paid: '44',
  currency: 'RUB',
  stage: '2',
  custom_id: 'gt-1787349999000-12',
  settlement: null,
  for: null,
  app: 570,
  ...over,
})

const checkin = { id: '1', event: 'checkin', amount: '50000', currency: 'RUB', time: '1787340000' }

test('завершённая покупка самоцвета → «покупка гема»: paid в мелких единицах, net со знаком минус', () => {
  const r = parseHistory([buy()], 'main')
  assert.equal(r.ops.length, 1)
  const op = r.ops[0]
  assert.equal(op.type, 'покупка гема')
  assert.equal(op.source, 'market.dota2.net')
  assert.equal(op.accountId, 'main')
  assert.equal(op.currency, 'RUB')
  assert.equal(op.gross, 44)
  assert.equal(op.net, -44)
  assert.equal(op.status, 'передан')
  assert.equal(op.happenedAt, 1_787_350_000_000)
  assert.equal(op.externalId, 'buy:cid:gt-1787349999000-12')
  assert.equal(JSON.parse(op.rawRef!).item_id, '5900000001')
  assert.deepEqual(r.skipped, {})
})

test('внешний номер: по custom_id, без него — item_id и время', () => {
  assert.equal(externalId(buy()), 'buy:cid:gt-1787349999000-12')
  assert.equal(externalId(buy({ custom_id: null })), 'buy:item:5900000001:1787350000')
  assert.equal(externalId(buy({ custom_id: '' })), 'buy:item:5900000001:1787350000')
  assert.equal(externalId(buy({ custom_id: null, item_id: null })), null)
})

test('Genuine-самоцвет — тоже самоцвет', () => {
  assert.equal(parseHistory([buy({ market_hash_name: 'Genuine Spectator: Alliance' })], 'main').ops.length, 1)
})

test('всё, что не завершённая покупка самоцвета, — в пропущенные с причиной, не в деньги', () => {
  const r = parseHistory([
    buy({ stage: '5' }),
    buy({ stage: '1' }),
    buy({ stage: undefined }),
    buy({ market_hash_name: 'Mask of Madness' }),
    { event: 'refund', item_id: '1', time: '1', currency: 'RUB' },
    checkin,
    { event: 'sell', item_id: '2' },
    { event: 'checkout', amount: '1' },
    { event: 'gift' },
    buy({ stage: '9' }),
    buy({ paid: '0.44' }),
    buy({ paid: undefined }),
    buy({ currency: '' }),
    buy({ time: 'вчера' }),
    buy({ custom_id: null, item_id: null }),
    'мусор',
    null,
  ], 'main')
  assert.equal(r.ops.length, 0)
  const reasons = Object.keys(r.skipped)
  assert.equal(r.skipped['сделка отменена (stage 5): возврат денег по API не подтверждён'], 1)
  assert.equal(r.skipped['не завершена (stage 1 или нет stage) — подберёт следующий импорт'], 2)
  assert.equal(r.skipped['не самоцвет'], 1)
  assert.equal(r.skipped['возврат: вживую не наблюдался, форма не проверена'], 1)
  assert.equal(r.skipped['нет денежного типа в §16: checkin'], 1)
  assert.equal(r.skipped['нет денежного типа в §16: sell'], 1)
  assert.equal(r.skipped['нет денежного типа в §16: checkout'], 1)
  assert.equal(r.skipped['не разобрано: событие gift'], 1)
  assert.equal(r.skipped['не разобрано: stage 9'], 1)
  assert.equal(r.skipped['не разобрано: paid не целое в мелких единицах'], 2)
  assert.equal(r.skipped['не разобрано: нет валюты'], 1)
  assert.equal(r.skipped['не разобрано: time'], 1)
  assert.equal(r.skipped['не разобрано: нет custom_id и item_id'], 1)
  assert.equal(r.skipped['не разобрано: строка не объект'], 2)
  assert.equal(Object.values(r.skipped).reduce((a, b) => a + b, 0), 17)
  assert.ok(reasons.length > 0)
})

test('отменённые покупки возвращаются отдельным списком — для сверки', () => {
  const r = parseHistory([buy({ stage: '5', custom_id: 'gt-1-1' }), buy()], 'main')
  assert.equal(r.cancelled.length, 1)
  const c = r.cancelled[0]
  assert.deepEqual({ customId: c.customId, itemId: c.itemId, time: c.time }, { customId: 'gt-1-1', itemId: '5900000001', time: 1_787_350_000_000 })
  assert.equal(JSON.parse(c.raw).stage, '5', 'строка истории — основание записи об отмене')
})

// ── импорт ──

const KEY = 'SECRET-KEY-123'

function fresh() {
  const db = new DatabaseSync(':memory:')
  db.exec(MONEY_DDL)
  return db
}

// Подменённая площадка: отвечает по окнам из заготовки.
function fake(answers: ((from: number) => any)[]) {
  const calls: { key: string; from: number; to: number }[] = []
  let i = 0
  const read = async (key: string, from: number, to: number) => {
    calls.push({ key, from, to })
    const a = answers[Math.min(i++, answers.length - 1)]
    return a(from)
  }
  return { read, calls }
}

test('импорт: окна по 7 суток, покупка записана, пропуски посчитаны, ключа нет в записях', async () => {
  const db = fresh()
  const { read, calls } = fake([() => ({ success: true, data: [buy(), checkin, buy({ stage: '5', custom_id: 'gt-x-1', item_id: '9' })] }), () => ({ success: true, data: [] })])
  const r = await syncHistory(db, { accountId: 'main', key: KEY, from: 0, to: 14 * DAY, read })
  assert.equal(calls.length, 2)
  assert.ok(calls.every(c => c.key === KEY && c.to - c.from <= 7 * DAY))
  assert.equal(r.windows, 2)
  assert.equal(r.rows, 3)
  assert.equal(r.inserted, 1)
  assert.equal(r.existing, 0)
  assert.deepEqual(r.failed, [])
  assert.equal(r.skipped['нет денежного типа в §16: checkin'], 1)
  assert.equal(r.cancelled.length, 1)
  assert.equal(listOps(db).length, 1)
  assert.ok(!JSON.stringify(listOps(db)).includes(KEY))
  assert.ok(!JSON.stringify(r).includes(KEY))
})

test('повторный импорт тех же данных ничего не добавляет (одна операция — одна запись)', async () => {
  const db = fresh()
  const { read } = fake([() => ({ success: true, data: [buy(), buy({ custom_id: null, item_id: '7' })] })])
  const a = await syncHistory(db, { accountId: 'main', key: KEY, from: 0, to: DAY, read })
  const b = await syncHistory(db, { accountId: 'main', key: KEY, from: 0, to: DAY, read })
  assert.equal(a.inserted, 2)
  assert.equal(b.inserted, 0)
  assert.equal(b.existing, 2)
  assert.equal(listOps(db).length, 2)
})

test('окно с ошибкой повторяется до двух раз; не вышло — в ответе, вставленное из других окон остаётся', async () => {
  const db = fresh()
  // 1-е окно: ок; 2-е: три отказа подряд (1 + 2 повтора); 3-е: ок.
  const { read, calls } = fake([
    () => ({ success: true, data: [buy()] }),
    () => ({ success: false, error: 'площадка: слишком часто (429)', rateLimited: true }),
    () => ({ success: false, error: '' }),
    () => ({ success: false, ambiguous: true, error: 'нет связи с площадкой' }),
    () => ({ success: true, data: [buy({ custom_id: 'gt-2-2', item_id: '8' })] }),
  ])
  const r = await syncHistory(db, { accountId: 'main', key: KEY, from: 0, to: 21 * DAY, read })
  assert.equal(calls.length, 5)
  assert.equal(r.failed.length, 1)
  assert.equal(r.failed[0].from, 7 * DAY)
  assert.match(r.failed[0].error, /нет связи/)
  assert.equal(r.inserted, 2)
  assert.equal(listOps(db).length, 2)
})

test('ошибка, вылечившаяся повтором, в неудачные не попадает', async () => {
  const db = fresh()
  const { read, calls } = fake([() => ({ success: false, error: '' }), () => ({ success: true, data: [buy()] })])
  const r = await syncHistory(db, { accountId: 'main', key: KEY, from: 0, to: DAY, read })
  assert.equal(calls.length, 2)
  assert.deepEqual(r.failed, [])
  assert.equal(r.inserted, 1)
})

test('пустая ошибка площадки получает понятный текст', async () => {
  const db = fresh()
  const { read } = fake([() => ({ success: false, error: '' })])
  const r = await syncHistory(db, { accountId: 'main', key: KEY, from: 0, to: DAY, read })
  assert.equal(r.failed.length, 1)
  assert.ok(r.failed[0].error.length > 0)
})
