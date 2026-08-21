// Площадка market.dota2.net.
//
// Там гемы стоят полцента против трёх-четырёх на Steam — в шесть-восемь раз
// дешевле, и лотов сотни: Alliance 251 штука. Список цен открытый, ключ
// нужен только чтобы покупать.
//
// Сама по себе цена ничего не значит. Гем стоит денег, только если его
// команда или игрок наиграли достаточно матчей: за полцента можно набрать
// сотню самоцветов, которые не дойдут и до трёхсот. Поэтому список цен
// соединяется с нашей картой матчей, и в плане закупки остаётся только то,
// что доходит до цели.
//
// Покупка здесь не делается сама никогда. Деньги тратит человек: работник
// умеет накручивать, но не покупать.

import { settings } from './settings.ts'

const PRICES = 'https://market.dota2.net/api/v2/prices/USD.json'
const API = 'https://market.dota2.net/api/v2/'

export type Offer = {
  gem: string
  name: string      // market_hash_name, им же и покупают
  price: number     // в долларах, как отдаёт площадка
  volume: number    // сколько лотов в продаже
  pool: number      // сколько матчей у команды или игрока по нашей карте
  owned: number     // сколько таких вещей уже лежит в инвентаре
}

export type Ranked = Offer & {
  reaches: boolean          // дойдёт ли до цели
  per1000: number           // цена за тысячу счётчиков
}

// Цена у них в копейках: доллар — тысяча. Округляем вверх, иначе лот
// с ценой 0,0051 не купится по 5.
export function cents(usd: number): number {
  const n = Number(usd)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.ceil(n * 1000)
}

const BARE = /^(Genuine\s+)?Spectator:\s*/i
export const gemName = (hashName: string) =>
  BARE.test(String(hashName ?? '')) ? String(hashName).replace(BARE, '').trim() : ''

// Сначала то, что доходит до цели; внутри — дешевле и чего больше в продаже.
export function rank(offers: Offer[], goal: number): Ranked[] {
  return offers
    .map(o => ({
      ...o,
      reaches: o.pool >= goal,
      per1000: o.pool > 0 ? (o.price / Math.min(o.pool, goal)) * 1000 : Infinity,
    }))
    .sort((a, b) =>
      Number(b.reaches) - Number(a.reaches) ||
      a.price - b.price ||
      b.volume - a.volume ||
      a.gem.localeCompare(b.gem))
}

export type Line = { gem: string; name: string; price: number; take: number; sum: number }

// План закупки: сколько чего взять, чтобы уложиться в деньги.
//
// Берём вширь, а не вглубь: по несколько штук каждого подходящего гема.
// Одно сообщение поднимает все вещи одной команды разом, поэтому вторая
// копия того же гема стоит ноль отправок — но и новая команда даёт свой
// запас матчей. Ровный разбор по списку оставляет выбор за человеком.
export function plan(ranked: Ranked[], budget: number, perGem: number) {
  const lines: Line[] = []
  let left = Number(budget) || 0
  const cap = Math.max(0, Math.trunc(perGem) || 0)

  for (const o of ranked) {
    if (!o.reaches || o.price <= 0) continue
    const affordable = Math.floor((left + 1e-9) / o.price)
    const take = Math.min(cap, o.volume, affordable)
    if (take <= 0) continue
    const sum = take * o.price
    lines.push({ gem: o.gem, name: o.name, price: o.price, take, sum })
    left -= sum
  }

  return { lines, total: lines.reduce((n, l) => n + l.sum, 0), left }
}

// ── обращения к площадке ──

export async function fetchPrices(): Promise<{ items: any[]; error: string | null }> {
  try {
    const r = await fetch(PRICES, { headers: { 'User-Agent': 'gemtrack' } })
    if (!r.ok) return { items: [], error: 'площадка ответила ' + r.status }
    const d: any = await r.json()
    if (!d?.success) return { items: [], error: 'площадка вернула отказ' }
    return { items: d.items ?? [], error: null }
  } catch (e: any) {
    return { items: [], error: e.message }
  }
}

async function call(method: string, key: string, params: Record<string, string | number>) {
  const q = new URLSearchParams({ key, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) })
  const r = await fetch(API + method + '?' + q, { headers: { 'User-Agent': 'gemtrack' } })
  const text = await r.text()
  try { return JSON.parse(text) } catch { return { success: false, error: text.slice(0, 200) } }
}

export const balance = (key: string) => call('get-money', key, {})

// Покупка одного лота.
//
// Цена передаётся потолком: площадка возьмёт самый дешёвый лот не дороже
// неё. Поэтому потолок — это защита, а не заявка: если цена подскочила,
// покупка просто не состоится.
export function buyOne(key: string, hashName: string, maxUsd: number, customId?: string) {
  const price = cents(maxUsd)
  if (!price) return Promise.resolve({ success: false, error: 'нулевая цена' })
  return call('buy', key, {
    hash_name: hashName,
    price,
    ...(customId ? { custom_id: customId } : {}),
  })
}

export const goal = () => settings().goal
