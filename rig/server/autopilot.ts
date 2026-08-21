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

import fs from 'node:fs'
import path from 'node:path'
import { GC, TOOLS } from './paths.ts'
import { burnedCount, db } from './db.ts'
import { decide, freshSendAt, type Action } from './worker.ts'
import { queueFor, type Pick } from './queue.ts'
import { inv, refreshInventory } from './steam.ts'
import { queueFile, senderState, start as startSender, statusFile, stop as stopSender } from './sender.ts'
import { advise, type Sample } from './pace.ts'
import { spreadPlan, type Wave } from './spread.ts'
import { active, list as accounts, type Account } from './accounts.ts'
import { settings } from './settings.ts'

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
  failures: number
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
      enabled: false, delay: 1000, auto: true, target: null, ordered: null, until: 0, waves: 1, plan: [], only: null,
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

// Отпечаток состава: считаем по assetid, а не по счётчикам. Счётчики
// меняются каждую отправку, состав — только при покупке.
const fingerprint = () => inv.rows.map(r => r.assetid).sort().join(',')

// Что жечь: всё, чьи гемы лежат в инвентаре и чья сущность известна.
// Выбирать вручную не нужно — состав и есть выбор.
export function picks(): (Pick & { objects: number })[] {
  const map = gemMap()
  if (!map.length) return []

  const byGem = new Map<string, number>()
  for (const r of inv.rows) {
    if (!r.gem || r.gem === '—') continue
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

// Что жжёт именно этот аккаунт: либо всё из инвентаря, либо выбранное.
export function picksFor(u: { only: string[] | null }) {
  const all = picks()
  if (!u.only?.length) return all
  const keep = new Set(u.only)
  return all.filter(p => keep.has(p.key))
}

function rebuild(a: Account, u: Unit): number {
  const list = picksFor(u)
  if (!list.length) { u.queueLength = 0; return 0 }

  const queue = queueFor(db, list, a.steamid)
  const file = queueFile(a.id)
  fs.writeFileSync(path.join(GC, file), queue.map(r => r.match + ',' + r.league).join('\n') + '\n', 'utf8')
  // Журнал отправщика привязан к имени файла. Уже отправленное вычтено
  // запросом, поэтому старый журнал только мешал бы.
  try { fs.unlinkSync(path.join(GC, 'sent-' + file + '.json')) } catch { }

  u.queueLength = queue.length
  u.fingerprint = fingerprint()
  u.rebuiltAt = Date.now()
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
function samples(id: string, delay: number): Sample[] {
  const st = status(id)
  const recent: any[] = st?.recent ?? []
  return recent
    .filter(e => e?.result)
    .map(e => ({ delay, ts: Number(e.ts) || 0, result: e.result as Sample['result'] }))
    .reverse()
}

export function paceAdvice(id: string) {
  return advise(samples(id, unit(id).delay), settings().pace)
}

async function tickOne(a: Account, push: () => void) {
  const u = unit(a.id)
  u.lastTick = Date.now()
  if (!u.enabled) { note(u, 'idle', 'работник выключен'); return }

  const sender = senderState(a.id)
  const count = made(a, u)

  const d = decide({
    enabled: u.enabled,
    senderAlive: sender.running,
    queueLength: u.queueLength,
    inventoryChanged: inv.rows.length > 0 && fingerprint() !== u.fingerprint,
    // Только своя метка: чужая заставила бы убивать живой отправщик.
    lastSendAt: freshSendAt(lastSendAt(a.id), sender.startedAt ?? 0),
    now: Date.now(),
    failures: u.failures,
    target: u.target,
    done: count,
    senderStartedAt: sender.startedAt ?? 0,
    displaced: sender.displaced ?? 0,
    until: u.until,
  }, {
    silentLimit: settings().silentLimit,
    startLimit: settings().startLimit,
    maxFailures: settings().maxFailures,
  })

  note(u, d.action, d.why)

  if (d.action === 'halt') {
    u.enabled = false
    if (sender.running) stopSender(a.id)
    push()
    return
  }

  if (d.action === 'idle') { push(); return }

  if (d.action === 'watch') {
    // Пауза подбирается на ходу: пока GC отвечает на каждую отправку,
    // темп можно поднимать. Отправщик перечитывает delay.txt сам.
    if (u.auto) {
      const adv = advise(samples(a.id, u.delay), settings().pace)
      if (adv.suggest !== u.delay && adv.measured >= settings().pace.enough) {
        u.delay = adv.suggest
        fs.writeFileSync(path.join(GC, 'delay.txt'), String(u.delay))
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
      : (u.only?.length ? 'выбранные гемы ничего не дают' : 'в инвентаре нет гемов, по которым понятно, чьи матчи считать'))
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
      u.failures = 0
    }
    push()
  }
}

export async function tick(push: () => void) {
  const on = accounts().filter(a => unit(a.id).enabled)
  if (on.length) await refreshInventory()
  for (const a of accounts()) await tickOne(a, push)
}

export function unitState(a: Account) {
  const u = unit(a.id)
  const s = senderState(a.id)
  return {
    id: a.id,
    label: a.label,
    steamid: a.steamid,
    enabled: u.enabled,
    delay: u.delay,
    auto: u.auto,
    target: u.target,
    until: u.until,
    ordered: u.ordered,
    waves: u.waves,
    plan: u.plan,
    only: u.only,
    // Что доступно для выбора и что реально пойдёт в очередь.
    available: picks().map(p => ({ gem: p.key, objects: p.objects })),
    picked: picksFor(u).map(p => p.key),
    // Следующая партия: работник сам скажет, когда её добавлять.
    nextWave: u.plan.find(w => w.addAt > made(a, u)) ?? null,
    done: made(a, u),
    queueLength: u.queueLength,
    action: u.lastAction,
    why: u.lastWhy,
    lastTick: u.lastTick,
    rebuiltAt: u.rebuiltAt,
    failures: u.failures,
    running: s.running,
    pid: s.pid,
    exit: s.exit,
    lines: s.lines.slice(-40),
    burned: burnedCount(a.steamid),
    etaMinutes: u.queueLength ? Math.round((u.queueLength * u.delay) / 60_000) : 0,
    log: u.log.slice(0, 20),
  }
}

export function autopilotState() {
  const list = picks()
  const a = active()
  return {
    goal: GOAL(),
    objects: list.reduce((n, p) => n + p.objects, 0),
    gems: list.map(p => ({ gem: p.key, objects: p.objects })),
    units: accounts().map(unitState),
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
    only?: string[] | null
  },
) {
  const a = accounts().find(x => x.id === id)
  if (!a) return { error: 'нет такого аккаунта' }
  const u = unit(id)

  if (patch.delay && patch.delay >= settings().pace.floor) { u.delay = patch.delay; u.auto = false }
  if (patch.auto !== undefined) u.auto = !!patch.auto
  if (patch.until !== undefined) u.until = Math.max(0, Math.trunc(Number(patch.until) || 0))
  if (patch.waves !== undefined) u.waves = Math.max(1, Math.min(8, Math.trunc(patch.waves)))
  if (patch.only !== undefined) {
    const list = Array.isArray(patch.only) ? patch.only.map(String).filter(Boolean) : []
    // Пустой выбор означает «все»: аккаунт без единого гема просто стоял бы.
    u.only = list.length ? list : null
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

  if (patch.on !== undefined) {
    u.enabled = !!patch.on
    if (!u.enabled) {
      stopSender(id)
      note(u, 'idle', 'выключен вручную')
    } else {
      u.failures = 0
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
