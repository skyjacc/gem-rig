// Выплаты Clover.tf руками (план 3.2, §7 С7, §16).
//
// Выплата — запись общего журнала операций (money_ops): тип «выплата Clover»,
// источник — площадка «Clover.tf». Отдельной таблицы нет (решение 1):
// неизменяемость, запрет удаления и сторно уже даёт журнал.
//
// Продажа и выплата — разные события (решение 2). Здесь пишется только
// выплата: деньги ушли с баланса Clover владельцу — «дошло до рук».
//
// Номер транзакции и версия записи раздельно (решение 3): номер — в
// raw_ref.tx, версия — в raw_ref.version, внутренний external_id —
// «v<версия>:<номер>». Самостоятельный номер «ABC#2» и исправление номера
// «ABC» не смешиваются: v1:ABC#2 и v2:ABC.
//
// Обычный ввод создаёт только версию 1 (решение 5). Новая версия — только
// явным исправлением сторнированной записи (решение 6); им же выплата
// переносится на другой аккаунт. Действующая запись номера всегда одна —
// на всех аккаунтах вместе.
//
// Доллары выплаты — центы суммы, которую указал владелец (решение 4). Если
// пришла монета (в том числе USDT), это его оценка: usdBy = 'владелец'.
// Из количества монеты доллары не выводятся никогда.

import type { DatabaseSync } from 'node:sqlite'
import { addOp, storno, type Op } from './money.ts'

export const VENUE = 'Clover.tf'
const TYPE = 'выплата Clover'
const BY = 'владелец'
const EARLIEST = Date.UTC(2020, 0, 1)
const SKEW = 60_000            // часы панели и сервера могут расходиться на минуту
export const CAP = 5_000        // защитный предел списка выплат (решение 11)

export type Payout = {
  accountId: string
  tx: string
  cents: number
  happenedAt: number
  asset: string
  assetAmount?: string
  network?: string
  usdBy: 'получено' | 'владелец'
  keys?: number
  note?: string
}

type Raw = {
  entry: 'вручную'
  tx: string
  version: number
  corrects: number | null
  asset: string
  assetAmount?: string
  network?: string
  usdBy: Payout['usdBy']
  keys?: number
  note?: string
}

type Fail = { error: string }
type Done = { id: number; inserted: boolean }

// ── номер транзакции ──

const HASH = /^(0x[0-9a-f]+|[0-9a-f]{64})$/i

export function normalizeTx(raw: unknown): { tx: string } | Fail {
  const t = String(raw ?? '').trim()
  if (!t) return { error: 'нужен номер транзакции — без него одну выплату можно внести дважды' }
  if (/\s/.test(t)) return { error: 'в номере транзакции не должно быть пробелов' }
  if (t.length < 4 || t.length > 200) return { error: 'длина номера транзакции — от 4 до 200 знаков' }
  // Хэш перевода регистра не различает: один перевод — одна запись. Номер
  // с сайта может различать — его не трогаем.
  return { tx: HASH.test(t) ? t.toLowerCase() : t }
}

export const externalId = (tx: string, version: number) => 'v' + version + ':' + tx

// ── разбор формы ──

// «12,50» → 1250. Только целые центы: доли цента в деньгах не храним.
function toCents(v: unknown): number | null {
  const s = String(v ?? '').trim().replace(',', '.')
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s)
  if (!m) return null
  const c = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(c) && c > 0 ? c : null
}

const usd = (cents: number) => '$' + (cents / 100).toFixed(2)

export function parsePayout(body: unknown, now: number): Payout | Fail {
  const b = (body ?? {}) as Record<string, unknown>
  const accountId = String(b.accountId ?? '').trim()
  if (!accountId) return { error: 'не указан аккаунт' }
  const t = normalizeTx(b.tx)
  if ('error' in t) return t
  const cents = toCents(b.usd)
  if (cents == null) return { error: 'сумма в долларах — больше нуля, не больше двух знаков после запятой' }
  const asset = String(b.asset ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{2,10}$/.test(asset)) return { error: 'не выбрано, чем пришла выплата' }

  let happenedAt = now
  if (b.happenedAt != null && b.happenedAt !== '') {
    happenedAt = Math.trunc(Number(b.happenedAt))
    if (!Number.isFinite(happenedAt)) return { error: 'дата выплаты не разобрана' }
    if (happenedAt > now + SKEW) return { error: 'дата выплаты в будущем' }
    if (happenedAt < EARLIEST) return { error: 'дата выплаты раньше 2020 года — проверьте год' }
  }

  const p: Payout = { accountId, tx: t.tx, cents, happenedAt, asset, usdBy: asset === 'USD' ? 'получено' : 'владелец' }

  const amount = String(b.assetAmount ?? '').trim()
  if (amount) {
    const a = amount.replace(',', '.')
    if (!/^\d+(\.\d+)?$/.test(a)) return { error: 'количество монеты — число' }
    p.assetAmount = a
  }
  const network = String(b.network ?? '').trim()
  if (network) {
    if (network.length > 20) return { error: 'сеть — не длиннее 20 знаков' }
    p.network = network
  }
  if (b.keys != null && b.keys !== '') {
    const k = Number(b.keys)
    if (!Number.isInteger(k) || k < 0) return { error: 'ключей — целое число, не меньше нуля' }
    p.keys = k
  }
  const note = String(b.note ?? '').trim()
  if (note) {
    if (note.length > 200) return { error: 'заметка — не длиннее 200 знаков' }
    p.note = note
  }
  return p
}

// ── чтение журнала ──

const rawOf = (o: Op): Raw => JSON.parse(o.raw_ref ?? '{}')

const byTx = (db: DatabaseSync, tx: string) =>
  db.prepare(`select * from money_ops where source = ? and type = ? and json_extract(raw_ref, '$.tx') = ? order by id`)
    .all(VENUE, TYPE, tx) as Op[]

const correctionOf = (db: DatabaseSync, id: number) =>
  db.prepare(`select * from money_ops where source = ? and type = ? and json_extract(raw_ref, '$.corrects') = ?`)
    .get(VENUE, TYPE, id) as Op | undefined

// Сторно пишет storno() журнала: source «вручную», external_id «storno:<id>».
const isReversed = (db: DatabaseSync, id: number) =>
  !!db.prepare(`select 1 from money_ops where type = 'сторно' and external_id = ?`).get('storno:' + id)

function write(db: DatabaseSync, p: Payout, version: number, corrects: number | null, now: number): Done | Fail {
  const raw: Raw = { entry: 'вручную', tx: p.tx, version, corrects, asset: p.asset, usdBy: p.usdBy }
  if (p.assetAmount) raw.assetAmount = p.assetAmount
  if (p.network) raw.network = p.network
  if (p.keys != null) raw.keys = p.keys
  if (p.note) raw.note = p.note
  return addOp(db, {
    accountId: p.accountId,
    type: TYPE,
    source: VENUE,
    externalId: externalId(p.tx, version),
    happenedAt: p.happenedAt,
    currency: 'USD',
    gross: null,
    net: p.cents,
    rawRef: JSON.stringify(raw),
    createdBy: BY,
  }, now)
}

// Проверка и вставка — одной транзакцией: два одновременных запроса не
// создадут две действующие записи одного номера.
function atomically<T>(db: DatabaseSync, run: () => T | Fail): T | Fail {
  try {
    db.exec('begin immediate')
  } catch (e: any) {
    return { error: 'журнал занят другой записью — повторите: ' + String(e?.message ?? e) }
  }
  try {
    const r = run()
    db.exec('error' in (r as object) ? 'rollback' : 'commit')
    return r
  } catch (e: any) {
    db.exec('rollback')
    return { error: String(e?.message ?? e) }
  }
}

type Opts = { now?: number; afterCheck?: () => void; labelOf?: (accountId: string) => string }

// ── запись (решения 3–5, 8) ──

export function addPayout(db: DatabaseSync, p: Payout, opts: Opts = {}): Done | Fail {
  const now = opts.now ?? Date.now()
  const label = opts.labelOf ?? (id => id)
  return atomically(db, () => {
    const rows = byTx(db, p.tx)
    const live = rows.filter(o => !isReversed(db, o.id))
    if (live.length) {
      const a = live[0]
      if (a.account_id !== p.accountId) return { error: 'номер уже внесён на аккаунт «' + label(a.account_id ?? '') + '»' }
      if (a.net !== p.cents) return { error: 'номер уже внесён с другой суммой: ' + usd(a.net) }
      return { id: a.id, inserted: false }
    }
    if (rows.length) {
      return { error: 'выплата с этим номером сторнирована; исправление — кнопкой «внести исправление» у сторнированной записи' }
    }
    opts.afterCheck?.()
    return write(db, p, 1, null, now)
  })
}

// ── исправление (решение 6) ──

export function correctPayout(db: DatabaseSync, corrects: number, p: Payout, opts: Opts = {}): Done | Fail {
  const now = opts.now ?? Date.now()
  return atomically(db, () => {
    const orig = db.prepare('select * from money_ops where id = ?').get(corrects) as Op | undefined
    if (!orig || orig.type !== TYPE || orig.source !== VENUE) return { error: 'нет такой выплаты Clover' }
    const o = rawOf(orig)
    if (o.tx !== p.tx) return { error: 'другой номер — это другая выплата: внесите её обычным вводом' }

    // Сначала — нет ли уже исправления этой записи: повтор запроса.
    const done = correctionOf(db, corrects)
    if (done) {
      if (isReversed(db, done.id)) return { error: 'исправление этой записи сторнировано; новое исправление — от него' }
      if (done.account_id === p.accountId && done.net === p.cents) return { id: done.id, inserted: false }
      return { error: 'исправление уже внесено: ' + usd(done.net) }
    }

    // Только потом — можно ли создать новое.
    if (!isReversed(db, corrects)) return { error: 'исправить можно только сторнированную выплату — сначала сторно' }
    const rows = byTx(db, p.tx)
    const last = Math.max(...rows.map(r => rawOf(r).version ?? 1))
    if ((o.version ?? 1) !== last) return { error: 'исправляется последняя версия номера' }
    if (rows.some(r => !isReversed(db, r.id))) return { error: 'у номера уже есть действующая запись' }
    opts.afterCheck?.()
    return write(db, p, last + 1, corrects, now)
  })
}

// ── сторно (решение 7) ──

export function stornoPayout(db: DatabaseSync, id: number, reason: string, now = Date.now()): { id: number } | Fail {
  const o = db.prepare('select * from money_ops where id = ?').get(id) as Op | undefined
  if (!o) return { error: 'нет такой выплаты' }
  if (o.type !== TYPE || o.source !== VENUE) return { error: 'здесь сторнируются только выплаты Clover' }
  const r = storno(db, id, reason, BY, { now })
  if ('error' in r && /UNIQUE/i.test(r.error)) return { error: 'операция уже сторнирована' }
  return r
}

// ── полный список (решение 11) ──

// Все выплаты Clover аккаунта и сторно, которые на них ссылаются, — без
// предела общего журнала. Свой защитный предел — CAP выплат.
export function listPayouts(db: DatabaseSync, accountId: string, cap = CAP): { ops: Op[]; complete: boolean } {
  const pays = db.prepare(
    `select * from money_ops where account_id = ? and source = ? and type = ? order by happened_at desc, id desc limit ?`,
  ).all(accountId, VENUE, TYPE, cap + 1) as Op[]
  const complete = pays.length <= cap
  const shown = pays.slice(0, cap)
  const ids = new Set(shown.map(o => 'storno:' + o.id))
  const stornos = (db.prepare(
    `select s.* from money_ops s where s.type = 'сторно' and s.external_id in
       (select 'storno:' || id from money_ops where account_id = ? and source = ? and type = ?)`,
  ).all(accountId, VENUE, TYPE) as Op[]).filter(s => ids.has(s.external_id))
  return { ops: [...shown, ...stornos], complete }
}

// ── маршруты ──
//
// Аккаунт приходит в теле явно (решение 8): форма закрепляет его при
// открытии. Сервер активный аккаунт не подставляет — только проверяет, что
// такой есть.

type Find = (id: string) => { id: string; label: string } | undefined

export function handlePayout(db: DatabaseSync, body: unknown, find: Find, now = Date.now()): Done | Fail {
  const p = parsePayout(body, now)
  if ('error' in p) return p
  if (!find(p.accountId)) return { error: 'нет такого аккаунта' }
  return addPayout(db, p, { now, labelOf: id => find(id)?.label ?? id })
}

export function handleCorrect(db: DatabaseSync, body: unknown, find: Find, now = Date.now()): Done | Fail {
  const corrects = Number((body as any)?.corrects)
  if (!Number.isInteger(corrects) || corrects <= 0) return { error: 'не указано, какую запись исправить' }
  const p = parsePayout(body, now)
  if ('error' in p) return p
  if (!find(p.accountId)) return { error: 'нет такого аккаунта' }
  return correctPayout(db, corrects, p, { now })
}

export function handleStorno(db: DatabaseSync, body: unknown, now = Date.now()): { id: number } | Fail {
  const id = Number((body as any)?.id)
  if (!Number.isInteger(id) || id <= 0) return { error: 'не указано, какую запись сторнировать' }
  return stornoPayout(db, id, String((body as any)?.reason ?? ''), now)
}
