import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { addOp, MONEY_DDL, storno, type Op } from './money.ts'
import {
  addPayout, correctPayout, externalId, handleCorrect, handlePayout, handleStorno, listPayouts,
  normalizeTx, parsePayout, stornoPayout, type Payout,
} from './payouts.ts'
import { allowedHosts, gate } from './auth.ts'

// Выплаты Clover (план 3.2). Номера транзакций, суммы и аккаунты — выдуманные.

const NOW = Date.UTC(2026, 9, 5, 12)
const A = 'main'
const B = 'second'

function fresh() {
  const db = new DatabaseSync(':memory:')
  db.exec(MONEY_DDL)
  return db
}

const all = (db: DatabaseSync) => db.prepare('select * from money_ops order by id').all() as Op[]
const raw = (o: Op) => JSON.parse(o.raw_ref ?? '{}')
const payoutsOf = (db: DatabaseSync, tx: string) =>
  all(db).filter(o => o.type === 'выплата Clover' && raw(o).tx === tx)
const reversed = (db: DatabaseSync, id: number) =>
  all(db).some(o => o.type === 'сторно' && o.external_id === 'storno:' + id)
const active = (db: DatabaseSync, tx: string) => payoutsOf(db, tx).filter(o => !reversed(db, o.id))

const pay = (over: Partial<Payout> = {}): Payout => ({
  accountId: A,
  tx: 'ABC1',
  cents: 1250,
  happenedAt: NOW - 3_600_000,
  asset: 'USD',
  usdBy: 'получено',
  ...over,
})

const ok = <T extends object>(r: T | { error: string }): T => {
  assert.ok(!('error' in r), 'ожидался успех, а пришло: ' + (r as any).error)
  return r as T
}
const refused = (r: object, re: RegExp) => {
  assert.ok('error' in r, 'ожидался отказ')
  assert.match((r as any).error, re)
}

// ── номер транзакции ──

test('номер: пробелы по краям срезаются, внутри — отказ', () => {
  assert.deepEqual(normalizeTx('  ABC1  '), { tx: 'ABC1' })
  refused(normalizeTx('AB C1'), /пробел/)
  refused(normalizeTx(''), /нужен номер транзакции/)
  refused(normalizeTx('   '), /нужен номер транзакции/)
})

test('номер: хэш перевода — в нижнем регистре, один перевод при любом регистре', () => {
  const h = 'AB'.repeat(32)
  assert.deepEqual(normalizeTx('0xDEADBEEF'), { tx: '0xdeadbeef' })
  assert.deepEqual(normalizeTx(h), { tx: h.toLowerCase() })
  // Не хэш — регистр не трогаем: номер с сайта может различать регистр.
  assert.deepEqual(normalizeTx('Pay-Out-7'), { tx: 'Pay-Out-7' })
})

test('номер: # и : внутри допустимы; короче 4 и длиннее 200 — отказ', () => {
  assert.deepEqual(normalizeTx('ABC#2'), { tx: 'ABC#2' })
  assert.deepEqual(normalizeTx('a:b:c'), { tx: 'a:b:c' })
  refused(normalizeTx('abc'), /длина/)
  refused(normalizeTx('x'.repeat(201)), /длина/)
  assert.deepEqual(normalizeTx('x'.repeat(200)), { tx: 'x'.repeat(200) })
})

test('внутренний идентификатор — v<версия>:<номер>', () => {
  assert.equal(externalId('ABC', 2), 'v2:ABC')
  assert.equal(externalId('ABC#2', 1), 'v1:ABC#2')
})

// ── разбор формы ──

const body = (over: Record<string, unknown> = {}) => ({
  accountId: A, tx: 'ABC1', usd: '12.50', happenedAt: NOW - 1_000, asset: 'USD', ...over,
})

test('сумма: «12,50» и «12.50» — 1250 центов; 0, минус, три знака, не число — отказ', () => {
  assert.equal(ok(parsePayout(body({ usd: '12,50' }), NOW)).cents, 1250)
  assert.equal(ok(parsePayout(body({ usd: '12.50' }), NOW)).cents, 1250)
  assert.equal(ok(parsePayout(body({ usd: '7' }), NOW)).cents, 700)
  assert.equal(ok(parsePayout(body({ usd: '0.5' }), NOW)).cents, 50)
  for (const usd of ['0', '-5', '1.234', 'abc', '', '1e3']) refused(parsePayout(body({ usd }), NOW), /сумм/)
})

test('аккаунт и монета обязательны', () => {
  refused(parsePayout(body({ accountId: '' }), NOW), /аккаунт/)
  refused(parsePayout(body({ asset: '' }), NOW), /чем пришла/)
})

test('в монете, включая USDT, доллары — оценка владельца; с клиента это не принимается', () => {
  assert.equal(ok(parsePayout(body({ asset: 'USD' }), NOW)).usdBy, 'получено')
  assert.equal(ok(parsePayout(body({ asset: 'usdt', usdBy: 'получено' }), NOW)).usdBy, 'владелец')
  assert.equal(ok(parsePayout(body({ asset: 'USDT' }), NOW)).asset, 'USDT')
})

test('количество монеты — строкой как введено, без пересчёта в доллары', () => {
  const p = ok(parsePayout(body({ asset: 'USDT', assetAmount: '12,48', network: 'BEP20', usd: '12.40' }), NOW))
  assert.equal(p.assetAmount, '12.48')
  assert.equal(p.cents, 1240, 'доллары — только из поля «в долларах»')
  refused(parsePayout(body({ asset: 'USDT', assetAmount: 'много' }), NOW), /количеств/)
})

test('дата: в будущем и раньше 2020 — отказ; нет даты — сейчас', () => {
  refused(parsePayout(body({ happenedAt: NOW + 3_600_000 }), NOW), /будущ/)
  refused(parsePayout(body({ happenedAt: Date.UTC(2019, 11, 31) }), NOW), /2020/)
  assert.equal(ok(parsePayout(body({ happenedAt: undefined }), NOW)).happenedAt, NOW)
})

test('ключей — целое ≥ 0 или нет', () => {
  assert.equal(ok(parsePayout(body({ keys: 5 }), NOW)).keys, 5)
  assert.equal(ok(parsePayout(body({ keys: '' }), NOW)).keys, undefined)
  refused(parsePayout(body({ keys: 1.5 }), NOW), /ключ/)
  refused(parsePayout(body({ keys: -1 }), NOW), /ключ/)
})

// ── запись (решения 3–5, 8) ──

test('первая выплата — версия 1 в общем журнале, источник — площадка', () => {
  const db = fresh()
  const r = ok(addPayout(db, pay({ asset: 'USDT', usdBy: 'владелец', assetAmount: '12.48', network: 'BEP20', keys: 5 }), { now: NOW }))
  assert.equal(r.inserted, true)
  const [o] = all(db)
  assert.equal(o.type, 'выплата Clover')
  assert.equal(o.source, 'Clover.tf')
  assert.equal(o.external_id, 'v1:ABC1')
  assert.equal(o.account_id, A)
  assert.equal(o.currency, 'USD')
  assert.equal(o.net, 1250)
  assert.equal(o.gross, null)
  assert.equal(o.fee_steam, null)
  assert.deepEqual(raw(o), {
    entry: 'вручную', tx: 'ABC1', version: 1, corrects: null,
    asset: 'USDT', assetAmount: '12.48', network: 'BEP20', usdBy: 'владелец', keys: 5,
  })
})

test('повтор: тот же номер, аккаунт и сумма — та же запись, дата первой', () => {
  const db = fresh()
  const first = ok(addPayout(db, pay(), { now: NOW }))
  const again = ok(addPayout(db, pay({ happenedAt: NOW - 10 }), { now: NOW }))
  assert.deepEqual(again, { id: first.id, inserted: false })
  assert.equal(all(db).length, 1)
  assert.equal(all(db)[0].happened_at, NOW - 3_600_000)
})

test('тот же номер с другой суммой — отказ, а не «уже внесена»', () => {
  const db = fresh()
  ok(addPayout(db, pay(), { now: NOW }))
  refused(addPayout(db, pay({ cents: 1350 }), { now: NOW }), /номер уже внесён с другой суммой: \$12\.50/)
  assert.equal(all(db).length, 1)
})

test('тот же номер на другом аккаунте — отказ с названием аккаунта', () => {
  const db = fresh()
  ok(addPayout(db, pay(), { now: NOW }))
  refused(addPayout(db, pay({ accountId: B }), { now: NOW, labelOf: id => id === A ? 'основной' : id }), /номер уже внесён на аккаунт «основной»/)
  assert.equal(all(db).length, 1)
})

test('номера не смешиваются: ABC после сторно и самостоятельный ABC#2', () => {
  const db = fresh()
  const v1 = ok(addPayout(db, pay({ tx: 'ABC' }), { now: NOW }))
  ok(stornoPayout(db, v1.id, 'ошибка в сумме', NOW))
  const other = ok(addPayout(db, pay({ tx: 'ABC#2', cents: 999 }), { now: NOW }))
  assert.equal(other.inserted, true)
  const o = all(db).find(x => x.id === other.id)!
  assert.equal(o.external_id, 'v1:ABC#2')
  assert.equal(raw(o).tx, 'ABC#2')
  assert.equal(raw(o).version, 1)
  assert.deepEqual(payoutsOf(db, 'ABC').map(x => x.id), [v1.id], 'у номера ABC — только его запись')
  // И исправление ABC после этого — версия 2 своего номера, не «ABC#2».
  const v2 = ok(correctPayout(db, v1.id, pay({ tx: 'ABC' }), { now: NOW }))
  assert.equal(all(db).find(x => x.id === v2.id)!.external_id, 'v2:ABC')
})

test('запоздавший повтор после сторно не воскрешает выплату', () => {
  const db = fresh()
  const v1 = ok(addPayout(db, pay(), { now: NOW }))
  ok(stornoPayout(db, v1.id, 'внесена по ошибке', NOW))
  refused(addPayout(db, pay(), { now: NOW }), /выплата с этим номером сторнирована; исправление — кнопкой «внести исправление»/)
  assert.equal(active(db, 'ABC1').length, 0)
  assert.equal(payoutsOf(db, 'ABC1').length, 1)
})

test('тот же номер у другой площадки не мешает', () => {
  const db = fresh()
  addOp(db, {
    accountId: A, type: 'покупка гема', source: 'market.dota2.net', externalId: 'v1:ABC1',
    happenedAt: NOW - 5_000, currency: 'RUB', gross: 100, net: -100, createdBy: 'импорт',
  })
  assert.equal(ok(addPayout(db, pay(), { now: NOW })).inserted, true)
})

test('гонка: второй ввод того же номера между проверкой и вставкой — действующая одна', () => {
  const db = fresh()
  let inner: object | null = null
  const r = ok(addPayout(db, pay(), { now: NOW, afterCheck: () => { inner = addPayout(db, pay(), { now: NOW }) } }))
  assert.equal(r.inserted, true)
  assert.ok(inner && ('error' in inner || (inner as any).inserted === false))
  assert.equal(active(db, 'ABC1').length, 1)
})

// ── сторно (решение 7) ──

test('сторно выплаты: обратная запись с причиной, исходная не меняется', () => {
  const db = fresh()
  const v1 = ok(addPayout(db, pay(), { now: NOW }))
  const before = JSON.stringify(all(db)[0])
  const s = ok(stornoPayout(db, v1.id, 'не тот аккаунт', NOW))
  const rows = all(db)
  assert.equal(JSON.stringify(rows[0]), before)
  const st = rows.find(x => x.id === s.id)!
  assert.equal(st.type, 'сторно')
  assert.equal(st.net, -1250)
  assert.deepEqual(JSON.parse(st.raw_ref!), { reverses: v1.id, reason: 'не тот аккаунт' })
  assert.equal(st.created_by, 'владелец')
})

test('сторно: без причины — отказ; второе — отказ; не выплату этим путём — отказ', () => {
  const db = fresh()
  const v1 = ok(addPayout(db, pay(), { now: NOW }))
  refused(stornoPayout(db, v1.id, '   ', NOW), /причин/)
  ok(stornoPayout(db, v1.id, 'ошибка', NOW))
  refused(stornoPayout(db, v1.id, 'ещё раз', NOW), /уже сторнирована/)
  assert.equal(all(db).filter(o => o.type === 'сторно').length, 1)
  const buy = addOp(db, {
    accountId: A, type: 'покупка гема', source: 'market.dota2.net', externalId: 'buy:1',
    happenedAt: NOW - 5_000, currency: 'RUB', gross: 100, net: -100, createdBy: 'импорт',
  }) as { id: number }
  refused(stornoPayout(db, buy.id, 'не та', NOW), /только выплаты Clover/)
  refused(stornoPayout(db, 999, 'нет', NOW), /нет такой выплаты/)
})

// ── исправление (решение 6) ──

test('исправление: сторнированная v1 → v2 того же номера со ссылкой на v1', () => {
  const db = fresh()
  const v1 = ok(addPayout(db, pay({ tx: 'ABC' }), { now: NOW }))
  ok(stornoPayout(db, v1.id, 'сумма', NOW))
  const v2 = ok(correctPayout(db, v1.id, pay({ tx: 'ABC', cents: 1300 }), { now: NOW }))
  assert.equal(v2.inserted, true)
  const o = all(db).find(x => x.id === v2.id)!
  assert.equal(o.external_id, 'v2:ABC')
  assert.equal(raw(o).version, 2)
  assert.equal(raw(o).corrects, v1.id)
  assert.equal('movedFrom' in raw(o), false, 'тот же аккаунт — не перенос')
  assert.equal(o.net, 1300)
  assert.equal(active(db, 'ABC').length, 1)
})

test('повтор исправления до его сторно — та же запись; с другой суммой — отказ', () => {
  const db = fresh()
  const v1 = ok(addPayout(db, pay({ tx: 'ABC' }), { now: NOW }))
  ok(stornoPayout(db, v1.id, 'сумма', NOW))
  const v2 = ok(correctPayout(db, v1.id, pay({ tx: 'ABC', cents: 1300 }), { now: NOW }))
  assert.deepEqual(ok(correctPayout(db, v1.id, pay({ tx: 'ABC', cents: 1300 }), { now: NOW })), { id: v2.id, inserted: false })
  assert.equal(payoutsOf(db, 'ABC').length, 2)
  refused(correctPayout(db, v1.id, pay({ tx: 'ABC', cents: 1400 }), { now: NOW }), /исправление уже внесено/)
  assert.equal(payoutsOf(db, 'ABC').length, 2)
})

test('повтор исправления после его сторно — отказ, ничего не создано; дальше исправляется v2', () => {
  const db = fresh()
  const v1 = ok(addPayout(db, pay({ tx: 'ABC' }), { now: NOW }))
  ok(stornoPayout(db, v1.id, 'сумма', NOW))
  const v2 = ok(correctPayout(db, v1.id, pay({ tx: 'ABC', cents: 1300 }), { now: NOW }))
  ok(stornoPayout(db, v2.id, 'опять не так', NOW))
  refused(correctPayout(db, v1.id, pay({ tx: 'ABC', cents: 1300 }), { now: NOW }), /исправление этой записи сторнировано; новое исправление — от него/)
  assert.equal(active(db, 'ABC').length, 0)
  assert.equal(payoutsOf(db, 'ABC').length, 2)
  const v3 = ok(correctPayout(db, v2.id, pay({ tx: 'ABC', cents: 1350 }), { now: NOW }))
  assert.equal(all(db).find(x => x.id === v3.id)!.external_id, 'v3:ABC')
  assert.equal(active(db, 'ABC').length, 1)
})

test('исправление ошибочного аккаунта: перенос A → B, действующая одна, связь сохранена', () => {
  const db = fresh()
  const labelOf = (id: string) => (id === A ? 'основной' : 'второй')
  const v1 = ok(addPayout(db, pay({ tx: 'ABC' }), { now: NOW }))
  ok(stornoPayout(db, v1.id, 'не тот аккаунт', NOW))
  const v2 = ok(correctPayout(db, v1.id, pay({ tx: 'ABC', accountId: B }), { now: NOW }))
  const o = all(db).find(x => x.id === v2.id)!
  assert.equal(o.account_id, B)
  assert.equal(raw(o).corrects, v1.id)
  assert.equal(raw(o).movedFrom, A, 'откуда перенесено — видно на новой записи')
  assert.deepEqual(active(db, 'ABC').map(x => x.account_id), [B])
  refused(addPayout(db, pay({ tx: 'ABC' }), { now: NOW, labelOf }), /номер уже внесён на аккаунт «второй»/)
  assert.deepEqual(ok(correctPayout(db, v1.id, pay({ tx: 'ABC', accountId: B }), { now: NOW })), { id: v2.id, inserted: false })
  refused(correctPayout(db, v1.id, pay({ tx: 'ABC', accountId: A }), { now: NOW }), /исправление уже внесено/)
  assert.equal(payoutsOf(db, 'ABC').length, 2)
})

test('исправить можно только сторнированную, последнюю версию, тем же номером', () => {
  const db = fresh()
  const v1 = ok(addPayout(db, pay({ tx: 'ABC' }), { now: NOW }))
  refused(correctPayout(db, v1.id, pay({ tx: 'ABC' }), { now: NOW }), /только сторнированную/)
  ok(stornoPayout(db, v1.id, 'сумма', NOW))
  refused(correctPayout(db, v1.id, pay({ tx: 'XYZ9' }), { now: NOW }), /другой номер — это другая выплата/)
  refused(correctPayout(db, 999, pay({ tx: 'ABC' }), { now: NOW }), /нет такой выплаты/)
  // Версия 2 номера, не связанная с v1 (так через панель не бывает — защита
  // от неполной истории): v1 уже не последняя.
  addOp(db, {
    accountId: A, type: 'выплата Clover', source: 'Clover.tf', externalId: 'v2:ABC',
    happenedAt: NOW - 1_000, currency: 'USD', gross: null, net: 1250, createdBy: 'владелец',
    rawRef: JSON.stringify({ entry: 'вручную', tx: 'ABC', version: 2, corrects: null, asset: 'USD', usdBy: 'получено' }),
  })
  refused(correctPayout(db, v1.id, pay({ tx: 'ABC' }), { now: NOW }), /исправляется последняя версия/)
})

test('гонка исправлений: второе между проверкой и вставкой — действующая одна', () => {
  const db = fresh()
  const v1 = ok(addPayout(db, pay({ tx: 'ABC' }), { now: NOW }))
  ok(stornoPayout(db, v1.id, 'сумма', NOW))
  let inner: object | null = null
  ok(correctPayout(db, v1.id, pay({ tx: 'ABC' }), { now: NOW, afterCheck: () => { inner = correctPayout(db, v1.id, pay({ tx: 'ABC' }), { now: NOW }) } }))
  assert.ok(inner && ('error' in inner || (inner as any).inserted === false))
  assert.equal(active(db, 'ABC').length, 1)
})

// ── полный список (решение 11) ──

test('список выплат не зависит от предела общего журнала', () => {
  const db = fresh()
  for (let i = 0; i < 6_000; i++) {
    addOp(db, {
      accountId: A, type: 'продажа вещи', source: 'рынок Steam', externalId: 'sale:' + i,
      happenedAt: NOW - 1_000 + i % 500, currency: 'steam:2018', gross: null, net: 100, createdBy: 'импорт',
    })
  }
  const ids = [1, 2, 3].map(i => ok(addPayout(db, pay({ tx: 'TX-' + i, happenedAt: Date.UTC(2021, 0, i) }), { now: NOW })).id)
  ok(stornoPayout(db, ids[0], 'ошибка', NOW))
  const l = listPayouts(db, A)
  assert.equal(l.complete, true)
  assert.deepEqual(l.ops.filter(o => o.type === 'выплата Clover').map(o => o.id).sort(), [...ids].sort())
  assert.equal(l.ops.filter(o => o.type === 'сторно').length, 1)
  assert.equal(l.ops.some(o => o.type === 'продажа вещи'), false)
})

test('список: свой предел — complete false; чужие выплаты и чужие сторно не входят', () => {
  const db = fresh()
  for (const i of [1, 2, 3]) ok(addPayout(db, pay({ tx: 'TX-' + i }), { now: NOW }))
  const other = ok(addPayout(db, pay({ tx: 'TX-B', accountId: B }), { now: NOW }))
  ok(stornoPayout(db, other.id, 'чужая', NOW))
  const buy = addOp(db, {
    accountId: A, type: 'покупка гема', source: 'market.dota2.net', externalId: 'buy:1',
    happenedAt: NOW - 5_000, currency: 'RUB', gross: 100, net: -100, createdBy: 'импорт',
  }) as { id: number }
  storno(db, buy.id, 'чужое сторно', 'владелец', { now: NOW })
  const capped = listPayouts(db, A, 2)
  assert.equal(capped.complete, false)
  assert.equal(capped.ops.filter(o => o.type === 'выплата Clover').length, 2)
  const full = listPayouts(db, A)
  assert.equal(full.ops.filter(o => o.type === 'выплата Clover').length, 3)
  assert.equal(full.ops.some(o => o.type === 'сторно'), false)
})

// ── маршруты: аккаунт проверяется явно (решение 8), вход обязателен ──

const accounts = new Map([[A, { id: A, label: 'основной' }], [B, { id: B, label: 'второй' }]])
const find = (id: string) => accounts.get(id)

test('маршрут записи: аккаунт из тела, несуществующий — отказ, ничего не записано', () => {
  const db = fresh()
  refused(handlePayout(db, body({ accountId: 'ghost' }), find, NOW), /нет такого аккаунта/)
  assert.equal(all(db).length, 0)
  assert.equal(ok(handlePayout(db, body(), find, NOW)).inserted, true)
  refused(handlePayout(db, body({ accountId: B }), find, NOW), /на аккаунт «основной»/)
})

test('маршрут исправления: перенос на несуществующий аккаунт — отказ, записей не прибавилось', () => {
  const db = fresh()
  const v1 = ok(handlePayout(db, body(), find, NOW))
  ok(handleStorno(db, { id: v1.id, reason: 'не тот аккаунт' }, find, NOW))
  const n = all(db).length
  refused(handleCorrect(db, { ...body({ accountId: 'ghost' }), corrects: v1.id }, find, NOW), /нет такого аккаунта/)
  refused(handleCorrect(db, { ...body(), corrects: 'x' }, find, NOW), /какую запись исправить/)
  assert.equal(all(db).length, n)
  assert.equal(ok(handleCorrect(db, { ...body({ accountId: B }), corrects: v1.id }, find, NOW)).inserted, true)
})

test('маршрут сторно: id и причина из тела', () => {
  const db = fresh()
  refused(handleStorno(db, { id: 'x', reason: 'r' }, find, NOW), /какую запись/)
  refused(handleStorno(db, { id: 1 }, find, NOW), /нет такой выплаты|причин/)
})

test('все маршруты выплат закрыты без входа', () => {
  const T = 'a'.repeat(48)
  const H = allowedHosts({})
  const headers = { host: 'localhost:4322', origin: 'http://localhost:4322' }
  for (const [method, url] of [
    ['POST', '/api/money/payout'], ['POST', '/api/money/payout/correct'],
    ['POST', '/api/money/storno'], ['GET', '/api/money/payouts?id=main'],
  ]) {
    assert.deepEqual(gate({ method, url, headers }, T, H), { ok: false, code: 401, why: 'нужен вход' }, method + ' ' + url)
  }
})
