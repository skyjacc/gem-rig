// План закупки под цель «предметы с высоким счётчиком на продажу».
//
//   node rig/plan-purchase.ts             порог 2000, по 10 копий
//   node rig/plan-purchase.ts 1000 20     порог 1000, по 20 копий
//
// Логика цели. Товар — это ПРЕДМЕТ с высоким счётчиком, а не счётчик сам по себе.
// Одно сообщение поднимает все экземпляры сущности разом, поэтому маржинальная
// стоимость второго и двадцатого товара равна нулю сообщений — только цена гема.
//
// Отсюда стратегия «в глубину»: мало сущностей, много копий каждой,
// а не по одному экземпляру всего подряд.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const TOOLS = path.resolve(import.meta.dirname, '..', 'tools')
const FLOOR = Number(process.argv[2]) || 2000
const COPIES = Number(process.argv[3]) || 10

const db = new DatabaseSync(path.join(TOOLS, 'rig.db'), { readOnly: true })
const map = JSON.parse(fs.readFileSync(path.join(TOOLS, 'gem-map.json'), 'utf8')) as any[]
const gems = JSON.parse(fs.readFileSync(path.join(TOOLS, 'gems.json'), 'utf8')) as any[]

const price = new Map(gems.map(g => [g.name, parseFloat(String(g.price).replace(/[^\d.]/g, '')) || 0]))
const lots = new Map(gems.map(g => [g.name, Number(g.listings) || 0]))

// Наборы, которые несут Spectator Gem нашего каталога. Остальные одиннадцать —
// партнёрские бренды снаряжения, к каталогу отношения не имеют.
const BUNDLES: Record<string, { name: string; pieces: number; price: number }> = {
  'Spectator: BZZ': { name: "Nether Lord's Regalia Set", pieces: 7, price: 0.05 },
  'Spectator: NaVi': { name: 'Wings of Obelis Set', pieces: 5, price: 0.04 },
  'Spectator: Sing': { name: 'Artillery of the Crested Cannoneer Set', pieces: 8, price: 0.14 },
}

// Карту матчей строит обходчик, и его могли ещё не запускать. Без проверки
// первый же запрос падает со стеком «no such table: vmatch» вместо внятного
// «сначала обход».
const hasTable = (t: string) =>
  !!db.prepare(`select name from sqlite_master where type='table' and name=?`).get(t)

if (!hasTable('vmatch') || !hasTable('vplayer')) {
  console.log('карты матчей нет — сначала обход: node rig/crawl.ts')
  process.exit(1)
}

const matchIds = (g: any): string[] => {
  if (g.kind === 'team') {
    return (db.prepare('select match_id from vmatch where radiant = ? or dire = ?')
      .all(g.entity_id, g.entity_id) as any[]).map(r => String(r.match_id))
  }
  if (g.kind === 'player') {
    return (db.prepare('select distinct match_id from vplayer where account_id = ?')
      .all(g.entity_id) as any[]).map(r => String(r.match_id))
  }
  return []
}

type Row = {
  gem: string; short: string; kind: string; pool: number
  price: number; lots: number
  via: 'набор' | 'гем'; unit: string; cost: number; objects: number
  ids: string[]
}

// Одна сущность может продаваться под двумя именами. `Genuine Spectator:
// Evil Geniuses` за $40.60 несёт ровно тот же набор матчей, что обычный
// за $0.09 — 2812 из 2812. Второй экземпляр не добавляет ни одного нового
// матча, поэтому из плана выбрасывается более дорогой.
const cheapestPerEntity = new Map<string, string>()
for (const g of map) {
  const key = g.kind + ':' + g.entity_id
  const p = price.get(g.name) ?? Infinity
  const cur = cheapestPerEntity.get(key)
  if (!cur || p < (price.get(cur) ?? Infinity)) cheapestPerEntity.set(key, g.name)
}

const rows: Row[] = []
const dropped: string[] = []
for (const g of map) {
  const key = g.kind + ':' + g.entity_id
  if (cheapestPerEntity.get(key) !== g.name) {
    const ids0 = matchIds(g)
    if (ids0.length >= FLOOR) dropped.push(`${g.name} — дубль ${cheapestPerEntity.get(key)}, тот же набор`)
    continue
  }
  const ids = matchIds(g)
  if (ids.length < FLOOR) continue
  const b = BUNDLES[g.name]
  const bare = price.get(g.name) ?? 0

  // Сколько стоит получить COPIES объектов: набором или поштучно.
  const viaBundle = b ? Math.ceil(COPIES / b.pieces) * b.price : Infinity
  const viaBare = bare * COPIES
  const useBundle = viaBundle < viaBare

  rows.push({
    gem: g.name,
    short: g.name.replace(/^(Genuine )?Spectator: ?/, ''),
    kind: g.kind,
    pool: ids.length,
    price: bare,
    lots: lots.get(g.name) ?? 0,
    via: useBundle ? 'набор' : 'гем',
    unit: useBundle ? `${b!.name} ×${Math.ceil(COPIES / b!.pieces)}` : `гем ×${COPIES}`,
    cost: useBundle ? viaBundle : viaBare,
    objects: useBundle ? Math.ceil(COPIES / b!.pieces) * b!.pieces : COPIES,
    ids,
  })
}
rows.sort((a, b) => a.cost / a.objects - b.cost / b.objects)

console.log(`порог ${FLOOR}+ счётчика, по ${COPIES} экземпляров на сущность`)
console.log()
console.log('сущность'.padEnd(24) + 'потолок'.padStart(8) + 'лотов'.padStart(7) +
  '  как брать'.padEnd(34) + 'цена'.padStart(8) + 'объектов'.padStart(9))
console.log('-'.repeat(92))
for (const r of rows) {
  console.log(r.short.slice(0, 23).padEnd(24) + String(r.pool).padStart(8) + String(r.lots).padStart(7) +
    ('  ' + r.unit).padEnd(34) + ('$' + r.cost.toFixed(2)).padStart(8) + String(r.objects).padStart(9))
}

const uni = new Set<string>()
for (const r of rows) for (const m of r.ids) uni.add(m)
const cost = rows.reduce((a, r) => a + r.cost, 0)
const objects = rows.reduce((a, r) => a + r.objects, 0)

console.log('-'.repeat(92))
console.log()
console.log('ИТОГ')
console.log('  сущностей          ', rows.length)
console.log('  закупка            $' + cost.toFixed(2))
console.log('  объектов на выходе ', objects, '— столько предметов получат счётчик ' + FLOOR + '+')
console.log('  сообщений          ', uni.size, '(объединение, пересечения уже вычтены)')
console.log('  сумма потолков     ', rows.reduce((a, r) => a + r.pool, 0))
console.log('  экономия на пересечениях', rows.reduce((a, r) => a + r.pool, 0) - uni.size)
console.log()
// Оба отношения делятся на счётчики, которые бывают нулём: ни одна сущность
// не прошла порог — и в итоге печаталось «NaN» вместо цены.
console.log('  товаров на тысячу сообщений',
  uni.size ? (objects / uni.size * 1000).toFixed(1) : '—')
console.log('  цена одного товара         ',
  objects ? '$' + (cost / objects).toFixed(4) : '— (ни одна сущность не прошла порог)')

// Узкое место: где лотов меньше, чем надо купить.
const thin = rows.filter(r => r.via === 'гем' && r.lots < COPIES * 3)
if (thin.length) {
  console.log()
  console.log('  ТОНКИЙ РЫНОК — лотов мало, покупка сдвинет цену:')
  for (const r of thin) console.log('    ' + r.short.padEnd(22) + r.lots + ' лотов на ' + COPIES + ' нужных')
}

if (dropped.length) {
  console.log()
  console.log('  ВЫБРОШЕНО КАК ДУБЛЬ:')
  for (const d of dropped) console.log('    ' + d)
}
