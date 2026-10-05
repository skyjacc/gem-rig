// Работник — то, что крутится само, пока человек покупает гемы.
//
// Один работник на аккаунт. Включать можно любое их число: пул матчей общий,
// журнал расхода у каждого свой, ограничение «одна сессия» — на аккаунт.
// Два включённых аккаунта дают вдвое больше товара за то же время.
//
// Каждые двадцать секунд по каждому включённому аккаунту:
//   состав инвентаря изменился  → пересобрать очередь
//   очередь пуста               → ждать
//   отправщик мёртв             → поднять
//   молчит минуту               → перезапустить
//   цель достигнута             → встать
//
// Решение принимает worker.decide, здесь только исполнение и состояние.
// По умолчанию всё выключено: каждая отправка необратима.
//
// Всё, что зависит от аккаунта, берётся ПО АККАУНТУ: инвентарь, счётчики,
// состав, темп, отчёт. Общими они были ровно до тех пор, пока аккаунт был
// один; со вторым каждое такое место — потраченные впустую матчи.

import fs from 'node:fs'
import path from 'node:path'
import { GC, TOOLS } from './paths.ts'
import { burnedCount, db } from './db.ts'
import { asideSet } from './arrival.ts'
import { decide, freshSendAt, type Action } from './worker.ts'
import { queueFor, sendsNeeded, type Pick } from './queue.ts'
import { invOf, refreshInventory } from './steam.ts'
import { queueFile, senderState, start as startSender, statusFile, stop as stopSender, writePace, forget } from './sender.ts'
import { advise, creditRate, evenDelay, silenceLimit, type Sample } from './pace.ts'
import { capFor, reached, spreadPlan, type Wave } from './spread.ts'
import { ACCOUNT, active, list as accounts, listFor, ownerOf, type Account } from './accounts.ts'
import { asUser, currentUser } from './ctx.ts'
import { settings } from './settings.ts'
import { sessionStatus } from './steamweb.ts'

// Как часто смотреть и что считать товаром — из настроек.
export const TICK = () => settings().tick
const GOAL = () => settings().goal

type Log = { ts: number; action: Action; why: string }

type Unit = {
  enabled: boolean
  delay: number
  auto: boolean            // подбирать паузу самому
  target: number | null    // сколько отправок заказано; null = до конца очереди
  ordered: number | null   // что человек попросил до превращения в живое число
  until: number            // до какого времени работать; 0 = без срока
  cap: number              // до какого счётчика вести каждый гем; 0 = жечь весь запас
  capped: string[]         // гемы, добравшиеся до своего потолка
  even: boolean            // растянуть работу ровно до срока, а не жечь и встать
  needSends: number        // сколько отправок до потолков — считано при пересборке
  needFrom: number         // сколько было сделано на тот момент
  waves: number            // на сколько партий разложить разброс
  plan: Wave[]
  // Какие гемы жечь на этом аккаунте. null — все, что лежат в инвентаре.
  // Пул матчей общий, журнал у каждого свой, поэтому два аккаунта могут
  // как жечь одно и то же независимо, так и разойтись по разным сущностям.
  only: string[] | null
  startedAt: number
  startBurned: number      // журнал на момент старта — от него считаем сделанное
  queueLength: number
  fingerprint: string
  failures: number         // отказы запуска: нет файла, нет сессии
  lastAction: Action
  lastWhy: string
  lastTick: number
  rebuiltAt: number
  log: Log[]
}

const U = new Map<string, Unit>()

function unit(id: string): Unit {
  let u = U.get(id)
  if (!u) {
    u = {
      enabled: false, delay: 1000, auto: true, target: null, ordered: null, until: 0,
      cap: 0, capped: [], even: false, needSends: 0, needFrom: 0,
      waves: 1, plan: [], only: null,
      startedAt: 0, startBurned: 0, queueLength: 0, fingerprint: '',
      failures: 0, lastAction: 'idle', lastWhy: 'не запускался',
      lastTick: 0, rebuiltAt: 0, log: [],
    }
    U.set(id, u)
  }
  return u
}

const note = (u: Unit, action: Action, why: string) => {
  u.lastAction = action
  u.lastWhy = why
  if (u.log[0]?.action === action && u.log[0]?.why === why) return
  u.log.unshift({ ts: Date.now(), action, why })
  if (u.log.length > 40) u.log.pop()
}

// Карта гемов читается часто — держим разбор, пока файл не изменился.
let mapCache: any[] = []
let mapAt = 0
function gemMap(): any[] {
  const f = path.join(TOOLS, 'gem-map.json')
  try {
    const m = fs.statSync(f).mtimeMs
    if (m !== mapAt) { mapCache = JSON.parse(fs.readFileSync(f, 'utf8')); mapAt = m }
  } catch { return [] }
  return mapCache
}

// Наибольший счётчик по каждому гему ЭТОГО аккаунта: по нему видно, дошёл ли
// он до своего потолка. Чужие счётчики здесь были бы прямой ложью — потолок
// решает, когда перестать тратить матчи.
//
// Отложенное на продажу не решает ничьих потолков: вещь уйдёт, и жечь
// под неё матчи — тратить запас впустую.
function counters(steamid: string): Map<string, number> {
  const aside = asideSet(db, steamid)
  const by = new Map<string, number>()
  for (const r of invOf(steamid).rows) {
    if (!r.gem || r.gem === '—') continue
    if (aside.has(r.assetid)) continue
    by.set(r.gem, Math.max(by.get(r.gem) ?? 0, r.value))
  }
  return by
}

// Кто уже добрался. Потолок у каждого гема свой и некруглый, поэтому
// счётчики выходят разными сами собой.
export function cappedGems(cap: number, steamid: string = ACCOUNT()): string[] {
  if (!cap) return []
  const out: string[] = []
  for (const [gem, value] of counters(steamid)) {
    if (reached(capFor(cap, gem), value)) out.push(gem)
  }
  return out.sort()
}

// Отпечаток состава: считаем по assetid, а не по счётчикам. Счётчики
// меняются каждую отправку, состав — только при покупке.
const fingerprint = (steamid: string) => invOf(steamid).rows.map(r => r.assetid).sort().join(',')

// Что жечь: всё, чьи гемы лежат в инвентаре ЭТОГО аккаунта и чья сущность
// известна. Выбирать вручную не нужно — состав и есть выбор.
//
// Отложенное на продажу не считается: гем, у которого отложены все вещи,
// выпадает из очереди целиком, и его запас остаётся тем, что купят позже.
export function picks(steamid: string = ACCOUNT()): (Pick & { objects: number })[] {
  const map = gemMap()
  if (!map.length) return []

  const aside = asideSet(db, steamid)
  const byGem = new Map<string, number>()
  for (const r of invOf(steamid).rows) {
    if (!r.gem || r.gem === '—') continue
    if (aside.has(r.assetid)) continue
    byGem.set(r.gem, (byGem.get(r.gem) ?? 0) + 1)
  }

  const out: (Pick & { objects: number })[] = []
  for (const [gem, objects] of byGem) {
    const g = map.find(x => String(x.name).replace(/^(Genuine )?Spectator: ?/, '') === gem)
    if (!g?.entity_id || (g.kind !== 'team' && g.kind !== 'player')) continue
    out.push({ key: gem, kind: g.kind, id: g.entity_id, objects })
  }
  return out
}

// Что жжёт именно этот аккаунт: либо всё из его инвентаря, либо выбранное.
export function picksFor(u: { only: string[] | null; cap?: number }, steamid: string = ACCOUNT()) {
  const all = picks(steamid)
  const chosen = u.only ? all.filter(p => new Set(u.only).has(p.key)) : all
  if (!u.cap) return chosen
  // Добравшиеся до потолка выбывают: их матчи больше не жжём, запас
  // остаётся для тех гемов этой же команды, что купят позже.
  const done = new Set(cappedGems(u.cap, steamid))
  return chosen.filter(p => !done.has(p.key))
}

// Долг каждого гема: сколько отправок ему не хватает до потолка. Без
// потолка долг равен всей очереди — растягивать тогда нечего, кроме неё.
function debts(u: Unit, steamid: string): Map<string, number> {
  const out = new Map<string, number>()
  if (!u.cap) return out
  const now = counters(steamid)
  for (const p of picksFor(u, steamid)) {
    const left = capFor(u.cap, p.key) - (now.get(p.key) ?? 0)
    if (left > 0) out.set(p.key, left)
  }
  return out
}

function rebuild(a: Account, u: Unit): number {
  const list = picksFor(u, a.steamid)
  if (!list.length) { u.queueLength = 0; return 0 }

  const queue = queueFor(db, list, a.steamid)
  const file = queueFile(a.id)
  fs.writeFileSync(path.join(GC, file), queue.map(r => r.match + ',' + r.league).join('\n') + '\n', 'utf8')
  // Журнал отправщика привязан к имени файла. Уже отправленное вычтено
  // запросом, поэтому старый журнал только мешал бы.
  try { fs.unlinkSync(path.join(GC, 'sent-' + file + '.json')) } catch { }

  u.queueLength = queue.length
  u.fingerprint = fingerprint(a.steamid)
  u.rebuiltAt = Date.now()

  // Сколько из этой очереди реально уйдёт: до потолков, а не до конца.
  const need = debts(u, a.steamid)
  u.needSends = need.size ? sendsNeeded(queue, need) : queue.length
  u.needFrom = made(a, u)
  return queue.length
}

function status(id: string): any {
  try { return JSON.parse(fs.readFileSync(path.join(GC, statusFile(id)), 'utf8')) } catch { return null }
}

const lastSendAt = (id: string) => Number(status(id)?.current?.ts) || 0

// Сделано в этом заходе — по журналу расхода, а не по счётчику в памяти:
// перезапуск панели не должен обнулять заказанный прогон.
function made(a: Account, u: Unit): number {
  if (!u.startedAt) return 0
  return Math.max(0, burnedCount(a.steamid) - u.startBurned)
}

// Замеры для подбора паузы: последние отправки этого аккаунта с их темпом.
// Замеры для подбора паузы: каждая отправка с ТОЙ паузой, на которой она
// действительно ушла.
//
// Раньше сюда подставлялась нынешняя пауза панели — одна и та же на все
// записи. Из-за этого фильтр в advise() («судим только по текущему темпу»)
// не отсекал ничего: замеры со вчерашней паузы в 5 секунд попадали в одну
// кучу с сегодняшними, и советчик считал чистыми те отправки, которые
// на нынешнем темпе никогда не делались. Отправщик пишет свою паузу
// в каждую запись отчёта — берём её.
export function toSamples(recent: any[], fallback: number): Sample[] {
  return (Array.isArray(recent) ? recent : [])
    .filter(e => e?.result)
    .map(e => ({
      delay: Number(e.delay) > 0 ? Number(e.delay) : fallback,
      ts: Number(e.ts) || 0,
      result: e.result as Sample['result'],
    }))
    .reverse()
}

function samples(id: string, delay: number): Sample[] {
  return toSamples(status(id)?.recent ?? [], delay)
}

export function paceAdvice(id: string) {
  return advise(samples(id, unit(id).delay), settings().pace)
}

// Доля отправок, за которые действительно начислили. По ней и растяжка
// по сроку, и оценка «сколько осталось» — иначе оба числа врут одинаково.
function credit(id: string): number {
  const t = status(id)?.tally ?? { update: 0, dup: 0 }
  return creditRate(Number(t.update) || 0, Number(t.dup) || 0)
}

// Сколько отправок ещё предстоит: посчитанное при пересборке минус
// сделанное с того момента.
const sendsLeft = (u: Unit, done: number) => {
  // Заказанное число главнее расчёта: человек сказал «столько-то отправок»,
  // и делить срок надо на них, а не на путь до потолков.
  if (u.target !== null) return Math.max(1, u.target - done)
  return Math.max(1, u.needSends - Math.max(0, done - u.needFrom))
}

const nice = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m >= 60 ? Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин' : m + ' мин'
}

// Остановка с причиной. Одна дверь, чтобы нельзя было выключить работника
// и забыть погасить отправщик: он продолжал бы жечь очередь молча.
function halt(a: Account, u: Unit, why: string, push: () => void) {
  note(u, 'halt', why)
  u.enabled = false
  if (senderState(a.id).running) stopSender(a.id)
  push()
}

async function tickOne(a: Account, push: () => void) {
  const u = unit(a.id)
  u.lastTick = Date.now()
  if (!u.enabled) { note(u, 'idle', 'работник выключен'); return }

  const sender = senderState(a.id)
  const count = made(a, u)
  const box = invOf(a.steamid)

  // Сессия отозвана Steam — отправщик не войдёт, а при попытке удалит токен.
  // Встаём сразу, с понятной причиной.
  if (sessionStatus(a, true).state === 'revoked') {
    halt(a, u, 'сессия Steam отозвана — обновите её по QR на экране аккаунтов', push)
    return
  }

  // Отправщик сказал, что возвращаться некуда: сессия протухла, Steam
  // выбивает вход подряд. Перезапуск даст ровно то же самое.
  if (sender.fatal && !sender.running) {
    halt(a, u, sender.fatal, push)
    return
  }

  // Инвентарь этого аккаунта не читается вовсе. Жечь по чужому или пустому
  // составу нельзя: очередь соберётся не из тех матчей, а они необратимы.
  if (box.private) {
    halt(a, u, 'инвентарь аккаунта закрыт настройками Steam — состав не виден', push)
    return
  }

  // Гем добрался до потолка — состав работы изменился, даже если инвентарь
  // прежний. Счётчики растут каждую отправку, поэтому отпечаток состава
  // такого не ловит: он считается по номерам вещей, а не по числам на них.
  // Потолок судит по счётчикам из инвентаря. Steam режет чтение по 429
  // и держит отказ часами: 22 августа счётчики стояли с 02:25 до утра,
  // пока работник жёг дальше. Слепой потолок хуже отсутствующего — он
  // обещает остановку, которой не будет, а матчи тратятся необратимо.
  const stale = Date.now() - (box.ts || 0)
  if (u.cap && stale > settings().invStale) {
    halt(a, u, 'счётчики не читаются ' + Math.round(stale / 60_000) + ' мин — потолок вслепую не считаю', push)
    return
  }

  const capped = cappedGems(u.cap, a.steamid)
  const capsChanged = capped.join(',') !== u.capped.join(',')
  if (capsChanged) {
    u.capped = capped
    u.fingerprint = ''
    if (capped.length) note(u, 'rebuild', 'дошли до потолка: ' + capped.join(', '))
  }

  const d = decide({
    enabled: u.enabled,
    senderAlive: sender.running,
    queueLength: u.queueLength,
    inventoryChanged: box.rows.length > 0 && fingerprint(a.steamid) !== u.fingerprint,
    // Только своя метка: чужая заставила бы убивать живой отправщик.
    lastSendAt: freshSendAt(lastSendAt(a.id), sender.startedAt ?? 0),
    now: Date.now(),
    // Отказы запуска и падения на ходу — одна беда с точки зрения решения:
    // отправщик не работает и сам не заработает.
    failures: u.failures + (sender.crashes ?? 0),
    target: u.target,
    done: count,
    senderStartedAt: sender.startedAt ?? 0,
    displaced: sender.displaced ?? 0,
    until: u.until,
    drained: !!sender.drained,
  }, {
    silentLimit: silenceLimit(settings().silentLimit, u.delay),
    startLimit: settings().startLimit,
    maxFailures: settings().maxFailures,
  })

  note(u, d.action, d.why)

  if (d.action === 'halt') {
    halt(a, u, d.why, push)
    return
  }

  if (d.action === 'idle') { push(); return }

  if (d.action === 'watch') {
    // Пауза подбирается на ходу: пока GC отвечает на каждую отправку,
    // темп можно поднимать. Отправщик перечитывает свой delay-файл сам.
    if (u.even && u.until) {
      // Долг считается в начислениях, а отправок на него уйдёт больше:
      // часть отвечает пустым. Делим срок на отправки, а не на долг.
      const rate = credit(a.id)
      const want = evenDelay(u.until - Date.now(), Math.round(sendsLeft(u, count) / rate), settings().pace.floor)
      if (want !== u.delay) {
        u.delay = writePace(a.id, want)
        note(u, 'watch', 'пауза ' + u.delay + ' мс — ' + nice(u.until - Date.now())
          + ' на ' + Math.round(sendsLeft(u, count) / rate) + ' отправок'
          + (rate < 0.95 ? ' (начисляет ' + Math.round(rate * 100) + '%)' : ''))
      }
    } else if (u.auto) {
      const adv = advise(samples(a.id, u.delay), settings().pace)
      if (adv.suggest !== u.delay && adv.measured >= settings().pace.enough) {
        u.delay = writePace(a.id, adv.suggest)
        note(u, 'watch', 'пауза ' + u.delay + ' мс — ' + adv.why)
      }
    }
    push()
    return
  }

  if (d.action === 'rebuild') {
    const n = rebuild(a, u)
    note(u, 'rebuild', n
      ? 'очередь пересобрана: ' + n + ' матчей'
      : (u.only ? (u.only.length ? 'выбранные гемы ничего не дают' : 'ни один гем не выбран') : 'в инвентаре нет гемов, по которым понятно, чьи матчи считать'))
    if (sender.running) stopSender(a.id)
    push()
    return
  }

  if (d.action === 'restart') { stopSender(a.id); push(); return }

  if (d.action === 'start') {
    const left = u.target === null ? null : Math.max(0, u.target - count)
    const r = startSender(a.id, a.token, queueFile(a.id), u.delay, push, left)
    if ((r as any).error) {
      u.failures++
      note(u, 'start', 'не удалось запустить: ' + (r as any).error)
    } else {
      // Отказы запуска обнуляются: файл нашёлся, сессия на месте. Падения
      // на ходу считает сам отправщик — их этим не стереть.
      u.failures = 0
    }
    push()
  }
}

// Что сервер знает о пользователях — снаружи (app.ts). По умолчанию — как
// до этапа 7: все активны, предела нет.
export const autopilotHooks = {
  userActive: (_user: string) => true,
  maxSenders: (_user: string) => Infinity,
}

// Работник отключённого пользователя (план 7.2, решение 10) гаснет на
// ближайшем такте, даже если «включён» остался в памяти.
function fenceDisabled(a: Account) {
  if (autopilotHooks.userActive(ownerOf(a))) return false
  const u = unit(a.id)
  if (u.enabled || senderState(a.id).running) {
    u.enabled = false
    stopSender(a.id)
    note(u, 'idle', 'доступ пользователя отключён')
  }
  return true
}

export async function tick(push: () => void) {
  // Инвентарь читается по каждому включённому аккаунту отдельно. Один общий
  // снимок означал бы, что второй работник жжёт по составу первого.
  for (const a of accounts()) {
    if (fenceDisabled(a)) continue
    if (unit(a.id).enabled) await refreshInventory(a.steamid)
  }
  // Такт аккаунта — от имени его владельца: его личные настройки (план 7.2).
  for (const a of accounts()) {
    if (fenceDisabled(a)) continue
    await asUser(ownerOf(a), () => tickOne(a, push))
  }
}

export function unitState(a: Account) {
  const u = unit(a.id)
  const s = senderState(a.id)
  const mine = picks(a.steamid)
  const box = invOf(a.steamid)
  return {
    id: a.id,
    label: a.label,
    steamid: a.steamid,
    enabled: u.enabled,
    // Когда человек включил работника. Без этого полосу «сколько срока
    // прошло» нечем заполнить: остаток известен, а начало — нет.
    startedAt: u.startedAt,
    delay: u.delay,
    auto: u.auto,
    target: u.target,
    until: u.until,
    cap: u.cap,
    even: u.even,
    needSends: u.needSends,
    sendsLeft: u.needSends ? sendsLeft(u, made(a, u)) : 0,
    // Потолки показываем только по тем гемам, что реально пойдут в работу
    // этого аккаунта: чужие числа в списке читались как обещание.
    caps: u.cap ? picksFor({ only: u.only }, a.steamid).map(p => ({ gem: p.key, cap: capFor(u.cap, p.key) })) : [],
    capped: u.capped,
    ordered: u.ordered,
    waves: u.waves,
    plan: u.plan,
    only: u.only,
    // Что доступно для выбора и что реально пойдёт в очередь.
    available: mine.map(p => ({ gem: p.key, objects: p.objects })),
    picked: picksFor(u, a.steamid).map(p => p.key),
    // Следующая партия: работник сам скажет, когда её добавлять.
    nextWave: u.plan.find(w => w.addAt > made(a, u)) ?? null,
    done: made(a, u),
    queueLength: u.queueLength,
    action: u.lastAction,
    why: u.lastWhy,
    lastTick: u.lastTick,
    rebuiltAt: u.rebuiltAt,
    failures: u.failures + (s.crashes ?? 0),
    displaced: s.displaced,
    fatal: s.fatal,
    running: s.running,
    pid: s.pid,
    exit: s.exit,
    lines: s.lines.slice(-40),
    burned: burnedCount(a.steamid),
    // Инвентарь этого аккаунта: возраст снимка и его беда, если она есть.
    // Одно общее поле врало бы про всех, кроме активного.
    inv: {
      error: box.error,
      private: box.private,
      truncated: box.truncated,
      age: box.ts ? Math.round((Date.now() - box.ts) / 1000) : null,
      items: box.rows.length,
    },
    // Сколько осталось на самом деле.
    //
    // Два поправочных множителя, и оба взяты из работы, а не из головы.
    // Первый: считаем до потолков, а не до конца очереди — по длине очереди
    // выходило 28 часов там, где работы на восемь. Второй: часть отправок
    // отвечает пустым и долг не уменьшает, поэтому их нужно больше, чем
    // начислений. Без этого множителя срок расходился ровно во столько раз,
    // во сколько пустых больше нуля: при половине пустых час превращался
    // в два, а панель до последнего обещала час.
    etaMinutes: u.queueLength
      ? Math.round(((u.needSends ? sendsLeft(u, made(a, u)) : u.queueLength) / credit(a.id)) * u.delay / 60_000)
      : 0,
    log: u.log.slice(0, 20),
  }
}

export function autopilotState() {
  const a = active()
  const list = picks(a?.steamid ?? ACCOUNT())
  return {
    goal: GOAL(),
    objects: list.reduce((n, p) => n + p.objects, 0),
    gems: list.map(p => ({ gem: p.key, objects: p.objects })),
    // Работники — только своих аккаунтов (план 7.2).
    units: listFor(currentUser()).map(unitState),
    pace: a ? paceAdvice(a.id) : null,
    // Поля активного аккаунта подняты наверх: дашборд смотрит на него.
    ...(a ? unitState(a) : {}),
  }
}

// on не передан — трогаем только настройки, выключатель остаётся как был.
export function setAutopilot(
  id: string,
  patch: {
    on?: boolean
    delay?: number
    target?: number | null
    auto?: boolean
    waves?: number
    until?: number
    cap?: number
    even?: boolean
    only?: string[] | null
  },
) {
  const a = accounts().find(x => x.id === id)
  if (!a) return { error: 'нет такого аккаунта' }
  const u = unit(id)

  if (patch.delay !== undefined) {
    const want = Math.trunc(Number(patch.delay) || 0)
    if (!Number.isFinite(want) || want < settings().pace.floor) {
      return { error: 'пауза меньше пола ' + settings().pace.floor + ' мс — отправщик такую не примет' }
    }
    // Ручная пауза старше и подбора, и растяжки: человек сказал число.
    // Иначе выбранное значение молча переписывалось бы на следующем такте.
    u.auto = false
    u.even = false
    // Пауза пишется сразу, а не при следующем решении работника: на ручной
    // паузе он в темп не вмешивается вовсе, и выбранное число доходило до
    // отправщика только через остановку и запуск.
    u.delay = writePace(id, want)
  }
  if (patch.auto !== undefined) {
    u.auto = !!patch.auto
    // «Сама» и «к сроку» — два разных хозяина у одной ручки. Включая одного,
    // выключаем другого, иначе они переписывали бы паузу по очереди.
    if (u.auto) u.even = false
  }
  if (patch.until !== undefined) {
    u.until = Math.max(0, Math.trunc(Number(patch.until) || 0))
    // Срок сам по себе означает «раздели работу на это время». Иначе
    // «до десяти утра» выжигало бы всё к четырём и стояло бы до десяти.
    if (patch.even === undefined) u.even = u.until > 0
  }
  if (patch.even !== undefined) {
    u.even = !!patch.even
    if (u.even) u.auto = false
  }
  if (patch.cap !== undefined) {
    u.cap = Math.max(0, Math.trunc(Number(patch.cap) || 0))
    u.capped = []
    u.fingerprint = ''   // состав работы меняется — пересобрать очередь
  }
  if (patch.waves !== undefined) u.waves = Math.max(1, Math.min(8, Math.trunc(patch.waves)))
  if (patch.only !== undefined) {
    // «Все» — это null. Пустой список — «ничего»: раньше он тоже значил
    // «все», и снятая последняя галочка включала прожиг каждого гема
    // в инвентаре — ровно обратное тому, что человек просил.
    u.only = Array.isArray(patch.only) ? patch.only.map(String).filter(Boolean) : null
    u.fingerprint = ''   // состав изменился — очередь пересобрать
  }
  if (patch.target !== undefined) {
    if (patch.target === null) {
      u.ordered = null
      u.target = null
      u.plan = []
    } else {
      // Круглое число на витрине выдаёт накрутку, поэтому заказ превращается
      // в живое: 1000 → 1147. Ниже заказанного не опускаемся.
      u.ordered = Math.max(1, Math.trunc(patch.target))
      u.plan = spreadPlan(u.ordered, u.waves, id + ':' + u.ordered, settings().spread)
      u.target = u.plan[0].value
    }
  }

  // Предел одновременно работающих отправщиков пользователя (решение 10).
  if (patch.on === true && !u.enabled) {
    const owner = ownerOf(a)
    const max = autopilotHooks.maxSenders(owner)
    const busy = listFor(owner).filter(x => x.id !== id && (unit(x.id).enabled || senderState(x.id).running)).length
    if (busy >= max) return { error: 'достигнут предел одновременно работающих отправщиков: ' + max }
    if (!autopilotHooks.userActive(owner)) return { error: 'нет такого аккаунта' }
  }

  if (patch.on !== undefined) {
    u.enabled = !!patch.on
    if (!u.enabled) {
      stopSender(id)
      note(u, 'idle', 'выключен вручную')
    } else {
      u.failures = 0
      // Падения и выбивания прошлого захода к этому не относятся: человек
      // сказал «работай», значит он уже разобрался с тем, что мешало.
      forget(id)
      u.fingerprint = ''
      u.startedAt = Date.now()
      u.startBurned = burnedCount(a.steamid)
      note(u, 'idle', u.target
        ? 'остановлюсь на ' + u.target + (u.ordered && u.target !== u.ordered ? ' (заказ ' + u.ordered + ', круглое не берём)' : '') + ', собираю очередь'
        : 'включён, собираю очередь')
    }
  }
  return unitState(a)
}
