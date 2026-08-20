// OpenDota: матчи сущности. Раз выкачали — держим в SQLite, второй раз не ходим.

import { odKey } from './paths.ts'
import { entityMatchesFromDb, saveEntityMatches } from './db.ts'

export type Kind = 'team' | 'player' | 'league' | 'studio' | 'unknown'
export type Match = { id: string; league: string }

// league_id обязателен: GC молча отвергает сообщение без него. Проверено
// 20 августа на матче 8003261364 — без лиги 7204 без обновления, с лигой
// ОБНОВЛЕНО и 507 байт. Матч без лиги в списке — это гарантированно
// потраченное впустую сообщение, поэтому он не должен туда попадать вовсе.
export function usableOnly(rows: Match[]): Match[] {
  return rows.filter(r => /^[0-9]{1,10}$/.test(String(r.league)) && Number(r.league) > 0)
}

const url = (p: string) =>
  'https://api.opendota.com/api' + p + (odKey() ? (p.includes('?') ? '&' : '?') + 'api_key=' + odKey() : '')

export async function entityMatches(kind: Kind, id: number): Promise<Match[]> {
  const cached = entityMatchesFromDb(kind, id)
  if (cached.length) return cached

  let u: string | null = null
  if (kind === 'team') u = url(`/teams/${id}/matches`)
  else if (kind === 'league') u = url(`/leagues/${id}/matches`)
  else if (kind === 'player') u = url(`/players/${id}/matches?significant=1`)
  if (!u) return []

  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'rig' } })
    let rows: any = await r.json()
    if (!Array.isArray(rows)) return []
    // У игрока эндпоинт отдаёт всю историю. Лиговые матчи идут лобби первого типа.
    if (kind === 'player') rows = rows.filter((m: any) => m.lobby_type === 1)
    const out: Match[] = usableOnly(rows
      .filter((m: any) => m.match_id)
      .map((m: any) => ({ id: String(m.match_id), league: String(m.leagueid ?? m.league_id ?? '') })))
    saveEntityMatches(kind, id, out)
    return out
  } catch {
    return []
  }
}
