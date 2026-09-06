// Разовый перемер запаса. Идёт по gem-map.json, для каждого гема тянет набор
// матчей через OpenDota /explorer и кладёт в entity_matches вместе с настоящей
// лигой — единственный источник, который отдаёт leagueid.
//
//   node rig/remeasure.ts            только показать, ничего не писать
//   node rig/remeasure.ts --write    записать в базу и в gem-supply.json
//
// Набор сущности не дополняется, а ЗАМЕЩАЕТСЯ: у части гемов он должен
// сократиться. Прежний фильтр lobby_type = 1 втягивал турнирные лобби без
// лиги, у DD таких 509 из 1017, и отправить их нельзя. Поэтому сначала
// удаляем строки сущности, потом пишем новые.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { playerSql, teamSql, leagueSql, parseRows } from './server/explorer.ts'

const TOOLS = path.resolve(import.meta.dirname, '..', 'tools')
const WRITE = process.argv.includes('--write')
const KEY = fs.readFileSync(path.join(TOOLS, 'opendota.key'), 'utf8').trim()
const PAUSE = 1600

const db = new DatabaseSync(path.join(TOOLS, 'rig.db'))
const map = JSON.parse(fs.readFileSync(path.join(TOOLS, 'gem-map.json'), 'utf8')) as any[]
const oldSupply = JSON.parse(fs.readFileSync(path.join(TOOLS, 'gem-supply.json'), 'utf8')) as Record<string, number>

const sqlFor = (g: any): string | null =>
  g.kind === 'player' ? playerSql(g.entity_id)
    : g.kind === 'team' ? teamSql(g.entity_id)
      : g.kind === 'league' ? leagueSql(g.entity_id)
        : null

const wipe = db.prepare(`delete from entity_matches where kind = ? and entity_id = ?`)
const ins = db.prepare(
  `insert or replace into entity_matches (kind, entity_id, match_id, league_id) values (?,?,?,?)`)

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const fresh: Record<string, number> = {}
let skipped = 0, failed = 0

console.log(WRITE ? 'режим: ЗАПИСЬ' : 'режим: только показать, --write чтобы записать')
console.log()
console.log('гем'.padEnd(36) + 'вид'.padEnd(9) + 'было'.padStart(6) + 'стало'.padStart(8) + '   разница')
console.log('-'.repeat(72))

for (const g of map) {
  const name = String(g.name)
  const sql = sqlFor(g)
  if (!sql) {
    console.log(name.padEnd(36) + String(g.kind ?? '—').padEnd(9) + '     сущность не опознана, пропуск')
    skipped++
    continue
  }

  const url = 'https://api.opendota.com/api/explorer?api_key=' + KEY + '&sql=' + encodeURIComponent(sql)
  let rows: { id: string; league: string }[] = []
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'gemtrack' } })
    // Отказ по частоте запросов — это отказ, а не пустая сущность.
    //
    // OpenDota на 429 и 5xx отвечает не JSON-ом, и разбор падает в catch;
    // но её же explorer умеет вернуть 200 с полем err и без rows, и такой
    // ответ раньше проходил как «матчей ноль». В отчёте это выглядело как
    // обнуление запаса команды, и с --write оно ещё и стирало её матчи.
    if (!res.ok) throw new Error('OpenDota ' + res.status)
    const body: any = await res.json()
    if (body?.err) throw new Error(String(body.err).slice(0, 120))
    if (!Array.isArray(body?.rows)) throw new Error('OpenDota не отдал строк')
    rows = parseRows(body)
  } catch (e: any) {
    console.log(name.padEnd(36) + String(g.kind).padEnd(9) + '     ошибка: ' + e.message)
    failed++
    await wait(PAUSE)
    continue
  }

  const was = oldSupply[name] ?? 0
  const now = rows.length
  fresh[name] = now
  const diff = now - was
  const mark = diff === 0 ? '' : (diff > 0 ? '   +' + diff : '   ' + diff)
  console.log(name.padEnd(36) + String(g.kind).padEnd(9) +
    String(was).padStart(6) + String(now).padStart(8) + mark)

  if (WRITE && now > 0) {
    wipe.run(g.kind, g.entity_id)
    for (const r of rows) ins.run(g.kind, g.entity_id, r.id, r.league)
  }
  await wait(PAUSE)
}

console.log('-'.repeat(72))
const sum = Object.values(fresh).reduce((a, b) => a + b, 0)
const empty = Object.entries(fresh).filter(([, n]) => n === 0).map(([k]) => k)
console.log('гемов измерено:', Object.keys(fresh).length, ' пропущено:', skipped, ' ошибок:', failed)
console.log('сумма по гемам:', sum)
console.log('с пустым набором:', empty.length, empty.length ? '— ' + empty.join(', ') : '')

if (WRITE) {
  fs.writeFileSync(path.join(TOOLS, 'gem-supply.json'), JSON.stringify(fresh, null, 1))
  const uni = (db.prepare('select count(distinct match_id) c from entity_matches').get() as any).c
  const noLeague = (db.prepare(
    `select count(*) c from entity_matches where league_id is null or league_id = '' or league_id = '0'`,
  ).get() as any).c
  console.log()
  console.log('записано. уникальных матчей в базе:', uni, ' строк без лиги:', noLeague)
} else {
  console.log()
  console.log('ничего не записано')
}
