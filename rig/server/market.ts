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

const API = 'https://market.dota2.net/api/v2/'

// Площадка отдаёт цены в трёх валютах — это её собственные числа, по ним
// и платят. Гривны у неё нет вовсе, запрос отвечает 404, поэтому цена
// в гривне — пересчёт доллара по курсу Национального банка Украины.
// Так и подписано в панели: где точная цена, а где пересчёт.
export type Currency = 'RUB' | 'USD' | 'EUR' | 'UAH'
export const NATIVE: Currency[] = ['RUB', 'USD', 'EUR']
const PRICES = (c: string) => 'https://market.dota2.net/api/v2/prices/' + c + '.json'
const NBU = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&json'

const SIGN: Record<Currency, string> = { RUB: '₽', USD: '$', EUR: '€', UAH: '₴' }

// Доллар пишется знаком спереди и точкой, остальные — знаком сзади
// и запятой. Полцента должно остаться полцентом, а не округлиться в ноль.
export function money(v: number, c: Currency): string {
  const n = Number(v) || 0
  if (c === 'USD') {
    const digits = Math.abs(n) < 0.01 && n !== 0 ? 3 : 2
    return '$' + n.toFixed(digits)
  }
  const [whole, frac] = n.toFixed(2).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+$)/g, ' ')
  return grouped + ',' + frac + ' ' + SIGN[c]
}

// Курс площадки — по её же ценам: берём середину отношений по всем позициям,
// которые есть в обоих списках. Одна перекошенная позиция середину не сдвинет.
export function impliedRate(usd: any[], other: any[]): number {
  const by = new Map<string, number>()
  for (const i of usd) {
    const p = Number(i?.price)
    if (p > 0) by.set(i.market_hash_name, p)
  }
  const ratios: number[] = []
  for (const i of other) {
    const a = by.get(i?.market_hash_name)
    const b = Number(i?.price)
    if (a && a > 0 && b > 0) ratios.push(b / a)
  }
  if (!ratios.length) return 0
  ratios.sort((x, y) => x - y)
  return ratios[Math.floor(ratios.length / 2)]
}

export async function nbuRate(): Promise<number> {
  try {
    const r = await fetch(NBU, { headers: { 'User-Agent': 'gemtrack' } })
    const d: any = await r.json()
    return Number(d?.[0]?.rate) || 0
  } catch { return 0 }
}

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

// Цена при покупке — в мелкой единице валюты СЧЁТА, и множитель у них
// разный: рубль сотня, доллар и евро тысяча. Спутать нельзя: послать
// рублёвую цену с множителем доллара значит переплатить вдесятеро.
//
// Округляем вверх, иначе лот с ценой 0,0051 не купится по пятёрке.
const MINOR: Record<string, number> = { RUB: 100, USD: 1000, EUR: 1000, UAH: 100 }

export function units(value: number, currency: Currency = 'USD'): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.ceil(n * (MINOR[currency] ?? 1000))
}

// Прежнее имя оставлено: доллар — тысяча.
export const cents = (usd: number) => units(usd, 'USD')

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

export async function fetchPrices(currency: Currency = 'USD'): Promise<{ items: any[]; error: string | null }> {
  try {
    const c = NATIVE.includes(currency) ? currency : 'USD'
    const r = await fetch(PRICES(c), { headers: { 'User-Agent': 'gemtrack' } })
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

// Нынешние предложения по предмету. Нужны, чтобы покупать по самой низкой
// цене на момент покупки, а не по той, что была в списке две минуты назад:
// дешёвые лоты кончаются по мере скупки, и цена ползёт вверх.
export const bestOffer = (key: string, hashName: string) =>
  call('search-item-by-hash-name', key, { hash_name: hashName })

// Покупка одного лота.
//
// Цена передаётся потолком: площадка возьмёт самый дешёвый лот не дороже
// неё. Поэтому потолок — это защита, а не заявка: если цена подскочила,
// покупка просто не состоится.
export function buyOne(key: string, hashName: string, max: number, currency: Currency, customId?: string) {
  const price = units(max, currency)
  if (!price) return Promise.resolve({ success: false, error: 'нулевая цена' })
  return call('buy', key, {
    hash_name: hashName,
    price,
    ...(customId ? { custom_id: customId } : {}),
  })
}

export const goal = () => settings().goal
