import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { leftFor, entityMatchIds } from './server/supply.ts'

// Пути считаются от файла, а не от текущей папки.
//
// Было '../tools/rig.db' — то есть отчёт работал, только если запускать его
// ровно из rig/. Из корня проекта он молча создавал пустую базу рядом и
// показывал нули по всем гемам. Все остальные утилиты рядом уже считают
// путь от import.meta.dirname.
const TOOLS = path.resolve(import.meta.dirname, '..', 'tools')
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(TOOLS, f), 'utf8'))

const dbFile = path.join(TOOLS, 'rig.db')
if (!fs.existsSync(dbFile)) throw new Error('нет ' + dbFile + ' — сначала запустите панель или обходчик')
const db = new DatabaseSync(dbFile, { readOnly: true })
const map = read('gem-map.json') as any[]
const prev = read('gem-supply.json') as Record<string, number>
const leagues = read('leagues.json') as any[]

// Журнал расхода ведётся по аккаунту, и без него leftFor считает по строке
// «undefined» — то есть всегда ноль сожжённых. Отчёт молча показывал полный
// запас там, где половина уже потрачена. Берём активный аккаунт из реестра.
const reg = read('accounts.json') as { active: string; list: { id: string; steamid: string }[] }
const ACCOUNT = (reg.list.find(a => a.id === reg.active) ?? reg.list[0])?.steamid ?? ''
if (!ACCOUNT) throw new Error('в tools/accounts.json нет ни одного аккаунта — некому приписать расход')

const studioLeagues = (name: string) => {
  const key = name.replace(/^(Genuine )?Spectator: ?/, '').toLowerCase()
  const pat = key === 'beyond the summit' ? /beyond the summit|bts /i : /dota ?cinema/i
  return leagues.filter(l => pat.test(l.name || '')).map(l => l.id)
}
const ent = (g: any) => {
  const e: any = { kind: g.kind, id: g.entity_id }
  if (g.kind === 'studio') e.leagues = studioLeagues(g.name)
  return e
}

const rows = map.map(g => {
  const r = leftFor(db, ent(g), ACCOUNT)
  return { name: g.name.replace(/^(Genuine )?Spectator: ?/, '') || 'без имени', kind: g.kind, ...r, was: prev[g.name] ?? 0 }
}).sort((a, b) => b.supply - a.supply)

console.log('гем'.padEnd(30) + 'вид'.padEnd(9) + 'было'.padStart(6) + 'стало'.padStart(7) + 'сожж'.padStart(6) + '   разница')
console.log('-'.repeat(74))
for (const r of rows) {
  const d = r.supply - r.was
  console.log(r.name.padEnd(30) + String(r.kind).padEnd(9) + String(r.was).padStart(6) +
    String(r.supply).padStart(7) + String(r.burned).padStart(6) +
    (d === 0 ? '' : (d > 0 ? '   +' + d : '   ' + d)))
}
console.log('-'.repeat(74))
const empty = rows.filter(r => r.supply === 0)
console.log('сумма по гемам:', rows.reduce((a, r) => a + r.supply, 0),
  ' с нулём:', empty.length, empty.length ? '— ' + empty.map(r => r.name).join(', ') : '')

const all = new Set<string>()
for (const g of map) for (const m of entityMatchIds(db, ent(g))) all.add(m)
console.log('ОБЪЕДИНЕНИЕ по всем гемам:', all.size, 'уникальных матчей')
