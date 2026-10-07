import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  ACCESS_DDL, activePermit, createInvite, entryOpen, grantPermit, inviteByToken, listInvites, permitAllows,
  revokeInvite, revokePermit, setEntryOpen, useInvite,
} from './access.ts'

// Приглашения, вход для приглашённых, допуск для приёмки (план 7.3, §18,
// решение 16). steamid выдуманные.

const T0 = Date.UTC(2026, 9, 7, 12)
const DAY = 86_400_000
const SID = '76561190000000077'

function fresh() {
  const db = new DatabaseSync(':memory:')
  db.exec(ACCESS_DDL)
  return db
}
const refused = (r: object, re: RegExp) => {
  assert.ok('error' in r, 'ожидался отказ, а пришло: ' + JSON.stringify(r))
  assert.match((r as any).error, re)
}

// ── приглашения ──

test('приглашение: токен не меньше 128 бит, в базе только хэш', () => {
  const db = fresh()
  const r = createInvite(db, { name: 'Дима', days: 7 }, 'owner', T0) as { id: number; token: string; expiresAt: number }
  assert.ok(Buffer.from(r.token, 'base64url').length >= 16, 'не меньше 128 бит')
  const row = db.prepare('select * from invites').get() as any
  assert.equal(JSON.stringify(row).includes(r.token), false, 'открытого токена в базе нет')
  assert.equal(r.expiresAt, T0 + 7 * DAY)
})

test('срок — только 1 / 7 / 30 дней; имя обязательно', () => {
  const db = fresh()
  refused(createInvite(db, { name: 'Дима', days: 3 }, 'owner', T0), /1, 7 или 30/)
  refused(createInvite(db, { name: '  ', days: 7 }, 'owner', T0), /имя/)
  for (const d of [1, 7, 30]) assert.ok('token' in createInvite(db, { name: 'x' + d, days: d }, 'owner', T0))
})

test('пределы приглашённого — из приглашения, по умолчанию 3 / 1', () => {
  const db = fresh()
  const a = createInvite(db, { name: 'А', days: 7 }, 'owner', T0) as any
  const b = createInvite(db, { name: 'Б', days: 7, limits: { accounts: 5, senders: 2 } }, 'owner', T0) as any
  assert.deepEqual(inviteByToken(db, a.token, T0)!.limits, { accounts: 3, senders: 1 })
  assert.deepEqual(inviteByToken(db, b.token, T0)!.limits, { accounts: 5, senders: 2 })
})

test('действующее — находится по токену; после срока, отзыва и использования — нет', () => {
  const db = fresh()
  const r = createInvite(db, { name: 'Дима', days: 1 }, 'owner', T0) as any
  assert.equal(inviteByToken(db, r.token, T0)!.name, 'Дима')
  assert.equal(inviteByToken(db, r.token, T0 + DAY + 1), null, 'после срока')
  assert.equal(inviteByToken(db, 'не тот', T0), null)
  const v = createInvite(db, { name: 'Саша', days: 7 }, 'owner', T0) as any
  assert.deepEqual(revokeInvite(db, v.id, 'owner', T0), { ok: true })
  assert.equal(inviteByToken(db, v.token, T0), null, 'после отзыва')
})

test('одноразовое: использованное не перепривязывается никогда', () => {
  const db = fresh()
  const r = createInvite(db, { name: 'Дима', days: 7 }, 'owner', T0) as any
  const inv = inviteByToken(db, r.token, T0)!
  assert.deepEqual(useInvite(db, inv.id, SID, T0), { ok: true })
  refused(useInvite(db, inv.id, '76561190000000078', T0), /уже использовано/)
  assert.equal(inviteByToken(db, r.token, T0), null)
  const row = db.prepare('select used_by_steamid from invites where id = ?').get(inv.id) as any
  assert.equal(row.used_by_steamid, SID, 'привязано к первому')
  refused(revokeInvite(db, inv.id, 'owner', T0), /уже использовано/)
})

test('список приглашений — без токенов, с состоянием', () => {
  const db = fresh()
  const a = createInvite(db, { name: 'А', days: 7 }, 'owner', T0) as any
  const b = createInvite(db, { name: 'Б', days: 7 }, 'owner', T0) as any
  createInvite(db, { name: 'В', days: 1 }, 'owner', T0)
  revokeInvite(db, b.id, 'owner', T0)
  useInvite(db, inviteByToken(db, a.token, T0)!.id, SID, T0)
  const l = listInvites(db, T0 + 2 * DAY)
  assert.equal(JSON.stringify(l).includes(a.token), false)
  assert.deepEqual(l.map(i => [i.name, i.state]).sort(), [['А', 'использовано'], ['Б', 'отозвано'], ['В', 'истекло']])
})

// ── вход для приглашённых (решение 16) ──

test('вход для приглашённых закрыт по умолчанию; открывает и закрывает владелец, с записью', () => {
  const db = fresh()
  assert.equal(entryOpen(db), false)
  setEntryOpen(db, true, 'owner', T0)
  assert.equal(entryOpen(db), true)
  setEntryOpen(db, false, 'owner', T0 + 1)
  assert.equal(entryOpen(db), false)
  const log = db.prepare('select * from access_log order by id').all() as any[]
  assert.deepEqual(log.map(r => r.what), ['вход открыт', 'вход закрыт'])
})

// ── допуск для приёмки (решение 16) ──

test('допуск: один steamid на 24 часа; второй при действующем — отказ', () => {
  const db = fresh()
  const p = grantPermit(db, SID, 'owner', T0) as any
  assert.equal(p.expiresAt, T0 + DAY)
  assert.equal(permitAllows(db, SID, T0), true)
  assert.equal(permitAllows(db, '76561190000000078', T0), false, 'другой steamid — нет')
  refused(grantPermit(db, '76561190000000078', 'owner', T0), /уже есть действующий/)
  assert.equal(permitAllows(db, SID, T0 + DAY + 1), false, 'после 24 часов — нет')
  assert.equal(activePermit(db, T0 + DAY + 1), null)
  assert.ok('id' in grantPermit(db, '76561190000000078', 'owner', T0 + DAY + 1), 'после срока — можно новый')
})

test('допуск: отзыв — сразу; запись кто, когда, какой steamid, когда снят', () => {
  const db = fresh()
  grantPermit(db, SID, 'owner', T0)
  assert.deepEqual(revokePermit(db, 'owner', T0 + 5), { steamid: SID })
  assert.equal(permitAllows(db, SID, T0 + 6), false)
  refused(revokePermit(db, 'owner', T0 + 7), /нет действующего/)
  const row = db.prepare('select * from acceptance_permits').get() as any
  assert.equal(row.steamid, SID)
  assert.equal(row.created_by, 'owner')
  assert.equal(row.created_at, T0)
  assert.equal(row.revoked_at, T0 + 5)
})

test('допуск: steamid — 17 цифр', () => {
  const db = fresh()
  refused(grantPermit(db, '123', 'owner', T0), /17 цифр/)
})
