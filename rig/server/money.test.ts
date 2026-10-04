import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { addOp, listOps, markReconciled, migrateMoney, MONEY_DDL, storno, type NewOp } from './money.ts'

function fresh() {
  const db = new DatabaseSync(':memory:')
  db.exec(MONEY_DDL)
  return db
}

const count = (db: DatabaseSync) => (db.prepare('select count(*) c from money_ops').get() as any).c as number

// Покупка в мелких единицах площадки: 30 = $0.030 (USD считается тысячными).
const buy = (over: Partial<NewOp> = {}): NewOp => ({
  accountId: 'main',
  type: 'покупка гема',
  source: 'market.dota2.net',
  externalId: 'buy:test-1',
  happenedAt: 1_790_000_000_000,
  currency: 'USD',
  gross: 30,
  net: -30,
  createdBy: 'импорт',
  ...over,
})

// ── вставка и дубль ──

test('вставка возвращает id и пишет запись', () => {
  const db = fresh()
  const r = addOp(db, buy())
  assert.ok('id' in r && r.inserted)
  assert.equal(count(db), 1)
  const row = listOps(db)[0]
  assert.equal(row.external_id, 'buy:test-1')
  assert.equal(row.user_id, 'owner')
  assert.equal(row.reconciled_at, null)
})

test('дубль source + external_id не вставляется и возвращает «уже есть»', () => {
  const db = fresh()
  const a = addOp(db, buy())
  const b = addOp(db, buy({ gross: 99, net: -99 }))
  assert.ok('id' in a && 'id' in b)
  assert.equal(b.inserted, false)
  assert.equal(b.id, a.id)
  assert.equal(count(db), 1)
  assert.equal(listOps(db)[0].gross, 30, 'первая запись не перезаписана')
})

test('тот же external_id у другого источника — другая операция', () => {
  const db = fresh()
  addOp(db, buy())
  const r = addOp(db, buy({ source: 'рынок Steam', type: 'продажа вещи', net: 30 }))
  assert.ok('id' in r && r.inserted)
  assert.equal(count(db), 2)
})

test('external_id и source пустыми не бывают — ни через код, ни прямой вставкой', () => {
  const db = fresh()
  assert.ok('error' in addOp(db, buy({ externalId: '' })))
  assert.ok('error' in addOp(db, buy({ source: '' as any })))
  assert.equal(count(db), 0)
  // В SQLite UNIQUE пропускает несколько NULL — поэтому NOT NULL в самой схеме.
  const raw = (ext: string | null, src: string | null) => db.prepare(`
    insert into money_ops (user_id, type, source, external_id, happened_at, recorded_at, currency, gross, net, created_by)
    values ('owner', 'покупка гема', ?, ?, 1, 1, 'USD', 1, -1, 'тест')`).run(src, ext)
  assert.throws(() => raw(null, 'market.dota2.net'))
  assert.throws(() => raw('x', null))
  assert.equal(count(db), 0)
})

test('суммы — только целые (мелкие единицы), не доли', () => {
  const db = fresh()
  assert.ok('error' in addOp(db, buy({ gross: 0.03 })))
  assert.ok('error' in addOp(db, buy({ net: -0.5 })))
  assert.ok('error' in addOp(db, buy({ feeSteam: 1.5 })))
  assert.equal(count(db), 0)
  // И база сама не примет дробь, даже мимо кода.
  assert.throws(() => db.prepare(`
    insert into money_ops (user_id, type, source, external_id, happened_at, recorded_at, currency, gross, net, created_by)
    values ('owner', 'покупка гема', 'market.dota2.net', 'x', 1, 1, 'USD', 0.5, -1, 'тест')`).run())
})

test('неизвестный тип операции не вставляется', () => {
  const db = fresh()
  assert.ok('error' in addOp(db, buy({ type: 'перевод' as any })))
  assert.equal(count(db), 0)
})

// ── неизменность ──

test('UPDATE любого поля и DELETE запрещены самой базой', () => {
  const db = fresh()
  const r = addOp(db, buy())
  assert.ok('id' in r)
  for (const sql of [
    `update money_ops set gross = 1 where id = ?`,
    `update money_ops set net = 0 where id = ?`,
    `update money_ops set external_id = 'другой' where id = ?`,
    `update money_ops set status = 'x' where id = ?`,
    `update money_ops set created_by = 'кто-то' where id = ?`,
  ]) assert.throws(() => db.prepare(sql).run(r.id), /запись не меняется/, sql)
  assert.throws(() => db.prepare('delete from money_ops where id = ?').run(r.id), /удаление запрещено/)
  assert.equal(listOps(db)[0].gross, 30)
  assert.equal(count(db), 1)
})

test('reconciled_at: NULL → время проходит один раз; второй раз и вместе с другим полем — нет', () => {
  const db = fresh()
  const r = addOp(db, buy())
  assert.ok('id' in r)
  assert.throws(() => db.prepare('update money_ops set reconciled_at = 5, gross = 1 where id = ?').run(r.id), /запись не меняется/)
  assert.deepEqual(markReconciled(db, r.id, 1_790_000_100_000), { ok: true })
  assert.equal(listOps(db)[0].reconciled_at, 1_790_000_100_000)
  assert.ok('error' in markReconciled(db, r.id, 1_790_000_200_000))
  assert.throws(() => db.prepare('update money_ops set reconciled_at = 7 where id = ?').run(r.id), /запись не меняется/)
  assert.throws(() => db.prepare('update money_ops set reconciled_at = null where id = ?').run(r.id), /запись не меняется/)
  assert.equal(listOps(db)[0].reconciled_at, 1_790_000_100_000)
})

// ── сторно ──

test('сторно — новая запись с обратным знаком, исходная не тронута', () => {
  const db = fresh()
  const r = addOp(db, buy())
  assert.ok('id' in r)
  const s = storno(db, r.id, 'ошибочный импорт', 'владелец')
  assert.ok('id' in s)
  assert.equal(count(db), 2)
  const rows = listOps(db)
  const st = rows.find(x => x.type === 'сторно')!
  const orig = rows.find(x => x.id === r.id)!
  assert.equal(st.net, 30)
  assert.equal(st.gross, 30)
  assert.equal(st.currency, 'USD')
  assert.equal(st.external_id, 'storno:' + r.id)
  assert.equal(st.source, 'вручную')
  assert.equal(st.created_by, 'владелец')
  assert.equal(JSON.parse(st.raw_ref!).reverses, r.id)
  assert.equal(JSON.parse(st.raw_ref!).reason, 'ошибочный импорт')
  assert.equal(orig.net, -30)
  // В сумме — ноль.
  assert.equal(rows.reduce((n, x) => n + x.net, 0), 0)
})

test('повторное сторно той же записи — отказ, записей не прибавилось', () => {
  const db = fresh()
  const r = addOp(db, buy())
  assert.ok('id' in r)
  assert.ok('id' in storno(db, r.id, 'ошибка', 'владелец'))
  const again = storno(db, r.id, 'ещё раз', 'владелец')
  assert.ok('error' in again)
  assert.equal(count(db), 2)
})

test('сторно сторно, несуществующей записи, без причины или автора — отказ', () => {
  const db = fresh()
  const r = addOp(db, buy())
  assert.ok('id' in r)
  const s = storno(db, r.id, 'ошибка', 'владелец')
  assert.ok('id' in s)
  assert.ok('error' in storno(db, s.id, 'отменить сторно', 'владелец'))
  assert.ok('error' in storno(db, 999, 'нет такой', 'владелец'))
  const r2 = addOp(db, buy({ externalId: 'buy:test-2' }))
  assert.ok('id' in r2)
  assert.ok('error' in storno(db, r2.id, '', 'владелец'))
  assert.ok('error' in storno(db, r2.id, 'причина', ''))
  assert.equal(count(db), 3)
})

test('ошибка внутри сторно — откат целиком, ничего не вставлено', () => {
  const db = fresh()
  const r = addOp(db, buy())
  assert.ok('id' in r)
  const res = storno(db, r.id, 'ошибка', 'владелец', { afterInsert: () => { throw new Error('сбой посередине') } })
  assert.ok('error' in res)
  assert.match(res.error, /сбой посередине/)
  assert.equal(count(db), 1)
  // И после отката сторно проходит нормально — замок не завис.
  assert.ok('id' in storno(db, r.id, 'ошибка', 'владелец'))
  assert.equal(count(db), 2)
})

test('список — новые сверху, с отбором по аккаунту', () => {
  const db = fresh()
  addOp(db, buy({ externalId: 'a', happenedAt: 1 }))
  addOp(db, buy({ externalId: 'b', happenedAt: 3, accountId: 'second' }))
  addOp(db, buy({ externalId: 'c', happenedAt: 2 }))
  assert.deepEqual(listOps(db).map(x => x.external_id), ['b', 'c', 'a'])
  assert.deepEqual(listOps(db, { accountId: 'main' }).map(x => x.external_id), ['c', 'a'])
  assert.deepEqual(listOps(db, { limit: 1 }).map(x => x.external_id), ['b'])
})

test('gross — сумма по модулю: отрицательный не принимают ни код, ни база', () => {
  const db = fresh()
  assert.ok('error' in addOp(db, buy({ gross: -30 })))
  assert.throws(() => db.prepare(`
    insert into money_ops (user_id, type, source, external_id, happened_at, recorded_at, currency, gross, net, created_by)
    values ('owner', 'покупка гема', 'market.dota2.net', 'x', 1, 1, 'USD', -1, -1, 'тест')`).run())
  assert.equal(count(db), 0)
})

// ── пустой gross (план 3.3, решение В) ──
//
// Продажа на рынке Steam в чужой валюте: «пришло» известно точно (в валюте
// кошелька), а цены покупателя в этой валюте в источнике нет. NULL здесь —
// «этого числа нет в источнике», а не 0 и не вычисленное.

const sale = (over: Partial<NewOp> = {}): NewOp => ({
  accountId: 'main', type: 'продажа вещи', source: 'рынок Steam', externalId: 'L1_P1',
  happenedAt: 1_790_000_000_000, currency: 'steam:2018', gross: null, net: 75, createdBy: 'импорт истории рынка Steam', ...over,
})

test('продажа без цены покупателя: gross и комиссии пустые, net есть — записывается', () => {
  const db = fresh()
  const r = addOp(db, sale())
  assert.ok('id' in r && r.inserted)
  const row = listOps(db)[0]
  assert.equal(row.gross, null)
  assert.equal(row.fee_steam, null)
  assert.equal(row.fee_game, null)
  assert.equal(row.net, 75)
})

test('пустой gross принимает и база напрямую; отрицательный gross и пустой net — по-прежнему нет', () => {
  const db = fresh()
  db.prepare(`
    insert into money_ops (user_id, type, source, external_id, happened_at, recorded_at, currency, gross, net, created_by)
    values ('owner', 'продажа вещи', 'рынок Steam', 'x', 1, 1, 'steam:2018', null, 5, 'тест')`).run()
  assert.equal(count(db), 1)
  assert.ok('error' in addOp(db, sale({ externalId: 'y', gross: -1 })))
  assert.ok('error' in addOp(db, sale({ externalId: 'z', net: null as any })))
  assert.throws(() => db.prepare(`
    insert into money_ops (user_id, type, source, external_id, happened_at, recorded_at, currency, gross, net, created_by)
    values ('owner', 'продажа вещи', 'рынок Steam', 'w', 1, 1, 'steam:2018', -3, 5, 'тест')`).run())
  assert.equal(count(db), 1)
})

test('сторно записи с пустым gross — gross тоже пустой, net обратный', () => {
  const db = fresh()
  const r = addOp(db, sale())
  assert.ok('id' in r)
  const s = storno(db, r.id, 'ошибочный импорт', 'владелец')
  assert.ok('id' in s)
  const st = listOps(db).find(x => x.type === 'сторно')!
  assert.equal(st.gross, null)
  assert.equal(st.net, -75)
  assert.equal(st.fee_steam, null)
})

// Таблица до решения В — как её создал этап 3.1 (gross NOT NULL). В живой
// базе она уже есть: переделка должна сохранить строки и всю защиту.
const OLD_DDL = `
  create table money_ops (
    id integer primary key autoincrement, user_id text not null, account_id text,
    type text not null, source text not null check (source <> ''), external_id text not null check (external_id <> ''),
    happened_at integer not null, recorded_at integer not null, currency text not null,
    gross integer not null check (gross is null or typeof(gross) = 'integer') check (gross >= 0),
    fee_steam integer, fee_game integer, net integer not null,
    status text, raw_ref text, created_by text not null check (created_by <> ''), reconciled_at integer,
    unique (source, external_id)
  );
  create trigger money_ops_no_delete before delete on money_ops begin select raise(abort, 'money_ops: удаление запрещено — ошибку исправляет сторно'); end;
`

test('переделка старой таблицы: строки сохранены, пустой gross теперь можно, защита на месте, повтор ничего не делает', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(OLD_DDL)
  db.prepare(`insert into money_ops (user_id, account_id, type, source, external_id, happened_at, recorded_at, currency, gross, net, created_by, reconciled_at)
    values ('owner', 'main', 'покупка гема', 'market.dota2.net', 'buy:cid:gt-1', 5, 6, 'RUB', 44, -44, 'импорт', 7)`).run()
  assert.deepEqual(migrateMoney(db), { migrated: true })
  db.exec(MONEY_DDL)
  const rows = listOps(db)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].gross, 44)
  assert.equal(rows[0].reconciled_at, 7)
  assert.ok('id' in addOp(db, sale()))
  assert.throws(() => db.prepare('update money_ops set net = 1 where id = 1').run(), /запись не меняется/)
  assert.throws(() => db.prepare('delete from money_ops where id = 1').run(), /удаление запрещено/)
  const again = addOp(db, buy({ externalId: 'buy:cid:gt-1' }))
  assert.ok('id' in again && again.inserted === false, 'уникальность source + external_id сохранена')
  assert.deepEqual(migrateMoney(db), { migrated: false })
  // id продолжают расти, а не начинаются заново.
  assert.ok(listOps(db).every(r => r.id >= 1) && Math.max(...listOps(db).map(r => r.id)) === 2)
})

test('переделка новой базы без таблицы и уже новой таблицы — ничего не делает', () => {
  const empty = new DatabaseSync(':memory:')
  assert.deepEqual(migrateMoney(empty), { migrated: false })
  const db = fresh()
  assert.deepEqual(migrateMoney(db), { migrated: false })
})
