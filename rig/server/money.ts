// Журнал денежных операций (§16, этап 3.1).
//
// Одна таблица на все деньги: покупка гема, возврат, продажа вещи, покупка
// ключа, выплата Clover, сторно. Одна внешняя операция — одна запись
// (§14 п. 2): UNIQUE(source, external_id), оба NOT NULL — в SQLite UNIQUE
// пропускает несколько NULL, и без этого дубль прошёл бы мимо.
//
// Финансовые поля записи неизменяемы, запись не удаляется. Единственное
// допустимое изменение — однократная отметка reconciled_at: NULL → время
// (её ставит сверка, когда нашла соответствие нашей покупке). Всё остальное
// запрещает сама база триггерами, а не дисциплина кода. Ошибка исправляется
// сторно — обратной записью с автором и причиной (§14 п. 9).
//
// Суммы — целые в мелких единицах источника (у площадки: RUB — копейки,
// USD/EUR — тысячные) вместе с валютой. Никаких долей: дробь в деньгах —
// это потерянная копейка при сложении.
//
// gross может быть пустым (план 3.3, решение В): у продажи на рынке Steam в
// чужой валюте «пришло» известно точно, а цены покупателя в валюте журнала
// в источнике нет. NULL — «этого числа нет в источнике», не 0 и не вычисленное.
// net пустым не бывает.
//
// Что значат поля конкретного источника (какое поле — сумма, что такое
// status) решает разбор этого источника (markethistory.ts), не этот модуль.

import type { DatabaseSync } from 'node:sqlite'

export const OP_TYPES = ['покупка гема', 'возврат за покупку', 'продажа вещи', 'покупка ключа', 'выплата Clover', 'сторно'] as const
export const OP_SOURCES = ['market.dota2.net', 'рынок Steam', 'вручную'] as const
export type OpType = (typeof OP_TYPES)[number]
export type OpSource = (typeof OP_SOURCES)[number]

// Пользователей пока нет (этап 7): вся работа — одного владельца.
export const OWNER = 'owner'

const list = (xs: readonly string[]) => xs.map(x => `'${x}'`).join(', ')
const whole = (c: string) => `check (${c} is null or typeof(${c}) = 'integer')`

// Схема живёт здесь, а не в db.ts, — тесты создают ту же таблицу одним
// источником правды (как ARRIVALS_DDL).
const TABLE = (name: string) => `
  create table if not exists ${name} (
    id            integer primary key autoincrement,
    user_id       text not null,
    account_id    text,
    type          text not null check (type in (${list(OP_TYPES)})),
    source        text not null check (source <> ''),
    external_id   text not null check (external_id <> ''),
    happened_at   integer not null,
    recorded_at   integer not null,
    currency      text not null,
    gross         integer ${whole('gross')} check (gross is null or gross >= 0),
    fee_steam     integer ${whole('fee_steam')},
    fee_game      integer ${whole('fee_game')},
    net           integer not null ${whole('net')},
    status        text,
    raw_ref       text,
    created_by    text not null check (created_by <> ''),
    reconciled_at integer,
    unique (source, external_id)
  );
`

const TRIGGERS = `
  create trigger if not exists money_ops_no_delete
  before delete on money_ops
  begin
    select raise(abort, 'money_ops: удаление запрещено — ошибку исправляет сторно');
  end;

  create trigger if not exists money_ops_only_reconcile
  before update on money_ops
  when old.reconciled_at is not null
    or new.reconciled_at is null
    or new.id is not old.id
    or new.user_id is not old.user_id
    or new.account_id is not old.account_id
    or new.type is not old.type
    or new.source is not old.source
    or new.external_id is not old.external_id
    or new.happened_at is not old.happened_at
    or new.recorded_at is not old.recorded_at
    or new.currency is not old.currency
    or new.gross is not old.gross
    or new.fee_steam is not old.fee_steam
    or new.fee_game is not old.fee_game
    or new.net is not old.net
    or new.status is not old.status
    or new.raw_ref is not old.raw_ref
    or new.created_by is not old.created_by
  begin
    select raise(abort, 'money_ops: запись не меняется — допустима только однократная отметка reconciled_at');
  end;
`

export const MONEY_DDL = TABLE('money_ops') + TRIGGERS

const COLS = 'id, user_id, account_id, type, source, external_id, happened_at, recorded_at, currency, gross, fee_steam, fee_game, net, status, raw_ref, created_by, reconciled_at'

// Таблица этапа 3.1 создана с gross NOT NULL, а снять NOT NULL в SQLite можно
// только пересозданием таблицы. Одной транзакцией: убрать защиту, переложить
// строки как есть (с теми же id и отметками сверки), вернуть защиту. Ничего
// не делает, если таблицы нет или gross уже допускает пусто.
export function migrateMoney(db: DatabaseSync): { migrated: boolean } {
  const g = (db.prepare(`select "notnull" as nn from pragma_table_info('money_ops') where name = 'gross'`).get() as any)
  if (!g || !g.nn) return { migrated: false }
  db.exec('begin immediate')
  try {
    db.exec('drop trigger if exists money_ops_no_delete; drop trigger if exists money_ops_only_reconcile;')
    db.exec('alter table money_ops rename to money_ops_old')
    db.exec(TABLE('money_ops'))
    db.exec(`insert into money_ops (${COLS}) select ${COLS} from money_ops_old`)
    db.exec('drop table money_ops_old')
    db.exec(TRIGGERS)
    db.exec('commit')
  } catch (e) {
    db.exec('rollback')
    throw e
  }
  return { migrated: true }
}

export type NewOp = {
  userId?: string
  accountId: string | null
  type: OpType
  source: OpSource
  externalId: string
  happenedAt: number
  currency: string
  gross: number | null
  feeSteam?: number | null
  feeGame?: number | null
  net: number
  status?: string | null
  rawRef?: string | null
  createdBy: string
}

export type Op = {
  id: number
  user_id: string
  account_id: string | null
  type: OpType
  source: OpSource
  external_id: string
  happened_at: number
  recorded_at: number
  currency: string
  gross: number | null
  fee_steam: number | null
  fee_game: number | null
  net: number
  status: string | null
  raw_ref: string | null
  created_by: string
  reconciled_at: number | null
}

const isWhole = (v: unknown) => v == null || Number.isInteger(v)

function check(op: NewOp): string | null {
  if (!OP_TYPES.includes(op.type)) return 'неизвестный тип операции: ' + op.type
  if (!OP_SOURCES.includes(op.source)) return 'неизвестный источник: ' + op.source
  if (!op.externalId) return 'нет внешнего номера операции'
  if (!op.createdBy) return 'не указано, кто записал'
  if (!op.currency) return 'нет валюты'
  if (!Number.isInteger(op.happenedAt)) return 'время операции — не целое'
  for (const [k, v] of [['gross', op.gross], ['net', op.net], ['fee_steam', op.feeSteam], ['fee_game', op.feeGame]] as const) {
    if (!isWhole(v)) return k + ' — не целое: суммы хранятся в мелких единицах'
  }
  if (op.net == null) return 'нет суммы (net)'
  if (op.gross != null && op.gross < 0) return 'gross — сумма по модулю, не бывает меньше нуля (§16)'
  return null
}

const insertSql = `
  insert or ignore into money_ops
    (user_id, account_id, type, source, external_id, happened_at, recorded_at,
     currency, gross, fee_steam, fee_game, net, status, raw_ref, created_by)
  values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`

function insert(db: DatabaseSync, op: NewOp, now: number) {
  return db.prepare(insertSql).run(
    op.userId ?? OWNER, op.accountId, op.type, op.source, op.externalId, op.happenedAt, now,
    op.currency, op.gross ?? null, op.feeSteam ?? null, op.feeGame ?? null, op.net,
    op.status ?? null, op.rawRef ?? null, op.createdBy,
  )
}

const idOf = (db: DatabaseSync, source: string, externalId: string) =>
  (db.prepare('select id from money_ops where source = ? and external_id = ?').get(source, externalId) as any)?.id as number | undefined

// Вставка. Дубль той же внешней операции не вставляется и не перезаписывает
// первую запись — возвращается её id с inserted: false.
export function addOp(db: DatabaseSync, op: NewOp, now = Date.now()):
  { id: number; inserted: boolean } | { error: string } {
  const bad = check(op)
  if (bad) return { error: bad }
  const r = insert(db, op, now)
  if (Number(r.changes) > 0) return { id: Number(r.lastInsertRowid), inserted: true }
  const id = idOf(db, op.source, op.externalId)
  return id != null ? { id, inserted: false } : { error: 'запись не вставлена' }
}

// Отметка сверки: один раз, NULL → время. Повторная — отказ.
export function markReconciled(db: DatabaseSync, id: number, at = Date.now()): { ok: true } | { error: string } {
  try {
    const r = db.prepare('update money_ops set reconciled_at = ? where id = ?').run(at, id)
    return Number(r.changes) > 0 ? { ok: true } : { error: 'нет такой операции' }
  } catch (e: any) {
    return { error: String(e?.message ?? e) }
  }
}

// Сторно: обратная запись в одной транзакции. Ошибка внутри — откат целиком,
// ничего не вставлено. afterInsert — только для теста отката.
export function storno(
  db: DatabaseSync, id: number, reason: string, by: string,
  opts: { now?: number; afterInsert?: () => void } = {},
): { id: number } | { error: string } {
  if (!reason?.trim()) return { error: 'у сторно должна быть причина' }
  if (!by?.trim()) return { error: 'не указано, кто делает сторно' }
  const orig = db.prepare('select * from money_ops where id = ?').get(id) as Op | undefined
  if (!orig) return { error: 'нет такой операции' }
  if (orig.type === 'сторно') return { error: 'сторно не сторнируется — запишите новую операцию' }

  const now = opts.now ?? Date.now()
  db.exec('begin immediate')
  try {
    const r = insert(db, {
      userId: orig.user_id,
      accountId: orig.account_id,
      type: 'сторно',
      source: 'вручную',
      externalId: 'storno:' + orig.id,
      happenedAt: now,
      currency: orig.currency,
      gross: orig.gross,
      feeSteam: orig.fee_steam == null ? null : -orig.fee_steam,
      feeGame: orig.fee_game == null ? null : -orig.fee_game,
      net: -orig.net,
      status: null,
      rawRef: JSON.stringify({ reverses: orig.id, reason: reason.trim() }),
      createdBy: by.trim(),
    }, now)
    if (Number(r.changes) === 0) throw new Error('операция уже сторнирована')
    opts.afterInsert?.()
    db.exec('commit')
    return { id: Number(r.lastInsertRowid) }
  } catch (e: any) {
    db.exec('rollback')
    return { error: String(e?.message ?? e) }
  }
}

export function listOps(db: DatabaseSync, q: { accountId?: string; limit?: number } = {}): Op[] {
  const limit = Math.max(1, Math.min(5_000, Math.trunc(q.limit ?? 500)))
  return (q.accountId
    ? db.prepare('select * from money_ops where account_id = ? order by happened_at desc, id desc limit ?').all(q.accountId, limit)
    : db.prepare('select * from money_ops order by happened_at desc, id desc limit ?').all(limit)) as Op[]
}
