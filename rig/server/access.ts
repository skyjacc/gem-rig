// Кого пускать в панель, кроме владельца (план 7.3, §18, решение 16).
//
//   приглашение — одноразовая ссылка на 1 / 7 / 30 дней с пределами;
//                 в базе только хэш токена; использованное не
//                 перепривязывается никогда; отзыв — до использования;
//   вход для приглашённых — закрыт, пока владелец не откроет его сам
//                 (после живой приёмки изоляции); пока закрыт, приглашения
//                 не принимаются;
//   допуск для приёмки — один steamid (тестовый Steam владельца) на 24 часа,
//                 входит при закрытом общем входе; не открывает вход другим.
//
// Здесь только хранение — без пользователей и сессий (users.ts) и без
// остановки работы (app.ts).

import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

const DAY = 86_400_000
export const INVITE_DAYS = [1, 7, 30]
export const PERMIT_TTL = DAY
export const DEFAULT_INVITE_LIMITS = { accounts: 3, senders: 1 }

export const ACCESS_DDL = `
  create table if not exists invites (
    id              integer primary key autoincrement,
    token_hash      text not null unique,
    name            text not null,
    limits_json     text,
    expires_at      integer not null,
    created_by      text not null,
    created_at      integer not null,
    used_at         integer,
    used_by_steamid text,
    revoked_at      integer,
    revoked_by      text
  );
  create table if not exists acceptance_permits (
    id          integer primary key autoincrement,
    steamid     text not null,
    created_by  text not null,
    created_at  integer not null,
    expires_at  integer not null,
    revoked_at  integer,
    revoked_by  text
  );
  create table if not exists server_flags (
    key   text primary key,
    value text,
    at    integer not null,
    by    text not null
  );
  create table if not exists access_log (
    id     integer primary key autoincrement,
    at     integer not null,
    by     text not null,
    what   text not null,
    detail text
  );
`

type Fail = { error: string }
type Limits = { accounts: number; senders: number }

export const hashToken = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const log = (db: DatabaseSync, by: string, what: string, now: number, detail?: string) =>
  db.prepare('insert into access_log (at, by, what, detail) values (?,?,?,?)').run(now, by, what, detail ?? null)

function limitsFrom(v: any): Limits {
  const n = (x: unknown, d: number) => (Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 50 ? (x as number) : d)
  return { accounts: n(v?.accounts, DEFAULT_INVITE_LIMITS.accounts), senders: n(v?.senders, DEFAULT_INVITE_LIMITS.senders) }
}

// ── приглашения ──

export function createInvite(db: DatabaseSync, p: { name: string; days: number; limits?: Partial<Limits> }, by: string, now = Date.now()):
  { id: number; token: string; expiresAt: number } | Fail {
  const name = String(p?.name ?? '').trim()
  if (!name || name.length > 40) return { error: 'имя для списка — от 1 до 40 знаков' }
  if (!INVITE_DAYS.includes(Number(p?.days))) return { error: 'срок ссылки — 1, 7 или 30 дней' }
  const token = crypto.randomBytes(32).toString('base64url')
  const expiresAt = now + Number(p.days) * DAY
  const r = db.prepare('insert into invites (token_hash, name, limits_json, expires_at, created_by, created_at) values (?,?,?,?,?,?)')
    .run(hashToken(token), name, JSON.stringify(limitsFrom(p.limits)), expiresAt, by, now)
  log(db, by, 'приглашение создано', now, name)
  return { id: Number(r.lastInsertRowid), token, expiresAt }
}

type InviteRow = { id: number; name: string; limits_json: string | null; expires_at: number; used_at: number | null; revoked_at: number | null }

// Действующее приглашение по токену: есть, не истекло, не отозвано, не
// использовано. Иначе — null (причина наружу не отдаётся).
export function inviteByToken(db: DatabaseSync, token: string, now = Date.now()) {
  if (!token) return null
  const r = db.prepare('select id, name, limits_json, expires_at, used_at, revoked_at from invites where token_hash = ?').get(hashToken(token)) as InviteRow | undefined
  if (!r || r.used_at != null || r.revoked_at != null || now > r.expires_at) return null
  let limits: Limits = DEFAULT_INVITE_LIMITS
  try { limits = limitsFrom(JSON.parse(r.limits_json ?? '{}')) } catch { }
  return { id: r.id, name: r.name, expiresAt: r.expires_at, limits }
}

// Использовать — только раз; привязывается к первому steamid навсегда.
export function useInvite(db: DatabaseSync, id: number, steamid: string, now = Date.now()): { ok: true } | Fail {
  const r = db.prepare('update invites set used_at = ?, used_by_steamid = ? where id = ? and used_at is null and revoked_at is null and expires_at >= ?')
    .run(now, steamid, id, now)
  if (Number(r.changes) !== 1) return { error: 'приглашение уже использовано, отозвано или истекло' }
  log(db, steamid, 'приглашение использовано', now, String(id))
  return { ok: true }
}

export function revokeInvite(db: DatabaseSync, id: number, by: string, now = Date.now()): { ok: true } | Fail {
  const row = db.prepare('select used_at, revoked_at from invites where id = ?').get(id) as InviteRow | undefined
  if (!row) return { error: 'нет такого приглашения' }
  if (row.used_at != null) return { error: 'приглашение уже использовано — отключите пользователя' }
  if (row.revoked_at != null) return { ok: true }
  db.prepare('update invites set revoked_at = ?, revoked_by = ? where id = ?').run(now, by, id)
  log(db, by, 'приглашение отозвано', now, String(id))
  return { ok: true }
}

export function listInvites(db: DatabaseSync, now = Date.now()) {
  const rows = db.prepare('select id, name, limits_json, expires_at, used_at, revoked_at, created_at from invites order by id desc limit 200').all() as (InviteRow & { created_at: number })[]
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    state: r.used_at != null ? 'использовано' : r.revoked_at != null ? 'отозвано' : now > r.expires_at ? 'истекло' : 'ждёт',
    limits: (() => { try { return limitsFrom(JSON.parse(r.limits_json ?? '{}')) } catch { return DEFAULT_INVITE_LIMITS } })(),
  }))
}

// ── вход для приглашённых ──

export const entryOpen = (db: DatabaseSync) =>
  (db.prepare(`select value from server_flags where key = 'multiuser_open_at'`).get() as { value: string | null } | undefined)?.value != null

export function setEntryOpen(db: DatabaseSync, open: boolean, by: string, now = Date.now()) {
  db.prepare(`insert into server_flags (key, value, at, by) values ('multiuser_open_at', ?, ?, ?)
              on conflict(key) do update set value = excluded.value, at = excluded.at, by = excluded.by`)
    .run(open ? String(now) : null, now, by)
  log(db, by, open ? 'вход открыт' : 'вход закрыт', now)
  return { ok: true as const, open }
}

// ── допуск для приёмки ──

type Permit = { id: number; steamid: string; created_by: string; created_at: number; expires_at: number }

export const activePermit = (db: DatabaseSync, now = Date.now()) =>
  (db.prepare('select id, steamid, created_by, created_at, expires_at from acceptance_permits where revoked_at is null and expires_at > ? order by id desc limit 1')
    .get(now) as Permit | undefined) ?? null

export const permitAllows = (db: DatabaseSync, steamid: string | null, now = Date.now()) =>
  !!steamid && activePermit(db, now)?.steamid === steamid

// С каких моментов действует доступ этого steamid (ревью PR #34): начало
// текущего открытия входа и начало действующего допуска. Сессия, созданная
// раньше обоих, — от прошлого доступа: повторное открытие её не оживляет.
export function accessStarts(db: DatabaseSync, steamid: string | null, now = Date.now()): number[] {
  const out: number[] = []
  const open = (db.prepare(`select value from server_flags where key = 'multiuser_open_at'`).get() as { value: string | null } | undefined)?.value
  if (open != null) out.push(Number(open))
  const p = activePermit(db, now)
  if (p && steamid && p.steamid === steamid) out.push(p.created_at)
  return out
}

export function grantPermit(db: DatabaseSync, steamid: string, by: string, now = Date.now()): { id: number; expiresAt: number } | Fail {
  const sid = String(steamid ?? '').trim()
  if (!/^\d{17}$/.test(sid)) return { error: 'steamid — 17 цифр' }
  if (activePermit(db, now)) return { error: 'уже есть действующий допуск — сначала снимите его' }
  const r = db.prepare('insert into acceptance_permits (steamid, created_by, created_at, expires_at) values (?,?,?,?)')
    .run(sid, by, now, now + PERMIT_TTL)
  log(db, by, 'допуск для приёмки', now, sid)
  return { id: Number(r.lastInsertRowid), expiresAt: now + PERMIT_TTL }
}

export function revokePermit(db: DatabaseSync, by: string, now = Date.now()): { steamid: string } | Fail {
  const p = activePermit(db, now)
  if (!p) return { error: 'нет действующего допуска' }
  db.prepare('update acceptance_permits set revoked_at = ?, revoked_by = ? where id = ?').run(now, by, p.id)
  log(db, by, 'допуск снят', now, p.steamid)
  return { steamid: p.steamid }
}
