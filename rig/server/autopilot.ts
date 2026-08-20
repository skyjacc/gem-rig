// Автопилот — цикл, который исполняет решения worker.decide().
//
// Живёт внутри панели. Раз в минуту смотрит инвентарь, пересобирает очередь,
// держит отправщик живым. Ничего не делает, пока не включён: по умолчанию
// выключен, потому что каждая отправка необратима.
//
// Человек покупает гем — автопилот через минуту это видит, добавляет его
// матчи в очередь и продолжает. Нажимать ничего не надо.

import fs from 'node:fs'
import path from 'node:path'
import { GC, TOOLS } from './paths.ts'
import { db } from './db.ts'
import { decide, type Action } from './worker.ts'
import { queueFor, type Pick } from './queue.ts'
import { inv, refreshInventory } from './steam.ts'
import { senderState, start as startSender, stop as stopSender } from './sender.ts'

const QUEUE_FILE = 'autopilot.csv'
const TICK = 20_000

type Log = { ts: number; action: Action; why: string }

const S = {
  enabled: false,
  delay: 1000,
  goal: 2000,
  queueLength: 0,
  fingerprint: '',
  failures: 0,
  lastAction: 'idle' as Action,
  lastWhy: 'не запускался',
  lastTick: 0,
  rebuiltAt: 0,
  log: [] as Log[],
}

const note = (action: Action, why: string) => {
  S.lastAction = action
  S.lastWhy = why
  if (S.log[0]?.action === action && S.log[0]?.why === why) return
  S.log.unshift({ ts: Date.now(), action, why })
  if (S.log.length > 40) S.log.pop()
}

// Отпечаток состава: если изменился — в инвентаре что-то появилось или ушло,
// и очередь пора пересобирать. Считаем по assetid, а не по счётчикам:
// счётчики меняются каждую отправку, состав — только при покупке.
function fingerprint(): string {
  return inv.rows.map(r => r.assetid).sort().join(',')
}

// Что жечь: всё, чьи гемы лежат в инвентаре и чья сущность известна.
// Выбирать вручную не нужно — состав и есть выбор.
// Карта гемов читается на каждом такте и на каждой отправке состояния —
// держим разбор, пока файл не изменился.
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

function picks(): (Pick & { objects: number })[] {
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

function rebuild(): number {
  const list = picks()
  if (!list.length) { S.queueLength = 0; return 0 }

  const queue = queueFor(db, list)
  fs.writeFileSync(
    path.join(GC, QUEUE_FILE),
    queue.map(r => r.match + ',' + r.league).join('\n') + '\n',
    'utf8',
  )
  // Журнал отправщика привязан к имени файла. Очередь пересобирается,
  // но уже отправленное вычтено из неё запросом — журнал только мешал бы,
  // заставляя пропускать строки, которых в новой очереди и так нет.
  try { fs.unlinkSync(path.join(GC, 'sent-' + QUEUE_FILE + '.json')) } catch { }

  S.queueLength = queue.length
  S.fingerprint = fingerprint()
  S.rebuiltAt = Date.now()
  return queue.length
}

// Когда отправщик последний раз что-то отправил — по его же журналу событий.
function lastSendAt(): number {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(GC, 'status.json'), 'utf8'))
    return Number(st?.current?.ts) || 0
  } catch { return 0 }
}

export async function tick(push: () => void) {
  S.lastTick = Date.now()
  if (!S.enabled) { note('idle', 'работник выключен'); return }

  await refreshInventory()

  const sender = senderState()
  const d = decide({
    enabled: S.enabled,
    senderAlive: sender.running,
    queueLength: S.queueLength,
    inventoryChanged: inv.rows.length > 0 && fingerprint() !== S.fingerprint,
    lastSendAt: lastSendAt(),
    now: Date.now(),
    failures: S.failures,
  })

  note(d.action, d.why)

  if (d.action === 'halt') { S.enabled = false; push(); return }
  if (d.action === 'idle' || d.action === 'watch') { push(); return }

  if (d.action === 'rebuild') {
    const n = rebuild()
    note('rebuild', n ? 'очередь пересобрана: ' + n + ' матчей' : 'в инвентаре нет гемов с известной сущностью')
    if (sender.running) stopSender()
    push()
    return
  }

  if (d.action === 'restart') { stopSender(); push(); return }

  if (d.action === 'start') {
    const r = startSender(QUEUE_FILE, S.delay, push)
    if ((r as any).error) {
      S.failures++
      note('start', 'не удалось запустить: ' + (r as any).error)
    } else {
      S.failures = 0
    }
    push()
  }
}

export function autopilotState() {
  const list = picks()
  const units = list.reduce((a, p) => a + p.objects, 0)
  return {
    enabled: S.enabled,
    delay: S.delay,
    goal: S.goal,
    queueLength: S.queueLength,
    action: S.lastAction,
    why: S.lastWhy,
    lastTick: S.lastTick,
    rebuiltAt: S.rebuiltAt,
    failures: S.failures,
    objects: units,
    gems: list.map(p => ({ gem: p.key, objects: p.objects })),
    log: S.log.slice(0, 20),
    // 76 отправок в минуту — измерено 20 августа при паузе 1000 мс.
    etaMinutes: S.queueLength ? Math.round(S.queueLength / 76) : 0,
  }
}

export function setAutopilot(on: boolean, delay?: number) {
  S.enabled = !!on
  if (delay && delay >= 500) S.delay = delay
  if (!on) { stopSender(); note('idle', 'выключен вручную') }
  else { S.failures = 0; S.fingerprint = ''; note('idle', 'включён, собираю очередь') }
  return autopilotState()
}
