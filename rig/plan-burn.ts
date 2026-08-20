// Сборка списка матчей на прожиг из локальной карты.
//
//   node rig/plan-burn.ts                    всё, чьи гемы лежат в инвентаре
//   node rig/plan-burn.ts Alliance NaVi      только названные
//   node rig/plan-burn.ts --write            записать CSV для отправщика
//
// Пишет tools/gcwatch/burn-<состав>.csv в формате «match_id,league_id».
// Дальше его выбирают в панели или скармливают отправщику напрямую.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { queueFor, type Pick } from './server/queue.ts'

const TOOLS = path.resolve(import.meta.dirname, '..', 'tools')
const GC = path.join(TOOLS, 'gcwatch')
const WRITE = process.argv.includes('--write')
const WANT = process.argv.slice(2).filter(a => !a.startsWith('--'))

const db = new DatabaseSync(path.join(TOOLS, 'rig.db'), { readOnly: true })
const map = JSON.parse(fs.readFileSync(path.join(TOOLS, 'gem-map.json'), 'utf8')) as any[]

const short = (n: string) => n.replace(/^(Genuine )?Spectator: ?/, '')

const plural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(n) % 100
  if (a > 10 && a < 20) return many
  const b = a % 10
  if (b === 1) return one
  if (b >= 2 && b <= 4) return few
  return many
}

// Что лежит в инвентаре — по последнему срезу счётчиков.
const inInventory = (db.prepare(`
  select gem, count(*) objects from counters
  where ts = (select max(ts) from counters) and gem is not null and gem <> '—'
  group by gem`).all() as any[])

const picks: (Pick & { objects: number })[] = []
for (const row of inInventory) {
  if (WANT.length && !WANT.some(w => String(row.gem).toLowerCase().includes(w.toLowerCase()))) continue
  const g = map.find(x => short(String(x.name)) === row.gem)
  if (!g?.entity_id || (g.kind !== 'team' && g.kind !== 'player')) continue
  picks.push({ key: row.gem, kind: g.kind, id: g.entity_id, objects: Number(row.objects) || 0 })
}

if (!picks.length) {
  console.log('нечего жечь: в инвентаре нет гемов с известной сущностью')
  console.log(WANT.length ? 'проверьте фильтр: ' + WANT.join(', ') : '')
  process.exitCode = 1
} else {
  const queue = queueFor(db, picks)

  console.log('состав:')
  let sumPool = 0
  for (const p of picks) {
    const own = queue.filter(r => r.entities.includes(p.key)).length
    sumPool += own
    console.log('  ' + p.key.padEnd(16) + String(own).padStart(6) + ' ' +
      plural(own, 'матч ', 'матча', 'матчей') + '  ×  ' +
      String(p.objects).padStart(2) + ' ' + plural(p.objects, 'вещь ', 'вещи ', 'вещей') +
      '  =  ' + String(own * p.objects).padStart(7) + ' ' +
      plural(own * p.objects, 'единица', 'единицы', 'единиц'))
  }

  const units = picks.reduce((a, p) => a + queue.filter(r => r.entities.includes(p.key)).length * p.objects, 0)
  const weights = queue.reduce((m: Record<number, number>, r) => (m[r.weight] = (m[r.weight] ?? 0) + 1, m), {})

  console.log()
  console.log('  сумма по сущностям     ' + sumPool)
  console.log('  сообщений к отправке   ' + queue.length + '   ← слияние сэкономило ' + (sumPool - queue.length))
  console.log('  единиц счётчика        ' + units + '   ' + (units / Math.max(queue.length, 1)).toFixed(2) + ' на сообщение')
  console.log('  вес матча: ' + Object.keys(weights).sort((a, b) => Number(b) - Number(a))
    .map(w => w + '× — ' + weights[Number(w)]).join(', '))

  // 76 матчей в минуту — измерено 20 августа при паузе 1000 мс.
  const mins = queue.length / 76
  console.log('  время при паузе 1 с    ' + (mins < 60 ? Math.round(mins) + ' мин' : (mins / 60).toFixed(1) + ' ч'))

  if (WRITE) {
    const name = 'burn-' + (WANT.length ? WANT.join('-') : 'all').toLowerCase().replace(/[^a-z0-9-]+/g, '') + '.csv'
    const file = path.join(GC, name)
    fs.writeFileSync(file, queue.map(r => r.match + ',' + r.league).join('\n') + '\n', 'utf8')
    console.log()
    console.log('записано: ' + file)
    console.log('запуск:   node index.js --ids ' + name + ' --send --delay 1000')
    console.log('          (из папки tools/gcwatch, при закрытых Steam и Dota)')
  } else {
    console.log()
    console.log('ничего не записано. --write чтобы создать файл')
  }
}
