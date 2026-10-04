// Модель экрана «Скупка» (§5.3) — чистые функции, без React.
//
// Логику плана и робота сервер держит сам (api.ts marketScan, purchase.ts),
// здесь её не меняют — только показывают (план 2.3):
//   planOrder / collect   перенос «собрать лучшее» из старого views/Buy.tsx
//                         (optimal(), строки 212–236) без изменения правил;
//   cartOf                корзина, как в старом (отправки — на гем, не на штуку);
//   feed                  лента покупок из state.purchase.log;
//   launchBlock           С8: почему кнопка запуска неактивна — заранее то,
//                         что сервер и так откажет. Не защита: сервер
//                         (buyKey, vetLines, startPurchase) проверяет сам;
//   arrivedSince          приход с начала закупки — нижняя граница.

import type { MarketKeyStatus, PurchaseRun } from '../../lib/api.ts'

export type Cur = 'RUB' | 'USD' | 'EUR' | 'UAH'

// Строка разбора площадки — ровно то, что отдаёт GET /api/market.
export type Offer = {
  gem: string
  name: string
  price: number
  volume: number
  pool: number
  owned: number
  reaches: boolean
  burning: boolean
  overlap: number    // общих матчей с тем, что уже крутится (считает сервер)
  sends: number      // отправок сверх уже идущего: max(0, min(pool, goal) − min(overlap, goal))
  per1000: number
  revenue: number
  profit: number
}

export type Scan = {
  goal: number       // settings().goal, по которой сервер посчитал этот разбор
  sell: number
  currency: Cur
  converted: boolean
  rate: number
  perGem: number
  updated: number
  error: string | null
  scanned: number
  balance: number | null
  balanceCurrency: string | null
  balanceError: string | null
  account?: { id: string; label: string }
  key?: MarketKeyStatus
  offers: Offer[]
}

// Отправок в минуту — замер 20 августа, та же константа, что в старом
// Buy.tsx:73 (§5.3 на неё ссылается). Это оценка, не измерение сейчас.
export const SPEED = 76

// Сколько отказов площадки подряд сервер терпит на позиции, прежде чем
// уйти к другой (purchase.ts, after(): failsInARow >= 3 → «дальше»).
export const RETRIES = 3

// Порядок «собрать план» (§5.3: он же сортировка плана по умолчанию):
// в работе → больше общих → дешевле тысяча → дешевле лот. Только те, что
// дойдут до цели и с ценой.
export function planOrder(offers: Offer[]): Offer[] {
  return offers
    .filter(o => o.reaches && o.price > 0)
    .sort((a, b) =>
      Number(b.burning) - Number(a.burning) ||
      (b.overlap ?? 0) - (a.overlap ?? 0) ||
      a.per1000 - b.per1000 ||
      a.price - b.price)
}

// На сколько собирать. Пустой бюджет — меньшее из потолка и баланса (план 2.3,
// решение 2; в старой — весь баланс). Потолок не задан (нет или 0) — остаётся
// баланс: план посмотреть можно, запуск всё равно закроет launchBlock.
export function cashFor(budget: string, cap: number | null | undefined, balance: number | null): number {
  const asked = Number(budget.replace(',', '.')) || 0
  if (asked > 0) return asked
  const bal = balance ?? 0
  return cap != null && cap > 0 ? Math.min(cap, bal) : bal
}

// «Собрать план»: perGem одного гема, не больше, чем есть лотов и денег.
// null — собирать не на что (как ранний return в старой optimal()).
export function collect(scan: Scan, cash: number): Record<string, number> | null {
  if (!cash) return null
  let left = cash
  const next: Record<string, number> = {}
  for (const o of planOrder(scan.offers)) {
    const can = Math.min(o.volume, scan.perGem, Math.floor(left / o.price))
    if (can <= 0) continue
    next[o.gem] = can
    left -= can * o.price
  }
  return next
}

// Сколько можно положить в строку: не больше лотов в продаже и perGem.
export const maxTake = (o: Offer, perGem: number) => Math.max(0, Math.min(o.volume, perGem))

export type Cart = {
  lines: { o: Offer; n: number }[]
  units: number
  cost: number
  free: number       // самоцветов, которым не нужно новых отправок (гем уже крутится)
  sends: number
  minutes: number    // sends / SPEED — оценка
}

export function cartOf(scan: Scan | null, take: Record<string, number>): Cart {
  if (!scan) return { lines: [], units: 0, cost: 0, free: 0, sends: 0, minutes: 0 }
  const lines = scan.offers.map(o => ({ o, n: take[o.gem] ?? 0 })).filter(x => x.n > 0)
  const units = lines.reduce((n, x) => n + x.n, 0)
  const cost = lines.reduce((n, x) => n + x.n * x.o.price, 0)
  const free = lines.reduce((n, x) => n + (x.o.burning ? x.n : 0), 0)
  // Отправки — на гем, а не на штуку: копии одного гема поднимает одно сообщение.
  const sends = lines.reduce((n, x) => n + (x.o.burning ? 0 : x.o.sends), 0)
  return { lines, units, cost, free, sends, minutes: Math.round(sends / SPEED) }
}

// ── лента покупок ──

export type FeedKind = 'ok' | 'skip' | 'retry' | 'stop'
export type Log = PurchaseRun['log'][number]
export type FeedRow = { l: Log; kind: FeedKind; text: string; retry: number | null }

// Лента новыми сверху (как log на сервере). Журнал хранит только последнюю
// закупку: при запуске он обнуляется (purchase.ts, startPurchase).
//
// «Повтор N из 3» сервер не пишет — N считается здесь: подряд идущие «отказ»
// одного гема. Внутри одного захода по позиции записи идут подряд; после трёх
// сервер уходит к другой позиции и при возврате считает заново — отсюда
// N = ((k − 1) mod 3) + 1. Ограничение: наружу отдаются последние 60 записей —
// если начало серии отрезано, N может быть меньше настоящего.
//
// «Отказ» с custom_id — другое: это ответ на неясную покупку (stage 5,
// трейд отменён), после него закупка стоит.
export function feed(log: Log[]): FeedRow[] {
  return log.map((l, i) => {
    if (l.reason === 'куплено') return { l, kind: 'ok', text: l.customId ? 'куплено · подтверждено по custom_id' : 'куплено', retry: null }
    if (l.reason === 'цена выросла') return { l, kind: 'skip', text: 'цена выросла — позиция брошена', retry: null }
    if (l.reason === 'цена ушла') return { l, kind: 'skip', text: 'цена ушла — позиция брошена', retry: null }
    if (l.reason === 'нет лотов') return { l, kind: 'skip', text: 'лотов не осталось — позиция брошена', retry: null }
    if (l.reason === 'отказ' && !l.customId) {
      let k = 1
      for (let j = i + 1; j < log.length && log[j].gem === l.gem && log[j].reason === 'отказ' && !log[j].customId; j++) k++
      const n = ((k - 1) % RETRIES) + 1
      return {
        l, kind: 'retry', retry: n,
        text: n < RETRIES
          ? 'площадка не ответила · повтор ' + n + ' из ' + RETRIES
          // «До следующего захода» не пишем: на последнем заходе его нет.
          : 'площадка не ответила ' + RETRIES + ' раза подряд — робот перешёл к другим позициям',
      }
    }
    if (l.reason === 'отказ') return { l, kind: 'stop', text: 'отказ площадки по custom_id — закупка остановлена', retry: null }
    if (l.reason === 'нет денег') return { l, kind: 'stop', text: 'нет денег — закупка остановлена', retry: null }
    if (l.reason === 'неясно') return { l, kind: 'stop', text: 'неясно, списались ли — закупка остановлена', retry: null }
    if (l.reason === 'остановлено') return { l, kind: 'stop', text: 'остановлено', retry: null }
    return { l, kind: 'stop', text: l.reason, retry: null }
  })
}

// ── С8: можно ли запускать ──

// Первая причина, по которой запуск закрыт, — словами, как ответил бы сервер.
// null — можно. Порядок — план 2.3, задача 1.
export function launchBlock(p: {
  scan: Scan | null
  running: boolean
  cart: Cart
  cur: Cur
  cap: number | null | undefined   // settings.purchaseCap; нет поля — «не задан»
}): string | null {
  const { scan, cart, cap } = p
  if (!scan) return 'нет разбора площадки — список цен не пришёл'
  if (scan.error) return 'разбор площадки с ошибкой: ' + scan.error + ' — обновите цены'
  if (p.running) return 'закупка уже идёт'

  const who = scan.account?.label ?? '—'
  const k = scan.key
  if (!k) return 'статус ключа площадки неизвестен — проверьте ключ'
  if (k.state === 'missing') return 'у аккаунта «' + who + '» нет ключа площадки — задайте его на экране аккаунтов'
  if (k.state === 'unchecked') return 'ключ площадки не проверен — нажмите «проверить ключ»'
  if (k.state === 'mismatch') return 'ключ площадки привязан к другому Steam (' + (k.marketSteamid ?? '—') + ') — лоты ушли бы не на «' + who + '»'
  if (k.state === 'invalid') return 'площадка отвергла ключ «' + who + '»' + (k.error ? ': ' + k.error : '')

  // Валюта: площадка торгует только в валюте счёта (рубль — сотнями, доллар —
  // тысячами); в гривне не торгует вовсе. Без баланса валюту не сверить —
  // сервер на запуске тоже откажет.
  if (!scan.balanceCurrency) return 'площадка не отдала баланс' + (scan.balanceError ? ': ' + scan.balanceError : '') + ' — валюту счёта не сверить'
  if (p.cur !== scan.balanceCurrency) return 'счёт площадки в ' + scan.balanceCurrency + ', а цены показаны в ' + p.cur + ' — переключите валюту'

  if (!(cap != null && cap > 0)) return 'не задан потолок закупки — задайте его в правилах, в валюте счёта площадки'
  if (!cart.units) return 'корзина пуста — «+» в строке плана или «собрать план»'
  if (cart.cost > cap + 1e-9) return 'корзина на ' + cart.cost.toFixed(2) + ' больше потолка ' + cap + ' — уменьшите корзину или поднимите потолок в правилах'
  return null
}

// Баланс меньше корзины — предупреждение, не блок: баланс в ответе живёт
// до 30 с (api.ts money()), окончательно его сверяет сервер на запуске.
export const shortOfMoney = (scan: Scan | null, cart: Cart) =>
  !!scan && scan.balance != null && cart.cost > scan.balance + 1e-9

// ── приход ──

export type Arrival = {
  assetid: string
  account: string | null   // steamid аккаунта (arrival.ts пишет ACCOUNT() = steamid)
  gem: string
  verdict: string
  ts: number | null
}

export type Arrived = { total: number; clean: number; ours: number; win: number }

// Приход с начала закупки на её аккаунт — из ДОСТУПНЫХ строк /api/arrivals.
// Сервер отдаёт не больше 400 строк всей таблицы, «выигрыши» первыми
// (arrival.ts:181, arrivalsOf) — значит, это нижняя граница. И это всё новое
// на аккаунте, не только купленное. Нет закупки или аккаунта — null.
export function arrivedSince(rows: Arrival[] | null | undefined, startedAt: number, steamid: string | null): Arrived | null {
  if (!rows || !startedAt || !steamid) return null
  const got = rows.filter(r => r.account === steamid && r.ts != null && r.ts >= startedAt && r.verdict !== 'старое')
  return {
    total: got.length,
    clean: got.filter(r => r.verdict === 'чисто').length,
    ours: got.filter(r => r.verdict === 'наш').length,
    win: got.filter(r => r.verdict === 'выигрыш').length,
  }
}
