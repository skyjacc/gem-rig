import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db, pushEvent, recentEvents } from './db.ts'
import { burnedList } from './api.ts'
import { ACCOUNT } from './accounts.ts'

// План 2.5, решения 1 и 3. База — своя, в памяти (testenv.ts).

const items = (match: string) => (db.prepare(`select items from events where match_id = ?`).get(match) as any).items

test('событие: точное число из ответа GC (so.econModified) пишется в items', () => {
  pushEvent({ ts: 1_700_000_000_001, match: 'e1', league: '1', result: 'update', bytes: 907, so: { econModified: 13, modified: 14 } }, 'acc1')
  assert.equal(items('e1'), 13)
  assert.equal(recentEvents(10, 'acc1').find((e: any) => e.match_id === 'e1').items, 13, 'лента отдаёт items')
})

test('событие без so или с мусором — items NULL («не известно»), а не 0; настоящий 0 — 0', () => {
  pushEvent({ ts: 1_700_000_000_002, match: 'e2', league: '1', result: 'update', bytes: 97 }, 'acc1')
  pushEvent({ ts: 1_700_000_000_003, match: 'e3', league: '1', result: 'dup', bytes: 0, so: null }, 'acc1')
  pushEvent({ ts: 1_700_000_000_004, match: 'e4', league: '1', result: 'update', bytes: 97, so: { econModified: -1 } }, 'acc1')
  pushEvent({ ts: 1_700_000_000_005, match: 'e5', league: '1', result: 'update', bytes: 97, so: { econModified: '3' } }, 'acc1')
  pushEvent({ ts: 1_700_000_000_006, match: 'e6', league: '1', result: 'update', bytes: 60, so: { econModified: 0 } }, 'acc1')
  assert.equal(items('e2'), null)
  assert.equal(items('e3'), null)
  assert.equal(items('e4'), null)
  assert.equal(items('e5'), null)
  assert.equal(items('e6'), 0)
})

test('журнал расхода: счёт по состояниям — только своего аккаунта; прежние поля на месте', () => {
  const ins = db.prepare(`insert into burned (account, match_id, league_id, ts, source, state) values (?,?,?,?,?,?)`)
  const me = ACCOUNT()
  ins.run(me, 'b1', '1', 1, 'live', 'confirmed')
  ins.run(me, 'b2', '1', 2, 'live', 'confirmed')
  ins.run(me, 'b3', '1', 3, 'live', 'dup')
  ins.run(me, 'b4', '1', 4, 'ledger', 'ledger')
  ins.run('чужой', 'b1', '1', 1, 'live', 'confirmed')
  ins.run('чужой', 'b9', '1', 9, 'live', 'dup')
  const r = burnedList(10)
  assert.deepEqual(r.byState, { confirmed: 2, dup: 1, ledger: 1, reconstructed: 0 })
  assert.equal(r.total, 4)
  assert.equal(r.rows.length, 4)
})
