import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { streamHub, logoutAllFor, logoutFor } from './streams.ts'
import { setEntryOpen } from './access.ts'
import { ensureOwner, IDLE, newSession, OWNER_ID, sessionUser, TOKEN_TTL, USERS_DDL } from './users.ts'

// Поток состояния и сессии (ревью PR #32, P1): выход, «выйти везде» и
// истечение срока закрывают уже открытые потоки, а не только следующий
// запрос. Потоки — поддельные соединения: пишут в массив и помнят end().

const T0 = Date.UTC(2026, 9, 5, 12)

function fresh() {
  const db = new DatabaseSync(':memory:')
  db.exec(USERS_DDL)
  ensureOwner(db, T0)
  db.prepare(`insert into users (id, steamid, name, role, created_at) values ('u2', null, 'второй', 'пользователь', ?)`).run(T0)
  setEntryOpen(db, true, 'owner', T0)   // второй пользователь впущен (план 7.3)
  return db
}

function fakeStream() {
  const s = { got: [] as string[], ended: false, raw: null as any }
  s.raw = {
    write: (x: string) => { if (s.ended) throw new Error('закрыт'); s.got.push(x); return true },
    end: () => { s.ended = true },
  }
  return s
}

// Открыть поток так же, как маршрут /api/stream: по предъявленной сессии.
function open(db: DatabaseSync, hub: ReturnType<typeof streamHub>, token: string, now = T0) {
  const who = sessionUser(db, token, now)!
  const s = fakeStream()
  hub.add(s, who.sessionId, who.user.id)
  return s
}

test('выйти: закрывается поток этой сессии, остальные — нет; данные в закрытый не идут', () => {
  const db = fresh()
  const hub = streamHub()
  const a = newSession(db, OWNER_ID, 'steam', T0)
  const b = newSession(db, OWNER_ID, 'steam', T0)
  const sa = open(db, hub, a.token)
  const sb = open(db, hub, b.token)
  hub.broadcast('data: 1\n\n')
  logoutFor(db, hub, a.token, T0)
  assert.equal(sa.ended, true, 'поток вышедшей сессии закрыт')
  assert.equal(hub.size(), 1, 'закрытый поток убран из рассылки')
  assert.equal(sb.ended, false)
  hub.broadcast('data: 2\n\n')
  assert.deepEqual(sa.got, ['data: 1\n\n'])
  assert.deepEqual(sb.got, ['data: 1\n\n', 'data: 2\n\n'])
  assert.equal(sessionUser(db, a.token, T0), null)
})

test('выйти везде: закрываются все потоки пользователя, чужие — нет', () => {
  const db = fresh()
  const hub = streamHub()
  const a = newSession(db, OWNER_ID, 'steam', T0)
  const b = newSession(db, OWNER_ID, 'токен', T0)
  const other = newSession(db, 'u2', 'steam', T0)
  const sa = open(db, hub, a.token)
  const sb = open(db, hub, b.token)
  const so = open(db, hub, other.token)
  logoutAllFor(db, hub, a.token, T0)
  assert.equal(sa.ended, true)
  assert.equal(sb.ended, true)
  assert.equal(so.ended, false, 'поток другого пользователя живёт')
  hub.broadcast('data: x\n\n')
  assert.deepEqual(so.got, ['data: x\n\n'])
  assert.equal(hub.size(), 1)
})

test('срок сессии истёк при открытом потоке — проверка закрывает поток', () => {
  const db = fresh()
  const hub = streamHub()
  const tok = newSession(db, OWNER_ID, 'токен', T0)
  const st = open(db, hub, tok.token)
  hub.sweep(db, T0 + TOKEN_TTL - 1)
  assert.equal(st.ended, false, 'до срока — живёт')
  hub.sweep(db, T0 + TOKEN_TTL + 1)
  assert.equal(st.ended, true, 'после 12 часов поток закрыт')
  hub.broadcast('data: поздно\n\n')
  assert.deepEqual(st.got, [])
})

test('бездействие и отзыв сессии в обход выхода — проверка закрывает поток', () => {
  const db = fresh()
  const hub = streamHub()
  const idle = newSession(db, OWNER_ID, 'steam', T0)
  const revoked = newSession(db, OWNER_ID, 'steam', T0)
  const si = open(db, hub, idle.token)
  const sr = open(db, hub, revoked.token)
  db.prepare('update sessions set revoked_at = ? where token_hash = (select token_hash from sessions order by id desc limit 1)').run(T0)
  hub.sweep(db, T0 + 1)
  assert.equal(sr.ended, true, 'отозванная — закрыта')
  assert.equal(si.ended, false)
  hub.sweep(db, T0 + IDLE + 1)
  assert.equal(si.ended, true, 'неделя без дела — закрыта')
})

test('отключённый пользователь — проверка закрывает его потоки', () => {
  const db = fresh()
  const hub = streamHub()
  const s = newSession(db, 'u2', 'steam', T0)
  const st = open(db, hub, s.token)
  db.prepare('update users set disabled_at = ? where id = ?').run(T0, 'u2')
  hub.sweep(db, T0 + 1)
  assert.equal(st.ended, true)
})

test('соединение закрылось само — убирается из списка', () => {
  const db = fresh()
  const hub = streamHub()
  const s = newSession(db, OWNER_ID, 'steam', T0)
  const st = open(db, hub, s.token)
  hub.remove(st)
  assert.equal(hub.size(), 0)
  hub.broadcast('data: 1\n\n')
  assert.deepEqual(st.got, [])
})
