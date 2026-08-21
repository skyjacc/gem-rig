// Управление отправщиками. Панель запускает и останавливает их сама.
//
// Отправщик один на аккаунт. Ограничение «одна сессия» действует на аккаунт,
// а не на машину, поэтому два и три работают рядом и в сумме дают втрое
// больше товара за то же время.
//
// У каждого своё: файл сессии, файл очереди, файл отчёта. Общий файл отчёта
// два процесса просто затирали бы друг другу.

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
}

const S = new Map<string, Sender>()

const slot = (id: string): Sender => {
  let s = S.get(id)
  if (!s) {
    s = { child: null, file: null, delay: null, limit: null, startedAt: null, lines: [], exit: null }
    S.set(id, s)
  }
  return s
}

const remember = (s: Sender, line: string) => {
  for (const l of line.split(/\r?\n/)) {
    const t = l.trimEnd()
    if (t) s.lines.push(t)
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

export const statusFile = (id: string) => (id === 'main' ? 'status.json' : `status-${id}.json`)
export const queueFile = (id: string) => (id === 'main' ? 'autopilot.csv' : `autopilot-${id}.csv`)

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
    lines: s.lines.slice(-60),
  }
}

export const runningIds = () => [...S.entries()].filter(([, s]) => isAlive(s.child)).map(([id]) => id)

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

  const full = path.join(GC, file)
  if (!fs.existsSync(full)) return { error: 'нет файла ' + file }
  if (!fs.existsSync(path.join(GC, token))) return { error: 'нет сессии ' + token + ' — привяжите аккаунт' }

  fs.writeFileSync(path.join(GC, 'delay.txt'), String(delay))

  // Отчёт прошлого запуска стираем. Он переживает перезапуск компьютера,
  // и по нему работник считал молчание в двадцать два часа, а подбор паузы
  // судил о темпе по вчерашним замерам.
  try { fs.unlinkSync(path.join(GC, statusFile(id))) } catch { }

  const args = [
    'index.js',
    '--ids', file,
    '--send',
    '--delay', String(delay),
    '--keep-alive',
    '--token', token,
    '--status', statusFile(id),
  ]
  if (limit && limit > 0) args.push('--limit', String(limit))

  const child = spawn(process.execPath, args, { cwd: GC, windowsHide: true })

  s.child = child
  s.file = file
  s.delay = delay
  s.limit = limit ?? null
  s.startedAt = Date.now()
  s.exit = null
  s.lines = []
  remember(s, `запущен: node ${args.join(' ')}`)

  child.stdout?.on('data', b => { remember(s, String(b)); onLine() })
  child.stderr?.on('data', b => { remember(s, String(b)); onLine() })
  child.on('exit', (code, signal) => {
    s.exit = signal ? `остановлен (${signal})` : `завершился с кодом ${code}`
    remember(s, s.exit)
    onLine()
  })

  return { ok: true, pid: child.pid }
}

export function stop(id = 'main') {
  const child = S.get(id)?.child ?? null
  if (!isAlive(child)) return { error: 'отправщик не запущен' }
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
