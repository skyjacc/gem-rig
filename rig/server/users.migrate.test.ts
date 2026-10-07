import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { ensureOwner, migrateUsers, startAttempt, USERS_DDL } from './users.ts'

// Обновление базы этапа 7.1 (ревью PR #34): в таблице попыток входа нет
// колонки invite_hash, и CHECK не знает цели «приглашение».

const T0 = Date.UTC(2026, 9, 7, 12)

// Таблицы ровно как их создавал 7.1 (users.ts на 8fc49ee).
const DDL_71 = `
  create table users (id text primary key, steamid text unique, name text not null,
    role text not null check (role in ('владелец', 'пользователь')), limits_json text, disabled_at integer, created_at integer not null);
  create table sessions (id integer primary key autoincrement, token_hash text not null unique, user_id text not null references users(id),
    kind text not null check (kind in ('steam', 'токен')), created_at integer not null, last_seen_at integer not null,
    expires_at integer not null, revoked_at integer, user_agent text);
  create table login_attempts (
    id              integer primary key autoincrement,
    state_hash      text not null unique,
    binding_hash    text not null,
    purpose         text not null check (purpose in ('вход', 'привязка владельца')),
    session_id      integer,
    created_at      integer not null,
    expires_at      integer not null,
    verified_steamid text,
    used_at         integer
  );
  create table openid_nonces (nonce text primary key, seen_at integer not null);
  create table auth_log (id integer primary key autoincrement, at integer not null, what text not null, detail text);
`

function old() {
  const db = new DatabaseSync(':memory:')
  db.exec(DDL_71)
  db.prepare(`insert into login_attempts (state_hash, binding_hash, purpose, session_id, created_at, expires_at, verified_steamid, used_at)
              values ('s-old', 'b-old', 'вход', null, ?, ?, '76561190000000042', null)`).run(T0, T0 + 600_000)
  return db
}

test('старая база 7.1: после обновления вход начинается, старые попытки на месте', () => {
  const db = old()
  // Как при запуске (app.ts, prepareDb): создать недостающее, потом миграции.
  db.exec(USERS_DDL)
  migrateUsers(db)
  ensureOwner(db, T0)
  const cols = (db.prepare('pragma table_info(login_attempts)').all() as any[]).map(c => c.name)
  assert.ok(cols.includes('invite_hash'))
  const kept = db.prepare(`select * from login_attempts where state_hash = 's-old'`).get() as any
  assert.equal(kept.verified_steamid, '76561190000000042', 'старая строка перенесена')
  assert.equal(kept.invite_hash, null)
  const a = startAttempt(db, 'вход', null, T0)
  assert.ok('state' in a, JSON.stringify(a))
  // Новая цель «приглашение» допустима в CHECK.
  db.prepare(`insert into login_attempts (state_hash, binding_hash, purpose, invite_hash, created_at, expires_at) values ('s2', 'b2', 'приглашение', 'h', ?, ?)`).run(T0, T0 + 1)
  // Повторное обновление ничего не ломает.
  migrateUsers(db)
  assert.equal((db.prepare('select count(*) c from login_attempts').get() as any).c, 3)
})

test('до обновления та же операция падала — ровно то, что чинит миграция', () => {
  const db = old()
  db.exec(USERS_DDL)
  ensureOwner(db, T0)
  assert.throws(() => startAttempt(db, 'вход', null, T0), /invite_hash/)
})
