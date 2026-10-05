import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { NS, returnTo, STEAM_OP } from './openid.ts'
import {
  ATTEMPT_TTL, IDLE, attemptLimiter, ensureOwner, handleFinish, handleReturn, newSession, OWNER_ID,
  revokeAll, revokeSession, sessionUser, startAttempt, STEAM_TTL, TOKEN_TTL, USERS_DDL,
} from './users.ts'

// Пользователи, сессии и вход через Steam (план 7.1: решения 1, 2а, 3, 16).
// steamid — выдуманные; ответы Steam подменены.

const PANEL = 'https://panel.example.ts.net'
const T0 = Date.UTC(2026, 9, 5, 12)
const OWNER_SID = '76561190000000042'
const OTHER_SID = '76561190000000077'
const DAY = 86_400_000

function fresh() {
  const db = new DatabaseSync(':memory:')
  db.exec(USERS_DDL)
  ensureOwner(db, T0)
  return db
}
const refused = (r: object, re: RegExp) => {
  assert.ok('error' in r, 'ожидался отказ, а пришло: ' + JSON.stringify(r))
  assert.match((r as any).error, re)
}

// Ответ Steam для попытки: всё верно, подпись подтверждается подменой.
const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
let nonceN = 0
const steamReply = (state: string, sid: string, at: number) => ({
  'openid.ns': NS, 'openid.mode': 'id_res', 'openid.op_endpoint': STEAM_OP,
  'openid.claimed_id': 'https://steamcommunity.com/openid/id/' + sid,
  'openid.identity': 'https://steamcommunity.com/openid/id/' + sid,
  'openid.return_to': returnTo(PANEL, state),
  'openid.response_nonce': stamp(at - 1_000) + 'n' + (nonceN++),
  'openid.assoc_handle': '1', 'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
  'openid.sig': 'c2ln', state,
})
const valid = async () => ({ ok: true, text: async () => 'ns:' + NS + '\nis_valid:true\n' })

// ── сессии (решение 3) ──

test('сессия: токен — в куку, в базе только хэш', () => {
  const db = fresh()
  const s = newSession(db, OWNER_ID, 'steam', T0)
  assert.equal(s.token.length, 64)
  const row = db.prepare('select * from sessions').get() as any
  assert.notEqual(row.token_hash, s.token)
  assert.equal(JSON.stringify(row).includes(s.token), false, 'открытого токена в базе нет')
  assert.equal(sessionUser(db, s.token, T0)!.user.id, OWNER_ID)
  assert.equal(sessionUser(db, 'не тот', T0), null)
})

test('сессия Steam: 30 дней абсолютно, 7 дней бездействия; использование продлевает только бездействие', () => {
  const db = fresh()
  const s = newSession(db, OWNER_ID, 'steam', T0)
  assert.equal(s.expiresAt, T0 + STEAM_TTL)
  // Каждые 6 дней заходим — бездействие не наступает, но абсолютный срок держит.
  for (let d = 6; d < 30; d += 6) assert.ok(sessionUser(db, s.token, T0 + d * DAY), 'день ' + d)
  assert.equal(sessionUser(db, s.token, T0 + 30 * DAY + 1), null, 'после 30 дней — нет')
  const idle = newSession(db, OWNER_ID, 'steam', T0)
  assert.equal(sessionUser(db, idle.token, T0 + IDLE + 1), null, 'неделя без дела — нет')
  assert.equal(sessionUser(db, idle.token, T0 + 1), null, 'погашенная не оживает')
})

test('сессия по токену: 12 часов, без продления', () => {
  const db = fresh()
  const s = newSession(db, OWNER_ID, 'токен', T0)
  assert.equal(s.expiresAt, T0 + TOKEN_TTL)
  assert.ok(sessionUser(db, s.token, T0 + TOKEN_TTL - 60_000))
  assert.equal(sessionUser(db, s.token, T0 + TOKEN_TTL + 1), null)
})

test('выйти: одна сессия; выйти везде — все сессии пользователя', () => {
  const db = fresh()
  const a = newSession(db, OWNER_ID, 'steam', T0)
  const b = newSession(db, OWNER_ID, 'steam', T0)
  revokeSession(db, a.token, T0)
  assert.equal(sessionUser(db, a.token, T0), null)
  assert.ok(sessionUser(db, b.token, T0))
  const c = newSession(db, OWNER_ID, 'токен', T0)
  revokeAll(db, OWNER_ID, T0)
  assert.equal(sessionUser(db, b.token, T0), null)
  assert.equal(sessionUser(db, c.token, T0), null)
})

test('вход токеном — не больше 5 попыток в минуту с адреса', () => {
  const lim = attemptLimiter(5, 60_000)
  for (let i = 0; i < 5; i++) assert.equal(lim.allow('1.2.3.4', T0 + i), true)
  assert.equal(lim.allow('1.2.3.4', T0 + 10), false)
  assert.equal(lim.allow('5.6.7.8', T0 + 10), true, 'другой адрес — свой счёт')
  assert.equal(lim.allow('1.2.3.4', T0 + 60_001), true, 'через минуту — снова')
})

// ── попытка входа привязана к браузеру (решение 2а) ──

async function login(db: DatabaseSync, sid: string, opts: { binding?: string; at?: number; purpose?: 'вход' | 'привязка владельца'; session?: string | null } = {}) {
  const at = opts.at ?? T0
  const a = startAttempt(db, opts.purpose ?? 'вход', opts.session ?? null, T0)
  if ('error' in a) return { a, ret: a, fin: a }
  const ret = await handleReturn(db, steamReply(a.state, sid, at), opts.binding ?? a.binding, PANEL, at, valid)
  return { a, ret }
}

test('вход владельца через Steam: возврат → finish → сессия', async () => {
  const db = fresh()
  db.prepare('update users set steamid = ? where id = ?').run(OWNER_SID, OWNER_ID)
  const { a, ret } = await login(db, OWNER_SID)
  assert.deepEqual(ret, { ok: true })
  const fin = handleFinish(db, (a as any).state, (a as any).binding, null, T0)
  assert.ok('session' in fin)
  assert.equal(sessionUser(db, (fin as any).session.token, T0)!.user.id, OWNER_ID)
})

test('возврат без куки попытки, с чужой кукой, после 10 минут — отказ', async () => {
  const db = fresh()
  db.prepare('update users set steamid = ? where id = ?').run(OWNER_SID, OWNER_ID)
  refused((await login(db, OWNER_SID, { binding: '' })).ret, /не из этого браузера или устарела/)
  refused((await login(db, OWNER_SID, { binding: 'b'.repeat(43) })).ret, /не из этого браузера или устарела/)
  refused((await login(db, OWNER_SID, { at: T0 + ATTEMPT_TTL + 1 })).ret, /не из этого браузера или устарела|устарел/)
})

test('перенос возврата в другой браузер — отказ, попытка погашена: и свой браузер её уже не завершит', async () => {
  const db = fresh()
  db.prepare('update users set steamid = ? where id = ?').run(OWNER_SID, OWNER_ID)
  const a = startAttempt(db, 'вход', null, T0) as { state: string; binding: string }
  const reply = steamReply(a.state, OWNER_SID, T0)
  refused(await handleReturn(db, reply, 'кука другого браузера', PANEL, T0, valid), /не из этого браузера/)
  refused(await handleReturn(db, { ...reply, 'openid.response_nonce': stamp(T0) + 'другой' }, a.binding, PANEL, T0, valid), /не из этого браузера или устарела/)
  refused(handleFinish(db, a.state, a.binding, null, T0), /не завершена|не из этого браузера/)
})

test('повторный возврат и повторный finish — отказ', async () => {
  const db = fresh()
  db.prepare('update users set steamid = ? where id = ?').run(OWNER_SID, OWNER_ID)
  const a = startAttempt(db, 'вход', null, T0) as { state: string; binding: string }
  const reply = steamReply(a.state, OWNER_SID, T0)
  assert.deepEqual(await handleReturn(db, reply, a.binding, PANEL, T0, valid), { ok: true })
  refused(await handleReturn(db, reply, a.binding, PANEL, T0, valid), /уже|повтор/)
  assert.ok('session' in handleFinish(db, a.state, a.binding, null, T0))
  refused(handleFinish(db, a.state, a.binding, null, T0), /не из этого браузера или устарела/)
})

test('повтор nonce Steam в новой попытке — отказ', async () => {
  const db = fresh()
  db.prepare('update users set steamid = ? where id = ?').run(OWNER_SID, OWNER_ID)
  const a = startAttempt(db, 'вход', null, T0) as { state: string; binding: string }
  const reply = steamReply(a.state, OWNER_SID, T0)
  await handleReturn(db, reply, a.binding, PANEL, T0, valid)
  const b = startAttempt(db, 'вход', null, T0) as { state: string; binding: string }
  const replay = { ...reply, 'openid.return_to': returnTo(PANEL, b.state), state: b.state }
  refused(await handleReturn(db, replay, b.binding, PANEL, T0, valid), /повтор/)
})

test('подпись не подтверждена — попытка не проверена, finish — отказ', async () => {
  const db = fresh()
  db.prepare('update users set steamid = ? where id = ?').run(OWNER_SID, OWNER_ID)
  const a = startAttempt(db, 'вход', null, T0) as { state: string; binding: string }
  const bad = async () => ({ ok: true, text: async () => 'ns:' + NS + '\nis_valid:false\n' })
  refused(await handleReturn(db, steamReply(a.state, OWNER_SID, T0), a.binding, PANEL, T0, bad), /подпись/)
  refused(handleFinish(db, a.state, a.binding, null, T0), /не из этого браузера или устарела/)
})

// ── вход закрыт для всех, кроме владельца (решение 16) ──

test('чужой Steam с верным ответом — «вход в панель пока закрыт», сессии нет', async () => {
  const db = fresh()
  db.prepare('update users set steamid = ? where id = ?').run(OWNER_SID, OWNER_ID)
  const { a, ret } = await login(db, OTHER_SID)
  assert.deepEqual(ret, { ok: true }, 'ответ Steam верный')
  refused(handleFinish(db, (a as any).state, (a as any).binding, null, T0), /вход в панель пока закрыт/)
  assert.equal((db.prepare('select count(*) c from sessions').get() as any).c, 0)
  assert.equal((db.prepare('select count(*) c from users').get() as any).c, 1, 'пользователь не создан')
})

test('Steam владельца не привязан — через Steam не войти никому', async () => {
  const db = fresh()
  const { a } = await login(db, OWNER_SID)
  refused(handleFinish(db, (a as any).state, (a as any).binding, null, T0), /вход в панель пока закрыт/)
})

// ── привязка Steam владельца ──

test('привязку начинает только сессия владельца; завершает только она же в том же браузере', async () => {
  const db = fresh()
  refused(startAttempt(db, 'привязка владельца', null, T0), /войдите/)
  const own = newSession(db, OWNER_ID, 'токен', T0)
  const a = startAttempt(db, 'привязка владельца', own.token, T0) as { state: string; binding: string }
  assert.deepEqual(await handleReturn(db, steamReply(a.state, OWNER_SID, T0), a.binding, PANEL, T0, valid), { ok: true })
  // Чужая сессия (или без сессии) — отказ, steamid не привязан.
  const other = newSession(db, OWNER_ID, 'токен', T0)
  refused(handleFinish(db, a.state, a.binding, other.token, T0), /не из этого браузера или устарела/)
  const b = startAttempt(db, 'привязка владельца', own.token, T0) as { state: string; binding: string }
  await handleReturn(db, steamReply(b.state, OWNER_SID, T0), b.binding, PANEL, T0, valid)
  refused(handleFinish(db, b.state, b.binding, null, T0), /не из этого браузера или устарела/)
  assert.equal((db.prepare('select steamid from users where id = ?').get(OWNER_ID) as any).steamid, null)
  // Та же сессия — привязано.
  const c = startAttempt(db, 'привязка владельца', own.token, T0) as { state: string; binding: string }
  await handleReturn(db, steamReply(c.state, OWNER_SID, T0), c.binding, PANEL, T0, valid)
  assert.deepEqual(handleFinish(db, c.state, c.binding, own.token, T0), { bound: OWNER_SID })
  assert.equal((db.prepare('select steamid from users where id = ?').get(OWNER_ID) as any).steamid, OWNER_SID)
})

test('Steam владельца уже привязан — другой не перепривязать', async () => {
  const db = fresh()
  db.prepare('update users set steamid = ? where id = ?').run(OWNER_SID, OWNER_ID)
  const own = newSession(db, OWNER_ID, 'токен', T0)
  const a = startAttempt(db, 'привязка владельца', own.token, T0) as { state: string; binding: string }
  await handleReturn(db, steamReply(a.state, OTHER_SID, T0), a.binding, PANEL, T0, valid)
  refused(handleFinish(db, a.state, a.binding, own.token, T0), /уже привязан/)
  assert.equal((db.prepare('select steamid from users where id = ?').get(OWNER_ID) as any).steamid, OWNER_SID)
})

test('владелец создаётся один раз, без steamid', () => {
  const db = fresh()
  ensureOwner(db, T0 + 1)
  const rows = db.prepare('select * from users').all() as any[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].role, 'владелец')
  assert.equal(rows[0].steamid, null)
})

// ── одновременные повторы ответа Steam (ревью PR #32, P2) ──
//
// Steam отвечает на проверку подписи с задержкой; оба запроса успевают
// пройти проверки до ответа. Подтвердиться должен ровно один.

const slowValid = (ms: number) => async () => {
  await new Promise(r => setTimeout(r, ms))
  return { ok: true, text: async () => 'ns:' + NS + '\nis_valid:true\n' }
}

test('один ответ Steam дважды одновременно на одну попытку — подтверждается один', async () => {
  const db = fresh()
  db.prepare('update users set steamid = ? where id = ?').run(OWNER_SID, OWNER_ID)
  const a = startAttempt(db, 'вход', null, T0) as { state: string; binding: string }
  const reply = steamReply(a.state, OWNER_SID, T0)
  const rs = await Promise.all([
    handleReturn(db, reply, a.binding, PANEL, T0, slowValid(30)),
    handleReturn(db, reply, a.binding, PANEL, T0, slowValid(10)),
  ])
  assert.equal(rs.filter(r => 'ok' in r).length, 1, JSON.stringify(rs))
  assert.match((rs.find(r => 'error' in r) as any).error, /повтор/)
  assert.equal((db.prepare('select count(*) c from openid_nonces').get() as any).c, 1)
})

test('один nonce одновременно в двух попытках — подтверждается одна, вторая погашена', async () => {
  const db = fresh()
  db.prepare('update users set steamid = ? where id = ?').run(OWNER_SID, OWNER_ID)
  const a = startAttempt(db, 'вход', null, T0) as { state: string; binding: string }
  const b = startAttempt(db, 'вход', null, T0) as { state: string; binding: string }
  const ra = steamReply(a.state, OWNER_SID, T0)
  const rb = { ...ra, 'openid.return_to': returnTo(PANEL, b.state), state: b.state }
  const rs = await Promise.all([
    handleReturn(db, ra, a.binding, PANEL, T0, slowValid(30)),
    handleReturn(db, rb, b.binding, PANEL, T0, slowValid(10)),
  ])
  assert.equal(rs.filter(r => 'ok' in r).length, 1, JSON.stringify(rs))
  const done = [a, b].filter(x => 'session' in handleFinish(db, x.state, x.binding, null, T0))
  assert.equal(done.length, 1, 'сессия — ровно одна')
})

test('два разных ответа Steam одновременно на одну попытку — подтверждается один', async () => {
  const db = fresh()
  db.prepare('update users set steamid = ? where id = ?').run(OWNER_SID, OWNER_ID)
  const a = startAttempt(db, 'вход', null, T0) as { state: string; binding: string }
  const r1 = steamReply(a.state, OWNER_SID, T0)
  const r2 = steamReply(a.state, OWNER_SID, T0)          // свой nonce
  assert.notEqual(r1['openid.response_nonce'], r2['openid.response_nonce'])
  const rs = await Promise.all([
    handleReturn(db, r1, a.binding, PANEL, T0, slowValid(30)),
    handleReturn(db, r2, a.binding, PANEL, T0, slowValid(10)),
  ])
  assert.equal(rs.filter(r => 'ok' in r).length, 1, JSON.stringify(rs))
})

test('известный повтор nonce — отказ без запроса к Steam', async () => {
  const db = fresh()
  db.prepare('update users set steamid = ? where id = ?').run(OWNER_SID, OWNER_ID)
  const a = startAttempt(db, 'вход', null, T0) as { state: string; binding: string }
  const reply = steamReply(a.state, OWNER_SID, T0)
  await handleReturn(db, reply, a.binding, PANEL, T0, valid)
  const b = startAttempt(db, 'вход', null, T0) as { state: string; binding: string }
  let asked = 0
  const counting = async () => { asked++; return { ok: true, text: async () => 'ns:' + NS + '\nis_valid:true\n' } }
  const r = await handleReturn(db, { ...reply, 'openid.return_to': returnTo(PANEL, b.state), state: b.state }, b.binding, PANEL, T0, counting)
  assert.match((r as any).error, /повтор/)
  assert.equal(asked, 0, 'в Steam за заведомым повтором не ходим')
})
