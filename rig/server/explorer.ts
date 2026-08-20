// OpenDota /explorer — произвольный SQL по их PostgreSQL.
//
// Зачем он вообще нужен: обычный /players/{id}/matches НЕ содержит поля
// leagueid — проверено перечислением ключей ответа. А league_id обязателен,
// GC без него молча отвергает сообщение (замер 20 августа, матч 8003261364).
// Поэтому для гемов-игроков обычные эндпоинты дают принципиально непригодные
// списки: 2433 строки у BZZ и 1017 у DD, все с пустой лигой.
//
// Условие leagueid > 0 здесь не украшение. Раньше фильтровали по lobby_type = 1,
// и в набор попадали турнирные лобби без записи о лиге — у DD таких оказалось
// 509 из 1017. Отправить их нельзя, значит и в запасе им не место.

export type Match = { id: string; league: string }

// Идентификаторы вставляются в текст запроса, поэтому приводятся к числу.
// Строка в SQL не уходит ни при каких входных данных.
const num = (v: unknown) => {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function playerSql(accountId: number): string {
  return `SELECT pm.match_id, m.leagueid
FROM player_matches pm JOIN matches m ON m.match_id = pm.match_id
WHERE pm.account_id = ${num(accountId)} AND m.leagueid > 0
ORDER BY pm.match_id`
}

export function teamSql(teamId: number): string {
  const t = num(teamId)
  return `SELECT m.match_id, m.leagueid
FROM matches m
WHERE (m.radiant_team_id = ${t} OR m.dire_team_id = ${t}) AND m.leagueid > 0
ORDER BY m.match_id`
}

export function leagueSql(leagueId: number): string {
  return `SELECT m.match_id, m.leagueid
FROM matches m WHERE m.leagueid = ${num(leagueId)}
ORDER BY m.match_id`
}

export function parseRows(payload: unknown): Match[] {
  const rows = (payload as any)?.rows
  if (!Array.isArray(rows)) return []
  const out: Match[] = []
  for (const r of rows) {
    const league = Number(r?.leagueid)
    if (!Number.isFinite(league) || league <= 0) continue
    out.push({ id: String(r.match_id), league: String(league) })
  }
  return out
}
