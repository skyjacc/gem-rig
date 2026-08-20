// Состояние обхода одной командой.
//
//   node rig/status.ts

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const TOOLS = path.resolve(import.meta.dirname, '..', 'tools')
const db = new DatabaseSync(path.join(TOOLS, 'rig.db'), { readOnly: true })

const has = (t: string) =>
  !!(db.prepare(`select name from sqlite_master where type='table' and name=?`).get(t))

if (!has('vleague')) {
  console.log('обходчик ещё не запускался — таблиц карты нет')
  process.exit(0)
}

const done = db.prepare('select league_id, matches, ts from vleague order by ts').all() as any[]
const lg = (JSON.parse(fs.readFileSync(path.join(TOOLS, 'leagues.json'), 'utf8')) as any[])
  .filter(l => l.hint > 0)
const seen = new Set(done.map(d => String(d.league_id)))
const left = lg.filter(l => !seen.has(String(l.id)))

const n = (s: string) => (db.prepare(s).get() as any).c as number
const matches = n('select count(*) c from vmatch')
const links = n('select count(*) c from vplayer')
const mirror = has('vmatch') ? n(`select count(*) c from vmatch where source = 'mirror'`) : 0

const pct = lg.length ? (100 * done.length / lg.length).toFixed(0) : '—'
console.log(`${done.length}/${lg.length} лиг  (${pct} %)`)
console.log('матчей  ' + matches.toLocaleString('ru'))
console.log('связей  ' + links.toLocaleString('ru'))
if (mirror) console.log('из них от зеркал  ' + mirror.toLocaleString('ru'))

if (!left.length) {
  console.log('обход завершён')
  process.exit(0)
}

// Темп считаем по страницам, а не по лигам: список идёт по убыванию размера,
// и оценка «лиг в минуту» на крупных завышает остаток в разы.
const tail = done.slice(-150)
const span = Math.max((tail[tail.length - 1].ts - tail[0].ts) / 60000, 0.01)
const pages = (l: any) => Math.max(1, Math.ceil(Math.min(l.hint ?? l.matches, 500) / 100))
const pps = tail.reduce((a, d) => a + pages({ hint: d.matches }), 0) / span
const pagesLeft = left.reduce((a, l) => a + pages(l), 0)

const eta = Math.round(pagesLeft / Math.max(pps, 0.01) + left.length * 0.4 / 60)
const age = Math.round((Date.now() - done[done.length - 1].ts) / 1000)

console.log(`осталось ~${eta} мин  (${left.length} лиг, ${pagesLeft} страниц)`)
console.log(age < 120 ? `жив, последняя запись ${age} с назад` : `ВСТАЛ, последняя запись ${age} с назад`)
