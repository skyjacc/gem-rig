import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { leftFor, entityMatchIds } from './server/supply.ts'

const db = new DatabaseSync('../tools/rig.db', { readOnly: true })
const map = JSON.parse(fs.readFileSync('../tools/gem-map.json', 'utf8')) as any[]
const prev = JSON.parse(fs.readFileSync('../tools/gem-supply.json', 'utf8')) as Record<string, number>
const leagues = JSON.parse(fs.readFileSync('../tools/leagues.json', 'utf8')) as any[]

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
  const r = leftFor(db, ent(g))
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
