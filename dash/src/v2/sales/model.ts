// Продажи (§5.4, план 2.6): деньги из журнала операций и ключи из снимка.
// Только чистые функции — без запросов и React.
//
// Правила плана:
//   решение 11 — масштаб денег по источнику и валюте (SCALE), не общее «÷100»;
//   решение 12 — знаки: покупки — net < 0 (в панели −net), возврат и продажа —
//                net > 0; сторно вместе с исходной из итогов исключается;
//   решение 2  — суммы разных валют не складываются никогда.

import { nf } from '../../lib/num.ts'

export type OpType = 'покупка гема' | 'возврат за покупку' | 'продажа вещи' | 'покупка ключа' | 'выплата Clover' | 'сторно'

export type Op = {
  id: number
  account_id: string | null
  type: OpType
  source: string
  external_id: string
  happened_at: number
  currency: string
  gross: number | null
  fee_steam: number | null
  fee_game: number | null
  net: number
  status: string | null
  raw_ref: string | null
}

const DAY = 86_400_000
const HOUR = 3_600_000

// ── масштаб денег (решение 11) ──

export const SCALE: { source: string; currency: RegExp; div: number; status: string }[] = [
  // план 3.1: paid истории = paid проверки × 100
  { source: 'market.dota2.net', currency: /^RUB$/, div: 100, status: 'OBSERVED' },
  // документация площадки; вживую не видели
  { source: 'market.dota2.net', currency: /^(USD|EUR)$/, div: 1_000, status: 'VERIFIED по документации' },
  // правдоподобие: средняя цена ключа при ÷100 = рыночной в валюте кошелька
  { source: 'рынок Steam', currency: /^steam:\d+$/, div: 100, status: 'OBSERVED по правдоподобию' },
  // план 3.2: выплаты Clover — центы долларовой суммы, которую ввёл владелец
  { source: 'Clover.tf', currency: /^USD$/, div: 100, status: 'ввод владельца, центы' },
]

export const scaleOf = (source: string, currency: string) =>
  SCALE.find(s => s.source === source && s.currency.test(currency))?.div ?? null

const SIGN: Record<string, string> = { RUB: '₽', USD: '$', EUR: '€', 'steam:2018': '₴' }

export function currencyName(currency: string): { sign: string | null; label: string; hint: string | null } {
  if (currency === 'steam:2018') return { sign: '₴', label: '₴ · кошелёк Steam', hint: 'гривна — со слов владельца; что код Steam 2018 = гривна, не сверено' }
  const m = /^steam:(\d+)$/.exec(currency)
  if (m) return { sign: null, label: 'кошелёк Steam · код ' + m[1], hint: 'название валюты по коду Steam не сверено' }
  return { sign: SIGN[currency] ?? null, label: currency, hint: null }
}

// Сумма для показа. Масштаб неизвестен — целым «в единицах источника»,
// а не деньгами: делить на сто там, где на деле на тысячу, — враньё в десять раз.
export function money(source: string, currency: string, units: number): { text: string; known: boolean } {
  const div = scaleOf(source, currency)
  if (div == null) return { text: nf(units) + ' ед. · масштаб не проверен', known: false }
  const v = units / div
  const [w, f] = Math.abs(v).toFixed(2).split('.')
  const num = (v < 0 ? '−' : '') + w.replace(/\B(?=(\d{3})+$)/g, ' ') + ',' + f
  const { sign } = currencyName(currency)
  if (currency === 'USD') return { text: (v < 0 ? '−$' : '$') + Math.abs(v).toFixed(2), known: true }
  return { text: num + ' ' + (sign ?? currency.replace(/^steam:/, 'код ')), known: true }
}

// ── сторно (решение 12) ──

// orphan    — сторно ссылается на операцию, которой нет среди загруженных;
// malformed — external_id сторно не вида storno:<id> — ошибка записи.
// Ни те, ни другие в суммы не входят.
export function clean(ops: Op[]) {
  const byId = new Map(ops.map(o => [o.id, o]))
  const reversed = new Set<number>()
  let orphan = 0
  let malformed = 0
  for (const o of ops) {
    if (o.type !== 'сторно') continue
    const m = /^storno:(\d+)$/.exec(o.external_id)
    if (!m) { malformed++; continue }
    if (byId.has(Number(m[1]))) reversed.add(Number(m[1]))
    else orphan++
  }
  return {
    ops: ops.filter(o => o.type !== 'сторно' && !reversed.has(o.id)),
    reversed: reversed.size,
    orphan,
    malformed,
  }
}

// Что значит сторно без исходной — зависит от того, вся ли история
// загружена. Загружена вся (меньше предела) — исходной нет в журнале вовсе:
// это расхождение журнала. Упёрлись в предел — исходная может быть просто
// старше загруженного: так и говорим, без вывода об ошибке.
export function stornoNotes(c: { reversed: number; orphan: number; malformed: number }, complete: boolean) {
  const out: { text: string; tone: 'hint' | 'warn' }[] = []
  if (c.reversed) out.push({ text: 'Сторнировано операций: ' + nf(c.reversed) + ' — вместе со сторно в итоги не входят.', tone: 'hint' })
  if (c.orphan) {
    out.push(complete
      ? { text: 'Сторно без исходной операции в журнале: ' + nf(c.orphan) + ' — история загружена целиком, исходной нет; это расхождение журнала, в суммы не входит.', tone: 'warn' }
      : { text: 'Сторно, чья исходная не среди загруженных: ' + nf(c.orphan) + ' — история загружена не целиком (предел), исходная может быть старше; в суммы не входит.', tone: 'hint' })
  }
  if (c.malformed) out.push({ text: 'Сторно с неверной ссылкой на исходную (не вида storno:<id>): ' + nf(c.malformed) + ' — ошибка записи журнала, в суммы не входит.', tone: 'warn' })
  return out
}

// ── период ──

export type Period = 'all' | 'month' | 'week'
export const PERIODS: [Period, string][] = [['all', 'всё время'], ['month', 'месяц'], ['week', '7 дней']]

export function inPeriod(ops: Op[], p: Period, now: number) {
  if (p === 'all') return ops
  const from = now - (p === 'month' ? 30 : 7) * DAY
  return ops.filter(o => o.happened_at >= from)
}

// ── суммы по валютам ──

export type Sum = { source: string; currency: string; units: number; n: number }

function add(m: Map<string, Sum>, o: Op, units: number) {
  const k = o.source + '|' + o.currency
  const s = m.get(k) ?? { source: o.source, currency: o.currency, units: 0, n: 0 }
  s.units += units
  s.n++
  m.set(k, s)
}

const sums = (m: Map<string, Sum>) => [...m.values()].sort((a, b) => b.n - a.n)

const spent = (ops: Op[], type: OpType) => {
  const m = new Map<string, Sum>()
  for (const o of ops) if (o.type === type) add(m, o, -o.net)   // затрата: net < 0 → −net
  return sums(m)
}
const came = (ops: Op[], type: OpType) => {
  const m = new Map<string, Sum>()
  for (const o of ops) if (o.type === type) add(m, o, o.net)    // приход: net > 0
  return sums(m)
}

// Вложено = покупки гемов − возвраты, в валюте площадки. Отрицательное — не
// минус на экране, а «расходится» (§3.3).
export type Invested = Sum & { refunds: number; conflict: boolean }

export function invested(ops: Op[]): Invested[] {
  const refunds = new Map(came(ops, 'возврат за покупку').map(s => [s.source + '|' + s.currency, s.units]))
  return spent(ops, 'покупка гема').map(s => {
    const r = refunds.get(s.source + '|' + s.currency) ?? 0
    return { ...s, units: s.units - r, refunds: r, conflict: s.units - r < 0 }
  })
}

export type KeysSummary = {
  onHand: number
  tradableNow: number
  held: number
  unknownTime: number
  conflict: number
  releases: { at: number; keys: number }[]
  nextRelease: { at: number; keys: number } | null
}
export type KeysResp = { snapshot: { id: number; seenAt: number } | null; summary?: KeysSummary; keys?: { assetid: string; tradable: 0 | 1; tradableAfter: number | null; tradableAfterRaw: string | null; state: string }[]; error?: string }

// ── выплаты Clover (план 3.2) ──
//
// Список приходит отдельным маршрутом (/api/money/payouts): все выплаты
// аккаунта и их сторно, без предела общего журнала (решение 11). complete =
// false — сервер упёрся в свой защитный предел: итог тогда «неполно».

export type PayoutList = { ops: Op[]; complete: boolean }

type PayoutRaw = {
  tx?: string; version?: number; corrects?: number | null; asset?: string; assetAmount?: string
  network?: string; usdBy?: string; keys?: number; note?: string
}
const payoutRaw = (o: Op): PayoutRaw => { try { return JSON.parse(o.raw_ref ?? '{}') } catch { return {} } }

// Реализовано (§16) — только выплаты Clover: дошло до рук. Продажи на Steam
// и любые другие типы сюда не входят никогда (решение 2): продажа и выплата
// одной суммы — два события, а не два заработка. Сторнированные выплаты
// убираются вместе со своим сторно (clean) по всему списку, потом — период.
export function realized(list: PayoutList, p: Period = 'all', now = 0) {
  const kept = inPeriod(clean(list.ops).ops.filter(o => o.type === 'выплата Clover'), p, now)
  return {
    sums: came(kept, 'выплата Clover'),
    n: kept.length,
    keys: kept.reduce((a, o) => a + (payoutRaw(o).keys ?? 0), 0),
    estimated: kept.some(o => payoutRaw(o).usdBy !== 'получено'),
    complete: list.complete,
  }
}

export type PayoutRow = {
  op: Op; tx: string; version: number; corrects: number | null; asset: string; assetAmount: string | null
  network: string | null; usdBy: string; keys: number | null; note: string | null; reversed: boolean
  stornoReason: string | null
}

// Строки списка выплат, новые сверху. Номер — из raw_ref.tx, не из
// external_id: «v2:ABC» и самостоятельный «ABC#2» — разные номера.
export function payoutRows(ops: Op[]): PayoutRow[] {
  const reasons = new Map<number, string>()
  for (const o of ops) {
    if (o.type !== 'сторно') continue
    const m = /^storno:(\d+)$/.exec(o.external_id)
    if (!m) continue
    let reason = ''
    try { reason = String(JSON.parse(o.raw_ref ?? '{}').reason ?? '') } catch { }
    reasons.set(Number(m[1]), reason)
  }
  return ops
    .filter(o => o.type === 'выплата Clover')
    .sort((a, b) => b.happened_at - a.happened_at || b.id - a.id)
    .map(o => {
      const r = payoutRaw(o)
      return {
        op: o, tx: r.tx ?? o.external_id, version: r.version ?? 1, corrects: r.corrects ?? null,
        asset: r.asset ?? '—', assetAmount: r.assetAmount ?? null, network: r.network ?? null,
        usdBy: r.usdBy ?? 'владелец', keys: r.keys ?? null, note: r.note ?? null,
        reversed: reasons.has(o.id), stornoReason: reasons.get(o.id) ?? null,
      }
    })
}

// Путь денег: пять узлов (решение 5).
export function path(ops: Op[]) {
  return {
    gems: { n: ops.filter(o => o.type === 'покупка гема').length, sums: invested(ops) },
    sold: { n: ops.filter(o => o.type === 'продажа вещи').length, sums: came(ops, 'продажа вещи') },
    keys: { n: ops.filter(o => o.type === 'покупка ключа').length, sums: spent(ops, 'покупка ключа') },
  }
}

// Средняя сумма одной покупки ключа — положительная: Σ(−net) / число покупок.
// Это «за покупку», а не «за ключ»: поля количества в истории нет.
export const avg = (s: Sum) => (s.n ? Math.round(s.units / s.n) : 0)

// ── дни ──

export const dayKey = (ts: number) => {
  const d = new Date(ts)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
export const dayLabel = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
}

// Валюты кошелька — по числу операций, больше — первой.
export function walletCurrencies(ops: Op[]) {
  const n = new Map<string, number>()
  for (const o of ops) if (o.source === 'рынок Steam') n.set(o.currency, (n.get(o.currency) ?? 0) + 1)
  return [...n].sort((a, b) => b[1] - a[1]).map(([c]) => c)
}

export type WalletDay = { day: string; sales: number; salesN: number; keys: number; keysN: number }

// Кошелёк по дням в одной валюте: вверх — продажи вещей (пришло), вниз —
// покупки ключей (потрачено). Прочие покупки Steam не импортируются (план 3.3).
export function walletDays(ops: Op[], currency: string): WalletDay[] {
  const m = new Map<string, WalletDay>()
  for (const o of ops) {
    if (o.source !== 'рынок Steam' || o.currency !== currency) continue
    if (o.type !== 'продажа вещи' && o.type !== 'покупка ключа') continue
    const k = dayKey(o.happened_at)
    const d = m.get(k) ?? { day: k, sales: 0, salesN: 0, keys: 0, keysN: 0 }
    if (o.type === 'продажа вещи') { d.sales += o.net; d.salesN++ } else { d.keys += -o.net; d.keysN++ }
    m.set(k, d)
  }
  return [...m.values()].sort((a, b) => a.day.localeCompare(b.day))
}

// Продажи по дням (решение 4): цена покупателя и комиссии — только если они
// есть у всех продаж дня; иначе null и сколько продаж без них.
export type SalesDay = { day: string; n: number; net: number; gross: number | null; feeSteam: number | null; feeGame: number | null; missing: number }

export function salesDays(ops: Op[], currency: string): SalesDay[] {
  const m = new Map<string, Op[]>()
  for (const o of ops) {
    if (o.type !== 'продажа вещи' || o.currency !== currency) continue
    const k = dayKey(o.happened_at)
    m.set(k, [...(m.get(k) ?? []), o])
  }
  return [...m].map(([day, list]) => {
    const missing = list.filter(o => o.gross == null || o.fee_steam == null || o.fee_game == null).length
    const all = missing === 0
    return {
      day,
      n: list.length,
      net: list.reduce((a, o) => a + o.net, 0),
      gross: all ? list.reduce((a, o) => a + (o.gross as number), 0) : null,
      feeSteam: all ? list.reduce((a, o) => a + (o.fee_steam as number), 0) : null,
      feeGame: all ? list.reduce((a, o) => a + (o.fee_game as number), 0) : null,
      missing,
    }
  }).sort((a, b) => b.day.localeCompare(a.day))
}

export type BuyDay = { day: string; source: string; currency: string; n: number; cost: number; refunds: number }

export function gemBuysDays(ops: Op[]): BuyDay[] {
  const m = new Map<string, BuyDay>()
  for (const o of ops) {
    if (o.type !== 'покупка гема' && o.type !== 'возврат за покупку') continue
    const k = dayKey(o.happened_at) + '|' + o.source + '|' + o.currency
    const d = m.get(k) ?? { day: dayKey(o.happened_at), source: o.source, currency: o.currency, n: 0, cost: 0, refunds: 0 }
    if (o.type === 'покупка гема') { d.cost += -o.net; d.n++ } else d.refunds += o.net
    m.set(k, d)
  }
  return [...m.values()].sort((a, b) => b.day.localeCompare(a.day))
}

// Партии ключей по дням. Связь «партия → эти ключи» не выводится: в истории
// рынка нет assetid (решение 7). Освобождение — оценка: покупка + 7 суток.
export type KeyBatch = { day: string; source: string; currency: string; n: number; spent: number; avg: number; first: number; last: number; estimate: { from: number; to: number; label: 'оценка' } }

export function keyBatches(ops: Op[]): KeyBatch[] {
  const m = new Map<string, KeyBatch>()
  for (const o of ops) {
    if (o.type !== 'покупка ключа') continue
    const k = dayKey(o.happened_at) + '|' + o.currency
    const b = m.get(k) ?? { day: dayKey(o.happened_at), source: o.source, currency: o.currency, n: 0, spent: 0, avg: 0, first: o.happened_at, last: o.happened_at, estimate: { from: 0, to: 0, label: 'оценка' as const } }
    b.n++
    b.spent += -o.net
    b.first = Math.min(b.first, o.happened_at)
    b.last = Math.max(b.last, o.happened_at)
    m.set(k, b)
  }
  return [...m.values()].map(b => ({ ...b, avg: Math.round(b.spent / b.n), estimate: { from: b.first + 7 * DAY, to: b.last + 7 * DAY, label: 'оценка' as const } }))
    .sort((a, b) => b.day.localeCompare(a.day))
}

// ── время ──

export function countdown(at: number, now: number) {
  const d = at - now
  if (d <= 0) return 'уже'
  const days = Math.floor(d / DAY)
  const hours = Math.floor((d % DAY) / HOUR)
  if (days) return 'через ' + days + ' д ' + hours + ' ч'
  const mins = Math.max(1, Math.round((d % HOUR) / 60_000))
  return hours ? 'через ' + hours + ' ч ' + mins + ' мин' : 'через ' + mins + ' мин'
}

// «вс 4 окт, 17:23» — в часовом поясе браузера (§3.5).
export const when = (ts: number) =>
  new Date(ts).toLocaleString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export const gmt = (ts: number) => new Date(ts).toUTCString()
