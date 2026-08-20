// Управление отправщиком. Панель запускает и останавливает его сама —
// отдельное окно с ботом больше не нужно.
//
// Отправщик живёт в ../tools/gcwatch/index.js и логинится по сохранённой сессии
// token.json, поэтому запускается без вопросов. Если сессии нет, он попросит QR
// в своём stdout — панель этот вывод показывает.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { GC } from './paths.ts'

type Sender = {
  child: ChildProcess | null
  file: string | null
  delay: number | null
  startedAt: number | null
  lines: string[]
  exit: string | null
}

const S: Sender = { child: null, file: null, delay: null, startedAt: null, lines: [], exit: null }

const remember = (line: string) => {
  for (const l of line.split(/\r?\n/)) {
    const t = l.trimEnd()
    if (t) S.lines.push(t)
  }
  while (S.lines.length > 200) S.lines.shift()
}

export function senderState() {
  return {
    running: !!S.child && S.child.exitCode === null,
    pid: S.child?.pid ?? null,
    file: S.file,
    delay: S.delay,
    startedAt: S.startedAt,
    exit: S.exit,
    lines: S.lines.slice(-60),
  }
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

export function start(file: string, delay: number, onLine: () => void) {
  if (S.child && S.child.exitCode === null) return { error: 'отправщик уже работает' }
  const full = path.join(GC, file)
  if (!fs.existsSync(full)) return { error: 'нет файла ' + file }

  fs.writeFileSync(path.join(GC, 'delay.txt'), String(delay))

  const args = ['index.js', '--ids', file, '--send', '--delay', String(delay), '--keep-alive']
  const child = spawn(process.execPath, args, { cwd: GC, windowsHide: true })

  S.child = child
  S.file = file
  S.delay = delay
  S.startedAt = Date.now()
  S.exit = null
  S.lines = []
  remember(`запущен: node ${args.join(' ')}`)

  child.stdout?.on('data', b => { remember(String(b)); onLine() })
  child.stderr?.on('data', b => { remember(String(b)); onLine() })
  child.on('exit', (code, signal) => {
    S.exit = signal ? `остановлен (${signal})` : `завершился с кодом ${code}`
    remember(S.exit)
    onLine()
  })

  return { ok: true, pid: child.pid }
}

export function stop() {
  if (!S.child || S.child.exitCode !== null) return { error: 'отправщик не запущен' }
  S.child.kill()
  return { ok: true }
}

// Если панель падает — не оставляем осиротевший процесс.
for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const) {
  process.on(sig, () => { try { S.child?.kill() } catch { } })
}
