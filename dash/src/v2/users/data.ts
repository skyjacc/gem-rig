// Данные экрана «Пользователи» (план 7.3, макет 8) — только у владельца.
//
//   пользователи и нагрузка   GET /api/users
//   приглашения               GET /api/users/invites (без ссылок: в базе только хэш)
//
// Владелец видит счётчики — ни чужих аккаунтов, ни ключей, ни денег.
// В показе (VITE_DEMO) — demo/users.json, составленный руками.

import fixture from '../../demo/users.json'
import { DEMO, useJson } from '../../lib/api.ts'

export type Limits = { accounts: number; senders: number }

export type UserRow = {
  id: string
  name: string
  role: 'владелец' | 'пользователь'
  steamid: string | null
  disabled: boolean
  active: boolean
  lastSeen: number | null
  accounts: number
  running: number
  buying: boolean
  limits: Limits | null
}

export type UsersResp = {
  users: UserRow[]
  entryOpen: boolean
  permit: { steamid: string; expiresAt: number } | null
  load: { users: number; accounts: number; running: number; dbBytes: number | null }
}

export type Invite = { id: number; name: string; createdAt: number; expiresAt: number; state: 'ждёт' | 'использовано' | 'отозвано' | 'истекло'; limits: Limits }

const FIX: any = fixture

export function useUsers(on: boolean, ts: unknown) {
  const users = useJson<UsersResp>(on && !DEMO ? '/api/users' : null, ts)
  const invites = useJson<Invite[]>(on && !DEMO ? '/api/users/invites' : null, ts)
  const canned = <T,>(d: T) => ({ data: d, loading: false, error: null as string | null, reload: () => { } })
  return {
    users: DEMO ? canned(FIX.users as UsersResp) : users,
    invites: DEMO ? canned(FIX.invites as Invite[]) : invites,
  }
}

export type UsersData = ReturnType<typeof useUsers>
