// Обход всех лиг через Steam Web API — построение локальной карты
// «матч → лига, обе команды, десять игроков».
//
//   node rig/crawl.ts --leagues     собрать список лиг и показать объём
//   node rig/crawl.ts               обойти лиги и записать в базу
//   node rig/crawl.ts --limit 20    обойти только первые 20 (для проверки)
//
// Возобновляемый: пройденные лиги помечаются в vleague, повторный запуск
// продолжает с того места, где остановился. Обход длинный, терять его нельзя.
//
// После обхода запас любого гема — локальный SQL, и внешние источники
// не нужны ни для перемера, ни для очередей, ни для новых гемов.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { historyUrl, parseHistory } from './server/valve.ts'

const TOOLS = path.resolve(import.meta.dirname, '..', 'tools')
const KEY = fs.readFileSync(path.join(TOOLS, 'steam.key'), 'utf8').trim()
const OD_KEY = fs.readFileSync(path.join(TOOLS, 'opendota.key'), 'utf8').trim()
const LEAGUES_FILE = path.join(TOOLS, 'leagues.json')

const argv = process.argv.slice(2)
const ONLY_LEAGUES = argv.includes('--leagues')
const LIMIT = Number(argv[argv.indexOf('--limit') + 1]) || 0
// По умолчанию обходим только лиги, про которые известно, что в них есть матчи.
// OpenDota знает 10 093 записи, но матчи есть примерно в 1210 — остальные это
// пустые заготовки и дубликаты. --all прогоняет и их, это ещё часа два.
const ALL = argv.includes('--all')
const PAUSE = 400
const UA = { 'User-Agent': 'gemtrack' }

const db = new DatabaseSync(path.join(TOOLS, 'rig.db'))
db.exec(`
  create table if not exists vmatch (
    match_id   text primary key,
    league_id  text,
    radiant    integer,
    dire       integer,
    start_time integer,
    lobby_type integer
  );
  create table if not exists vplayer (
    match_id   text,
    account_id integer,
    primary key (match_id, account_id)
  );
  create table if not exists vleague (
    league_id text primary key,
    matches   integer,
    done      integer,
    ts        integer,
    error     text
  );
  create index if not exists idx_vmatch_league on vmatch (league_id);
  create index if not exists idx_vmatch_rad    on vmatch (radiant);
  create index if not exists idx_vmatch_dire   on vmatch (dire);
  create index if not exists idx_vplayer_acc   on vplayer (account_id);
`)

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── список лиг: объединение двух источников ──
// Datdota знает 1212 лиг с матчами и сразу говорит, сколько их в каждой.
// OpenDota знает 10 093 записи, включая пустые и дубликаты. Берём оба:
// пропустить лигу дороже, чем сделать лишний запрос.
async function collectLeagues(): Promise<{ id: number; hint: number; name: string }[]> {
  const byId = new Map<number, { id: number; hint: number; name: string }>()

  try {
    const r = await fetch('https://api.datdota.com/api/leagues', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36' },
    })
    const j: any = await r.json()
    for (const l of j?.data ?? []) {
      const id = Number(l.leagueId)
      if (id > 0) byId.set(id, { id, hint: Number(l.count) || 0, name: String(l.name || '') })
    }
    console.log('datdota:', byId.size, 'лиг')
  } catch (e: any) { console.log('datdota недоступна:', e.message) }

  try {
    const sql = 'SELECT leagueid, name FROM leagues ORDER BY leagueid'
    const r = await fetch('https://api.opendota.com/api/explorer?api_key=' + OD_KEY + '&sql=' + encodeURIComponent(sql), { headers: UA })
    const j: any = await r.json()
    let added = 0
    for (const l of j?.rows ?? []) {
      const id = Number(l.leagueid)
      if (id > 0 && !byId.has(id)) { byId.set(id, { id, hint: 0, name: String(l.name || '') }); added++ }
    }
    console.log('opendota добавила:', added, 'лиг, которых не было у datdota')
  } catch (e: any) { console.log('opendota недоступна:', e.message) }

  const all = [...byId.values()].sort((a, b) => b.hint - a.hint || a.id - b.id)
  fs.writeFileSync(LEAGUES_FILE, JSON.stringify(all, null, 1))
  return all
}

// ── обход одной лиги со всеми страницами ──
const insM = db.prepare(
  `insert or ignore into vmatch (match_id, league_id, radiant, dire, start_time, lobby_type) values (?,?,?,?,?,?)`)
const insP = db.prepare(`insert or ignore into vplayer (match_id, account_id) values (?,?)`)
const mark = db.prepare(`insert or replace into vleague (league_id, matches, done, ts, error) values (?,?,?,?,?)`)

async function crawlLeague(id: number): Promise<{ n: number; error: string | null }> {
  let start: string | null = null
  let n = 0

  for (let page = 0; page < 200; page++) {
    let payload: unknown = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(historyUrl(KEY, id, start), { headers: UA })
        if (res.status === 429) { await wait(30_000); continue }
        if (!res.ok) return { n, error: 'HTTP ' + res.status }
        payload = await res.json()
        break
      } catch (e: any) {
        if (attempt === 2) return { n, error: e.message }
        await wait(2000)
      }
    }

    const p = parseHistory(payload, id)
    if (p.error) return { n, error: p.error }

    for (const m of p.matches) {
      insM.run(m.matchId, m.leagueId, m.radiant, m.dire, m.startTime, m.lobbyType)
      for (const a of m.players) insP.run(m.matchId, a)
      n++
    }

    if (p.done || !p.next) break
    start = p.next
    await wait(PAUSE)
  }
  return { n, error: null }
}

// ── прогон ──
const leagues = fs.existsSync(LEAGUES_FILE) && !ONLY_LEAGUES
  ? JSON.parse(fs.readFileSync(LEAGUES_FILE, 'utf8'))
  : await collectLeagues()

const hinted = leagues.reduce((a: number, l: any) => a + l.hint, 0)
console.log('лиг к обходу:', leagues.length, ' известно матчей заранее:', hinted)

if (ONLY_LEAGUES) {
  console.log('список записан в', LEAGUES_FILE)
  process.exit(0)
}

const doneIds = new Set(
  (db.prepare(`select league_id from vleague where done = 1`).all() as any[]).map(r => String(r.league_id)))
const todo = leagues
  .filter((l: any) => ALL || l.hint > 0)
  .filter((l: any) => !doneIds.has(String(l.id)))
  .slice(0, LIMIT || undefined)
console.log(ALL ? 'режим: все лиги' : 'режим: только лиги с известными матчами (--all для полного обхода)')
console.log('уже пройдено:', doneIds.size, ' осталось:', todo.length)

// Valve отдаёт максимум 500 матчей на лигу — проверено: total_results
// приходит равным 500 даже там, где матчей 4798. Курсор ниже самого старого
// даёт пусто, date_min и date_max игнорируются. Обхода нет.
// Крупные лиги придётся дополнять зеркалами.
const capped = todo.filter((l: any) => l.hint > 500)
if (capped.length) {
  const lost = capped.reduce((a: number, l: any) => a + (l.hint - 500), 0)
  console.log('лиг крупнее 500:', capped.length, '— из них Valve отдаст только по 500, недоберём', lost, 'матчей')
}
console.log()

const started = Date.now()
let total = 0, failed = 0, i = 0

for (const l of todo) {
  i++
  const { n, error } = await crawlLeague(l.id)
  total += n
  if (error) failed++
  mark.run(String(l.id), n, error ? 0 : 1, Date.now(), error)

  if (n > 0 || error || i % 50 === 0) {
    const mins = (Date.now() - started) / 60000
    const rate = i / Math.max(mins, 0.01)
    const left = Math.round((todo.length - i) / Math.max(rate, 0.01))
    console.log(
      String(i).padStart(5) + '/' + todo.length,
      String(l.id).padStart(6),
      String(n).padStart(5) + ' матчей',
      error ? ('  ОШИБКА: ' + error) : '',
      '   осталось ~' + left + ' мин   ' + String(l.name).slice(0, 40))
  }
  await wait(PAUSE)
}

const vm = (db.prepare('select count(*) c from vmatch').get() as any).c
const vp = (db.prepare('select count(*) c from vplayer').get() as any).c
console.log()
console.log('обход окончен за', Math.round((Date.now() - started) / 60000), 'мин')
console.log('за этот прогон матчей:', total, ' лиг с ошибкой:', failed)
console.log('в базе: матчей', vm, ' связей игрок-матч', vp)
