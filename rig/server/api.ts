// Обработчики, которые не про поток состояния: аккаунты, граф, очередь.
// Держим отдельно от index.ts, чтобы тот остался про сборку сервера.

import path from 'node:path'
import { TOOLS, readJson } from './paths.ts'
import { cachedStatus, keyFor } from './marketkeys.ts'
import { db } from './db.ts'
import { ACCOUNT, active, hasSession, linkCancel, linkStart, linkState, list, rename, setActive, unlink, type Account } from './accounts.ts'
import { buildGraph, type GraphEntity } from './graph.ts'
import { hasMap } from './supply.ts'
import { queueFor } from './queue.ts'
import { invOf } from './steam.ts'
import { picks } from './autopilot.ts'
import { arrivalsOf, arrivalSummary, setAside } from './arrival.ts'
import { pieceKey } from './itemset.ts'
import { settings } from './settings.ts'
import { balance, fetchPrices, gemName, impliedRate, nbuRate, rank, type Currency, type Offer } from './market.ts'

const norm = (s: string) => String(s ?? '').replace(/^(Genuine\s+)?Spectator:\s*/, '').trim()

export function accountList() {
  return {
    active: active()?.id ?? null,
    link: linkState(),
    list: list().map(a => ({
      id: a.id,
      label: a.label,
      steamid: a.steamid,
      token: a.token,
      added: a.added,
      session: hasSession(a),
      burned: (db.prepare(`select count(*) c from burned where account = ?`).get(a.steamid) as any).c,
      // Статус ключа площадки. Самого ключа здесь нет и быть не должно.
      market: cachedStatus(a),
    })),
  }
}

export const accountsApi = { linkStart, linkCancel, setActive, unlink, rename }

// ── граф ──
//
// Узлы — сущности, рёбра — общие матчи. Считается по локальной карте,
// поэтому дорого: держим кеш, пока не поменялся состав или журнал.
let gCache: any = null
let gKey = ''

export function graph(scope: 'owned' | 'all' = 'owned') {
  const map = readJson<any[]>(path.join(TOOLS, 'gem-map.json'), [])
  const gems = readJson<any[]>(path.join(TOOLS, 'gems.json'), [])
  const priceBy = new Map<string, number>()
  const iconBy = new Map<string, string>()
  for (const g of gems) {
    const key = norm(g.name)
    const p = parseFloat(String(g.price).replace(/[^\d.]/g, ''))
    if (Number.isFinite(p)) priceBy.set(key, p)
    if (g.icon) iconBy.set(key, g.icon)
  }

  const owned = new Map<string, { items: number; max: number; icon: string }>()
  for (const r of invOf().rows) {
    if (!r.gem || r.gem === '—') continue
    const e = owned.get(r.gem) ?? { items: 0, max: 0, icon: r.icon }
    e.items++
    e.max = Math.max(e.max, r.value)
    owned.set(r.gem, e)
  }

  const key = scope + '|' + [...owned.keys()].sort().join(',') + '|' + ACCOUNT() +
    '|' + (db.prepare(`select count(*) c from burned where account = ?`).get(ACCOUNT()) as any).c
  if (gCache && gKey === key) return gCache

  const entities: GraphEntity[] = []
  for (const g of map) {
    const name = norm(g.name)
    const own = owned.get(name)
    if (scope === 'owned' && !own) continue
    if (!g.entity_id && g.kind !== 'studio') continue
    entities.push({
      key: name,
      kind: g.kind,
      id: Number(g.entity_id) || 0,
      leagues: g.leagues,
      owned: own?.items ?? 0,
      counter: own?.max ?? 0,
      price: priceBy.get(name) ?? null,
      icon: own?.icon ?? iconBy.get(name) ?? '',
    })
  }

  gCache = { ...buildGraph(db, entities, ACCOUNT()), scope, ts: Date.now() }
  gKey = key
  return gCache
}

// ── очередь ──
//
// То же, что уйдёт в отправщик, но без записи файла: посмотреть, что будет
// сожжено и в каком порядке, не запуская ничего.
export function queuePreview(limit = 200) {
  const list = picks()
  if (!list.length) return { total: 0, rows: [], weight2: 0 }
  const rows = queueFor(db, list, ACCOUNT())
  return {
    total: rows.length,
    weight2: rows.filter(r => r.weight > 1).length,
    rows: rows.slice(0, limit),
  }
}

// ── дерево ──
//
// Аккаунт → гем → турниры, откуда у этой сущности матчи. Даёт то, чего
// не даёт сеть пересечений: видно, из чего вообще состоит потолок гема
// и какой турнир кормит его больше всех.

let leagueNames: Map<string, string> | null = null
function leagueName(id: string): string {
  if (!leagueNames) {
    leagueNames = new Map()
    for (const l of readJson<any[]>(path.join(TOOLS, 'leagues.json'), [])) {
      if (l?.id) leagueNames.set(String(l.id), String(l.name ?? ''))
    }
  }
  return leagueNames.get(String(id)) || 'турнир ' + id
}

export type TreeNode = {
  id: string
  label: string
  kind: 'root' | 'gem' | 'league'
  value: number
  burned?: number
  counter?: number
  icon?: string
  children?: TreeNode[]
}

let tCache: TreeNode | null = null
let tKey = ''

export function tree(top = 12): TreeNode {
  const acc = active()
  const list = picks()
  const key = acc?.id + '|' + list.map(p => p.key).join(',') + '|' + top
  if (tCache && tKey === key) return tCache

  const owned = new Map<string, { items: number; max: number; icon: string }>()
  for (const r of invOf().rows) {
    if (!r.gem || r.gem === '—') continue
    const e = owned.get(r.gem) ?? { items: 0, max: 0, icon: r.icon }
    e.items++
    e.max = Math.max(e.max, r.value)
    owned.set(r.gem, e)
  }

  const spent = new Set<string>(
    (db.prepare(`select match_id from burned where account = ? and state = 'confirmed'`)
      .all(acc?.steamid ?? '') as any[]).map(r => String(r.match_id)),
  )

  const gems: TreeNode[] = []
  // Карту строит обходчик; до него разворачивать нечего, и падать незачем.
  for (const p of hasMap(db) ? list : []) {
    const rows = p.kind === 'team'
      ? db.prepare(`select match_id, league_id from vmatch where radiant = ? or dire = ?`).all(p.id, p.id)
      : db.prepare(`select v.match_id, v.league_id from vmatch v join vplayer pl on pl.match_id = v.match_id where pl.account_id = ?`).all(p.id)

    const byLeague = new Map<string, { n: number; burned: number }>()
    let burned = 0
    for (const r of rows as any[]) {
      const lg = String(r.league_id ?? '')
      if (!/^[0-9]{1,10}$/.test(lg) || Number(lg) <= 0) continue
      const e = byLeague.get(lg) ?? { n: 0, burned: 0 }
      e.n++
      if (spent.has(String(r.match_id))) { e.burned++; burned++ }
      byLeague.set(lg, e)
    }

    const own = owned.get(p.key)
    const children = [...byLeague.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, top)
      .map(([lg, v]) => ({
        id: p.key + ':' + lg,
        label: leagueName(lg),
        kind: 'league' as const,
        value: v.n,
        burned: v.burned,
      }))

    const rest = [...byLeague.values()].reduce((n, v) => n + v.n, 0) - children.reduce((n, c) => n + c.value, 0)
    if (rest > 0) {
      children.push({ id: p.key + ':rest', label: 'ещё ' + (byLeague.size - children.length) + ' турниров', kind: 'league', value: rest, burned: 0 })
    }

    gems.push({
      id: p.key,
      label: p.key,
      kind: 'gem',
      value: [...byLeague.values()].reduce((n, v) => n + v.n, 0),
      burned,
      counter: own?.max ?? 0,
      icon: own?.icon ?? '',
      children,
    })
  }

  gems.sort((a, b) => b.value - a.value)
  tCache = {
    id: 'root',
    label: acc?.label ?? 'аккаунт',
    kind: 'root',
    value: gems.reduce((n, g) => n + g.value, 0),
    children: gems,
  }
  tKey = key
  return tCache
}

// ── израсходованные матчи ──
//
// «Какие катки уже ушли» — вопрос, на который человек должен отвечать сам,
// а не спрашивать. Матч расходуется навсегда, поэтому список должен быть
// виден: с турниром, временем и тем, каким гемам он поднял счётчик.
export function burnedList(limit = 500) {
  const acc = ACCOUNT()
  const rows = db.prepare(
    `select match_id, league_id, ts, state from burned where account = ? order by ts desc limit ?`,
  ).all(acc, limit) as any[]

  // Кому этот матч служил: сверяем с наборами гемов из инвентаря.
  const sets = new Map<string, Set<string>>()
  for (const p of hasMap(db) ? picks() : []) {
    const ids = p.kind === 'team'
      ? db.prepare(`select match_id from vmatch where radiant = ? or dire = ?`).all(p.id, p.id)
      : db.prepare(
        `select v.match_id from vmatch v join vplayer pl on pl.match_id = v.match_id where pl.account_id = ?`,
      ).all(p.id)
    sets.set(p.key, new Set((ids as any[]).map(r => String(r.match_id))))
  }

  const total = (db.prepare(`select count(*) c from burned where account = ?`).get(acc) as any).c

  return {
    total,
    rows: rows.map(r => {
      const id = String(r.match_id)
      const gems: string[] = []
      for (const [gem, set] of sets) if (set.has(id)) gems.push(gem)
      return {
        match: id,
        league: String(r.league_id ?? ''),
        leagueName: r.league_id ? leagueName(String(r.league_id)) : '',
        ts: r.ts ?? null,
        state: r.state,
        gems,
      }
    }),
  }
}

// ── приходы ──
//
// Сканер слепых лотов: что лежало в купленной вещи до нас. Список идёт
// с текущим числом и отметкой «ушло» — вещь могли уже продать, и тогда
// строка остаётся историей, а не делом.
export function arrivalList() {
  const acc = ACCOUNT()
  const now = new Map(invOf(acc).rows.map(r => [r.assetid, r.value]))
  return {
    summary: arrivalSummary(db),
    rows: arrivalsOf(db).map(r => ({
      ...r,
      now: now.get(r.assetid) ?? null,
      gone: !now.has(r.assetid),
    })),
  }
}

export function arrivalAside(assetid: string, aside: boolean) {
  setAside(db, assetid, aside)
  return { ok: true }
}

// ── пул наборов ──
//
// Продаётся собранный набор на героя, а не россыпь частей: семь предметов
// Pugna со счётчиками стоят иначе, чем семь одиночных вещей. Поэтому
// инвентарь надо смотреть наборами.
//
// Состав набора Steam отдаёт в описании каждого предмета — значит видно
// и сколько комплектов собирается, и чего до следующего не хватает.
export function itemPool() {
  const goal = settings().goal

  type Kit = {
    key: string
    hero: string
    set: string
    gem: string
    icon: string
    roster: string[]            // из чего набор состоит по данным Steam
    have: Map<string, number>   // сколько у меня каждой части
    items: number
    min: number
    max: number
    equipped: number
    bare: number
  }

  const kits = new Map<string, Kit>()

  for (const r of invOf().rows) {
    // Голые самоцветы одного гема — одна строка, а не двенадцать одинаковых.
    const isBare = r.carrier === 'gem'
    const key = isBare ? 'самоцвет|' + r.gem : (r.set ? (r.hero || '—') + '|' + r.set : 'один|' + r.name)

    let k = kits.get(key)
    if (!k) {
      k = {
        key,
        hero: isBare ? '' : (r.hero || '—'),
        set: isBare ? 'голый самоцвет' : (r.set || r.name),
        gem: r.gem === '—' ? '' : r.gem,
        icon: r.icon,
        roster: isBare ? [] : (r.setPieces ?? []),
        have: new Map(),
        items: 0,
        min: r.value,
        max: r.value,
        equipped: 0,
        bare: 0,
      }
      kits.set(key, k)
    }

    k.items++
    // Ключ без приставки качества: «Inscribed Primeval Staff» — тот же посох.
    k.have.set(pieceKey(r.name), (k.have.get(pieceKey(r.name)) ?? 0) + 1)
    k.min = Math.min(k.min, r.value)
    k.max = Math.max(k.max, r.value)
    if (r.equipped) k.equipped++
    if (isBare) k.bare++
    if (!k.gem && r.gem !== '—') k.gem = r.gem
    if (!k.roster.length && r.setPieces?.length) k.roster = r.setPieces
  }

  const list = [...kits.values()].map(k => {
    const roster = k.roster.length ? k.roster : [...k.have.keys()]
    const missing = roster.filter(p => !k.have.get(pieceKey(p)))
    // Сколько полных комплектов собирается: по самой редкой части.
    const complete = missing.length ? 0 : Math.min(...roster.map(p => k.have.get(pieceKey(p)) ?? 0))
    return {
      key: k.key,
      hero: k.hero,
      set: k.set,
      gem: k.gem,
      icon: k.icon,
      items: k.items,
      pieces: roster.length,
      distinct: roster.length - missing.length,
      missing,
      complete,                       // сколько полных наборов собирается
      spare: k.items - complete * roster.length,
      min: k.min,
      max: k.max,
      equipped: k.equipped,
      bare: k.bare,
      ready: k.min >= goal,
    }
  })

  list.sort((a, b) => b.complete - a.complete || b.items - a.items || b.max - a.max)
  return { goal, kits: list }
}

// ── скупка ──
//
// Терминал закупки. Цена лота сама по себе ничего не значит: за полцента
// можно набрать сотню самоцветов, которые не дойдут и до трёхсот просмотров.
// Значение имеет связка «цена — запас матчей — сколько отправок это стоит».
//
// И ограничение у нас не деньги, а время. Копия гема, который уже
// накручивается, стоит НОЛЬ отправок: одно сообщение поднимает все вещи
// этой команды разом. Новая команда — это полный прогон в тысячу отправок.
// Поэтому в терминале две колонки прибыли: на доллар и на отправку.

type Cache = { at: number; items: any[]; error: string | null }
const priceCache = new Map<string, Cache>()
let rateCache = { at: 0, usdToUah: 0 }

// Курс доллара к гривне у площадки взять негде — её цен в гривне нет вовсе.
// Берём у Национального банка и подписываем, что это пересчёт.
async function uah(): Promise<number> {
  if (Date.now() - rateCache.at < 6 * 3600_000 && rateCache.usdToUah) return rateCache.usdToUah
  const r = await nbuRate()
  if (r) rateCache = { at: Date.now(), usdToUah: r }
  return rateCache.usdToUah
}

async function prices(currency: Currency, force: boolean): Promise<Cache> {
  const native: Currency = currency === 'UAH' ? 'USD' : currency
  const has = priceCache.get(native)
  if (!force && has?.items.length && Date.now() - has.at < 120_000) return has
  const r = await fetchPrices(native)
  const next: Cache = r.items.length
    ? { at: Date.now(), items: r.items, error: null }
    : { at: has?.at ?? 0, items: has?.items ?? [], error: r.error }
  priceCache.set(native, next)
  return next
}

// Матчи сущности из карты. Список нужен и для потолка, и для пересечения
// с тем, что уже накручивается, поэтому он считается один раз на заход.
function entityIds(kind: string, id: number): string[] {
  if (!hasMap(db)) return []
  const rows = kind === 'team'
    ? db.prepare(`select match_id from vmatch where radiant = ? or dire = ?`).all(id, id)
    : db.prepare(
      `select distinct v.match_id from vmatch v join vplayer p on p.match_id = v.match_id where p.account_id = ?`,
    ).all(id)
  return (rows as any[]).map(r => String(r.match_id))
}

// Итог разбора площадки живёт минуту.
//
// Раньше он пересчитывался на каждый запрос, а панель запрашивала его
// на каждый толчок состояния — то есть примерно раз в секунду во время
// работы. Это сотни запросов к базе в секунду ради списка, который меняется
// не чаще, чем обновляются цены.
type ScanCache = { key: string; at: number; value: any }
let scanCache: ScanCache | null = null

// Баланс площадки — обращение по сети, и его нельзя дёргать на каждый
// показ списка. Полминуты достаточно: деньги списываются только через
// закупку, а она сама толкает состояние.
// Баланс — по аккаунту: у каждого свой ключ, значит и свой счёт.
const moneyCache = new Map<string, { at: number; value: any }>()
async function money(force: boolean, a: Account) {
  const key = keyFor(a)
  if (!key) return null
  const c = moneyCache.get(a.id)
  if (!force && c?.value && Date.now() - c.at < 30_000) return c.value
  const r = await balance(key)
  moneyCache.set(a.id, { at: Date.now(), value: r })
  return r
}

// Разбор площадки — для конкретного аккаунта: что у НЕГО уже лежит и что
// накручивается, его баланс и его ключ. Раньше всё бралось у активного,
// а покупалось общим ключом — и лоты уезжали не туда, куда считался план.
export async function marketScan(force = false, currency: Currency = 'USD', who: Account | null = active()) {
  const a = who ?? active()
  const s = settings()
  const goal = s.goal

  const cache = await prices(currency, force)
  // В гривне цены не выдают вовсе, поэтому доллар пересчитывается курсом НБУ.
  const rate = currency === 'UAH' ? await uah() : 1
  const sell = s.sellPrice * (currency === 'UAH' ? rate : await sellRate(currency, force))

  // Что уже лежит и что уже накручивается — от этого зависит цена в отправках.
  const owned = new Map<string, number>()
  for (const r of invOf(a.steamid).rows) {
    if (!r.gem || r.gem === '—') continue
    owned.set(r.gem, (owned.get(r.gem) ?? 0) + 1)
  }
  const mine = picks(a.steamid)
  const burning = new Set(mine.map(p => p.key))

  const key = [a.id, currency, goal, s.sellPrice, s.perGem, cache.at, [...burning].sort().join(','), [...owned.keys()].sort().join(',')].join('|')
  const acc: any = await money(force, a)
  // Кому считается и с каким ключом — без самого ключа.
  const whom = { account: { id: a.id, label: a.label }, key: cachedStatus(a) }
  if (!force && scanCache && scanCache.key === key && Date.now() - scanCache.at < 60_000) {
    return {
      ...scanCache.value,
      ...whom,
      balance: acc?.success ? Number(acc.money) || 0 : null,
      balanceCurrency: acc?.currency ?? null,
      balanceError: keyFor(a) ? (acc?.success ? null : (acc?.error ?? 'площадка не ответила')) : 'нет ключа',
    }
  }

  const map = readJson<any[]>(path.join(TOOLS, 'gem-map.json'), [])
  const byName = new Map<string, any>()
  for (const g of map) byName.set(norm(g.name), g)

  // Матчи, которые уже уходят в работу. Пересечение с ними — это то, ради
  // чего вообще стоит покупать вместе: общий матч поднимает обе сущности
  // одной отправкой, значит новый гем получает свой счётчик бесплатно.
  const mineIds = new Set<string>()
  for (const p of mine) for (const m of entityIds(p.kind, p.id)) mineIds.add(m)

  const offers: (Offer & { overlap: number })[] = []
  for (const it of cache.items) {
    const gem = gemName(it.market_hash_name ?? '')
    if (!gem) continue
    const g = byName.get(gem)
    if (!g?.entity_id || (g.kind !== 'team' && g.kind !== 'player')) continue

    const ids = entityIds(g.kind, g.entity_id)
    let overlap = 0
    if (!burning.has(gem)) for (const m of ids) if (mineIds.has(m)) overlap++

    offers.push({
      gem,
      name: it.market_hash_name,
      price: (Number(it.price) || 0) * rate,
      volume: Number(it.volume) || 0,
      pool: ids.length,
      owned: owned.get(gem) ?? 0,
      overlap,
    })
  }

  const ranked = rank(offers, goal).map(o => {
    const over = (o as any).overlap as number
    // Отправок на штуку: копия уже накручиваемого гема не стоит ни одной,
    // новая команда — полный прогон до цели, но её общие с моими матчи
    // поднимутся сами собой и в этот прогон не входят.
    const sends = burning.has(o.gem) ? 0 : Math.max(0, Math.min(o.pool, goal) - Math.min(over, goal))
    return {
      ...o,
      burning: burning.has(o.gem),
      overlap: over,
      sends,
      revenue: o.reaches ? sell : 0,
      profit: o.reaches ? sell - o.price : -o.price,
    }
  })

  const value = {
    goal,
    sell,
    currency,
    // Точная цена площадки или пересчёт: подписываем честно.
    converted: currency === 'UAH',
    rate: currency === 'UAH' ? rate : 1,
    perGem: s.perGem,
    updated: cache.at,
    error: cache.error,
    scanned: cache.items.length,
    offers: ranked,
  }
  scanCache = { key, at: Date.now(), value }

  return {
    ...value,
    ...whom,
    balance: acc?.success ? Number(acc.money) || 0 : null,
    balanceCurrency: acc?.currency ?? null,
    balanceError: keyFor(a) ? (acc?.success ? null : (acc?.error ?? 'площадка не ответила')) : 'нет ключа',
  }
}

// Цена продажи хранится в долларах. Чтобы показать её в валюте площадки,
// нужен курс — берём его по её же ценам, а не со стороны.
async function sellRate(currency: Currency, force: boolean): Promise<number> {
  if (currency === 'USD') return 1
  const [usd, other] = await Promise.all([prices('USD', force), prices(currency, force)])
  return impliedRate(usd.items, other.items) || 1
}

// Покупка живёт в purchase.ts: она стала наблюдаемой работой, которую
// можно остановить. Второй путь к трате денег убран намеренно.
