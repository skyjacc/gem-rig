import { test } from 'node:test'
import assert from 'node:assert/strict'

// Итог «Реализовано» и список выплат (план 3.2, задача 4). Модель экрана
// «Продажи» — чистые функции панели (dash/src/v2/sales/model.ts), поэтому
// проверяется здесь, как tuneModel. Суммы и номера — выдуманные.
const { money, payoutRows, realized } = await import('../../dash/src/v2/sales/model.ts')
type Op = Parameters<typeof payoutRows>[0][number]

const T = Date.UTC(2026, 9, 1)
let next = 1
const op = (over: Partial<Op>): Op => ({
  id: next++, account_id: 'main', type: 'выплата Clover', source: 'Clover.tf', external_id: 'v1:TX-' + next,
  happened_at: T, currency: 'USD', gross: null, fee_steam: null, fee_game: null, net: 1250, status: null,
  raw_ref: JSON.stringify({ entry: 'вручную', tx: 'TX-' + next, version: 1, corrects: null, asset: 'USD', usdBy: 'получено' }),
  ...over,
})
const pay = (tx: string, net: number, extra: object = {}, over: Partial<Op> = {}) =>
  op({
    net, external_id: 'v' + ((extra as any).version ?? 1) + ':' + tx,
    raw_ref: JSON.stringify({ entry: 'вручную', tx, version: 1, corrects: null, asset: 'USD', usdBy: 'получено', ...extra }),
    ...over,
  })
const storno = (of: Op) => op({
  type: 'сторно', source: 'вручную', external_id: 'storno:' + of.id, net: -of.net,
  raw_ref: JSON.stringify({ reverses: of.id, reason: 'ошибка' }),
})
const units = (r: ReturnType<typeof realized>) => r.sums.map(s => s.currency + ':' + s.units)

test('реализовано — только выплаты Clover; продажи и покупки его не меняют', () => {
  const p1 = pay('A-1', 1250)
  const p2 = pay('A-2', 700)
  const base = realized({ ops: [p1, p2], complete: true })
  assert.deepEqual(units(base), ['USD:1950'])
  assert.equal(base.n, 2)
  const noise = [
    op({ type: 'продажа вещи', source: 'рынок Steam', currency: 'USD', net: 5_000, raw_ref: null }),
    op({ type: 'покупка ключа', source: 'рынок Steam', currency: 'USD', net: -3_000, raw_ref: null }),
    op({ type: 'покупка гема', source: 'market.dota2.net', currency: 'USD', net: -100, raw_ref: null }),
  ]
  assert.deepEqual(units(realized({ ops: [p1, ...noise, p2], complete: true })), ['USD:1950'])
})

test('выплата и её сторно — суммы нет; v1 сторнирована + v2 — в сумме только v2', () => {
  const v1 = pay('ABC', 1250)
  assert.deepEqual(realized({ ops: [v1, storno(v1)], complete: true }).sums, [])
  const v2 = pay('ABC', 1300, { version: 2, corrects: v1.id })
  const r = realized({ ops: [v1, storno(v1), v2], complete: true })
  assert.deepEqual(units(r), ['USD:1300'])
  assert.equal(r.n, 1)
})

test('период: выплата старше месяца в итог за месяц не входит, за всё время — входит', () => {
  const old = pay('OLD-1', 900, {}, { happened_at: T - 40 * 86_400_000 })
  const fresh = pay('NEW-1', 400)
  assert.deepEqual(units(realized({ ops: [old, fresh], complete: true }, 'month', T)), ['USD:400'])
  assert.deepEqual(units(realized({ ops: [old, fresh], complete: true }, 'all', T)), ['USD:1300'])
})

test('доллары выплаты в монете — оценка: метка estimated', () => {
  assert.equal(realized({ ops: [pay('U-1', 500)], complete: true }).estimated, false)
  assert.equal(realized({ ops: [pay('U-1', 500), pay('T-1', 600, { asset: 'USDT', usdBy: 'владелец' })], complete: true }).estimated, true)
})

test('неполный список — итог неполный', () => {
  assert.equal(realized({ ops: [pay('A-1', 100)], complete: false }).complete, false)
  assert.equal(realized({ ops: [pay('A-1', 100)], complete: true }).complete, true)
})

test('ключей по выплатам — справочно, только действующие', () => {
  const v1 = pay('K-1', 800, { keys: 5 })
  const v2 = pay('K-2', 300, { keys: 2 })
  assert.equal(realized({ ops: [v1, v2, storno(v2)], complete: true }).keys, 5)
})

test('сумма Clover показывается долларами', () => {
  assert.deepEqual(money('Clover.tf', 'USD', 1250), { text: '$12.50', known: true })
})

test('номер строки — из raw_ref: «ABC#2» версии 1 и «ABC» версии 2 — разные', () => {
  const a1 = pay('ABC', 1000)
  const other = pay('ABC#2', 500)
  const a2 = pay('ABC', 1000, { version: 2, corrects: a1.id }, { happened_at: T + 1 })
  const rows = payoutRows([a1, storno(a1), other, a2])
  const byId = new Map(rows.map(r => [r.op.id, r]))
  assert.equal(byId.get(other.id)!.tx, 'ABC#2')
  assert.equal(byId.get(other.id)!.version, 1)
  assert.equal(byId.get(a2.id)!.tx, 'ABC')
  assert.equal(byId.get(a2.id)!.version, 2)
  assert.equal(byId.get(a2.id)!.corrects, a1.id)
  assert.equal(byId.get(a1.id)!.reversed, true)
  assert.equal(byId.get(a1.id)!.stornoReason, 'ошибка')
  assert.equal(rows.length, 3, 'сторно — не строка выплаты')
  assert.equal(rows[0].op.id, a2.id, 'новые сверху')
})
