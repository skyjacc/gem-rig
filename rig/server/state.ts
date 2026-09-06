// Сборка состояния, которое уходит в браузер по SSE.
//
// Это самая горячая функция панели: она считается на КАЖДОЕ изменение файлов
// отправщика, то есть примерно раз в секунду во время работы. Поэтому здесь
// нет ничего, чего не читает фронт.
//
// Раньше было наоборот. В каждый снимок клались:
//   chart    — полный проход по таблице counters с group by
//   files    — чтение и подсчёт строк ВСЕХ csv в папке отправщика
//   seam     — join по журналу расхода
//   bundles  — разбор json с диска
//   current, delay, steamid, sender, watched
// Ни одно из этих полей фронт не читал: график берёт /api/counters, состояние
// отправщика приходит в autopilot.units. Панель раз в секунду перечитывала
// мегабайты csv и сканировала историю счётчиков, чтобы выбросить результат.

import path from 'node:path'
import { TOOLS, readJson, odKey, steamKey } from './paths.ts'
import { invOf } from './steam.ts'
import { burnedCount, lastConfirmed, ratePerMinute, recentEvents, supplyRows } from './db.ts'
import { db } from './db.ts'
import { arrivalSummary, asideSet } from './arrival.ts'
import { entityStat } from './queue.ts'
import { classifySupply } from './supply.ts'
import { ACCOUNT } from './accounts.ts'
import { autopilotState } from './autopilot.ts'
import { purchaseState } from './purchase.ts'

// Потолок и остаток считаются по локальной карте — по той же выборке,
// из которой строится очередь. Таблица supply хранит только старую оценку
// и врёт: у Ohaiyo там 0 при 1672 пригодных, у DD 1017 при 508.
//
// Запросы индексированы и стоят миллисекунды, но состояние уходит в браузер
// часто. Держим короткий кеш и сбрасываем его, когда журнал сожжённого вырос.
const statCache = new Map<string, { supply: number; burned: number; left: number }>()
let statBurned = -1
let statAt = 0
let statAccount = ''

function stat(kind: string, id: number) {
  if (kind !== 'team' && kind !== 'player') return null
  const n = burnedCount()
  if (n !== statBurned || statAccount !== ACCOUNT() || Date.now() - statAt > 10_000) {
    statCache.clear()
    statBurned = n
    statAccount = ACCOUNT()
    statAt = Date.now()
  }
  const key = kind + ':' + id
  let v = statCache.get(key)
  if (!v) { v = entityStat(db, { key, kind, id }, ACCOUNT()); statCache.set(key, v) }
  return v
}

const norm = (s: string) => String(s ?? '').replace(/^(Genuine\s+)?Spectator:\s*/, '').trim().toLowerCase()

// Каталог гемов и наличие ключей меняются раз в никогда, а состояние уходит
// раз в секунду. Читать json и три файла ключей на каждый снимок незачем.
let slowAt = 0
let slowCache: { catalog: any[]; keys: { opendota: boolean; steam: boolean } } | null = null
function slow() {
  if (!slowCache || Date.now() - slowAt > 60_000) {
    slowCache = {
      catalog: readJson<any[]>(path.join(TOOLS, 'gems.json'), []),
      keys: { opendota: !!odKey(), steam: !!steamKey() },
    }
    slowAt = Date.now()
  }
  return slowCache
}

export type State = ReturnType<typeof buildState>

export function buildState() {
  const { catalog, keys } = slow()
  const supply = supplyRows()
  const supBy = new Map(supply.map(s => [norm(s.gem), s]))
  // Инвентарь активного аккаунта: панель показывает того, на кого переключились.
  const box = invOf()

  // мои гемы
  //
  // Отложенное на продажу помечается, а не прячется: вещь всё ещё в инвентаре
  // и её видно на полке, но фарма под неё больше нет.
  const asideArr = asideSet(db, ACCOUNT())
  const groups = new Map<string, any>()
  for (const r of box.rows) {
    const g = r.gem || '—'
    if (!groups.has(g)) groups.set(g, { gem: g, items: 0, equipped: 0, min: null as number | null, max: 0, icon: r.icon, heroes: new Set<string>(), rows: [] as any[], bare: 0, aside: 0 })
    const e = groups.get(g)
    const isAside = asideArr.has(r.assetid)
    e.items++
    // Значок у вещи не хранится: он один на весь гем и уже лежит в группе.
    // Хеш картинки Steam — полторы сотни знаков, вещей шестьсот с лишним,
    // и на каждый толчок состояния это сто килобайт одного и того же текста:
    // сорок процентов всего снимка. Ни один экран его не читал.
    e.rows.push({
      assetid: r.assetid, name: r.name, hero: r.hero, value: r.value,
      equipped: !!r.equipped,
      // Голый самоцвет и предмет с вставленным — разный товар и разная цена.
      carrier: r.carrier ?? 'item',
      aside: isAside,
    })
    if (isAside) e.aside++
    if ((r.carrier ?? 'item') === 'gem') e.bare++
    e.max = Math.max(e.max, r.value)
    e.min = e.min === null ? r.value : Math.min(e.min, r.value)
    if (r.equipped) e.equipped++
    if (r.hero) e.heroes.add(r.hero)
  }

  const mine = [...groups.values()].map(e => {
    const s = supBy.get(norm(e.gem))
    const st = s?.kind && s?.entity_id ? stat(s.kind, s.entity_id) : null
    const estimate = s?.matches ?? null
    return {
      gem: e.gem, items: e.items, equipped: e.equipped, min: e.min, max: e.max, icon: e.icon,
      heroes: [...e.heroes].join(', '),
      // Каждая вещь отдельно: группа скрывает, что у 29 предметов BZZ
      // счётчики от нуля до двенадцати, а продаётся именно предмет.
      rows: (e.rows as any[]).sort((x, y) => y.value - x.value),
      bare: e.bare,
      socketed: e.items - e.bare,
      aside: e.aside,
      kind: s?.kind ?? null, entityId: s?.entity_id ?? null, entityName: s?.entity_name ?? null,
      supply: st && st.supply > 0 ? st.supply : estimate,
      left: st ? st.left : null,
      spent: st ? st.burned : null,
      supplyKind: classifySupply(st?.supply ?? 0, estimate),
    }
  }).sort((a, b) => b.items - a.items || b.max - a.max)

  const cat = catalog.map(c => {
    const key = norm(c.name)
    const s = supBy.get(key)
    const own = mine.find(m => norm(m.gem) === key)
    const st = s?.kind && s?.entity_id ? stat(s.kind, s.entity_id) : null
    const measured = st && st.supply > 0 ? st.supply : (s?.matches ?? null)
    return {
      // Только то, что читают экраны. listings, kind, entityId, entityName,
      // per1000 и ownedValue считались на все 53 позиции каждый толчок
      // и не открывались нигде.
      name: c.name,
      short: c.name.replace(/^(Genuine\s+)?Spectator:\s*/, '').trim() || 'без имени',
      price: c.price,
      icon: c.icon,
      market: 'https://steamcommunity.com/market/listings/570/' + encodeURIComponent(c.name),
      supply: measured,
      supplyKind: classifySupply(st?.supply ?? 0, s?.matches ?? null),
      ownedItems: own?.items ?? 0,
    }
  }).sort((a, b) => (b.supply ?? 0) - (a.supply ?? 0))

  return {
    ts: Date.now(),
    events: recentEvents(240),
    mine,
    catalog: cat,
    autopilot: autopilotState(),
    purchase: purchaseState(),
    confirmed: lastConfirmed(),
    rate: ratePerMinute(),
    // Инвентарь активного аккаунта. У каждого работника есть свой такой же
    // в autopilot.units[].inv — общее поле врало бы про всех, кроме активного.
    inv: {
      error: box.error,
      private: box.private,
      truncated: box.truncated,
      age: box.ts ? Math.round((Date.now() - box.ts) / 1000) : null,
      items: box.rows.length,
    },
    burned: burnedCount(),
    keys,
    // Сводка сканера прихода: open — выигрыши, ждущие решения. Одно число
    // в состоянии дешевле, чем список: список живёт в /api/arrivals.
    arrivals: arrivalSummary(db),
  }
}
