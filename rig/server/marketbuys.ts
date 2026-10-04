// Журнал закупки, отмены и сверка (план 3.1, задача 4).
//
// Три слоя — три факта:
//   money_ops             только доказанное движение денег (money.ts);
//   market_buys           что купил Gemtrack — по колбэку закупки;
//   market_cancellations  что площадка сказала об отмене.
// Ни market_buys, ни market_cancellations не деньги и на money_ops не
// ссылаются. Все три — только вставка: правки и удаления запрещает база.
//
// JOURNAL_START — момент включения журнала закупки в ЭТОЙ базе, записан
// один раз при первом создании таблиц. Покупка gt-… раньше него — «до
// журнала»; позже и без строки в журнале — «отсутствует в журнале»
// (так видна, например, упавшая запись onBought).

import type { DatabaseSync } from 'node:sqlite'
import { buyInfo } from './market.ts'
import { markReconciled } from './money.ts'
import { syncHistory, type Cancelled, type SyncResult } from './markethistory.ts'

const DAY_MS = 86_400_000

const frozen = (table: string) => `
  create trigger if not exists ${table}_no_update before update on ${table}
  begin select raise(abort, '${table}: запись не меняется'); end;
  create trigger if not exists ${table}_no_delete before delete on ${table}
  begin select raise(abort, '${table}: удаление запрещено'); end;
`

export const MARKET_DDL = `
  create table if not exists market_meta (
    key   text primary key,
    value text not null
  );
  ${frozen('market_meta')}

  create table if not exists market_buys (
    id         integer primary key autoincrement,
    account_id text not null,
    custom_id  text not null check (custom_id <> ''),
    hash_name  text not null,
    ask_price  integer not null check (typeof(ask_price) = 'integer' and ask_price > 0),
    currency   text not null,
    buy_id     text,
    item_id    text,
    bought_at  integer not null,
    how        text not null check (how in ('buy', 'custom_id')),
    unique (account_id, custom_id)
  );
  ${frozen('market_buys')}

  create table if not exists market_cancellations (
    id                  integer primary key autoincrement,
    account_id          text not null,
    cancel_key          text not null check (cancel_key <> ''),
    custom_id           text,
    item_id             text not null check (item_id <> ''),
    happened_at         integer not null,
    causer              text,
    cancellation_reason text,
    checked_at          integer,
    raw_ref             text,
    unique (account_id, cancel_key)
  );
  ${frozen('market_cancellations')}
`

// Таблицы и начало журнала. Повторный вызов ничего не меняет.
export function ensureJournal(db: DatabaseSync, now = Date.now()): number {
  db.exec(MARKET_DDL)
  db.prepare(`insert or ignore into market_meta (key, value) values ('journal_start', ?)`).run(String(now))
  return journalStart(db)!
}

export function journalStart(db: DatabaseSync): number | null {
  const r = db.prepare(`select value from market_meta where key = 'journal_start'`).get() as any
  return r ? Number(r.value) : null
}

// ── журнал закупки ──

export type Bought = {
  accountId: string
  customId: string
  hashName: string
  askPrice: number          // цена, ушедшая в buy потолком, в мелких единицах — не списанная
  currency: string
  buyId: string | null      // id из ответа buy; связь с item_id истории не проверена
  itemId: string | null     // из get-buy-info-by-custom-id, если покупку подтверждали
  how: 'buy' | 'custom_id'
  at: number
}

export function recordBuy(db: DatabaseSync, b: Bought): { inserted: boolean } | { error: string } {
  if (!b.customId) return { error: 'нет custom_id' }
  if (!Number.isInteger(b.askPrice) || b.askPrice <= 0) return { error: 'цена — не целое в мелких единицах' }
  try {
    const r = db.prepare(`
      insert or ignore into market_buys (account_id, custom_id, hash_name, ask_price, currency, buy_id, item_id, bought_at, how)
      values (?,?,?,?,?,?,?,?,?)`).run(b.accountId, b.customId, b.hashName, b.askPrice, b.currency, b.buyId, b.itemId, b.at, b.how)
    return { inserted: Number(r.changes) > 0 }
  } catch (e: any) {
    return { error: String(e?.message ?? e) }
  }
}

// ── отмены ──

// Не больше стольких новых проверок по custom_id за запуск — остальные со
// следующим: защита от всплеска запросов к площадке.
export const CHECK_LIMIT = 20

export const cancelKey = (c: Pick<Cancelled, 'customId' | 'itemId' | 'time'>) =>
  c.customId ? 'cid:' + c.customId : 'item:' + c.itemId + ':' + c.time

type Ask = (key: string, customId: string) => Promise<any>

export type CheckResult = {
  stored: number
  known: number
  unchecked: { cancelKey: string; error: string }[]
}

// Отмены из истории → market_cancellations. Причина — только из ответа
// проверки, не из stage 5. В деньги ничего не пишется ни в каком случае.
export async function reconcileCancellations(db: DatabaseSync, o: {
  accountId: string
  key: string
  cancelled: Cancelled[]
  ask?: Ask
  limit?: number
  now?: number
}): Promise<CheckResult> {
  const ask = o.ask ?? buyInfo
  const limit = o.limit ?? CHECK_LIMIT
  const res: CheckResult = { stored: 0, known: 0, unchecked: [] }

  // Сначала без повторов: одна отмена — не больше одного запроса за запуск.
  const uniq = new Map<string, Cancelled>()
  for (const c of o.cancelled) if (!uniq.has(cancelKey(c))) uniq.set(cancelKey(c), c)

  const has = db.prepare('select 1 from market_cancellations where account_id = ? and cancel_key = ?')
  const ins = db.prepare(`
    insert or ignore into market_cancellations
      (account_id, cancel_key, custom_id, item_id, happened_at, causer, cancellation_reason, checked_at, raw_ref)
    values (?,?,?,?,?,?,?,?,?)`)

  let asked = 0
  for (const [k, c] of uniq) {
    // Отмена без item_id — неполная строка истории: записывать нечего и не
    // по чему узнать её потом. Вживую item_id у buy был всегда.
    if (!c.itemId) { res.unchecked.push({ cancelKey: k, error: 'нет item_id в строке истории — отмена не записана' }); continue }
    if (has.get(o.accountId, k)) { res.known++; continue }
    if (!c.customId) {
      ins.run(o.accountId, k, null, c.itemId, c.time, null, null, null, c.raw)
      res.stored++
      continue
    }
    if (asked >= limit) { res.unchecked.push({ cancelKey: k, error: 'лимит ' + limit + ' проверок за запуск — спросим в следующий раз' }); continue }
    asked++
    const r = await ask(o.key, c.customId)
    if (!r?.success || !r.data) {
      res.unchecked.push({ cancelKey: k, error: String(r?.error || 'площадка не ответила') })
      continue
    }
    const raw = JSON.stringify(r)
    if (raw.includes(o.key)) { res.unchecked.push({ cancelKey: k, error: 'в ответе оказался ключ — не сохраняю' }); continue }
    const d = r.data
    ins.run(o.accountId, k, c.customId, c.itemId, c.time,
      d.causer != null && String(d.causer) ? String(d.causer) : null,
      d.cancellation_reason != null && String(d.cancellation_reason) ? String(d.cancellation_reason) : null,
      o.now ?? Date.now(), raw)
    res.stored++
  }
  return res
}

// ── сверка ──

const MONEY_WORD = 'возврат денег по API не подтверждён'
const BUYER_WARNING = 'со слов владельца: частые отмены покупателем дают статус нежелательного покупателя и временную блокировку'

export type Report = {
  missingInHistory: { customId: string; at: number }[]
  beforeJournal: number
  notInJournal: { customId: string; at: number }[]
  notGemtrack: number
  reconciled: number
  cheaper: number
  mismatch: { customId: string; why: string }[]
  cancellations: { cancelKey: string; customId: string | null; at: number; reason: string; money: string }[]
  buyerCancelled30d: number
  buyerWarning: string
}

const reasonOf = (c: any) => {
  if (c.checked_at == null) return 'нет custom_id — площадку не спросить'
  if (c.cancellation_reason === 'buyer_cancelled' || c.causer === 'buyer') return 'отменил покупатель'
  if (c.cancellation_reason === 'seller_cancelled' || c.causer === 'seller') return 'отменил продавец'
  return 'причина неизвестна'
}

// Отчёт. Меняет только reconciled_at (однократно) — больше ничего.
export function reconcile(db: DatabaseSync, accountId: string, now = Date.now()): Report {
  const start = journalStart(db) ?? now
  const buys = db.prepare('select * from market_buys where account_id = ?').all(accountId) as any[]
  const ops = db.prepare(`select * from money_ops where account_id = ? and source = 'market.dota2.net' and type = 'покупка гема'`).all(accountId) as any[]
  const cancels = db.prepare('select * from market_cancellations where account_id = ? order by happened_at desc').all(accountId) as any[]

  const opByCid = new Map<string, any>()
  for (const o of ops) if (String(o.external_id).startsWith('buy:cid:')) opByCid.set(String(o.external_id).slice('buy:cid:'.length), o)
  const buyByCid = new Map(buys.map(b => [String(b.custom_id), b]))
  const cancelled = new Set(cancels.map(c => String(c.custom_id ?? '')).filter(Boolean))

  const r: Report = {
    missingInHistory: [], beforeJournal: 0, notInJournal: [], notGemtrack: 0,
    reconciled: 0, cheaper: 0, mismatch: [], cancellations: [], buyerCancelled30d: 0, buyerWarning: BUYER_WARNING,
  }

  // (а) наша покупка без операции истории и без отмены.
  for (const b of buys) {
    if (!opByCid.has(String(b.custom_id)) && !cancelled.has(String(b.custom_id))) r.missingInHistory.push({ customId: b.custom_id, at: b.bought_at })
  }

  for (const o of ops) {
    const ext = String(o.external_id)
    const cid = ext.startsWith('buy:cid:') ? ext.slice('buy:cid:'.length) : null
    const b = cid ? buyByCid.get(cid) : undefined
    if (!b) {
      // (б) операция истории без нашей покупки.
      if (cid && cid.startsWith('gt-')) {
        if (o.happened_at < start) r.beforeJournal++
        else r.notInJournal.push({ customId: cid, at: o.happened_at })
      } else r.notGemtrack++
      continue
    }
    // Сумма: фактически списано не больше потолка запроса — сверено.
    if (o.currency !== b.currency) { r.mismatch.push({ customId: cid!, why: 'валюта истории ' + o.currency + ', в запросе ' + b.currency }); continue }
    if (o.gross > b.ask_price) { r.mismatch.push({ customId: cid!, why: 'списано больше потолка запроса' }); continue }
    if (o.reconciled_at != null) continue
    if ('ok' in markReconciled(db, o.id, now)) {
      r.reconciled++
      if (o.gross < b.ask_price) r.cheaper++
    }
  }

  // (в) отмены и (г) риск отмен покупателем за 30 дней.
  for (const c of cancels) {
    const reason = reasonOf(c)
    r.cancellations.push({ cancelKey: c.cancel_key, customId: c.custom_id, at: c.happened_at, reason, money: MONEY_WORD })
    if (reason === 'отменил покупатель' && c.happened_at >= now - 30 * DAY_MS) r.buyerCancelled30d++
  }
  return r
}

// ── импорт для маршрута ──

export const MAX_DAYS = 180

export async function moneySync(db: DatabaseSync, o: {
  accountId: string
  key: string
  days?: number
  now?: number
  read?: Parameters<typeof syncHistory>[1]['read']
  ask?: Ask
}): Promise<{ days: number; history: SyncResult; cancellations: CheckResult }> {
  const days = Math.max(1, Math.min(MAX_DAYS, Math.trunc(Number(o.days) || 30)))
  const now = o.now ?? Date.now()
  const to = Math.trunc(now / 1000)
  const history = await syncHistory(db, { accountId: o.accountId, key: o.key, from: to - days * 86_400, to, read: o.read })
  const cancellations = await reconcileCancellations(db, { accountId: o.accountId, key: o.key, cancelled: history.cancelled, ask: o.ask, now })
  return { days, history, cancellations }
}
