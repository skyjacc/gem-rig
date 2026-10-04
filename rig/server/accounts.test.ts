import { test, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { GC } from './paths.ts'

// Реестр — свой, во временной папке (testenv.ts, ACCOUNTS_FILE). Пишется до
// импорта accounts.ts: тот читает реестр при загрузке.
const MAIN = { id: 'main', label: 'основной', steamid: '76561198000000001', token: 'token.json', added: 1 }
const SECOND = { id: 'second', label: 'второй', steamid: '76561198000000002', token: 'token-second.json', added: 2 }
fs.writeFileSync(process.env.ACCOUNTS_FILE!, JSON.stringify({ active: 'main', list: [MAIN, SECOND] }))

const accounts = await import('./accounts.ts')
const web = await import('./steamweb.ts')
const api = await import('./api.ts')

const jwt = (payload: object) =>
  [{ typ: 'JWT', alg: 'EdDSA' }, payload].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.') + '.подпись'
const tok = (days: number) => JSON.stringify({ refreshToken: jwt({ exp: Math.trunc(Date.now() / 1000) + days * 86_400 }) })
const put = (file: string, text: string) => fs.writeFileSync(path.join(GC, file), text)
const has = (file: string) => fs.existsSync(path.join(GC, file))

let calls: string[][] = []
const answer = { next: async (): Promise<string[]> => ['COOKIES ' + JSON.stringify(['steamLoginSecure=СЕКРЕТ; Domain=steamcommunity.com'])] }

beforeEach(() => {
  mock.restoreAll()
  calls = []
  mock.method(web.exchange, 'run', (token: string, args: string[]) => { calls.push([token, ...args]); return answer.next() })
})

// ── две сессии в списке (план 2.4, решение 1) ──

test('список аккаунтов: обе сессии сразу, игровая — со сроком; обмена кук нет', () => {
  put('token.json', tok(30))
  put('token-web-main.json', tok(60))
  const r = api.accountList()
  const m = r.list.find(a => a.id === 'main')!
  assert.equal(m.sessionState.state, 'unknown')
  assert.ok(m.sessionState.validUntil! > Date.now(), 'срок игрового токена виден без нажатия')
  assert.equal(m.web.state, 'unchecked')
  const s = r.list.find(a => a.id === 'second')!
  assert.equal(s.sessionState.state, 'missing')
  assert.equal(s.web.state, 'missing')
  assert.equal(calls.length, 0, 'показ списка не вызывает webcookies.js')
})

test('проверка веба: нет аккаунта — ошибка без обращения к Steam', async () => {
  const r = await api.webCheck('нет-такого')
  assert.ok(!('state' in r))
  assert.match(String(r.error), /нет такого аккаунта/)
  assert.equal(calls.length, 0)
})

test('проверка веба: один обмен, в ответе только состояние — ни имён, ни значений кук', async () => {
  put('token-web-main.json', tok(60))
  const r = await api.webCheck('main')
  assert.equal(calls.length, 1)
  assert.ok('state' in r)
  assert.equal(r.state, 'ok')
  assert.doesNotMatch(JSON.stringify(r), /steamLoginSecure|СЕКРЕТ/)
  assert.equal(api.accountList().list.find(a => a.id === 'main')!.web.state, 'ok')
})

// ── отвязка (план 2.4, решение 9) ──

test('отвязка удаляет и игровой, и веб-токен; прежнее «веб работает» забывается', async () => {
  put('token-second.json', tok(30))
  put('token-web-second.json', tok(60))
  await web.checkWeb(accounts.byId('second')!)
  assert.equal(web.webStatus({ id: 'second' }).state, 'ok')
  assert.deepEqual(accounts.unlink('second'), { ok: true })
  assert.equal(has('token-second.json'), false)
  assert.equal(has('token-web-second.json'), false)
  // Тот же id потом достанется другому аккаунту — чужое «работает» ему не переходит.
  put('token-web-second.json', tok(60))
  assert.equal(web.webStatus({ id: 'second' }).state, 'unchecked')
  fs.rmSync(path.join(GC, 'token-web-second.json'), { force: true })
})

// ── веб-вход по QR (план 2.4, решение 2Б) ──
//
// Сам вход не запускается: процесс подменён. Поддельный печатает то же, что
// weblogin.js, — QRURL, STEAMID, ERROR — и пишет временный файл, как он.

const read = (file: string) => fs.readFileSync(path.join(GC, file), 'utf8')

function fakeChild() {
  const c: any = new EventEmitter()
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.exitCode = null
  c.killed = false
  c.kill = () => { c.killed = true; if (c.exitCode === null) { c.exitCode = 1; c.emit('exit', 1) } return true }
  c.say = (line: string) => c.stdout.emit('data', Buffer.from(line + '\n'))
  c.end = (code = 0) => { c.exitCode = code; c.emit('exit', code) }
  return c
}

function spawnSpy() {
  const runs: { args: string[]; child: any }[] = []
  mock.method(accounts.proc, 'spawn', (_cmd: string, args: string[]) => {
    const child = fakeChild()
    runs.push({ args, child })
    return child
  })
  return runs
}

const settle = () => {
  try { accounts.webLinkCancel() } catch { }
  try { accounts.linkCancel() } catch { }
  for (const f of ['token-web-main.json', 'token-web-main.tmp.json']) fs.rmSync(path.join(GC, f), { force: true })
}

test('веб-вход: тот же Steam — временный токен становится веб-входом; игровой не тронут; прежнее «работает» забыто', async () => {
  settle()
  put('token.json', 'ИГРОВОЙ')
  put('token-web-main.json', tok(60))
  await web.checkWeb(accounts.byId('main')!)
  assert.equal(web.webStatus({ id: 'main' }).state, 'ok')
  const runs = spawnSpy()
  const changes: number[] = []
  assert.deepEqual(accounts.webLinkStart('main', () => changes.push(1)), { ok: true, id: 'main' })
  assert.equal(runs.length, 1)
  const args = runs[0].args
  assert.equal(args[0], 'weblogin.js')
  assert.equal(args[args.indexOf('--out') + 1], 'token-web-main.tmp.json', 'вход пишет во временный файл')
  assert.equal(args.includes('token-web-main.json'), false)
  runs[0].child.say('QRURL https://s.team/q/1/2')
  assert.equal(accounts.webLinkState()!.url, 'https://s.team/q/1/2')
  assert.equal(api.accountList().webLink!.url, 'https://s.team/q/1/2')
  const fresh = tok(90)
  put('token-web-main.tmp.json', fresh)
  runs[0].child.say('STEAMID ' + MAIN.steamid)
  const st = accounts.webLinkState()!
  assert.equal(st.done, true)
  assert.equal(st.error, null)
  assert.equal(read('token-web-main.json'), fresh)
  assert.equal(has('token-web-main.tmp.json'), false)
  assert.equal(read('token.json'), 'ИГРОВОЙ', 'игровой токен веб-вход не трогает')
  assert.equal(web.webStatus({ id: 'main' }).state, 'unchecked', 'итог проверки относился к прежнему токену')
  assert.ok(changes.length > 0)
})

test('веб-вход: другой Steam — временный удалён, прежний веб-вход цел, в ошибке оба steamid', () => {
  settle()
  const old = tok(60)
  put('token-web-main.json', old)
  const runs = spawnSpy()
  accounts.webLinkStart('main', () => { })
  put('token-web-main.tmp.json', tok(90))
  runs[0].child.say('STEAMID 76561198999999999')
  const st = accounts.webLinkState()!
  assert.equal(st.done, true)
  assert.match(String(st.error), /76561198999999999/)
  assert.match(String(st.error), new RegExp(MAIN.steamid))
  assert.equal(read('token-web-main.json'), old)
  assert.equal(has('token-web-main.tmp.json'), false)
})

test('веб-вход: отмена — временный удалён, прежний цел, процесс остановлен', () => {
  settle()
  const old = tok(60)
  put('token-web-main.json', old)
  const runs = spawnSpy()
  accounts.webLinkStart('main', () => { })
  put('token-web-main.tmp.json', tok(90))
  accounts.webLinkCancel()
  assert.equal(runs[0].child.killed, true)
  assert.equal(has('token-web-main.tmp.json'), false)
  assert.equal(read('token-web-main.json'), old)
  assert.equal(accounts.webLinkState()!.error, 'отменено')
})

test('веб-вход: процесс кончился без STEAMID — временный удалён, причина из ERROR', () => {
  settle()
  const runs = spawnSpy()
  accounts.webLinkStart('main', () => { })
  put('token-web-main.tmp.json', tok(90))
  runs[0].child.stderr.emit('data', Buffer.from('ERROR QR протух, запусти заново\n'))
  runs[0].child.end(1)
  const st = accounts.webLinkState()!
  assert.equal(st.done, true)
  assert.equal(st.error, 'QR протух, запусти заново')
  assert.equal(has('token-web-main.tmp.json'), false)
  assert.equal(has('token-web-main.json'), false, 'веб-входа не было — и не появился')
})

test('веб-вход: хвост прошлой попытки удаляется до запуска', () => {
  settle()
  put('token-web-main.tmp.json', 'ХВОСТ')
  spawnSpy()
  accounts.webLinkStart('main', () => { })
  assert.equal(has('token-web-main.tmp.json'), false)
})

test('веб-вход: нет аккаунта — ошибка, вход не запускается', () => {
  settle()
  const runs = spawnSpy()
  assert.match(String((accounts.webLinkStart('нет-такого', () => { }) as any).error), /нет такого аккаунта/)
  assert.equal(runs.length, 0)
})

test('одна привязка за раз: веб и игровая не идут одновременно', () => {
  settle()
  const runs = spawnSpy()
  accounts.webLinkStart('main', () => { })
  assert.match(String((accounts.webLinkStart('main', () => { }) as any).error), /уже идёт/)
  assert.match(String((accounts.linkStart('третий', () => { }) as any).error), /уже идёт/)
  accounts.webLinkCancel()
  accounts.linkStart('третий', () => { })
  assert.match(String((accounts.webLinkStart('main', () => { }) as any).error), /уже идёт/)
  accounts.linkCancel()
  assert.equal(runs.length, 2, 'отказ — без запуска процесса')
  settle()
})

test('сверка веб-токена сама по себе: чужой steamid — временный удалён до всякой замены; нет аккаунта — тоже', () => {
  settle()
  const old = tok(60)
  put('token-web-main.json', old)
  put('token-web-main.tmp.json', tok(90))
  const r = accounts.acceptWebToken('main', '76561198999999999', 'token-web-main.tmp.json')
  assert.ok('error' in r)
  assert.equal(has('token-web-main.tmp.json'), false)
  assert.equal(read('token-web-main.json'), old)
  put('token-web-x.tmp.json', tok(90))
  assert.ok('error' in accounts.acceptWebToken('нет-такого', MAIN.steamid, 'token-web-x.tmp.json'))
  assert.equal(has('token-web-x.tmp.json'), false)
  settle()
})
