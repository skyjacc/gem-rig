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

import { settings } from './settings.ts'
import { currentUser } from './ctx.ts'
import { balance, bestOffer, buyInfo, buyOne, units, type Currency } from './market.ts'
import type { Bought } from './marketbuys.ts'

// Паузы закупки. Вынесены, чтобы тесты шли без ожидания.
//   settle   сколько дать площадке записать покупку, прежде чем спрашивать
//   gap      между проверками по custom_id
//   tries    сколько раз спросить
//   between  между лотами
export const pace = { settle: 2000, gap: 3000, tries: 3, between: 350 }

const sleep = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve())

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

// Что ответила площадка на вопрос «что с покупкой по custom_id».
//
// «Отказ» — только когда площадка сама это сказала: stage 5, трейд отменён.
// «not found» отказом не считается: видна ли покупка по custom_id сразу,
// не доказано, а ложный отказ исказил бы журнал. Это промежуточное
// «не найдено» — по нему проверку повторяют, а в журнал оно не попадает.
export function judgeBuyInfo(res: any): { reason: 'куплено' | 'отказ' | 'неясно' | 'не найдено'; paid: number | null; detail: string; itemId: string | null } {
  if (res?.success === false && res?.error === 'not found') {
    return { reason: 'не найдено', paid: null, detail: 'площадка не знает эту покупку', itemId: null }
  }
  if (!res?.success || !res?.data) {
    return { reason: 'неясно', paid: null, detail: 'проверка не удалась: ' + String(res?.error ?? 'нет ответа').slice(0, 60), itemId: null }
  }
  const stage = String(res.data.stage ?? '')
  const paid = Number(res.data.paid)
  // item_id — для журнала закупки (план 3.1): по нему подтверждённая покупка
  // видна в истории площадки. paid здесь в основных единицах — не для денег.
  const itemId = res.data.item_id != null && String(res.data.item_id) ? String(res.data.item_id) : null
  if (stage === '1' || stage === '2') return { reason: 'куплено', paid: paid > 0 ? paid : null, detail: 'подтверждено по custom_id', itemId }
  if (stage === '5') return { reason: 'отказ', paid: null, detail: 'трейд отменён площадкой, деньги возвращаются', itemId }
  return { reason: 'неясно', paid: null, detail: 'площадка вернула stage ' + (stage || '—'), itemId: null }
}

type Settled = { reason: 'куплено' | 'отказ' | 'неясно'; paid: number | null; detail: string; itemId: string | null }

// Ответ на покупку потерялся. Заново не покупаем — спрашиваем, что стало
// с этой покупкой. «not found» сразу может значить «ещё не записалась»,
// поэтому до трёх вопросов с паузой. Отказом он не становится никогда:
// отсутствие ответа — не доказательство, что покупки нет.
//
// buyInfo сейчас не бросает (call в market.ts ловит сбои сам), но запись
// в журнале не должна застрять на «проверяю…», если это когда-то изменится:
// исключение здесь — тоже «неясно».
export async function resolveAmbiguous(key: string, customId: string, ask: typeof buyInfo = buyInfo): Promise<Settled> {
  await sleep(pace.settle)
  for (let i = 0; i < pace.tries; i++) {
    if (i) await sleep(pace.gap)
    let res: any
    try { res = await ask(key, customId) } catch (e: any) {
      res = { success: false, ambiguous: true, error: String(e?.message ?? e) }
    }
    const v = judgeBuyInfo(res)
    if (v.reason !== 'не найдено') return v as Settled
  }
  return { reason: 'неясно', paid: null, detail: 'площадка не нашла покупку по custom_id за ' + pace.tries + ' проверки', itemId: null }
}

// Сверка заказа с тем, что сервер сам видел на площадке.
//
// Раньше строки закупки приходили из браузера как есть: имя, цена, сколько
// брать — и сервер им верил. Проверялся только баланс. Значит любой, кто
// дотянулся до /api/market/buy, заказывал что угодно по какой угодно цене
// в пределах счёта. Теперь имя обязано быть в последнем разборе площадки,
// цена — не выше увиденной с допуском, а сумма — в пределах потолка.
export function vetLines(
  lines: any[],
  seen: Map<string, number>,
  tolerance: number,
  cap: number,
): { lines: Line[] } | { error: string } {
  if (!Array.isArray(lines) || !lines.length) return { error: 'нечего покупать' }
  const tol = Math.max(0, Number(tolerance) || 0)
  const out: Line[] = []
  for (const l of lines) {
    const name = String(l?.name ?? '')
    const take = Math.trunc(Number(l?.take) || 0)
    const price = Number(l?.price)
    if (!name || take <= 0) continue
    if (!Number.isFinite(price) || price <= 0) return { error: 'у «' + name + '» нет цены' }
    const known = seen.get(name)
    if (known === undefined) return { error: '«' + name + '» нет в разборе площадки — обновите список' }
    if (price > known * (1 + tol) + 1e-9) {
      return { error: 'цена «' + name + '» ' + price + ' выше увиденной ' + known + ' — обновите список' }
    }
    out.push({ name, take, price })
  }
  if (!out.length) return { error: 'нечего покупать' }
  // Потолок обязателен. Одно число по умолчанию здесь не годится: счёт
  // площадки бывает в рублях, долларах и евро, и «1000» значит то одиннадцать
  // долларов, то тысячу. Поэтому без явно заданного потолка закупка
  // не начинается вовсе — ноль больше не значит «без предела».
  if (!(cap > 0)) {
    return { error: 'не задан потолок закупки — задайте его в настройках, в валюте счёта площадки' }
  }
  const total = out.reduce((n, l) => n + l.take * l.price, 0)
  if (total > cap + 1e-9) {
    return { error: 'закупка на ' + total.toFixed(2) + ' больше потолка ' + cap + ' — поднимите потолок в настройках' }
  }
  return { lines: out }
}

export type Entry = {
  ts: number
  gem: string
  ok: boolean
  price: number
  reason: 'куплено' | 'цена выросла' | 'нет лотов' | 'цена ушла' | 'нет денег' | 'отказ' | 'неясно' | 'остановлено'
  detail?: string
  planned?: number   // сколько собирались платить
  customId?: string  // с каким custom_id ушёл buy — по нему площадка отдаёт статус
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
  // На чей аккаунт идёт закупка: у каждого свой ключ площадки, и лоты
  // приходят на тот Steam, к которому привязан этот ключ.
  account: { id: string; label: string } | null
}

const EMPTY: Job = {
  active: false, cancel: false, startedAt: 0, finishedAt: 0, currency: 'RUB', account: null,
  planned: 0, done: 0, ok: 0, spent: 0, current: '', pass: 0,
  positions: [], log: [], error: null,
}

// Закупка — у каждого пользователя своя (план 7.2, решение 7): своё
// состояние, своя остановка, «уже идёт» — в пределах пользователя.
const jobs = new Map<string, Job>()
const jobFor = (user: string) => jobs.get(user) ?? { ...EMPTY }

// Что сервер знает о пользователях — снаружи (app.ts). Отключённый
// пользователь (решение 10): новых покупок нет; уже отправленная на
// площадку доводится и записывается как обычно.
export const purchaseHooks = { userActive: (_user: string) => true }

export const purchaseState = (user = currentUser()) => {
  const job = jobFor(user)
  return { ...job, log: job.log.slice(0, 60) }
}

export function stopPurchase(user = currentUser()) {
  const job = jobs.get(user)
  if (!job?.active) return { error: 'закупка не идёт' }
  job.cancel = true
  job.current = 'останавливаюсь'
  return { ok: true }
}

const note = (job: Job, e: Entry) => {
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
const starting = new Set<string>()

// Ключ и аккаунт приходят снаружи: их выбирает и проверяет marketkeys.buyKey.
// Здесь закупка только тратит тем ключом, который ей дали.
export type Target = { key: string; id: string; label: string }

// Факт «куплено» уходит наружу колбэком (план 3.1): закупка базу не знает,
// журнал закупки ведёт marketbuys.ts. Ошибка колбэка закупку не останавливает.
export type Hooks = { onBought?: (b: Bought) => void }

function report(hooks: Hooks, b: Bought) {
  try { hooks.onBought?.(b) } catch (e: any) {
    console.error('журнал закупки: покупка ' + b.customId + ' не записана — ' + String(e?.message ?? e))
  }
}

export async function startPurchase(lines: Line[], currency: Currency, push: () => void, target: Target, hooks: Hooks = {}) {
  const user = currentUser()
  if (jobFor(user).active || starting.has(user)) return { error: 'закупка уже идёт' }
  starting.add(user)
  try {
    const key = String(target?.key ?? '')
    if (!key) return { error: 'нет ключа площадки' }
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

    const job: Job = {
      ...EMPTY,
      active: true,
      startedAt: Date.now(),
      currency: accCur,
      planned,
      log: [],
      account: { id: target.id, label: target.label },
    }
    jobs.set(user, job)
    push()

    // Работа идёт своим чередом, ответ уходит сразу: панель дальше смотрит
    // на состояние, а не ждёт конца.
    void run(job, user, lines, key, accCur, settings().priceTolerance, push, target.id, hooks)
    return { started: true, planned, total, currency: accCur, account: target.label }
  } finally {
    // Снимаем замок только после того, как job.active поднят: дальше
    // от второго запуска защищает уже он.
    starting.delete(user)
  }
}

// Идёт ли закупка прямо сейчас — с учётом того, что она может быть
// в середине проверок и ещё не отражена в job.
export const purchaseBusy = (user = currentUser()) => jobFor(user).active || starting.has(user)

async function run(job: Job, user: string, lines: Line[], key: string, currency: Currency, tolerance: number, push: () => void, accountId: string, hooks: Hooks) {
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
      if (job.cancel || !purchaseHooks.userActive(user) || work.every(w => w.done || w.left === 0)) break
      job.pass = round

      for (let i = 0; i < work.length; i++) {
        const w = work[i]
        if (w.done || w.left === 0) continue

        let failsInARow = 0

        while (w.left > 0 && !w.done) {
          // Остановили или пользователя отключили — перед следующей покупкой.
          if (job.cancel || !purchaseHooks.userActive(user)) {
            note(job, { ts: Date.now(), gem: w.gem, ok: false, price: w.price, reason: 'остановлено' })
            mark(i)
            return
          }

          job.current = w.gem

          // Сколько стоит прямо сейчас: дешёвые лоты кончаются по мере
          // скупки, и цена ползёт вверх во время самой закупки.
          const res: any = await bestOffer(key, w.name)
          // Пока узнавали цену, могли остановить или отключить (ревью PR #33):
          // перед покупкой — ещё раз.
          const stopped = () => job.cancel || !purchaseHooks.userActive(user)
          if (stopped()) {
            note(job, { ts: Date.now(), gem: w.gem, ok: false, price: w.price, reason: 'остановлено' })
            mark(i)
            return
          }
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
            const customId = 'gt-' + Date.now() + '-' + w.left
            // И в самый момент отправки — после ожидания ограничителя площадки.
            const r: any = await buyOne(key, w.name, call.price, currency, customId, () => !stopped())
            if (r?.notSent) {
              note(job, { ts: Date.now(), gem: w.gem, ok: false, price: w.price, reason: 'остановлено', detail: 'покупка не отправлена' })
              mark(i)
              return
            }

            // Ответ потерялся: лот мог уже списаться. Второго buy нет ни при
            // каком исходе — закупка встаёт, а что стало с этой покупкой,
            // спрашиваем у площадки по custom_id.
            if (r?.ambiguous) {
              job.done++
              const e: Entry = {
                ts: Date.now(), gem: w.gem, ok: false, price: call.price, planned: w.price,
                reason: 'неясно', detail: 'ответ не получен — проверяю по custom_id…', customId,
              }
              note(job, e)
              w.why = 'неясно'
              mark(i)
              push()

              const v = await resolveAmbiguous(key, customId)
              e.reason = v.reason
              e.detail = v.detail + (v.reason === 'неясно' ? ' — сверьте историю покупок' : '') + '; закупка остановлена'
              if (v.reason === 'куплено') {
                report(hooks, {
                  accountId, customId, hashName: w.name, askPrice: units(call.price, currency), currency,
                  buyId: null, itemId: v.itemId, how: 'custom_id', at: Date.now(),
                })
                e.ok = true
                if (v.paid) e.price = v.paid
                job.ok++
                job.spent += e.price
                w.left--
              }
              mark(i)
              push()
              return
            }

            ok = !!r?.success
            reason = ok ? 'куплено' : classify(r?.error ?? '')
            if (ok) {
              // Цена — та, что ушла в buy потолком (units), не списанная:
              // площадка берёт лот не дороже. Списанное — в истории площадки.
              report(hooks, {
                accountId, customId, hashName: w.name, askPrice: units(call.price, currency), currency,
                buyId: r?.id != null ? String(r.id) : null, itemId: null, how: 'buy', at: Date.now(),
              })
            }
            detail = ok ? undefined : String(r?.error ?? '').slice(0, 80)
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

          note(job, { ts: Date.now(), gem: w.gem, ok, price: paid, planned: w.price, reason, detail })
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

          await sleep(pace.between)
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
