// Steam Web API — первоисточник. Всё остальное, что мы читали, это зеркала:
// OpenDota и STRATZ независимо скребут те же данные и независимо теряют куски.
// Сверка 20 августа: по Ohaiyo STRATZ дал 1916, explorer 1672, общих 1615.
// Ни один не полон. Засчитывает же гем Valve, по своим записям.
//
// IDOTA2Match_570/GetMatchHistory?league_id=N отдаёт все матчи лиги, и в каждом
// сразу оба team_id и все десять account_id. Значит из одного обхода по лигам
// строится полная карта «сущность → матчи» для всех гемов разом.

// Valve подставляет это вместо account_id, когда профиль скрыт.
// Сопоставить такого игрока не с чем, поэтому в карту он не попадает.
export const ANON = 4294967295

export type ValveMatch = {
  matchId: string
  leagueId: string
  radiant: number
  dire: number
  startTime: number
  lobbyType: number
  players: number[]
}

export type Page = {
  matches: ValveMatch[]
  done: boolean
  next: string | null
  error: string | null
}

const num = (v: unknown) => {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function historyUrl(key: string, leagueId: number, startAt: string | null): string {
  const base = 'https://api.steampowered.com/IDOTA2Match_570/GetMatchHistory/v1/'
    + '?league_id=' + num(leagueId)
    + '&matches_requested=100'
  return base + (startAt ? '&start_at_match_id=' + startAt : '') + '&key=' + key
}

export function parseHistory(payload: unknown, leagueId: number): Page {
  const res = (payload as any)?.result
  const raw = res?.matches

  if (!Array.isArray(raw)) {
    // status 1 — норма. Всё остальное Valve объясняет в statusDetail.
    const status = res?.status
    const error = status !== undefined && status !== 1
      ? 'Valve status ' + status + (res.statusDetail ? ': ' + res.statusDetail : '')
      : null
    return { matches: [], done: true, next: null, error }
  }

  const matches: ValveMatch[] = raw.map((m: any) => ({
    matchId: String(m.match_id),
    leagueId: String(num(leagueId)),
    radiant: num(m.radiant_team_id),
    dire: num(m.dire_team_id),
    startTime: num(m.start_time),
    lobbyType: Math.trunc(Number(m.lobby_type)) || 0,
    players: (Array.isArray(m.players) ? m.players : [])
      .map((p: any) => num(p?.account_id))
      .filter((a: number) => a > 0 && a !== ANON),
  }))

  // Страница на сто записей означает, что есть продолжение. Курсор Valve
  // включающий, поэтому отступаем на единицу от последнего id.
  const done = raw.length < 100
  const last = matches.length ? matches[matches.length - 1].matchId : null
  const next = last ? String(BigInt(last) - 1n) : null

  return { matches, done, next, error: null }
}
