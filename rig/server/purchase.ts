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

// Что делать после неудачи. Беды разной природы:
//
//   нет денег      дальше бессмысленно всё
//   цена выросла   остальные лоты позиции стоят столько же — бросаем её
//   нет лотов      брать нечего — бросаем позицию
//   отказ          площадка не ответила; это не приговор, пробуем ещё,
//                  но не бесконечно — после трёх подряд идём дальше
//
// Одна ошибка связи не должна стоить всей позиции: 22 августа так и вышло —
// пять сбоев отняли сто тридцать лотов.
export function after(reason: string, failsInARow: number): 'стоп' | 'позиция' | 'ещё' | 'дальше' {
  if (reason === 'нет денег') return 'стоп'
  // Непонятно, списались ли деньги. Повтор мог бы купить тот же лот второй
  // раз — останавливаемся, человек сверяет историю покупок на площадке.
  if (reason === 'неясно') return 'стоп'
  if (reason === 'цена выросла' || reason === 'нет лотов' || reason === 'цена ушла') return 'позиция'
  if (reason === 'отказ') return failsInARow >= 3 ? 'дальше' : 'ещё'
  return 'дальше'
}

export type Entry = {
  ts: number
  gem: string
  ok: boolean
  price: number
  reason: 'куплено' | 'цена выросла' | 'нет лотов' | 'цена ушла' | 'нет денег' | 'отказ' | 'неясно' | 'остановлено'
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
  pass: number        // какой заход по списку идёт
  positions: { gem: string; asked: number; got: number; done: boolean; why: string }[]
  log: Entry[]
  error: string | null
}

const EMPTY: Job = {
  active: false, cancel: false, startedAt: 0, finishedAt: 0, currency: 'RUB',
  planned: 0, done: 0, ok: 0, spent: 0, current: '', pass: 0,
  positions: [], log: [], error: null,
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

// Замок берётся ДО первого await и держится до конца проверок.
//
// Раньше защита от второго запуска была одной строкой `if (job.active)`,
// а между ней и `job.active = true` стоял поход за балансом на площадку —
// сотни миллисекунд. Два нажатия подряд, два открытых окна панели, повтор
// запроса при обрыве связи — и оба вызова проходили проверку, пока флаг
// ещё не поднят, а потом оба уходили покупать. Деньги списываются дважды,
// и вернуть их нельзя: лоты уже куплены.
let starting = false

export async function startPurchase(lines: Line[], currency: Currency, push: () => void) {
  if (job.active || starting) return { error: 'закупка уже идёт' }
  starting = true
  try {
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
  } finally {
    // Снимаем замок только после того, как job.active поднят: дальше
    // от второго запуска защищает уже он.
    starting = false
  }
}

// Идёт ли закупка прямо сейчас — с учётом того, что она может быть
// в середине проверок и ещё не отражена в job.
export const purchaseBusy = () => job.active || starting

async function run(lines: Line[], key: string, currency: Currency, tolerance: number, push: () => void) {
  // Список работ: у каждой позиции своё «сколько ещё надо».
  const work = lines
    .map(l => ({
      name: String(l.name),
      gem: String(l.name).replace(/^(Genuine\s+)?Spectator:\s*/i, ''),
      price: Number(l.price),
      left: Math.max(0, Math.trunc(Number(l.take) || 0)),
      done: false,
      why: '',
    }))
    .filter(w => w.left > 0)

  job.positions = work.map(w => ({ gem: w.gem, asked: w.left, got: 0, done: false, why: '' }))

  const mark = (i: number) => {
    const p = job.positions[i]
    const w = work[i]
    p.got = p.asked - w.left
    p.done = w.done
    p.why = w.why
  }

  try {
    // Несколько заходов по списку. Сбой связи не должен стоить позиции:
    // недобранное остаётся в работе и добирается на следующем круге.
    for (let round = 1; round <= 3; round++) {
      if (job.cancel || work.every(w => w.done || w.left === 0)) break
      job.pass = round

      for (let i = 0; i < work.length; i++) {
        const w = work[i]
        if (w.done || w.left === 0) continue

        let failsInARow = 0

        while (w.left > 0 && !w.done) {
          if (job.cancel) {
            note({ ts: Date.now(), gem: w.gem, ok: false, price: w.price, reason: 'остановлено' })
            mark(i)
            return
          }

          job.current = w.gem

          // Сколько стоит прямо сейчас: дешёвые лоты кончаются по мере
          // скупки, и цена ползёт вверх во время самой закупки.
          const res: any = await bestOffer(key, w.name)
          const now = lowest(res, currency)
          const call = decideBuy(w.price, now, tolerance)

          let reason: Entry['reason']
          let ok = false
          let paid = call.price
          let detail: string | undefined

          if (!call.buy) {
            reason = now == null ? (res?.success ? 'нет лотов' : 'отказ') : 'цена выросла'
            paid = now ?? w.price
            detail = now != null
              ? undefined
              : res?.success ? 'предложений не осталось' : 'площадка: ' + String(res?.error ?? 'нет ответа').slice(0, 60)
          } else {
            const r: any = await buyOne(key, w.name, call.price, currency, 'gt-' + Date.now() + '-' + w.left)
            ok = !!r?.success
            reason = ok ? 'куплено' : r?.ambiguous ? 'неясно' : classify(r?.error ?? '')
            detail = ok ? undefined
              : r?.ambiguous ? 'ответ не получен — проверьте историю покупок, закупка остановлена'
                : String(r?.error ?? '').slice(0, 80)
          }

          job.done++
          if (ok) {
            job.ok++
            job.spent += paid
            w.left--
            failsInARow = 0
          } else {
            failsInARow++
          }

          note({ ts: Date.now(), gem: w.gem, ok, price: paid, planned: w.price, reason, detail })
          mark(i)
          push()

          if (!ok) {
            const step = after(reason, failsInARow)
            if (step === 'стоп') { w.why = reason; mark(i); return }
            if (step === 'позиция') { w.done = true; w.why = reason; mark(i); break }
            // «дальше» — эта позиция пока не даётся, переходим к другим
            // и вернёмся к ней следующим кругом.
            if (step === 'дальше') { mark(i); break }
          }

          await new Promise(res2 => setTimeout(res2, 350))
        }
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
