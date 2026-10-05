import { test, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'

// Гонка «закрыли окно привязки, пока запуск ещё в пути» (сверка PR #30).
//
// Очередь запросов живёт в окне панели (dash/src/v2/linkFlow.ts), а отвечает
// за последствия сервер — поэтому проверка здесь, на настоящих linkStart и
// linkCancel. Сеть подменена: запрос запуска доходит до сервера с задержкой,
// отмена — сразу, как если бы запуск застрял в пути дольше отмены.

const MAIN = { id: 'main', label: 'основной', steamid: '76561198000000001', token: 'token.json', added: 1 }
fs.writeFileSync(process.env.ACCOUNTS_FILE!, JSON.stringify({ active: 'main', list: [MAIN] }))

const accounts = await import('./accounts.ts')
const { linkFlow } = await import('../../dash/src/v2/linkFlow.ts')

const NEW = '76561198000000009'

function fakeChild() {
  const c: any = new EventEmitter()
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.exitCode = null
  c.killed = false
  // Настоящий процесс сообщает о выходе не сразу после kill(), а позже.
  c.kill = () => { c.killed = true; setImmediate(() => { if (c.exitCode === null) { c.exitCode = 1; c.emit('exit', 1) } }); return true }
  c.say = (line: string) => c.stdout.emit('data', Buffer.from(line + '\n'))
  return c
}

let runs: any[] = []
let seen: string[] = []

beforeEach(() => {
  mock.restoreAll()
  try { accounts.linkCancel() } catch { }
  runs = []
  seen = []
  mock.method(accounts.proc, 'spawn', () => { const c = fakeChild(); runs.push(c); return c })
})

// Сервер как за HTTP: запрос выполняется, когда «дошёл», ответ — после.
// Задержка — на дорогу до сервера; выполнение синхронное, как в index.ts.
const wire = (delay: { start: number; cancel: number }) => (url: string, body: any) =>
  new Promise<any>(resolve => {
    const isStart = url === '/api/accounts/link'
    setTimeout(() => {
      seen.push(isStart ? 'start' : 'cancel')
      resolve(isStart ? accounts.linkStart(String(body?.label ?? ''), () => { }) : accounts.linkCancel())
    }, isStart ? delay.start : delay.cancel)
  })

const settled = () => new Promise(r => setTimeout(r, 60))

test('без очереди: отмена, обогнавшая запуск, его не гасит — вход остаётся ждать без окна', async () => {
  // Так и было: окно слало отмену, не дожидаясь ответа на запуск.
  const send = wire({ start: 30, cancel: 0 })
  void send('/api/accounts/link', { label: 'третий' })
  await send('/api/accounts/link/cancel', {})
  await settled()
  assert.deepEqual(seen, ['cancel', 'start'])
  assert.equal(accounts.linkState()?.done, false, 'вход ждёт, хотя окно закрыто')
  assert.equal(runs[0].killed, false)
})

test('с очередью: закрыли окно до ответа на запуск — отмена уходит после него; ожидания и привязки нет', async () => {
  const flow = linkFlow(wire({ start: 30, cancel: 0 }))
  const order: string[] = []
  const started = flow.start({ label: 'третий' }).then(() => order.push('start'))
  const cancelled = flow.cancel().then(() => order.push('cancel'))   // закрыли окно сразу
  await Promise.all([started, cancelled])

  assert.deepEqual(seen, ['start', 'cancel'], 'сервер видит отмену после запуска')
  assert.deepEqual(order, ['start', 'cancel'], 'ответ на отмену — после ответа на запуск')
  assert.equal(runs.length, 1)
  assert.equal(runs[0].killed, true, 'процесс входа погашен')
  const s = accounts.linkState()!
  assert.equal(s.done, true)
  assert.equal(s.error, 'отменено')

  // Поздний вход по уже показанной ссылке: процесс успел напечатать STEAMID.
  runs[0].say('STEAMID ' + NEW)
  assert.equal(accounts.list().some(a => a.steamid === NEW), false, 'аккаунт не привязан')
  assert.equal(accounts.linkState()!.error, 'отменено')

  // Следующая привязка не упирается в «привязка уже идёт».
  assert.equal((accounts.linkStart('четвёртый', () => { }) as any).ok, true)
  accounts.linkCancel()
})

test('с очередью: «другой код» — отмена прежнего, потом новый запуск; ждёт ровно один вход', async () => {
  const flow = linkFlow(wire({ start: 30, cancel: 0 }))
  void flow.start({ label: 'третий' })
  await flow.cancel()
  await flow.start({ label: 'третий' })
  assert.deepEqual(seen, ['start', 'cancel', 'start'])
  assert.equal(runs.length, 2)
  assert.equal(runs[0].killed, true)
  assert.equal(runs[1].killed, false)
  assert.equal(accounts.linkState()!.done, false)
  accounts.linkCancel()
})

// Запуск выполнен на сервере, но окно ответа не получило: ответ — ошибка
// (сеть оборвалась после отправки) или его нет вовсе. Сессия уже заведена —
// отмена должна уйти в любом случае и не ждать вечно.
const executed = (answer: 'reject' | 'lost') => (url: string, body: any) => {
  if (url === '/api/accounts/link') {
    seen.push('start')
    accounts.linkStart(String(body?.label ?? ''), () => { })
    return answer === 'reject' ? Promise.reject(new Error('сеть оборвалась')) : new Promise<any>(() => { })
  }
  seen.push('cancel')
  return Promise.resolve(accounts.linkCancel())
}

test('запуск кончился ошибкой, хотя сервер его выполнил — отмена всё равно уходит и гасит вход', async () => {
  const flow = linkFlow(executed('reject'))
  await assert.rejects(flow.start({ label: 'третий' }))
  await flow.cancel()
  assert.deepEqual(seen, ['start', 'cancel'])
  assert.equal(runs[0].killed, true)
  assert.equal(accounts.linkState()!.done, true)
})

test('ответа на запуск нет — отмена уходит по истечении ожидания, не вечно', { timeout: 2_000 }, async () => {
  const flow = linkFlow(executed('lost'), 50)
  void flow.start({ label: 'третий' })
  const t0 = Date.now()
  await flow.cancel()
  assert.ok(Date.now() - t0 >= 40, 'сначала ждём ответа на запуск')
  assert.deepEqual(seen, ['start', 'cancel'])
  assert.equal(runs[0].killed, true)
  assert.equal(accounts.linkState()!.done, true)
})
