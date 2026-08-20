// Добор матчей из зеркал туда, где первоисточник не дотянулся.
//
//   node rig/merge-mirrors.ts            показать разрыв, ничего не писать
//   node rig/merge-mirrors.ts --write    добрать и записать
//
// Valve отдаёт максимум 500 матчей на лигу — это проверенный потолок, обхода
// нет. Зеркала таких ограничений не имеют, но теряют своё в других местах:
// по Ohaiyo STRATZ даёт 1916, OpenDota 1672, общих 1615. Поэтому правда —
// объединение, а не выбор «правильного» источника.
//
// Берём у OpenDota сразу матчи ВМЕСТЕ с игроками: их explorer это умеет одним
// запросом. Иначе пришлось бы дёргать GetMatchDetails по одному матчу
// десять тысяч раз.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const TOOLS = path.resolve(import.meta.dirname, '..', 'tools')
const KEY = fs.readFileSync(path.join(TOOLS, 'opendota.key'), 'utf8').trim()
const WRITE = process.argv.includes('--write')
const PAUSE = 1600

const db = new DatabaseSync(path.join(TOOLS, 'rig.db'))
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

async function explorer(sql: string): Promise<any[]> {
  const url = 'https://api.opendota.com/api/explorer?api_key=' + KEY + '&sql=' + encodeURIComponent(sql)
  const r = await fetch(url, { headers: { 'User-Agent': 'gemtrack' } })
  const j: any = await r.json().catch(() => null)
  if (j?.err) { console.log('  SQL отказал:', String(j.err).slice(0, 120)); return [] }
  return j?.rows ?? []
}

// ── где мы отстаём ──
console.log('спрашиваю у OpenDota размеры лиг…')
const odCounts = await explorer(
  'SELECT leagueid, count(*) n FROM matches WHERE leagueid > 0 GROUP BY leagueid')

const ours = new Map<string, number>(
  (db.prepare('select league_id, count(*) n from vmatch group by league_id').all() as any[])
    .map(r => [String(r.league_id), Number(r.n)]))

const behind = odCounts
  .map((r: any) => ({ id: Number(r.leagueid), od: Number(r.n), mine: ours.get(String(r.leagueid)) ?? 0 }))
  .filter(x => x.od > x.mine)
  .sort((a, b) => (b.od - b.mine) - (a.od - a.mine))

const gap = behind.reduce((a, x) => a + (x.od - x.mine), 0)
console.log('лиг, где зеркало знает больше:', behind.length, ' суммарный недобор:', gap)
console.log()
console.log('крупнейшие:')
for (const b of behind.slice(0, 8)) {
  console.log('  лига', String(b.id).padStart(6), ' у нас', String(b.mine).padStart(5),
    ' у зеркала', String(b.od).padStart(5), ' разрыв', String(b.od - b.mine).padStart(5))
}

// process.exit тут ронял libuv ассертом: выход при живых fetch-хендлах.
// Поэтому не выходим, а пропускаем запись.
if (!WRITE) {
  console.log()
  console.log('ничего не записано. --write чтобы добрать')
}

if (WRITE) {

// ── добор ──
const insM = db.prepare(
  `insert or ignore into vmatch (match_id, league_id, radiant, dire, start_time, lobby_type, source)
   values (?,?,?,?,?,?,'mirror')`)
const insP = db.prepare(`insert or ignore into vplayer (match_id, account_id) values (?,?)`)

let addedM = 0, addedP = 0, i = 0
console.log()
for (const b of behind) {
  i++
  // Матчи и участники одним запросом. account_id может быть null у скрытых
  // профилей — такие строки просто не создают связь.
  const rows = await explorer(
    `SELECT m.match_id, m.leagueid, m.radiant_team_id, m.dire_team_id, m.start_time,
            m.lobby_type, pm.account_id
     FROM matches m LEFT JOIN player_matches pm ON pm.match_id = m.match_id
     WHERE m.leagueid = ${b.id}`)

  const seen = new Set<string>()
  for (const r of rows) {
    const id = String(r.match_id)
    if (!seen.has(id)) {
      seen.add(id)
      const before = (db.prepare('select 1 from vmatch where match_id = ?').get(id) as any) ? 1 : 0
      insM.run(id, String(b.id), Number(r.radiant_team_id) || 0, Number(r.dire_team_id) || 0,
        Number(r.start_time) || 0, Number(r.lobby_type) || 0)
      if (!before) addedM++
    }
    const acc = Number(r.account_id)
    if (Number.isFinite(acc) && acc > 0 && acc !== 4294967295) { insP.run(id, acc); addedP++ }
  }

  if (i % 20 === 0 || i === behind.length) {
    console.log('  ' + i + '/' + behind.length, ' добрано матчей:', addedM, ' связей:', addedP)
  }
  await wait(PAUSE)
}

const vm = (db.prepare('select count(*) c from vmatch').get() as any).c
const mirrored = (db.prepare(`select count(*) c from vmatch where source = 'mirror'`).get() as any).c
console.log()
console.log('готово. добрано матчей:', addedM, ' связей:', addedP)
console.log('в базе всего матчей:', vm, ' из них от зеркал:', mirrored)
}
