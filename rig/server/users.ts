// Пользователи панели, их сессии и вход через Steam (план 7.1).
//
// Пользователь — человек; рабочий аккаунт — Steam, который крутит гемы
// (§12.2). В 7.1 пользователь один — владелец: вход через Steam принимает
// только его steamid (решение 16), чужой — «вход в панель пока закрыт».
// Изоляции данных между пользователями ещё нет (7.2), поэтому закрыто на
// сервере, а не правилом «никого не приглашать».
//
// Секреты — только хэшем: токен сессии, state и binding попытки входа.
//
// Сроки (решение 3):
//   сессия Steam — 30 дней с входа, 7 дней без дела;
//   сессия по токену панели (запасной вход владельца) — 12 часов, без продления.
//
// Попытка входа через Steam привязана к браузеру, который её начал
// (решение 2а): state идёт в адрес возврата, binding — в куку этого
// браузера. Возврат от Steam принимается только с той же кукой; сессия
// создаётся не на возврате, а отдельным finish со своей страницы — там уже
// есть кука сессии (SameSite=Strict), и привязку Steam владельца завершит
// только та же сессия владельца.

import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { checkResponse, NONCE_AGE, returnTo, verifySignature } from './openid.ts'
import { ACCESS_DDL, entryOpen, hashToken, inviteByToken, permitAllows, useInvite } from './access.ts'

export const OWNER_ID = 'owner'
const MIN = 60_000
const DAY = 86_400_000
export const STEAM_TTL = 30 * DAY
export const IDLE = 7 * DAY
export const TOKEN_TTL = 12 * 60 * MIN
export const ATTEMPT_TTL = 10 * MIN
const SEEN_EVERY = MIN

export const USERS_DDL = `
  create table if not exists users (
    id          text primary key,
    steamid     text unique,
    name        text not null,
    role        text not null check (role in ('владелец', 'пользователь')),
    limits_json text,
    disabled_at integer,
    created_at  integer not null,
    settings_json text
  );
  create table if not exists sessions (
    id           integer primary key autoincrement,
    token_hash   text not null unique,
    user_id      text not null references users(id),
    kind         text not null check (kind in ('steam', 'токен')),
    created_at   integer not null,
    last_seen_at integer not null,
    expires_at   integer not null,
    revoked_at   integer,
    user_agent   text
  );
  create index if not exists idx_sessions_user on sessions (user_id);
  create table if not exists login_attempts (
    id              integer primary key autoincrement,
    state_hash      text not null unique,
    binding_hash    text not null,
    purpose         text not null check (purpose in ('вход', 'привязка владельца', 'приглашение')),
    invite_hash     text,
    session_id      integer,
    created_at      integer not null,
    expires_at      integer not null,
    verified_steamid text,
    used_at         integer
  );
  create table if not exists openid_nonces (
    nonce   text primary key,
    seen_at integer not null
  );
  create table if not exists auth_log (
    id     integer primary key autoincrement,
    at     integer not null,
    what   text not null,
    detail text
  );
` + ACCESS_DDL

export type User = { id: string; steamid: string | null; name: string; role: 'владелец' | 'пользователь'; disabled_at: number | null }
type Fail = { error: string }

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const secret = () => crypto.randomBytes(32).toString('base64url')

// Таблица этапа 7.1 без личных настроек — добавить колонку (только добавление).
export function migrateUsers(db: DatabaseSync) {
  const cols = (db.prepare(`pragma table_info(users)`).all() as any[]).map(c => c.name)
  if (cols.length && !cols.includes('settings_json')) db.exec(`alter table users add column settings_json text`)
}

// ── пределы и отключение (план 7.2, решение 10) ──

// Изменяемые значения по умолчанию для приглашённого (рекомендация сверки):
// 3 рабочих аккаунта, 1 одновременно работающий отправщик. У владельца
// предела нет.
export const DEFAULT_LIMITS = { accounts: 3, senders: 1 }

export function limitsOf(db: DatabaseSync, userId: string): { accounts: number; senders: number } {
  if (userId === OWNER_ID) return { accounts: Infinity, senders: Infinity }
  const r = db.prepare('select limits_json from users where id = ?').get(userId) as { limits_json: string | null } | undefined
  let l: any = {}
  try { l = JSON.parse(r?.limits_json ?? '{}') ?? {} } catch { }
  const n = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : d)
  return { accounts: n(l.accounts, DEFAULT_LIMITS.accounts), senders: n(l.senders, DEFAULT_LIMITS.senders) }
}

// Активен ли пользователь: есть, не отключён и пущен (план 7.3, решение 16):
// владелец — всегда; остальные — пока открыт вход для приглашённых или пока
// действует допуск для приёмки на его steamid. Пустой id — запрос без входа.
export function userActive(db: DatabaseSync, userId: string, now = Date.now()): boolean {
  if (!userId) return false
  const u = userById(db, userId)
  return !!u && u.disabled_at == null && admitted(db, u, now)
}

const admitted = (db: DatabaseSync, u: User, now: number) =>
  u.role === 'владелец' || entryOpen(db) || permitAllows(db, u.steamid, now)

// Пометка и сессии. Остальное (потоки, работники, закупка, QR) гасит
// app.ts — у него эти части сервера.
export function markDisabled(db: DatabaseSync, userId: string, now = Date.now()): { ok: true } | Fail {
  if (userId === OWNER_ID) return { error: 'владельца не отключить' }
  const u = userById(db, userId)
  if (!u) return { error: 'нет такого пользователя' }
  db.prepare('update users set disabled_at = coalesce(disabled_at, ?) where id = ?').run(now, userId)
  revokeAll(db, userId, now)
  logAuth(db, 'пользователь отключён', now, userId)
  return { ok: true }
}

export function markEnabled(db: DatabaseSync, userId: string, now = Date.now()): { ok: true } | Fail {
  const u = userById(db, userId)
  if (!u) return { error: 'нет такого пользователя' }
  db.prepare('update users set disabled_at = null where id = ?').run(userId)
  logAuth(db, 'пользователь включён', now, userId)
  return { ok: true }
}

export function getPersonalSettings(db: DatabaseSync, userId: string): any {
  const r = db.prepare('select settings_json from users where id = ?').get(userId) as { settings_json: string | null } | undefined
  try { return r?.settings_json ? JSON.parse(r.settings_json) : null } catch { return null }
}

export function setPersonalSettings(db: DatabaseSync, userId: string, v: any) {
  db.prepare('update users set settings_json = ? where id = ?').run(v == null ? null : JSON.stringify(v), userId)
}

export function ensureOwner(db: DatabaseSync, now = Date.now()) {
  db.prepare(`insert or ignore into users (id, steamid, name, role, created_at) values (?, null, 'владелец', 'владелец', ?)`).run(OWNER_ID, now)
}

export const userById = (db: DatabaseSync, id: string) =>
  db.prepare('select id, steamid, name, role, disabled_at from users where id = ?').get(id) as User | undefined

export function logAuth(db: DatabaseSync, what: string, now: number, detail?: string) {
  db.prepare('insert into auth_log (at, what, detail) values (?, ?, ?)').run(now, what, detail ?? null)
}

// ── сессии ──

export function newSession(db: DatabaseSync, userId: string, kind: 'steam' | 'токен', now = Date.now(), ua?: string) {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = now + (kind === 'steam' ? STEAM_TTL : TOKEN_TTL)
  db.prepare(`insert into sessions (token_hash, user_id, kind, created_at, last_seen_at, expires_at, user_agent) values (?,?,?,?,?,?,?)`)
    .run(hash(token), userId, kind, now, now, expiresAt, ua ? ua.slice(0, 200) : null)
  return { token, expiresAt }
}

type Session = { id: number; user_id: string; kind: 'steam' | 'токен'; last_seen_at: number; expires_at: number; revoked_at: number | null }

// Жива ли сессия: не отозвана, не истекла по любому сроку, пользователь не
// отключён. Истёкшая — гасится.
function alive(db: DatabaseSync, s: Session | undefined, now: number): User | null {
  if (!s || s.revoked_at != null) return null
  const idle = s.kind === 'steam' && now - s.last_seen_at > IDLE
  if (now > s.expires_at || idle) {
    db.prepare('update sessions set revoked_at = ? where id = ?').run(now, s.id)
    return null
  }
  const user = userById(db, s.user_id)
  if (!user || user.disabled_at != null) return null
  // Не пущен (закрыли вход, истёк или снят допуск) — сессия гасится.
  if (!admitted(db, user, now)) {
    db.prepare('update sessions set revoked_at = ? where id = ?').run(now, s.id)
    return null
  }
  return user
}

const SESSION_COLS = 'id, user_id, kind, last_seen_at, expires_at, revoked_at'

// Кто это — по предъявленному токену. Обращение продлевает только срок
// бездействия.
export function sessionUser(db: DatabaseSync, token: string, now = Date.now()): { user: User; sessionId: number; kind: Session['kind'] } | null {
  if (!token) return null
  const s = db.prepare(`select ${SESSION_COLS} from sessions where token_hash = ?`).get(hash(token)) as Session | undefined
  const user = alive(db, s, now)
  if (!user || !s) return null
  if (now - s.last_seen_at > SEEN_EVERY) db.prepare('update sessions set last_seen_at = ? where id = ?').run(now, s.id)
  return { user, sessionId: s.id, kind: s.kind }
}

// Для открытых потоков (streams.ts): по id сессии, без продления — открытый
// поток сам по себе не считается делом.
export function sessionAlive(db: DatabaseSync, sessionId: number, now = Date.now()): boolean {
  const s = db.prepare(`select ${SESSION_COLS} from sessions where id = ?`).get(sessionId) as Session | undefined
  return !!alive(db, s, now)
}

export function revokeSession(db: DatabaseSync, token: string, now = Date.now()) {
  db.prepare('update sessions set revoked_at = ? where token_hash = ? and revoked_at is null').run(now, hash(token))
}

export function revokeAll(db: DatabaseSync, userId: string, now = Date.now()) {
  db.prepare('update sessions set revoked_at = ? where user_id = ? and revoked_at is null').run(now, userId)
}

// Ограничение попыток: не больше n за окно с одного адреса.
export function attemptLimiter(n: number, windowMs: number) {
  const seen = new Map<string, number[]>()
  return {
    allow(key: string, now = Date.now()) {
      const list = (seen.get(key) ?? []).filter(t => now - t < windowMs)
      if (list.length >= n) { seen.set(key, list); return false }
      list.push(now)
      seen.set(key, list)
      return true
    },
  }
}

// ── попытка входа через Steam ──

type Attempt = {
  id: number; binding_hash: string; purpose: 'вход' | 'привязка владельца' | 'приглашение'; session_id: number | null; invite_hash: string | null
  expires_at: number; verified_steamid: string | null; used_at: number | null
}

const STALE = 'попытка входа не из этого браузера или устарела — начните вход заново'

export function startAttempt(db: DatabaseSync, purpose: Attempt['purpose'], sessionToken: string | null, now = Date.now(), invite = ''):
  { state: string; binding: string } | Fail {
  let sessionId: number | null = null
  // Вход по приглашению (план 7.3): ссылка действует и вход для
  // приглашённых открыт; иначе — не начинаем.
  if (purpose === 'приглашение') {
    if (!entryOpen(db)) return { error: 'вход в панель пока закрыт' }
    if (!inviteByToken(db, invite, now)) return { error: 'приглашение недействительно: истекло, отозвано или уже использовано' }
  }
  if (purpose === 'привязка владельца') {
    const who = sessionUser(db, sessionToken ?? '', now)
    if (!who || who.user.role !== 'владелец') return { error: 'войдите в панель владельцем, чтобы привязать Steam' }
    sessionId = who.sessionId
  }
  const state = secret()
  const binding = secret()
  db.prepare(`insert into login_attempts (state_hash, binding_hash, purpose, session_id, invite_hash, created_at, expires_at) values (?,?,?,?,?,?,?)`)
    .run(hash(state), hash(binding), purpose, sessionId, purpose === 'приглашение' ? hashToken(invite) : null, now, now + ATTEMPT_TTL)
  return { state, binding }
}

const attemptOf = (db: DatabaseSync, state: string) =>
  db.prepare('select id, binding_hash, purpose, session_id, invite_hash, expires_at, verified_steamid, used_at from login_attempts where state_hash = ?')
    .get(hash(state)) as Attempt | undefined

const burn = (db: DatabaseSync, id: number, now: number) =>
  db.prepare('update login_attempts set used_at = ? where id = ? and used_at is null').run(now, id)

// Годна ли попытка для этого браузера. Не годна — гасится: перенос ссылки
// возврата в чужой браузер сжигает её и для своего.
function usable(db: DatabaseSync, a: Attempt | undefined, binding: string, now: number): a is Attempt {
  if (!a) return false
  if (a.used_at != null) return false
  if (now > a.expires_at || !binding || hash(binding) !== a.binding_hash) {
    burn(db, a.id, now)
    return false
  }
  return true
}

type FetchFn = Parameters<typeof verifySignature>[1]

// Возврат от Steam: проверки ответа (openid.ts), повтор nonce, подпись.
// Успех — только отметка «steamid подтверждён» у попытки; сессии нет.
export async function handleReturn(
  db: DatabaseSync, q: Record<string, string>, binding: string, panelUrl: string, now = Date.now(), fetchFn?: FetchFn,
): Promise<{ ok: true } | Fail> {
  const state = String(q.state ?? '')
  const a = attemptOf(db, state)
  if (!usable(db, a, binding, now)) return { error: STALE }
  if (a.verified_steamid) return { error: 'попытка уже подтверждена — повтор ответа Steam' }
  const fail = (error: string) => { burn(db, a.id, now); return { error } }
  const r = checkResponse(q, returnTo(panelUrl, state), now)
  if ('error' in r) return fail(r.error)
  db.prepare('delete from openid_nonces where seen_at < ?').run(now - 2 * NONCE_AGE)
  if (db.prepare('select 1 from openid_nonces where nonce = ?').get(r.nonce)) return fail('повтор ответа Steam')
  // Ожидание Steam — без транзакции: базу на время сети не держим.
  const sig = await verifySignature(q, fetchFn)
  if ('error' in sig) return fail(sig.error)
  // После подписи — одной транзакцией (ревью PR #32, P2): попытка всё ещё
  // годна и не подтверждена, nonce ещё не встречался. Два одновременных
  // ответа с одним nonce или на одну попытку — подтвердится только один.
  db.exec('begin immediate')
  try {
    const fresh = attemptOf(db, state)
    if (!fresh || fresh.used_at != null || fresh.verified_steamid || now > fresh.expires_at) {
      db.exec('rollback')
      return { error: 'повтор ответа Steam' }
    }
    const n = db.prepare('insert or ignore into openid_nonces (nonce, seen_at) values (?, ?)').run(r.nonce, now)
    if (Number(n.changes) !== 1) {
      db.prepare('update login_attempts set used_at = ? where id = ? and used_at is null').run(now, a.id)
      db.exec('commit')
      return { error: 'повтор ответа Steam' }
    }
    db.prepare('update login_attempts set verified_steamid = ? where id = ? and used_at is null and verified_steamid is null').run(r.steamid, a.id)
    db.exec('commit')
    return { ok: true }
  } catch (e: any) {
    db.exec('rollback')
    return { error: String(e?.message ?? e) }
  }
}

// Завершение со своей страницы. Попытка гасится до действия — второй
// finish получит отказ.
// confirm — вход по приглашению (§18, «это вы?»): первый вызов показывает,
// какой Steam войдёт, и ничего не создаёт; пользователь создаётся только
// со вторым, подтверждённым.
export function handleFinish(db: DatabaseSync, state: string, binding: string, sessionToken: string | null, now = Date.now(), confirm = false):
  { session: { token: string; expiresAt: number }; user: User } | { bound: string } | { confirm: { steamid: string; name: string } } | Fail {
  db.exec('begin immediate')
  try {
    const r = finish(db, state, binding, sessionToken, now, confirm)
    db.exec('commit')
    return r
  } catch (e: any) {
    db.exec('rollback')
    return { error: String(e?.message ?? e) }
  }
}

function finish(db: DatabaseSync, state: string, binding: string, sessionToken: string | null, now: number, confirm: boolean) {
  const a = attemptOf(db, state)
  if (!usable(db, a, binding, now) || !a.verified_steamid) return { error: STALE }
  if (a.purpose === 'приглашение') return finishInvite(db, a, now, confirm)
  if (a.purpose === 'привязка владельца') {
    const who = sessionUser(db, sessionToken ?? '', now)
    if (!who || who.sessionId !== a.session_id || who.user.role !== 'владелец') { burn(db, a.id, now); return { error: STALE } }
    burn(db, a.id, now)
    const owner = userById(db, OWNER_ID)!
    if (owner.steamid && owner.steamid !== a.verified_steamid) return { error: 'Steam владельца уже привязан — другой не привязать' }
    db.prepare('update users set steamid = ? where id = ?').run(a.verified_steamid, OWNER_ID)
    logAuth(db, 'привязан Steam владельца', now)
    return { bound: a.verified_steamid }
  }
  burn(db, a.id, now)
  // Решение 16: владелец — всегда; остальные — пока открыт вход или действует
  // допуск для приёмки на этот steamid.
  const sid = a.verified_steamid
  let u = db.prepare('select id, steamid, name, role, disabled_at from users where steamid = ?').get(sid) as User | undefined
  if (u?.disabled_at != null && u) return { error: 'доступ отключён владельцем' }
  if (!u && permitAllows(db, sid, now)) u = createUser(db, sid, 'приёмка', null, now)
  if (!u) { logAuth(db, 'вход: не приглашён', now); return { error: entryOpen(db) ? 'этот Steam не приглашён' : 'вход в панель пока закрыт' } }
  if (!admitted(db, u, now)) { logAuth(db, 'вход закрыт', now); return { error: 'вход в панель пока закрыт' } }
  logAuth(db, 'вход через Steam', now)
  return { session: newSession(db, u.id, 'steam', now), user: u }
}

function createUser(db: DatabaseSync, steamid: string, name: string, limits: object | null, now: number): User {
  const id = 'u-' + crypto.randomBytes(6).toString('hex')
  db.prepare(`insert into users (id, steamid, name, role, limits_json, created_at) values (?, ?, ?, 'пользователь', ?, ?)`)
    .run(id, steamid, name, limits ? JSON.stringify(limits) : null, now)
  return userById(db, id)!
}

// Вход по приглашению. Подтверждение — до всяких записей; само создание —
// в одной транзакции с погашением приглашения и попытки.
function finishInvite(db: DatabaseSync, a: Attempt, now: number, confirm: boolean) {
  const sid = a.verified_steamid!
  const inv = db.prepare('select id, name, limits_json, expires_at, used_at, revoked_at from invites where token_hash = ?').get(a.invite_hash ?? '') as
    { id: number; name: string; limits_json: string | null; expires_at: number; used_at: number | null; revoked_at: number | null } | undefined
  if (!inv || inv.used_at != null || inv.revoked_at != null || now > inv.expires_at) { burn(db, a.id, now); return { error: 'приглашение недействительно: истекло, отозвано или уже использовано' } }
  if (!entryOpen(db)) { burn(db, a.id, now); return { error: 'вход в панель пока закрыт' } }
  const existing = db.prepare('select id, role from users where steamid = ?').get(sid) as { id: string; role: string } | undefined
  if (existing) { burn(db, a.id, now); return { error: 'этот Steam уже пользователь панели — входите обычной кнопкой «Войти через Steam»; приглашение не потрачено' } }
  if (!confirm) return { confirm: { steamid: sid, name: inv.name } }
  burn(db, a.id, now)
  const used = useInvite(db, inv.id, sid, now)
  if ('error' in used) return used
  let limits: object | null = null
  try { limits = JSON.parse(inv.limits_json ?? 'null') } catch { }
  const u = createUser(db, sid, inv.name, limits, now)
  logAuth(db, 'вход по приглашению', now, u.id)
  return { session: newSession(db, u.id, 'steam', now), user: u }
}
