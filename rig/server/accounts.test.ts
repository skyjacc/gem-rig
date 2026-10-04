import { test, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
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
