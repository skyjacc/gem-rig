import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { NS, returnTo, STEAM_OP } from './openid.ts'
import { createInvite, grantPermit, inviteByToken, revokePermit, setEntryOpen } from './access.ts'
import { ensureOwner, handleFinish, handleReturn, OWNER_ID, sessionUser, startAttempt, userActive, USERS_DDL } from './users.ts'

// Кого пускает вход через Steam (план 7.3, решение 16, §18). Ответы Steam
// подменены; steamid выдуманные.

const PANEL = 'https://panel.example.ts.net'
const T0 = Date.UTC(2026, 9, 7, 12)
const DAY = 86_400_000
const OWNER_SID = '76561190000000042'
const TEST_SID = '76561190000000077'
const FRIEND_SID = '76561190000000088'

function fresh() {
  const db = new DatabaseSync(':memory:')
  db.exec(USERS_DDL)
  ensureOwner(db, T0)
  db.prepare('update users set steamid = ? where id = ?').run(OWNER_SID, OWNER_ID)
  return db
}
const refused = (r: object, re: RegExp) => {
  assert.ok('error' in r, 'ожидался отказ, а пришло: ' + JSON.stringify(r))
  assert.match((r as any).error, re)
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
let n = 0
const valid = async () => ({ ok: true, text: async () => 'ns:' + NS + '\nis_valid:true\n' })

// Полный вход: попытка → возврат от Steam → (подтверждение) → сессия.
async function viaSteam(db: DatabaseSync, sid: string, opts: { purpose?: 'вход' | 'приглашение'; invite?: string; at?: number } = {}) {
  const at = opts.at ?? T0
  const a = startAttempt(db, opts.purpose ?? 'вход', null, at, opts.invite ?? '')
  if ('error' in a) return { start: a }
  const reply = {
    'openid.ns': NS, 'openid.mode': 'id_res', 'openid.op_endpoint': STEAM_OP,
    'openid.claimed_id': 'https://steamcommunity.com/openid/id/' + sid, 'openid.identity': 'https://steamcommunity.com/openid/id/' + sid,
    'openid.return_to': returnTo(PANEL, a.state), 'openid.response_nonce': stamp(at - 1_000) + 'n' + (n++),
    'openid.assoc_handle': '1', 'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'c2ln', state: a.state,
  }
  const ret = await handleReturn(db, reply, a.binding, PANEL, at, valid)
  const fin = (confirm = false) => handleFinish(db, a.state, a.binding, null, at, confirm)
  return { a, ret, fin }
}
const users = (db: DatabaseSync) => (db.prepare('select count(*) c from users').get() as any).c as number

// ── закрытый вход ──

test('вход закрыт: чужой Steam — «пока закрыт», пользователь не создаётся; приглашение не начать', async () => {
  const db = fresh()
  const r = await viaSteam(db, FRIEND_SID)
  refused(r.fin!(), /вход в панель пока закрыт/)
  assert.equal(users(db), 1)
  const inv = createInvite(db, { name: 'Дима', days: 7 }, OWNER_ID, T0) as any
  refused(startAttempt(db, 'приглашение', null, T0, inv.token), /пока закрыт/)
  assert.ok(inviteByToken(db, inv.token, T0), 'приглашение не потрачено')
})

// ── допуск для приёмки ──

test('допуск: допущенный Steam входит при закрытом входе, другой — нет', async () => {
  const db = fresh()
  grantPermit(db, TEST_SID, OWNER_ID, T0)
  const ok = (await viaSteam(db, TEST_SID)).fin!()
  assert.ok('session' in ok, JSON.stringify(ok))
  assert.equal((ok as any).user.role, 'пользователь')
  refused((await viaSteam(db, FRIEND_SID)).fin!(), /пока закрыт/)
  // Приглашения при допуске по-прежнему не принимаются.
  const inv = createInvite(db, { name: 'Дима', days: 7 }, OWNER_ID, T0) as any
  refused(startAttempt(db, 'приглашение', null, T0, inv.token), /пока закрыт/)
})

test('допуск истёк или снят — сессии допущенного гасятся, повторный вход — отказ', async () => {
  const db = fresh()
  grantPermit(db, TEST_SID, OWNER_ID, T0)
  const s = (await viaSteam(db, TEST_SID)).fin!() as any
  assert.ok(sessionUser(db, s.session.token, T0 + 1_000))
  assert.equal(sessionUser(db, s.session.token, T0 + DAY + 1), null, 'после 24 часов')
  assert.equal(sessionUser(db, s.session.token, T0 + 2_000), null, 'и не оживает')
  // Снятие допуска — так же.
  grantPermit(db, TEST_SID, OWNER_ID, T0 + DAY + 2)
  const s2 = (await viaSteam(db, TEST_SID, { at: T0 + DAY + 3 })).fin!() as any
  assert.ok('session' in s2)
  revokePermit(db, OWNER_ID, T0 + DAY + 4)
  assert.equal(sessionUser(db, s2.session.token, T0 + DAY + 5), null, 'после снятия')
  assert.equal(userActive(db, s2.user.id, T0 + DAY + 5), false, 'работа допущенного встаёт')
  refused((await viaSteam(db, TEST_SID, { at: T0 + DAY + 6 })).fin!(), /пока закрыт/)
})

// ── вход открыт: приглашения ──

test('вход открыт: Steam без приглашения — «не приглашён»', async () => {
  const db = fresh()
  setEntryOpen(db, true, OWNER_ID, T0)
  refused((await viaSteam(db, FRIEND_SID)).fin!(), /этот Steam не приглашён/)
  assert.equal(users(db), 1)
})

test('приглашение: «это вы?» — ничего не создаёт; подтвердили — пользователь с именем и пределами, ссылка потрачена', async () => {
  const db = fresh()
  setEntryOpen(db, true, OWNER_ID, T0)
  const inv = createInvite(db, { name: 'Дима', days: 7, limits: { accounts: 2, senders: 1 } }, OWNER_ID, T0) as any
  const r = await viaSteam(db, FRIEND_SID, { purpose: 'приглашение', invite: inv.token })
  assert.deepEqual(r.ret, { ok: true })
  assert.deepEqual(r.fin!(false), { confirm: { steamid: FRIEND_SID, name: 'Дима' } })
  assert.equal(users(db), 1, 'до подтверждения — никого')
  const ok = r.fin!(true) as any
  assert.ok('session' in ok, JSON.stringify(ok))
  assert.equal(ok.user.name, 'Дима')
  assert.equal(ok.user.steamid, FRIEND_SID)
  const row = db.prepare('select limits_json from users where id = ?').get(ok.user.id) as any
  assert.deepEqual(JSON.parse(row.limits_json), { accounts: 2, senders: 1 })
  assert.equal(inviteByToken(db, inv.token, T0), null, 'ссылка потрачена')
  refused(r.fin!(true), /не из этого браузера или устарела/)
  // Дальше — обычной кнопкой, без ссылки.
  assert.ok('session' in (await viaSteam(db, FRIEND_SID)).fin!())
})

test('использованное приглашение не перепривязывается: другой Steam по той же ссылке — отказ', async () => {
  const db = fresh()
  setEntryOpen(db, true, OWNER_ID, T0)
  const inv = createInvite(db, { name: 'Дима', days: 7 }, OWNER_ID, T0) as any
  ;(await viaSteam(db, FRIEND_SID, { purpose: 'приглашение', invite: inv.token })).fin!(true)
  refused((await viaSteam(db, TEST_SID, { purpose: 'приглашение', invite: inv.token })).start!, /недействительно/)
})

test('приглашение, использованное в другой вкладке, пока шёл вход, — отказ при подтверждении', async () => {
  const db = fresh()
  setEntryOpen(db, true, OWNER_ID, T0)
  const inv = createInvite(db, { name: 'Дима', days: 7 }, OWNER_ID, T0) as any
  const a = await viaSteam(db, FRIEND_SID, { purpose: 'приглашение', invite: inv.token })
  const b = await viaSteam(db, TEST_SID, { purpose: 'приглашение', invite: inv.token })
  assert.ok('session' in (b.fin!(true) as any))
  refused(a.fin!(true), /недействительно/)
  assert.equal(users(db), 2, 'один пользователь по одной ссылке')
})

test('приглашение для Steam, который уже пользователь, — отказ, ссылка не потрачена', async () => {
  const db = fresh()
  setEntryOpen(db, true, OWNER_ID, T0)
  const inv = createInvite(db, { name: 'Ещё раз', days: 7 }, OWNER_ID, T0) as any
  refused((await viaSteam(db, OWNER_SID, { purpose: 'приглашение', invite: inv.token })).fin!(true), /уже пользователь панели/)
  assert.ok(inviteByToken(db, inv.token, T0))
})

test('вход закрыли снова — сессии приглашённых гасятся; владелец работает', async () => {
  const db = fresh()
  setEntryOpen(db, true, OWNER_ID, T0)
  const inv = createInvite(db, { name: 'Дима', days: 7 }, OWNER_ID, T0) as any
  const s = (await viaSteam(db, FRIEND_SID, { purpose: 'приглашение', invite: inv.token })).fin!(true) as any
  const own = (await viaSteam(db, OWNER_SID)).fin!() as any
  setEntryOpen(db, false, OWNER_ID, T0 + 1)
  assert.equal(sessionUser(db, s.session.token, T0 + 2), null)
  assert.ok(sessionUser(db, own.session.token, T0 + 2))
})

test('отключённый — «доступ отключён владельцем»', async () => {
  const db = fresh()
  setEntryOpen(db, true, OWNER_ID, T0)
  const inv = createInvite(db, { name: 'Дима', days: 7 }, OWNER_ID, T0) as any
  const s = (await viaSteam(db, FRIEND_SID, { purpose: 'приглашение', invite: inv.token })).fin!(true) as any
  db.prepare('update users set disabled_at = ? where id = ?').run(T0, s.user.id)
  refused((await viaSteam(db, FRIEND_SID)).fin!(), /доступ отключён владельцем/)
})
