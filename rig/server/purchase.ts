// Закупка как наблюдаемая работа, а не один длинный запрос.
//
// Раньше покупка пятисот лотов была одним обращением к панели, которое
// молчало три минуты и отвечало в конце. Человек не видел, идёт ли она,
// не мог остановить, и узнавал о подорожании только постфактум.
//
// Теперь это работа с состоянием: каждый лот попадает в журнал сразу,
// остановить можно в любой момент, и следующая покупка после остановки
// не начинается.
//
// Покупается всегда самое дешёвое предложение НА МОМЕНТ ПОКУПКИ, а не то,
// что было в списке. Разница не теоретическая: список живёт до двух минут,
// а дешёвые лоты кончаются по мере скупки — забрав десять самых дешёвых
// Alliance, одиннадцатый ты берёшь уже дороже.
//
// Поэтому перед каждым лотом спрашивается нынешняя цена. Упала — берём
// дешевле, чем планировали. Выросла выше допуска — не берём вовсе
// и переходим к следующей позиции, а в журнале видно обе цены.

import { marketKey } from './paths.ts'
import { settings } from './settings.ts'
import { balance, bestOffer, buyOne, type Currency } from './market.ts'

export type Line = { name: string; take: number; price: number }

// Мелкая единица у площадки своя на валюту: рубль сотня, доллар тысяча.
const MINOR: Record<string, number> = { RUB: 100, USD: 1000, EUR: 1000 }

// Самое дешёвое предложение среди отданных площадкой.
export function lowest(res: any, currency: string): number | null {
  if (!res?.success || !Array.isArray(res.data) || !res.data.length) return null
  const div = MINOR[currency] ?? 1000
  const prices = res.data.map((d: any) => Number(d?.price)).filter((p: number) => p > 0)
  if (!prices.length) return null
  return Math.min(...prices) / div
}

// Брать ли лот по нынешней цене.
//
// Планировали одну цену, а покупаем по той, что сейчас: упала — берём
// дешевле, выросла — не берём вовсе. Допуск оставлен настройкой для тех,
// кому важнее набрать объём, чем сэкономить копейку.
export function decideBuy(planned: number, now: number | null, tolerance: number) {
  if (now == null || now <= 0) return { buy: false, price: 0 }
  const tol = Math.max(0, Number(tolerance) || 0)
  return { buy: now <= planned * (1 + tol) + 1e-9, price: now }
}

export type Entry = {
  ts: number
  gem: string
  ok: boolean
  price: number
  reason: 'куплено' | 'цена выросла' | 'нет лотов' | 'цена ушла' | 'нет денег' | 'отказ' | 'остановлено'
  detail?: string
  planned?: number   // сколько собирались платить
}

type Job = {
  active: boolean
  cancel: boolean
  startedAt: number
  finishedAt: number
  currency: Currency
  planned: number     // сколько лотов заказано
  done: number        // сколько попыток сделано
  ok: number          // сколько куплено
  spent: number
  current: string     // что покупается прямо сейчас
  log: Entry[]
  error: string | null
}

const EMPTY: Job = {
  active: false, cancel: false, startedAt: 0, finishedAt: 0, currency: 'RUB',
  planned: 0, done: 0, ok: 0, spent: 0, current: '', log: [], error: null,
}

let job: Job = { ...EMPTY }

export const purchaseState = () => ({
  ...job,
  log: job.log.slice(0, 60),
})

export function stopPurchase() {
  if (!job.active) return { error: 'закупка не идёт' }
  job.cancel = true
  job.current = 'останавливаюсь'
  return { ok: true }
}

const note = (e: Entry) => {
  job.log.unshift(e)
  if (job.log.length > 400) job.log.pop()
}

// Отказ площадки по цене отличается от прочих: он означает, что список
// устарел, а не что что-то сломалось.
function classify(error: string): Entry['reason'] {
  const m = String(error || '').toLowerCase()
  if (m.includes('price') || m.includes('цен') || m.includes('not found') || m.includes('no item')) return 'цена ушла'
  if (m.includes('money') || m.includes('balance') || m.includes('денег')) return 'нет денег'
  return 'отказ'
}

export async function startPurchase(lines: Line[], currency: Currency, push: () => void) {
  if (job.active) return { error: 'закупка уже идёт' }

  const key = marketKey()
  if (!key) return { error: 'нет ключа площадки — положите его в tools/market.key' }
  if (!lines.length) return { error: 'нечего покупать' }

  const acc: any = await balance(key)
  if (!acc?.success) return { error: 'площадка не отдала баланс: ' + (acc?.error ?? 'нет ответа') }

  const accCur = String(acc.currency ?? '') as Currency
  if (currency === 'UAH') return { error: 'в гривне площадка не торгует — валюта счёта ' + accCur }
  if (currency !== accCur) return { error: 'валюта счёта ' + accCur + ', а цены показаны в ' + currency }

  const planned = lines.reduce((n, l) => n + Math.max(0, Math.trunc(l.take)), 0)
  const total = lines.reduce((n, l) => n + Math.max(0, Math.trunc(l.take)) * l.price, 0)
  if (Number(acc.money) < total) {
    return { error: 'на счету ' + acc.money + ' ' + accCur + ', нужно ' + total.toFixed(2) }
  }

  job = {
    ...EMPTY,
    active: true,
    startedAt: Date.now(),
    currency: accCur,
    planned,
    log: [],
  }
  push()

  // Работа идёт своим чередом, ответ уходит сразу: панель дальше смотрит
  // на состояние, а не ждёт конца.
  void run(lines, key, accCur, settings().priceTolerance, push)
  return { started: true, planned, total, currency: accCur }
}

async function run(lines: Line[], key: string, currency: Currency, tolerance: number, push: () => void) {
  try {
    for (const l of lines) {
      const take = Math.max(0, Math.trunc(Number(l.take) || 0))
      const gem = String(l.name).replace(/^(Genuine\s+)?Spectator:\s*/i, '')

      for (let i = 0; i < take; i++) {
        if (job.cancel) {
          note({ ts: Date.now(), gem, ok: false, price: l.price, reason: 'остановлено' })
          return
        }

        job.current = gem

        // Сколько стоит прямо сейчас. Спрашиваем перед каждым лотом:
        // цена ползёт вверх по мере того, как мы выбираем дешёвые.
        const res: any = await bestOffer(key, String(l.name))
        const now = lowest(res, currency)
        const call = decideBuy(Number(l.price), now, tolerance)

        if (!call.buy) {
          job.done++
          const reason = now == null ? (res?.success ? 'нет лотов' : 'отказ') : 'цена выросла'
          note({
            ts: Date.now(), gem, ok: false, price: now ?? 0, planned: l.price, reason,
            // Пустой ответ и отказ площадки — разные беды, и лечатся
            // по-разному: в первом случае лоты кончились, во втором
            // не достучались. Прятать одно под другим значит потом гадать.
            // Обе цены и так показаны отдельными полями, поэтому пояснение
            // нужно только там, где причина не видна из чисел.
            detail: now != null
              ? undefined
              : res?.success ? 'предложений не осталось' : 'площадка: ' + String(res?.error ?? 'нет ответа').slice(0, 60),
          })
          push()
          break
        }

        const r: any = await buyOne(key, String(l.name), call.price, currency, 'gt-' + Date.now() + '-' + i)
        job.done++

        if (r?.success) {
          job.ok++
          job.spent += call.price
          note({ ts: Date.now(), gem, ok: true, price: call.price, planned: l.price, reason: 'куплено' })
        } else {
          const reason = classify(r?.error ?? '')
          note({ ts: Date.now(), gem, ok: false, price: call.price, planned: l.price, reason, detail: String(r?.error ?? '').slice(0, 80) })
          push()
          // Цена ушла — остальные лоты этой позиции стоят столько же,
          // добивать их бессмысленно. Кончились деньги — тем более.
          if (reason === 'цена ушла' || reason === 'нет денег') break
        }

        push()
        await new Promise(res => setTimeout(res, 350))
      }
    }
  } catch (e: any) {
    job.error = e.message
  } finally {
    job.active = false
    job.cancel = false
    job.current = ''
    job.finishedAt = Date.now()
    push()
  }
}
