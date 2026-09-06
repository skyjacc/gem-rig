import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { fresh, ingestOne } from './ledger.ts'
import { queueFor } from './queue.ts'

// Сквозная проверка расхода: отчёт отправщика → журнал → следующая очередь.
//
// Каждое звено проверялось по отдельности, а цепь — ни разу. Между тем
// именно она решает, потратится матч дважды или нет: если отчёт разобран
// неверно, очередь на следующей пересборке выдаст уже сожжённое, и каждая
// такая отправка — необратимо потерянный матч.

const A = '76561190000000001'
const B = '76561190000000002'

function base() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    create table burned (
      account text not null, match_id text not null, league_id text,
      ts integer, source text, state text default 'confirmed',
      primary key (account, match_id));
    create table vmatch (match_id text primary key, league_id text, radiant integer, dire integer);
    create table vplayer (match_id text, account_id integer);
  `)
  const ins = db.prepare(`insert into vmatch (match_id, league_id, radiant, dire) values (?,?,?,?)`)
  for (let i = 1; i <= 6; i++) ins.run('m' + i, '100', 7, 8)
  return db
}

const EMPIRE = [{ key: 'Empire', kind: 'team' as const, id: 7 }]

const report = (rows: { ts: number; match: string; result: string }[]) =>
  rows.map(r => ({ ...r, league: '100' }))

function ingest(db: DatabaseSync, recent: any[], seen: number, account: string) {
  const f = fresh(recent, seen)
  for (const e of f.rows) ingestOne(db, e as any, account)
  return f.watermark
}

test('подтверждённое уходит из очереди навсегда', () => {
  const db = base()
  assert.equal(queueFor(db, EMPIRE, A).length, 6)

  ingest(db, report([
    { ts: 10, match: 'm1', result: 'update' },
    { ts: 11, match: 'm2', result: 'update' },
  ]), 0, A)

  const q = queueFor(db, EMPIRE, A)
  assert.equal(q.length, 4)
  assert.equal(q.some(r => r.match === 'm1' || r.match === 'm2'), false)
})

test('спорное остаётся в очереди, но уходит в хвост', () => {
  const db = base()
  ingest(db, report([{ ts: 10, match: 'm1', result: 'dup' }]), 0, A)

  const q = queueFor(db, EMPIRE, A)
  assert.equal(q.length, 6, 'dup — не «сожжён», матч мог остаться целым')
  assert.equal(q[q.length - 1].match, 'm1', 'но тратить на него прогон первым делом нельзя')
  assert.equal(q[q.length - 1].tried, true)
})

test('молчание не трогает очередь вовсе', () => {
  const db = base()
  ingest(db, report([{ ts: 10, match: 'm1', result: 'silent' }]), 0, A)

  const q = queueFor(db, EMPIRE, A)
  assert.equal(q.length, 6)
  assert.equal(q[0].tried, false, 'мы не знаем ничего — значит и понижать не за что')
  assert.equal((db.prepare(`select count(*) c from burned`).get() as any).c, 0)
})

test('второй аккаунт жжёт тот же пул с нуля', () => {
  const db = base()
  ingest(db, report([
    { ts: 10, match: 'm1', result: 'update' },
    { ts: 11, match: 'm2', result: 'update' },
    { ts: 12, match: 'm3', result: 'update' },
  ]), 0, A)

  assert.equal(queueFor(db, EMPIRE, A).length, 3)
  assert.equal(queueFor(db, EMPIRE, B).length, 6, 'в этом весь смысл второго аккаунта')
})

test('повторный разбор того же отчёта ничего не портит', () => {
  const db = base()
  const rows = report([
    { ts: 10, match: 'm1', result: 'update' },
    { ts: 11, match: 'm2', result: 'dup' },
  ])
  const mark = ingest(db, rows, 0, A)
  ingest(db, rows, mark, A)

  assert.equal((db.prepare(`select count(*) c from burned`).get() as any).c, 2)
  assert.equal(queueFor(db, EMPIRE, A).length, 5)
})

test('метка идёт по максимуму, а не по первой строке отчёта', () => {
  // Отправщик кладёт свежие первыми, но порядок — его дело, и полагаться
  // на него нельзя: одна переставленная запись отрезала бы весь хвост.
  const out = fresh([
    { ts: 30, match: 'm3', result: 'update' },
    { ts: 10, match: 'm1', result: 'update' },
    { ts: 20, match: 'm2', result: 'update' },
  ], 0)
  assert.equal(out.watermark, 30)
  assert.deepEqual(out.rows.map(r => r.match), ['m1', 'm2', 'm3'], 'разбираем от старых к новым')
})

test('уже разобранное второй раз не берём', () => {
  const out = fresh([
    { ts: 30, match: 'm3', result: 'update' },
    { ts: 20, match: 'm2', result: 'update' },
    { ts: 10, match: 'm1', result: 'update' },
  ], 20)
  assert.deepEqual(out.rows.map(r => r.match), ['m3'])
  assert.equal(out.watermark, 30)
})

test('мусор в отчёте не роняет разбор', () => {
  assert.deepEqual(fresh(null as any, 0), { rows: [], watermark: 0 })
  assert.deepEqual(fresh([{ ts: 0 } as any, null as any], 5).rows, [])
  assert.equal(fresh([{ ts: 7, result: 'update' }], 5).watermark, 7)
})

test('запись в журнал без аккаунта не проходит', () => {
  const db = base()
  assert.throws(() => ingestOne(db, { match: 'm1', result: 'update', ts: 1 }, ''))
})
