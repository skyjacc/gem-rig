import { test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'

// Приёмка изоляции вдвоём (план 7.2, решение 14) — настоящими запросами к
// маршрутам (app.inject). Два пользователя одновременно: A — владелец
// (аккаунт main), B — пользователь u2 (аккаунты b1, b2). Всё выдуманное.

const SA = '76561198000000001'
const SB1 = '76561198000000002'
const SB2 = '76561198000000003'
fs.writeFileSync(process.env.ACCOUNTS_FILE!, JSON.stringify({
  active: 'main',
  actives: { u2: 'b1' },
  list: [
    { id: 'main', label: 'основной-А', steamid: SA, token: 'token.json', added: 1 },
    { id: 'b1', label: 'бэ-один', steamid: SB1, token: 'token-b1.json', added: 2, user: 'u2' },
    { id: 'b2', label: 'бэ-два', steamid: SB2, token: 'token-b2.json', added: 3, user: 'u2' },
  ],
}))

const { allowedHosts } = await import('./auth.ts')
const { buildApp, prepareDb } = await import('./app.ts')
const { db } = await import('./db.ts')
const users = await import('./users.ts')
const accounts = await import('./accounts.ts')
const { addPayout } = await import('./payouts.ts')
const { ROUTES } = await import('./own.ts')
const { unitState } = await import('./autopilot.ts')

prepareDb()
// Приёмка изоляции — среди впущенных пользователей: вход для приглашённых
// открыт (план 7.3, решение 16). Закрытый вход проверяется в users.access.test.ts.
const { setEntryOpen } = await import('./access.ts')
setEntryOpen(db, true, 'owner')
db.prepare(`insert or ignore into users (id, steamid, name, role, limits_json, created_at) values ('u2', null, 'бэ', 'пользователь', ?, ?)`)
  .run(JSON.stringify({ accounts: 2, senders: 1 }), Date.now())
const sessA = users.newSession(db, users.OWNER_ID, 'токен').token
let sessB = users.newSession(db, 'u2', 'steam').token

const { app, hub, push, enforceAccess } = await buildApp({ token: 'x'.repeat(48), allowed: allowedHosts({}), dist: null })
after(() => app.close())

const H = (s: string) => ({ host: 'localhost:4322', origin: 'http://localhost:4322', cookie: 'rig_auth=' + s })
const as = (s: string, method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url, headers: H(s), ...(payload ? { payload } : {}) })

// Выплата A — чтобы было что красть.
const payA = addPayout(db, { accountId: 'main', tx: 'TX-OF-A-0001', cents: 4200, happenedAt: Date.now() - 1000, asset: 'USD', usdBy: 'получено' }) as { id: number }
db.prepare(`insert or ignore into arrivals (assetid, account, gem, item, carrier, value, expected, verdict, aside, ts) values ('asset-of-a', ?, 'гем-А', 'вещь-А', 'item', 5, 0, 'выигрыш', 0, ?)`).run(SA, Date.now())

// Всё, что выдаёт A, — его метки, steamid, id выплаты.
const SECRETS_A = ['основной-А', SA, 'TX-OF-A-0001', 'asset-of-a', 'гем-А']
const clean = (body: string, who = 'B') => {
  for (const s of SECRETS_A) assert.equal(body.includes(s), false, who + ' получил данные A: «' + s + '»')
}

// Снимок состояния A: реестр, выплаты, работник.
const snapA = () => JSON.stringify({
  acc: accounts.byId('main'),
  active: accounts.activeFor('owner')?.id,
  ops: db.prepare(`select count(*) c from money_ops where account_id = 'main'`).get(),
  unit: unitState(accounts.byId('main')!).enabled,
  aside: db.prepare(`select aside from arrivals where assetid = 'asset-of-a'`).get(),
})

test('таблица маршрутов: каждый маршрут app.ts в ней есть, лишних нет', () => {
  const src = fs.readFileSync(new URL('./app.ts', import.meta.url), 'utf8')
  const found = new Set([...src.matchAll(/app\.(get|post)\('(\/api\/[^']+)'/g)].map(m => m[1].toUpperCase() + ' ' + m[2]))
  for (const r of found) assert.ok(ROUTES[r], 'маршрут без вида в own.ts: ' + r)
  for (const r of Object.keys(ROUTES)) assert.ok(found.has(r), 'в own.ts лишний маршрут: ' + r)
})

test('B с id аккаунта A — 404 «нет такого аккаунта» на каждом маршруте с аккаунтом; у A ничего не изменилось', async () => {
  const before = snapA()
  const calls: [string, 'GET' | 'POST', string, object?][] = [
    ['стоп отправщика', 'POST', '/api/sender/stop', { id: 'main' }],
    ['автопилот', 'POST', '/api/autopilot', { id: 'main', on: true }],
    ['активный', 'POST', '/api/accounts/active', { id: 'main' }],
    ['обновить вход', 'POST', '/api/accounts/link', { relink: 'main' }],
    ['веб-вход', 'POST', '/api/accounts/web-link', { id: 'main' }],
    ['имя', 'POST', '/api/accounts/rename', { id: 'main', label: 'взлом' }],
    ['отвязка', 'POST', '/api/accounts/unlink', { id: 'main' }],
    ['ключ площадки', 'POST', '/api/accounts/market-key', { id: 'main', key: 'k'.repeat(32) }],
    ['удалить ключ', 'POST', '/api/accounts/market-key/remove', { id: 'main' }],
    ['проверить ключ', 'POST', '/api/accounts/market-key/check', { id: 'main' }],
    ['сессия игры', 'POST', '/api/accounts/session-check', { id: 'main' }],
    ['веб-проверка', 'POST', '/api/accounts/web-check', { id: 'main' }],
    ['закупка', 'POST', '/api/market/buy', { id: 'main', lines: [{ name: 'x', take: 1, price: 1 }] }],
    ['история площадки', 'POST', '/api/money/sync', { id: 'main' }],
    ['история Steam', 'POST', '/api/money/steam-sync', { id: 'main' }],
    ['ключи TF2', 'POST', '/api/keys/sync', { id: 'main' }],
    ['журнал денег', 'GET', '/api/money?id=main'],
    ['выплаты', 'GET', '/api/money/payouts?id=main'],
    ['сверка', 'GET', '/api/money/reconcile?id=main'],
    ['снимок ключей', 'GET', '/api/keys?id=main'],
    ['выплата на A', 'POST', '/api/money/payout', { accountId: 'main', tx: 'TX-NEW-B-01', usd: '1', asset: 'USD' }],
  ]
  for (const [what, method, url, payload] of calls) {
    const r = await as(sessB, method, url, payload)
    assert.equal(r.statusCode, 404, what + ': ' + r.body)
    assert.equal(r.json().error, 'нет такого аккаунта', what)
    clean(r.body)
  }
  // Чужая выплата: исправить и сторнировать — как несуществующую.
  const fix = await as(sessB, 'POST', '/api/money/payout/correct', { corrects: payA.id, accountId: 'b1', tx: 'TX-OF-A-0001', usd: '1', asset: 'USD' })
  assert.equal(fix.statusCode, 404)
  assert.equal(fix.json().error, 'нет такой выплаты Clover')
  const st = await as(sessB, 'POST', '/api/money/storno', { id: payA.id, reason: 'взлом' })
  assert.equal(st.statusCode, 404)
  assert.equal(st.json().error, 'нет такой выплаты')
  // Чужой приход не откладывается.
  const aside = await as(sessB, 'POST', '/api/arrivals/aside', { assetid: 'asset-of-a', aside: true })
  assert.match(aside.json().error, /нет такого прихода/)
  assert.equal(snapA(), before, 'у A ничего не изменилось')
})

test('чужой и несуществующий — неотличимы', async () => {
  const foreign = await as(sessB, 'POST', '/api/accounts/rename', { id: 'main', label: 'x' })
  const missing = await as(sessB, 'POST', '/api/accounts/rename', { id: 'нет-такого', label: 'x' })
  assert.equal(foreign.statusCode, missing.statusCode)
  assert.deepEqual(foreign.json(), missing.json())
})

test('списки и состояние B — только его: ни меток, ни steamid, ни выплат A', async () => {
  const acc = await as(sessB, 'GET', '/api/accounts')
  assert.deepEqual(acc.json().list.map((a: any) => a.id).sort(), ['b1', 'b2'])
  assert.equal(acc.json().active, 'b1')
  for (const url of ['/api/accounts', '/api/state', '/api/autopilot', '/api/burned', '/api/arrivals', '/api/money', '/api/market/run', '/api/settings', '/api/queue', '/api/tree']) {
    const r = await as(sessB, 'GET', url)
    assert.ok(r.statusCode < 500, url + ': ' + r.statusCode + ' ' + r.body.slice(0, 200))
    clean(r.body, 'B ' + url)
  }
  const ar = await as(sessB, 'GET', '/api/arrivals')
  assert.deepEqual(ar.json().rows, [])
  // A видит своё.
  const accA = await as(sessA, 'GET', '/api/accounts')
  assert.deepEqual(accA.json().list.map((a: any) => a.id), ['main'])
  assert.ok((await as(sessA, 'GET', '/api/arrivals')).body.includes('asset-of-a'))
})

test('только владельцу: каждый маршрут вида «владелец» из таблицы — B получает 403, ничего не меняется', async () => {
  const before = db.prepare('select count(*) c from invites').get()
  const flags = db.prepare('select count(*) c from server_flags').get()
  for (const key of Object.keys(ROUTES).filter(k => ROUTES[k] === 'владелец')) {
    const [method, url] = key.split(' ')
    const r = await as(sessB, method as any, url, method === 'POST' ? { id: 'u2', open: true, steamid: '76561198000000099', name: 'взлом', days: 7 } : undefined)
    assert.equal(r.statusCode, 403, key + ': ' + r.body)
  }
  assert.deepEqual(db.prepare('select count(*) c from invites').get(), before, 'приглашений не создано')
  assert.deepEqual(db.prepare('select count(*) c from server_flags').get(), flags, 'вход не тронут')
})

test('экран «Пользователи» у владельца — счётчики без чужих меток, аккаунтов и ключей', async () => {
  const r = await as(sessA, 'GET', '/api/users')
  assert.equal(r.statusCode, 200, r.body)
  const b = r.json().users.find((u: any) => u.id === 'u2')
  assert.equal(b.accounts, 2)
  for (const s of ['бэ-один', 'бэ-два', SB1, SB2]) assert.equal(r.body.includes(s), false, 'владелец видит только счётчики: ' + s)
})

test('поток: каждый получает своё состояние, данные A в поток B не попадают', async () => {
  const fake = () => {
    const s = { got: '' as string, ended: false, raw: null as any }
    s.raw = { write: (x: string) => { s.got += x; return true }, end: () => { s.ended = true } }
    return s
  }
  const a = fake()
  const b = fake()
  hub.add(a, users.sessionUser(db, sessA)!.sessionId, 'owner')
  hub.add(b, users.sessionUser(db, sessB)!.sessionId, 'u2')
  await new Promise(r => setTimeout(r, 300))
  push()
  await new Promise(r => setTimeout(r, 300))
  assert.ok(a.got.includes('основной-А'), 'A получил своё')
  assert.ok(b.got.length > 0, 'B получил своё')
  clean(b.got, 'поток B')
  hub.remove(a)
  hub.remove(b)
})

test('настройки: B меняет только личное; общие и пол паузы — от сервера; у A ничего не поменялось', async () => {
  const before = (await as(sessA, 'GET', '/api/settings')).json()
  const r = await as(sessB, 'POST', '/api/settings', { goal: 777, tick: 5_000, pace: { floor: 500, ceil: 9_000 } })
  const s = r.json()
  assert.equal(s.goal, 777, 'личное')
  assert.equal(s.tick, before.tick, 'общее — от сервера')
  assert.ok(s.pace.floor >= before.pace.floor, 'пол паузы не ниже общего')
  const afterA = (await as(sessA, 'GET', '/api/settings')).json()
  assert.deepEqual(afterA, before, 'у владельца ничего не поменялось')
  assert.equal((await as(sessB, 'GET', '/api/settings')).json().goal, 777, 'личное хранится')
})

test('пределы B: аккаунтов — 2 (новая привязка — отказ), отправщиков — 1', async () => {
  const link = await as(sessB, 'POST', '/api/accounts/link', { label: 'третий' })
  assert.match(link.json().error, /предел рабочих аккаунтов: 2/)
  const on1 = await as(sessB, 'POST', '/api/autopilot', { id: 'b1', on: true })
  assert.equal(on1.json().error, undefined, on1.body)
  const on2 = await as(sessB, 'POST', '/api/autopilot', { id: 'b2', on: true })
  assert.match(on2.json().error, /предел одновременно работающих отправщиков: 1/)
  await as(sessB, 'POST', '/api/autopilot', { id: 'b1', on: false })
})

test('QR B: Steam, уже привязанный у A, — «привязать нельзя» без названия A', async () => {
  const runs: any[] = []
  mock.method(accounts.proc, 'spawn', () => {
    const c: any = new EventEmitter()
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.exitCode = null
    c.kill = () => { c.exitCode = 1; return true }
    runs.push(c)
    return c
  })
  db.prepare(`update users set limits_json = ? where id = 'u2'`).run(JSON.stringify({ accounts: 3, senders: 1 }))
  const r = await as(sessB, 'POST', '/api/accounts/link', { label: 'третий' })
  assert.equal(r.json().ok, true, r.body)
  runs[0].stdout.emit('data', Buffer.from('STEAMID ' + SA + '\n'))
  const st = accounts.linkState('u2')!
  assert.equal(st.error, 'этот Steam привязать нельзя')
  clean(JSON.stringify((await as(sessB, 'GET', '/api/accounts')).json()), 'B после QR')
  assert.equal(accounts.listFor('u2').length, 2, 'аккаунт не добавлен')
  // У A своя привязка не занята привязкой B.
  assert.equal(accounts.linkState('owner'), null)
  mock.restoreAll()
  db.prepare(`update users set limits_json = ? where id = 'u2'`).run(JSON.stringify({ accounts: 2, senders: 1 }))
})

test('отключение B посреди работы: поток закрыт, сессия — 401, работник и QR остановлены, поздний ответ QR ничего не добавляет; A работает', async () => {
  const runs: any[] = []
  mock.method(accounts.proc, 'spawn', () => {
    const c: any = new EventEmitter()
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.exitCode = null
    c.kill = () => { c.exitCode = 1; return true }
    runs.push(c)
    return c
  })
  // B: работник включён, QR-вход обновления b1 идёт, поток открыт.
  await as(sessB, 'POST', '/api/autopilot', { id: 'b2', on: true })
  const relink = await as(sessB, 'POST', '/api/accounts/link', { relink: 'b1' })
  assert.equal(relink.json().ok, true, relink.body)
  const s = { got: '', ended: false, raw: null as any }
  s.raw = { write: (x: string) => { s.got += x; return true }, end: () => { s.ended = true } }
  hub.add(s, users.sessionUser(db, sessB)!.sessionId, 'u2')
  const beforeA = snapA()

  const r = await as(sessA, 'POST', '/api/users/disable', { id: 'u2' })
  assert.deepEqual(r.json(), { ok: true })
  assert.equal(s.ended, true, 'поток B закрыт')
  assert.equal((await as(sessB, 'GET', '/api/accounts')).statusCode, 401, 'сессия B погашена')
  assert.equal(unitState(accounts.byId('b2')!).enabled, false, 'работник B выключен')
  assert.equal(accounts.linkState('u2')!.done, true, 'QR B отменён')
  // Поздний ответ QR после отключения: ничего не заменяется и не добавляется.
  runs[runs.length - 1].stdout.emit('data', Buffer.from('STEAMID ' + SB1 + '\n'))
  assert.equal(accounts.listFor('u2').length, 2)
  // Новая сессия B не действует; A работает как работал.
  sessB = users.newSession(db, 'u2', 'steam').token
  assert.equal((await as(sessB, 'GET', '/api/accounts')).statusCode, 401, 'отключённый не входит и новой сессией')
  assert.equal((await as(sessA, 'GET', '/api/accounts')).statusCode, 200)
  assert.equal(snapA(), beforeA)
  mock.restoreAll()
})

test('поздний ответ QR, пришедший до отмены привязки, при отключённом пользователе ничего не добавляет', async () => {
  const { asUser } = await import('./ctx.ts')
  db.prepare(`insert or ignore into users (id, steamid, name, role, created_at) values ('u3', null, 'вэ', 'пользователь', ?)`).run(Date.now())
  const runs: any[] = []
  mock.method(accounts.proc, 'spawn', () => {
    const c: any = new EventEmitter()
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.exitCode = null
    c.kill = () => { c.exitCode = 1; return true }
    runs.push(c)
    return c
  })
  const r: any = asUser('u3', () => accounts.linkStart('вэ-один', () => { }))
  assert.equal(r.ok, true, JSON.stringify(r))
  // Отключили прямо в базе — без отмены привязки: проверяется сама защита.
  db.prepare(`update users set disabled_at = ? where id = 'u3'`).run(Date.now())
  runs[0].stdout.emit('data', Buffer.from('STEAMID 76561198000000009\n'))
  assert.equal(accounts.listFor('u3').length, 0, 'аккаунт не добавлен')
  assert.equal(accounts.linkState('u3')!.error, 'доступ отключён владельцем')
  mock.restoreAll()
})

test('такт работника не поднимает отправщик отключённого пользователя и гасит «включён»', async () => {
  const autopilot = await import('./autopilot.ts')
  const sender = await import('./sender.ts')
  // Включён в памяти, хотя пользователь уже отключён (u2 — с прошлого теста).
  const { asUser } = await import('./ctx.ts')
  db.prepare(`update users set disabled_at = null where id = 'u2'`).run()
  const on: any = asUser('u2', () => autopilot.setAutopilot('b1', { on: true }))
  assert.equal(on.error, undefined, 'работник включён: ' + JSON.stringify(on))
  assert.equal(unitState(accounts.byId('b1')!).enabled, true)
  db.prepare(`update users set disabled_at = ? where id = 'u2'`).run(Date.now())
  // Сеть закрыта: такт не должен никуда ходить за отключённого.
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => { throw new Error('сеть закрыта в тесте') }) as any
  try { await autopilot.tick(() => { }) } finally { globalThis.fetch = realFetch }
  assert.equal(unitState(accounts.byId('b1')!).enabled, false, 'работник отключённого выключен')
  assert.equal(unitState(accounts.byId('b1')!).why, 'доступ пользователя отключён', 'выключен именно за отключение, такт его не трогал')
  assert.equal(sender.senderState('b1').running, false, 'отправщик не поднят')
})

test('пол паузы: личный не ниже общего; строже — можно', async () => {
  // Сюда пишет только тест: SETTINGS_FILE (testenv.ts), рабочий файл не трогается.
  db.prepare(`update users set disabled_at = null where id = 'u2'`).run()
  sessB = users.newSession(db, 'u2', 'steam').token
  await as(sessA, 'POST', '/api/settings', { pace: { floor: 900 } })
  const low = (await as(sessB, 'POST', '/api/settings', { pace: { floor: 600 } })).json()
  assert.equal(low.pace.floor, 900, 'ниже общего — действует общий')
  const high = (await as(sessB, 'POST', '/api/settings', { pace: { floor: 1_200 } })).json()
  assert.equal(high.pace.floor, 1_200, 'строже — своё')
  await as(sessA, 'POST', '/api/settings', { pace: { floor: 500 } })
  assert.equal((await as(sessB, 'GET', '/api/settings')).json().pace.floor, 1_200, 'общий опустили — личное строже остаётся')
})

test('общие поля в личных настройках (запись в обход правки) не действуют', async () => {
  const shared = (await as(sessA, 'GET', '/api/settings')).json()
  users.setPersonalSettings(db, 'u2', { tick: 5_000, invTtl: 10_000, goal: 555 })
  const s = (await as(sessB, 'GET', '/api/settings')).json()
  assert.equal(s.goal, 555, 'личное действует')
  assert.equal(s.tick, shared.tick, 'общее — от сервера')
  assert.equal(s.invTtl, shared.invTtl)
})

test('одновременные привязки двух пользователей с одной меткой — разные id и файлы сессии', async () => {
  const { asUser } = await import('./ctx.ts')
  db.prepare(`update users set disabled_at = null, limits_json = ? where id = 'u2'`).run(JSON.stringify({ accounts: 5, senders: 1 }))
  db.prepare(`insert or ignore into users (id, steamid, name, role, created_at) values ('u4', null, 'гэ', 'пользователь', ?)`).run(Date.now())
  const runs: { args: string[]; c: any }[] = []
  mock.method(accounts.proc, 'spawn', (_cmd: string, args: string[]) => {
    const c: any = new EventEmitter()
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.exitCode = null
    c.kill = () => { c.exitCode = 1; return true }
    runs.push({ args, c })
    return c
  })
  const a: any = asUser('u2', () => accounts.linkStart('общая метка', () => { }))
  const b: any = asUser('u4', () => accounts.linkStart('общая метка', () => { }))
  assert.equal(a.ok, true, JSON.stringify(a))
  assert.equal(b.ok, true, JSON.stringify(b))
  assert.notEqual(a.id, b.id, 'id разные')
  const tokenOf = (args: string[]) => args[args.indexOf('--token') + 1]
  assert.notEqual(tokenOf(runs[0].args), tokenOf(runs[1].args), 'файлы сессии разные')
  // Обе завершились — два разных аккаунта, каждый у своего пользователя.
  runs[0].c.stdout.emit('data', Buffer.from('STEAMID 76561198000000021\n'))
  runs[1].c.stdout.emit('data', Buffer.from('STEAMID 76561198000000022\n'))
  assert.equal(accounts.byId(a.id)?.user, 'u2')
  assert.equal(accounts.byId(b.id)?.user, 'u4')
  assert.notEqual(accounts.byId(a.id)?.token, accounts.byId(b.id)?.token)
  mock.restoreAll()
})

// ── доступ кончился — сразу, без единого запроса пользователя (ревью PR #34) ──

const liveSessions = (id: string) => (db.prepare('select count(*) c from sessions where user_id = ? and revoked_at is null').get(id) as any).c as number

test('закрыли вход: сессии B отозваны сразу, работник и QR остановлены; снова открыли — старая сессия не действует', async () => {
  const { unitOn } = await import('./autopilot.ts')
  db.prepare(`update users set disabled_at = null, limits_json = ? where id = 'u2'`).run(JSON.stringify({ accounts: 9, senders: 2 }))
  const s = users.newSession(db, 'u2', 'steam').token
  mock.method(accounts.proc, 'spawn', () => {
    const c: any = new EventEmitter()
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.exitCode = null
    c.kill = () => { c.exitCode = 1; return true }
    return c
  })
  assert.equal((await as(s, 'POST', '/api/autopilot', { id: 'b1', on: true })).json().error, undefined)
  assert.equal((await as(s, 'POST', '/api/accounts/link', { label: 'ещё один' })).json().ok, true)
  assert.ok(liveSessions('u2') > 0)

  await as(sessA, 'POST', '/api/users/entry', { open: false })
  assert.equal(liveSessions('u2'), 0, 'сессии отозваны в базе сразу')
  assert.equal(unitOn('b1'), false, 'работник выключен сразу')
  assert.equal(accounts.linkState('u2')!.done, true, 'QR отменён сразу')

  await as(sessA, 'POST', '/api/users/entry', { open: true })
  assert.equal((await as(s, 'GET', '/api/accounts')).statusCode, 401, 'повторное открытие старую сессию не оживляет')
  mock.restoreAll()
})

test('снятие допуска — сессии отозваны сразу; истечение по сроку — проверкой раз в 15 с', async () => {
  const SID6 = '76561198000000066'
  await as(sessA, 'POST', '/api/users/entry', { open: false })
  db.prepare(`insert or ignore into users (id, steamid, name, role, created_at) values ('u6', ?, 'приёмка', 'пользователь', ?)`).run(SID6, Date.now())
  assert.equal((await as(sessA, 'POST', '/api/users/permit', { steamid: SID6 })).json().ok, true)
  await new Promise(r => setTimeout(r, 5))
  const s = users.newSession(db, 'u6', 'steam').token
  assert.equal((await as(s, 'GET', '/api/accounts')).statusCode, 200, 'допущенный входит')
  await as(sessA, 'POST', '/api/users/permit/revoke')
  assert.equal(liveSessions('u6'), 0, 'снятие — сразу')

  assert.equal((await as(sessA, 'POST', '/api/users/permit', { steamid: SID6 })).json().ok, true)
  await new Promise(r => setTimeout(r, 5))
  users.newSession(db, 'u6', 'steam')
  assert.ok(liveSessions('u6') > 0)
  const ended = enforceAccess(Date.now() + 86_400_000 + 1_000)
  assert.deepEqual(ended, ['u6'], 'по сроку — тот, чей допуск кончился')
  assert.equal(liveSessions('u6'), 0)
})

test('конец доступа при уже отозванных сессиях: работает только веб-QR — процесс остановлен, временный файл удалён', async () => {
  const { GC } = await import('./paths.ts')
  const path = await import('node:path')
  const SID7 = '76561198000000077'
  db.prepare(`insert or ignore into users (id, steamid, name, role, created_at) values ('u7', ?, 'приёмка-7', 'пользователь', ?)`).run(SID7, Date.now())
  accounts.addAccount({ id: 'w7', label: 'вэ-семь', steamid: '76561198000000071', token: 'token-w7.json', added: Date.now(), user: 'u7' })
  // Допуск для приёмки — u7 входит и запускает веб-QR (допуск прошлых тестов снят).
  const { revokePermit } = await import('./access.ts')
  revokePermit(db, 'owner')
  assert.equal((await as(sessA, 'POST', '/api/users/permit', { steamid: SID7 })).json().ok, true)
  assert.equal(users.userActive(db, 'u7'), true)
  const kids: any[] = []
  mock.method(accounts.proc, 'spawn', () => {
    const c: any = new EventEmitter()
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.exitCode = null; c.killed = false
    c.kill = () => { c.killed = true; c.exitCode = 1; return true }
    kids.push(c)
    return c
  })
  const { asUser } = await import('./ctx.ts')
  const r: any = asUser('u7', () => accounts.webLinkStart('w7', () => { }))
  assert.equal(r.ok, true, JSON.stringify(r))
  // Процесс веб-входа успел записать временный токен.
  const tmp = path.join(GC, accounts.webTmpFile({ id: 'w7' }))
  fs.writeFileSync(tmp, '{}')
  // Доступ кончился «в обход» маршрута (тот сам остановил бы всё), сессий
  // у u7 нет — работает только веб-QR.
  users.revokeAll(db, 'u7')
  db.prepare('update users set disabled_at = ? where id = ?').run(Date.now(), 'u7')
  assert.equal(users.userActive(db, 'u7'), false)
  const ended = enforceAccess()
  assert.ok(ended.includes('u7'), 'веб-QR — незавершённая работа: ' + JSON.stringify(ended))
  assert.equal(kids[0].killed, true, 'процесс веб-входа остановлен')
  assert.equal(accounts.webLinkState('u7')!.done, true)
  assert.equal(fs.existsSync(tmp), false, 'временный файл удалён')
  mock.restoreAll()
})
