// Открытые потоки состояния (/api/stream) — вместе с сессией, которая их
// открыла (ревью PR #32, P1).
//
// Выход гасит сессию в базе, но уже открытый поток об этом не знает и
// продолжал бы получать данные. Поэтому каждый поток помнит свою сессию и
// пользователя:
//   выйти         — закрыть потоки этой сессии;
//   выйти везде   — закрыть все потоки пользователя;
//   sweep         — периодически: закрыть потоки, чья сессия истекла,
//                   отозвана в обход выхода или чей пользователь отключён.

import type { DatabaseSync } from 'node:sqlite'
import { revokeAll, revokeSession, sessionAlive, sessionUser } from './users.ts'

type Res = { raw: { write: (s: string) => unknown; end: () => unknown } }
type Entry = { sessionId: number; userId: string }

export function streamHub() {
  const open = new Map<Res, Entry>()
  const close = (res: Res) => {
    open.delete(res)
    try { res.raw.end() } catch { /* уже закрыт */ }
  }
  const write = (res: Res, line: string) => {
    try { res.raw.write(line) } catch { open.delete(res) }
  }
  return {
    add: (res: Res, sessionId: number, userId: string) => { open.set(res, { sessionId, userId }) },
    remove: (res: Res) => { open.delete(res) },
    size: () => open.size,
    broadcast: (line: string) => { for (const res of [...open.keys()]) write(res, line) },
    closeSession: (sessionId: number) => { for (const [res, e] of [...open]) if (e.sessionId === sessionId) close(res) },
    closeUser: (userId: string) => { for (const [res, e] of [...open]) if (e.userId === userId) close(res) },
    sweep: (db: DatabaseSync, now = Date.now()) => {
      for (const [res, e] of [...open]) if (!sessionAlive(db, e.sessionId, now)) close(res)
    },
  }
}

export type StreamHub = ReturnType<typeof streamHub>

// Выйти: сессия гаснет, её открытые потоки закрываются.
export function logoutFor(db: DatabaseSync, hub: StreamHub, token: string, now = Date.now()) {
  const who = sessionUser(db, token, now)
  revokeSession(db, token, now)
  if (who) hub.closeSession(who.sessionId)
}

// Выйти везде: все сессии и все потоки пользователя.
export function logoutAllFor(db: DatabaseSync, hub: StreamHub, token: string, now = Date.now()) {
  const who = sessionUser(db, token, now)
  if (!who) return
  revokeAll(db, who.user.id, now)
  hub.closeUser(who.user.id)
}
