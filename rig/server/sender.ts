// Управление отправщиками. Панель запускает и останавливает их сама.
//
// Отправщик один на аккаунт. Ограничение «одна сессия» действует на аккаунт,
// а не на машину, поэтому два и три работают рядом и в сумме дают втрое
// больше товара за то же время.
//
// У каждого своё: файл сессии, файл очереди, файл отчёта, файл темпа. Общий
// файл два процесса просто затирали бы друг другу — и отчёт, и темп.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { GC } from './paths.ts'

type Sender = {
  child: ChildProcess | null
  file: string | null
  delay: number | null
  limit: number | null
  startedAt: number | null
  lines: string[]
  exit: string | null
  displaced: number   // сколько раз аккаунт выбило другой сессией Steam
  crashes: number     // сколько раз подряд процесс умер сам, не по нашей просьбе
  stopping: boolean   // мы сами его останавливаем — это не падение
  fatal: string | null // причина, по которой возвращаться бессмысленно
}

const S = new Map<string, Sender>()

const blank = (): Sender => ({
  child: null, file: null, delay: null, limit: null, startedAt: null,
  lines: [], exit: null, displaced: 0, crashes: 0, stopping: false, fatal: null,
})

const slot = (id: string): Sender => {
  let s = S.get(id)
  if (!s) { s = blank(); S.set(id, s) }
  return s
}

// Что панель понимает из вывода отправщика.
//
// Отправщик печатает метки одним словом — «EVENT displaced» и подобные.
// Разбирать русскую фразу нельзя: она меняется при первой же правке текста,
// а от этого разбора зависит остановка работника. Пока метки не было,
// поле displaced не увеличивалось НИКОГДА, и вся ветка «аккаунт занят
// другой сессией» в worker.decide была недостижимым кодом.
const EVENT = /^EVENT\s+([a-z-]+)$/

// Метки, после которых возвращаться бессмысленно: пока человек не вмешается,
// повтор даст ровно то же самое.
const FATAL: Record<string, string> = {
  'stale-token': 'сессия аккаунта протухла — привяжите его заново по QR',
  exhausted: 'Steam выбивает вход подряд — закройте игру и клиент Steam',
  fatal: 'отправщик не смог войти',
}

function digest(s: Sender, line: string) {
  const m = line.match(EVENT)
  if (!m) return
  const kind = m[1]
  if (kind === 'displaced') s.displaced++
  if (FATAL[kind]) s.fatal = FATAL[kind]
}

const remember = (s: Sender, line: string) => {
  for (const l of line.split(/\r?\n/)) {
    const t = l.trimEnd()
    if (!t) continue
    s.lines.push(t)
    digest(s, t.trim())
  }
  while (s.lines.length > 200) s.lines.shift()
}

// Жив ли процесс.
//
// Мало проверить exitCode: процесс, убитый сигналом, оставляет его пустым
// навсегда, а признак смерти кладёт в signalCode. Панель на этом двадцать
// минут считала мёртвый отправщик живым, работник ничего не предпринимал,
// и следующий запуск не происходил вовсе.
export const isAlive = (child: { exitCode: number | null; signalCode: string | null } | null) =>
  !!child && child.exitCode === null && child.signalCode === null

// Сколько процесс должен прожить, чтобы считаться работавшим, а не упавшим.
// Минута: за это время отправщик успевает войти и отправить хотя бы раз даже
// на самой медленной паузе.
const LIVED_ENOUGH = 60_000

export const statusFile = (id: string) => (id === 'main' ? 'status.json' : `status-${id}.json`)
export const queueFile = (id: string) => (id === 'main' ? 'autopilot.csv' : `autopilot-${id}.csv`)
// Темп у каждого аккаунта свой. Раньше файл был один на всех, и два
// работника с разными сроками перетирали друг другу паузу: тот, кто тикнул
// последним, задавал темп обоим.
export const paceFile = (id: string) => (id === 'main' ? 'delay.txt' : `delay-${id}.txt`)

export function senderState(id = 'main') {
  const s = slot(id)
  return {
    running: isAlive(s.child),
    pid: s.child?.pid ?? null,
    file: s.file,
    delay: s.delay,
    limit: s.limit,
    startedAt: s.startedAt,
    exit: s.exit,
    displaced: s.displaced,
    crashes: s.crashes,
    fatal: s.fatal,
    lines: s.lines.slice(-60),
  }
}

export const runningIds = () => [...S.entries()].filter(([, s]) => isAlive(s.child)).map(([id]) => id)

// Начать заход с чистого листа: человек включил работника руками, прошлые
// падения к этому заходу не относятся.
export function forget(id: string) {
  const s = slot(id)
  s.crashes = 0
  s.displaced = 0
  s.fatal = null
}

// Пауза — только файлом. Ниже пятисот отправщик значение из файла не примет
// вовсе (tools/gcwatch/lib.js, effectiveDelay) и молча останется на прежнем
// темпе: панель показывала бы одно, а уходило бы другое.
export const PACE_FLOOR = 500

export function writePace(id: string, ms: number) {
  const v = Math.max(PACE_FLOOR, Math.trunc(Number(ms) || 0))
  fs.writeFileSync(path.join(GC, paceFile(id)), String(v))
  return v
}

// Списки матчей, которые можно скормить отправщику.
export function listFiles() {
  if (!fs.existsSync(GC)) return []
  return fs.readdirSync(GC)
    .filter(f => f.endsWith('.csv'))
    .map(f => {
      const p = path.join(GC, f)
      const text = fs.readFileSync(p, 'utf8')
      const rows = text.split(/\r?\n/).filter(l => /^\d{6,}/.test(l.trim())).length
      return { name: f, rows, mtime: fs.statSync(p).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

// Имя файла, а не путь.
//
// Имя приходит снаружи и склеивается с папкой отправщика. Без проверки
// «../../» уводило бы запуск к любому файлу на диске, а за этой кнопкой —
// необратимые сообщения игровому координатору.
export const safeName = (name: string) =>
  /^[A-Za-z0-9._-]+\.csv$/.test(String(name)) && !String(name).includes('..')

export function start(
  id: string,
  token: string,
  file: string,
  delay: number,
  onLine: () => void,
  limit?: number | null,
) {
  const s = slot(id)
  if (isAlive(s.child)) return { error: 'отправщик уже работает' }
  if (!safeName(file)) return { error: 'недопустимое имя файла очереди' }

  const full = path.join(GC, file)
  if (!fs.existsSync(full)) return { error: 'нет файла ' + file }
  if (!fs.existsSync(path.join(GC, token))) return { error: 'нет сессии ' + token + ' — привяжите аккаунт' }

  const pace = writePace(id, delay)

  // Отчёт прошлого запуска стираем. Он переживает перезапуск компьютера,
  // и по нему работник считал молчание в двадцать два часа, а подбор паузы
  // судил о темпе по вчерашним замерам.
  try { fs.unlinkSync(path.join(GC, statusFile(id))) } catch { }

  // Паузу передаём ТОЛЬКО файлом, без --delay. Флаг у отправщика главнее
  // файла, поэтому прогон намертво вставал на стартовом темпе: панель
  // писала «пауза 2600», а отправлялось по одной в секунду — как при
  // запуске. Через файл темп читается перед каждой отправкой и меняется
  // на ходу, без перезапуска.
  const args = [
    'index.js',
    '--ids', file,
    '--send',
    '--keep-alive',
    '--token', token,
    '--status', statusFile(id),
    '--delay-file', paceFile(id),
  ]
  if (limit && limit > 0) args.push('--limit', String(limit))

  const child = spawn(process.execPath, args, { cwd: GC, windowsHide: true })

  s.child = child
  s.file = file
  s.delay = pace
  s.limit = limit ?? null
  s.startedAt = Date.now()
  s.exit = null
  s.lines = []
  s.displaced = 0
  s.stopping = false
  s.fatal = null
  remember(s, `запущен: node ${args.join(' ')}`)

  child.stdout?.on('data', b => { remember(s, String(b)); onLine() })
  child.stderr?.on('data', b => { remember(s, String(b)); onLine() })
  child.on('exit', (code, signal) => {
    s.exit = signal ? `остановлен (${signal})` : `завершился с кодом ${code}`
    // Падение считается, только если процесс умер САМ и не прожил минуты.
    //
    // Раньше падения считал работник и только по отказу спавна, а любой
    // удавшийся запуск обнулял счётчик: отправщик, который поднимался
    // и умирал через секунду, крутился бы так вечно и не останавливался
    // никогда. Теперь счётчик ведёт тот, кто видит смерть.
    const lived = Date.now() - (s.startedAt ?? Date.now())
    if (s.stopping) {
      // Наша остановка: пересборка, перезапуск, выключение. Не падение.
    } else if (lived < LIVED_ENOUGH) {
      s.crashes++
    } else {
      s.crashes = 0
    }
    s.stopping = false
    remember(s, s.exit)
    onLine()
  })

  return { ok: true, pid: child.pid }
}

export function stop(id = 'main') {
  const s = S.get(id)
  const child = s?.child ?? null
  if (!isAlive(child)) return { error: 'отправщик не запущен' }
  s!.stopping = true
  child!.kill()
  return { ok: true }
}

export function stopAll() {
  for (const id of runningIds()) stop(id)
}

// Если панель падает — не оставляем осиротевших процессов.
for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const) {
  process.on(sig, () => { try { stopAll() } catch { } })
}
