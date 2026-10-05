// Fastify + SSE. Сервер сам толкает состояние, когда меняются файлы отправщика
// или обновляется инвентарь. Браузер ничего не опрашивает.

import Fastify from 'fastify'
import fstatic from '@fastify/static'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GC, readJson } from './paths.ts'
import { counterLines, db, importLegacy, pushEvent, supplyRows } from './db.ts'
import { fresh, ingestOne } from './ledger.ts'
import { refreshEquipped, refreshInventory } from './steam.ts'
import { entityMatches, type Kind } from './opendota.ts'
import { buildState } from './state.ts'
import { senderState, statusFile, stop } from './sender.ts'
import { allowedHosts, bearer, cookieValue, gate, loadToken, loginCookie, logoutCookie, sameToken } from './auth.ts'
import { accountList, accountsApi, arrivalAside, arrivalList, burnedList, graph, itemPool, marketScan, queuePreview, tree, webCheck } from './api.ts'
import { purchaseState, startPurchase, stopPurchase, vetLines } from './purchase.ts'
import { ACCOUNT, active as activeAccount, activeId as activeAccountId, byId as accountById, list as accountList2 } from './accounts.ts'
import { buyKey, checkKey, keyFor, removeKey, setKey } from './marketkeys.ts'
import { listOps, migrateMoney, MONEY_DDL } from './money.ts'
import { handleCorrect, handlePayout, handleStorno, listPayouts } from './payouts.ts'
import { ensureJournal, moneySync, recordBuy, reconcile } from './marketbuys.ts'
import { checkSession, webCookieHeader } from './steamweb.ts'
import { steamSync } from './steammarket.ts'
import { keyState, lastSnapshot, summarize, syncKeys, TF2_DDL } from './tf2keys.ts'
import { autopilotState, setAutopilot, tick, TICK } from './autopilot.ts'
import { reset as resetSettings, settings, update as updateSettings } from './settings.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

// Деньги и журнал закупки (план 3.1): таблицы — при запуске, только
// добавление (create if not exists). Начало журнала пишется один раз.
// Таблицу этапа 3.1 (gross NOT NULL) переделываем один раз — до создания.
const moneyMigrated = migrateMoney(db)
if (moneyMigrated.migrated) console.log('миграция: money_ops — gross может быть пустым')
db.exec(MONEY_DDL)
ensureJournal(db)
// Ключи TF2 (план 3.4): снимки — только вставка.
db.exec(TF2_DDL)
// Фронт живёт в отдельной папке: оформление переделано с нуля,
// и держать его внутри движка больше незачем.
const DIST = path.resolve(here, '..', '..', 'dash', 'dist')
const PORT = Number(process.env.PORT ?? 4322)

// Слушаем петлю, а не всю сеть.
//
// За этими адресами стоят необратимые действия: /api/autopilot запускает
// отправку сообщений игровому координатору, /api/market/buy тратит деньги
// с баланса площадки, /api/accounts/unlink удаляет сессию Steam. Пока сервер
// отвечал на 0.0.0.0 без ключа, всё это мог сделать любой в той же сети —
// от соседа по вайфаю до заражённого устройства. Теперь каждый /api/*
// требует токен (auth.ts), но петля по умолчанию остаётся: ключ — второй
// замок, а не повод открывать дверь.
//
// Нужен доступ с телефона — лучше Tailscale (tailscale serve), а не
// HOST=0.0.0.0. Имя из tailnet добавляется в ALLOWED_HOSTS.
const HOST = process.env.HOST || '127.0.0.1'

const app = Fastify({ logger: false, bodyLimit: 1_048_576 })

// ─────────────────────────────── вход ───────────────────────────────
// Host, Origin и токен на каждый запрос — см. auth.ts. Адрес 127.0.0.1
// защищает от сети, но не от страницы в том же браузере.
const ALLOWED = allowedHosts()
const { token: PANEL_TOKEN, created: tokenCreated } = loadToken()

app.addHook('onRequest', async (req, reply) => {
  const g = gate({ method: req.method, url: req.url, headers: req.headers as any }, PANEL_TOKEN, ALLOWED)
  if (!g.ok) {
    reply.code(g.code).type('application/json; charset=utf-8').send({ error: g.why, auth: g.code === 401 })
    return reply
  }
})

const presented = (req: any) =>
  cookieValue(req.headers.cookie) || bearer(req.headers.authorization)
const isHttps = (req: any) =>
  req.protocol === 'https' || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'

app.get('/api/auth', async (req: any) => ({ authed: sameToken(presented(req), PANEL_TOKEN) }))

// Вход: ссылка из консоли (GET) или поле на экране входа (POST).
app.get('/api/login', async (req: any, reply) => {
  if (!sameToken(String(req.query?.token ?? ''), PANEL_TOKEN)) {
    return reply.code(401).type('text/plain; charset=utf-8').send('токен не подходит')
  }
  reply.header('set-cookie', loginCookie(PANEL_TOKEN, isHttps(req)))
  return reply.redirect('/')
})

app.post('/api/login', async (req: any, reply) => {
  if (!sameToken(String(req.body?.token ?? ''), PANEL_TOKEN)) {
    return reply.code(401).send({ error: 'токен не подходит' })
  }
  reply.header('set-cookie', loginCookie(PANEL_TOKEN, isHttps(req)))
  return { ok: true }
})

app.post('/api/logout', async (_req, reply) => {
  reply.header('set-cookie', logoutCookie())
  return { ok: true }
})

const moved = importLegacy()
if (!moved.skipped) console.log('перенёс из JSON:', moved)

// ─────────────────────────────── SSE ───────────────────────────────
const clients = new Set<any>()

// Толчок состояния — не чаще раза в 250 мс.
//
// Толкают все: отправщик пишет отчёт на каждую отправку, работник тикает,
// каждый POST зовёт push. При паузе в полсекунды это два полных снимка
// в секунду на каждого зрителя, и каждый снимок фронт принимает за повод
// перезапросить вторичные экраны. Склейка ничего не теряет: последний
// снимок всегда уходит.
const PUSH_GAP = 250
let pushAt = 0
let pending: NodeJS.Timeout | null = null

function flush() {
  pushAt = Date.now()
  pending = null
  if (!clients.size) return
  let line: string
  try { line = 'data: ' + JSON.stringify(buildState()) + '\n\n' } catch (e: any) {
    console.error('состояние не собралось:', e.message)
    return
  }
  for (const res of clients) { try { res.raw.write(line) } catch { clients.delete(res) } }
}

function push() {
  if (pending) return
  const wait = Math.max(0, pushAt + PUSH_GAP - Date.now())
  if (!wait) return flush()
  pending = setTimeout(flush, wait)
}

app.get('/api/stream', (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  reply.raw.write('retry: 2000\n\n')
  reply.raw.write('data: ' + JSON.stringify(buildState()) + '\n\n')
  clients.add(reply)
  req.raw.on('close', () => clients.delete(reply))
})

// Пульс. Без него обрыв канала по дороге (сон машины, прокси, спящая
// вкладка) выглядит для браузера как тишина: EventSource молчит, панель
// показывает вчерашние числа как сегодняшние. Комментарий SSE не событие
// и состояние не пересобирает.
setInterval(() => {
  for (const res of clients) { try { res.raw.write(': ping\n\n') } catch { clients.delete(res) } }
}, 15_000)

app.get('/api/state', async () => buildState())

// ───────────────────────── управление отправщиком ─────────────────────────
//
// Запуска отправщика снаружи больше нет. Он принимал имя файла, склеивал
// его с папкой отправщика без проверки и поднимал процесс, который шлёт
// необратимые сообщения. Отправщиком владеет работник: он знает, что за
// файл, чья сессия и сколько отправок заказано. Остановка оставлена —
// она ничего не тратит и нужна при разборе.
// Стоп выключает и работника. Раньше гасился только процесс, а включённый
// работник на следующем такте видел мёртвый отправщик и поднимал его снова:
// кнопка «стоп» останавливала отправку секунд на двадцать.
app.post('/api/sender/stop', async (req: any) => {
  const id = String(req.body?.id ?? activeAccountId())
  const was = senderState(id).running
  setAutopilot(id, { on: false })
  if (senderState(id).running) stop(id)
  push()
  return was ? { ok: true } : { error: 'отправщик не запущен' }
})

app.get('/api/autopilot', async () => autopilotState())

// Настройки работника: выключатель, пауза, цель прогона, автоподбор темпа.
// Аккаунт по умолчанию — активный, но можно указать любой: включённых
// одновременно бывает несколько.
app.post('/api/autopilot', async (req: any) => {
  const b = req.body ?? {}
  const id = String(b.id ?? activeAccountId())
  const patch: any = {}
  if (b.on !== undefined) patch.on = !!b.on
  if (b.delay !== undefined) patch.delay = Number(b.delay)
  if (b.auto !== undefined) patch.auto = !!b.auto
  if (b.target !== undefined) patch.target = b.target === null ? null : Number(b.target)
  if (b.waves !== undefined) patch.waves = Number(b.waves)
  if (b.until !== undefined) patch.until = Number(b.until)
  if (b.cap !== undefined) patch.cap = Number(b.cap)
  if (b.even !== undefined) patch.even = !!b.even
  if (b.only !== undefined) patch.only = b.only
  const r = setAutopilot(id, patch)
  push()
  return r
})

// ── аккаунты ──
app.get('/api/accounts', async () => accountList())

app.post('/api/accounts/active', async (req: any) => {
  const r = accountsApi.setActive(String(req.body?.id ?? ''))
  // Переключились — инвентарь нового аккаунта может быть ещё не прочитан.
  // Не ждём ответа: снимок придёт следующим толчком, а панель пока честно
  // покажет пустой инвентарь с возрастом «—», а не чужой.
  void refreshInventory(ACCOUNT()).then(() => push())
  push()
  return r
})

app.post('/api/accounts/link', async (req: any) => {
  // relink — обновить сессию существующего аккаунта (протухший токен).
  // Работник этого аккаунта на время входа гасится: он бы стучался
  // со старым токеном и выбивал новую сессию.
  const relink = req.body?.relink ? String(req.body.relink) : null
  if (relink && accountById(relink)) {
    setAutopilot(relink, { on: false })
    if (senderState(relink).running) stop(relink)
  }
  const r = accountsApi.linkStart(String(req.body?.label ?? ''), () => push(), relink)
  push()
  return r
})

app.post('/api/accounts/link/cancel', async () => {
  const r = accountsApi.linkCancel()
  push()
  return r
})

// Веб-вход по QR (план 2.4, решение 2Б). Игровой токен и работник не
// трогаются; новый веб-токен принимается, только если вошли тем же Steam.
app.post('/api/accounts/web-link', async (req: any) => {
  const r = accountsApi.webLinkStart(String(req.body?.id ?? ''), () => push())
  push()
  return r
})

app.post('/api/accounts/web-link/cancel', async () => {
  const r = accountsApi.webLinkCancel()
  push()
  return r
})

app.post('/api/accounts/rename', async (req: any) => {
  const r = accountsApi.rename(String(req.body?.id ?? ''), String(req.body?.label ?? ''))
  push()
  return r
})

// Отвязка удаляет сохранённую сессию: вернуть аккаунт можно только новым QR.
// Журнал расхода остаётся — матчи на нём действительно израсходованы.
// Сначала гасим работу аккаунта и забираем его последний отчёт, потом
// отвязываем. Раньше отвязка удаляла только сессию и строку реестра:
// запущенный отправщик продолжал слать, а его отчёт больше никто не
// разбирал — расход шёл мимо журнала.
app.post('/api/accounts/unlink', async (req: any) => {
  const id = String(req.body?.id ?? '')
  if (accountList2().some(a => a.id === id)) {
    setAutopilot(id, { on: false })
    if (senderState(id).running) stop(id)
    ingestStatus()
    // Ключ площадки уходит вместе с аккаунтом: он тратит деньги на его Steam,
    // и оставлять его без хозяина незачем. tools/market.key основного
    // не трогаем: это прежнее место ключа, его человек удаляет сам.
    const a = accountById(id)
    if (a && a.id !== 'main' && accountList2().length > 1) removeKey(a)
  }
  const r = accountsApi.unlink(id)
  push()
  return r
})

// ── настройки ──
//
// Всё, что раньше было константой в коде. Пороги подбирались замерами,
// но замеры устаревают: у другого канала и времени суток числа другие.
app.get('/api/settings', async () => settings())

app.post('/api/settings', async (req: any) => {
  const r = updateSettings(req.body ?? {})
  push()
  return r
})

app.post('/api/settings/reset', async () => {
  const r = resetSettings()
  push()
  return r
})

// ── граф и очередь ──
app.get('/api/graph', async (req: any) => graph(req.query?.scope === 'all' ? 'all' : 'owned'))
app.get('/api/queue', async (req: any) => queuePreview(Number(req.query?.limit) || 200))

// Закупка запускается и дальше живёт сама: панель смотрит на её состояние.
app.post('/api/market/buy', async (req: any) => {
  const b = req.body ?? {}
  const currency = String(b.currency ?? 'RUB') as any
  // Покупаем на конкретный аккаунт: план считался по нему, и лоты должны
  // прийти туда же. Без явного id — активный, как видит панель.
  const who = b.id ? accountById(String(b.id)) : activeAccount()
  if (!who) return { error: 'нет такого аккаунта' }
  // Цены сверяются с разбором площадки в той же валюте: сервер покупает
  // только то и не дороже того, что видел сам.
  const scan: any = await marketScan(false, currency, who)
  const seen = new Map<string, number>((scan?.offers ?? []).map((o: any) => [String(o.name), Number(o.price)]))
  const s = settings()
  const vet = vetLines(b.lines ?? [], seen, s.priceTolerance, s.purchaseCap)
  if ('error' in vet) return vet
  // Ключ этого аккаунта и проверка, что площадка шлёт лоты именно ему.
  const k = await buyKey(who)
  if ('error' in k) return k
  // Журнал закупки — колбэком: закупка базу не знает. Не записалось —
  // закупка идёт дальше, а сверка покажет покупку «отсутствует в журнале».
  const r = await startPurchase(vet.lines, currency, () => push(), { key: k.key, id: who.id, label: who.label }, {
    onBought: b => { const w = recordBuy(db, b); if ('error' in w) throw new Error(w.error) },
  })
  push()
  return r
})

// Ключ площадки аккаунта: записать, удалить, перепроверить. В ответ —
// только статус; сам ключ сервер не отдаёт никогда.
app.post('/api/accounts/market-key', async (req: any) => {
  const a = accountById(String(req.body?.id ?? ''))
  if (!a) return { error: 'нет такого аккаунта' }
  const r = await setKey(a, String(req.body?.key ?? ''))
  push()
  return r
})

app.post('/api/accounts/market-key/remove', async (req: any) => {
  const a = accountById(String(req.body?.id ?? ''))
  if (!a) return { error: 'нет такого аккаунта' }
  const r = removeKey(a)
  push()
  return r
})

// Жива ли сессия Steam аккаунта — без входа в сеть Steam.
app.post('/api/accounts/session-check', async (req: any) => {
  const a = accountById(String(req.body?.id ?? ''))
  if (!a) return { error: 'нет такого аккаунта' }
  const r = await checkSession(a)
  push()
  return r
})

// Веб-сессия аккаунта (план 2.4) — один обмен токена на куки, по кнопке.
// В ответ — только состояние; куки остаются на сервере.
app.post('/api/accounts/web-check', async (req: any) => {
  const r = await webCheck(String(req.body?.id ?? ''))
  push()
  return r
})

app.post('/api/accounts/market-key/check', async (req: any) => {
  const a = accountById(String(req.body?.id ?? ''))
  if (!a) return { error: 'нет такого аккаунта' }
  const r = await checkKey(a, true)
  push()
  return r
})

app.post('/api/market/stop', async () => {
  const r = stopPurchase()
  push()
  return r
})

app.get('/api/market/run', async () => purchaseState())

// Журнал денег (план 3.1). Импорт истории площадки — только по запросу,
// через общий ограничитель; ключ берётся на сервере и в ответ не попадает.
app.post('/api/money/sync', async (req: any) => {
  const a = accountById(String(req.body?.id ?? ''))
  if (!a) return { error: 'нет такого аккаунта' }
  const key = keyFor(a)
  if (!key) return { error: 'у аккаунта «' + a.label + '» нет ключа площадки' }
  return moneySync(db, { accountId: a.id, key, days: Number(req.body?.days) || undefined })
})

app.get('/api/money', async (req: any) => listOps(db, {
  accountId: req.query?.id ? String(req.query.id) : undefined,
  limit: Number(req.query?.limit) || undefined,
}))

// История рынка Steam (план 3.3) — только по запросу. Куки — из веб-токена
// аккаунта на сервере, в ответ не попадают; нет веб-сессии — понятная ошибка.
app.post('/api/money/steam-sync', async (req: any) => {
  const a = accountById(String(req.body?.id ?? ''))
  if (!a) return { error: 'нет такого аккаунта' }
  const b = req.body ?? {}
  // Куки берёт сам steamSync — после проверки параметров.
  return steamSync(db, {
    accountId: a.id, me: a.steamid, getCookie: () => webCookieHeader(a),
    pages: b.pages == null ? undefined : Number(b.pages),
    mode: b.mode == null ? undefined : b.mode,
    from: b.from == null ? undefined : Number(b.from),
  })
})

// Ключи TF2 (план 3.4): чтение инвентаря — только по запросу, без кук,
// через ограничитель Steam; неполный инвентарь не сохраняется.
app.post('/api/keys/sync', async (req: any) => {
  const a = accountById(String(req.body?.id ?? ''))
  if (!a) return { error: 'нет такого аккаунта' }
  return syncKeys(db, { accountId: a.id, steamid: a.steamid })
})

// Итог по последнему снимку — без сети. Состояния считаются на сейчас.
app.get('/api/keys', async (req: any) => {
  const a = accountById(String(req.query?.id ?? ''))
  if (!a) return { error: 'нет такого аккаунта' }
  const s = lastSnapshot(db, a.id)
  if (!s) return { snapshot: null }
  const now = Date.now()
  return {
    snapshot: { id: s.id, seenAt: s.seenAt },
    summary: summarize(s.keys, now),
    keys: s.keys.map(k => ({ ...k, state: keyState(k, now) })),
  }
})

// Выплаты Clover руками (план 3.2). Аккаунт приходит в теле явно — форма
// закрепляет его при открытии; сервер активный не подставляет.
const accountForPayout = (id: string) => {
  const a = accountById(id)
  return a ? { id: a.id, label: a.label } : undefined
}

app.post('/api/money/payout', async (req: any) => {
  const r = handlePayout(db, req.body, accountForPayout)
  push()
  return r
})

app.post('/api/money/payout/correct', async (req: any) => {
  const r = handleCorrect(db, req.body, accountForPayout)
  push()
  return r
})

app.post('/api/money/storno', async (req: any) => {
  const r = handleStorno(db, req.body)
  push()
  return r
})

// Все выплаты аккаунта и их сторно — без предела общего журнала (решение 11).
app.get('/api/money/payouts', async (req: any) => {
  const a = accountById(String(req.query?.id ?? ''))
  if (!a) return { error: 'нет такого аккаунта' }
  return listPayouts(db, a.id)
})

// Отчёт сверки — без обращения к площадке.
app.get('/api/money/reconcile', async (req: any) => {
  const a = accountById(String(req.query?.id ?? ''))
  if (!a) return { error: 'нет такого аккаунта' }
  return reconcile(db, a.id)
})
app.get('/api/market', async (req: any) => marketScan(req.query?.force === '1', (req.query?.cur ?? 'USD')))
app.get('/api/pool', async () => itemPool())
app.get('/api/burned', async (req: any) => burnedList(Number(req.query?.limit) || 500))

// Приходы сканера слепых лотов. Откладывание меняет farm-решения работника,
// поэтому после него — толчок состояния.
app.get('/api/arrivals', async () => arrivalList())
app.post('/api/arrivals/aside', async (req: any) => {
  const r = arrivalAside(String(req.body?.assetid ?? ''), !!req.body?.aside)
  push()
  return r
})
app.get('/api/counters', async () => counterLines())
app.get('/api/tree', async (req: any) => tree(Number(req.query?.top) || settings().treeTop))

// ───────────────────── файлы отправщика: ловим изменения ─────────────────────
// Каждый аккаунт пишет свой отчёт: два отправщика в один файл затирали бы
// друг друга. Разбираем все и приписываем расход тому, кто его сделал —
// иначе журнал снова станет общим и второй аккаунт получит пустую очередь.
const seenBy = new Map<string, number>()

function ingestStatus() {
  for (const a of accountList2()) {
    const st = readJson<any>(path.join(GC, statusFile(a.id)), null)
    if (!Array.isArray(st?.recent)) continue
    const { rows, watermark } = fresh(st.recent, seenBy.get(a.id) ?? 0)
    for (const e of rows) {
      pushEvent(e, a.steamid)
      // В ленту попадает всё, включая silent. В журнал — только то, что GC
      // подтвердил: silent означает «не знаем», а не «сожжён».
      if (e.match) ingestOne(db, e as any, a.steamid)
    }
    seenBy.set(a.id, watermark)
  }
}

function watchSender() {
  if (!fs.existsSync(GC)) return
  let t: NodeJS.Timeout | null = null
  fs.watch(GC, (_ev, name) => {
    if (!name || !/^status.*\.json$/.test(String(name))) return
    if (t) clearTimeout(t)
    t = setTimeout(() => { ingestStatus(); push() }, 120)
  })
}

// ───────────────────────────── статика ─────────────────────────────
if (fs.existsSync(DIST)) {
  await app.register(fstatic, { root: DIST })
  app.setNotFoundHandler((_req, reply) => reply.sendFile('index.html'))
} else {
  app.get('/', async (_req, reply) => {
    reply.type('text/html').send('<pre style="font:14px monospace;padding:24px">Фронт не собран.\n\ncd dash && npm run deploy   — собрать фронт в dash/dist\nnpm run dev     — режим разработки на http://localhost:5173</pre>')
  })
}

await app.listen({ port: PORT, host: HOST })
console.log('Gemtrack: http://localhost:' + PORT + (HOST === '127.0.0.1' ? '' : '  (слушает ' + HOST + ' — вход только по токену)'))
// Ссылку печатаем только при создании токена: дальше он лежит в файле,
// и незачем оставлять его в каждом логе запуска.
if (tokenCreated) console.log('вход (один раз в браузере): http://localhost:' + PORT + '/api/login?token=' + PANEL_TOKEN)
else console.log('вход: токен в ' + (process.env.PANEL_TOKEN ? 'PANEL_TOKEN' : 'tools/panel.token') + ', ссылка — /api/login?token=<токен>')
if (ALLOWED.size > 3) console.log('разрешённые имена: ' + [...ALLOWED].join(', '))
console.log('гемов в базе:', supplyRows().length)

ingestStatus()
watchSender()

// Сессии проверяются при запуске: отозванный токен выглядит как живой файл,
// и панель честно покажет «сессия отозвана» до того, как работник упрётся.
void (async () => {
  for (const a of accountList2()) {
    if (!fs.existsSync(path.join(GC, a.token))) continue
    const st = await checkSession(a)
    if (st.state === 'revoked') console.log('сессия Steam «' + a.label + '» отозвана — обновите её по QR на экране аккаунтов')
    push()
  }
})()

// Остаток жилы считается по матчам сущности, поэтому их надо один раз выкачать.
// Греем всё, что есть в инвентаре, начиная с самой представленной сущности.
const warmed = new Set<string>()
async function warmOwned() {
  const st = buildState()
  for (const m of st.mine) {
    if (!m.entityId || !m.kind || m.kind === 'unknown') continue
    const key = `${m.kind}:${m.entityId}`
    if (warmed.has(key)) continue
    warmed.add(key)
    await entityMatches(m.kind as Kind, m.entityId)
    push()
  }
}

const cycle = async () => {
  // Активный аккаунт читается всегда: на него смотрит панель. Включённые
  // читает работник в своём такте.
  const changed = await refreshInventory(ACCOUNT())
  await refreshEquipped(ACCOUNT())
  await warmOwned()
  if (changed || clients.size) push()
}

// Автопилот тикает отдельно и чаще: он должен замечать смерть отправщика
// быстрее, чем обновляется инвентарь.
// Работник тикает по своему расписанию: оно меняется из настроек,
// поэтому проверяем срок сами, а не полагаемся на фиксированный интервал.
let lastTickAt = 0
let ticking = false
setInterval(() => {
  if (ticking || Date.now() - lastTickAt < TICK()) return
  lastTickAt = Date.now()
  ticking = true
  // Такт ходит в Steam и может занять секунды. Без замка следующий заход
  // начинался бы поверх предыдущего: два решения по одному снимку, два
  // запуска отправщика, две пересборки очереди.
  tick(() => push())
    .catch(e => console.error('автопилот:', e.message))
    .finally(() => { ticking = false })
}, 5_000)

let cycling = false
const runCycle = () => {
  if (cycling) return
  cycling = true
  cycle().catch(e => console.error('обновление:', e.message)).finally(() => { cycling = false })
}
runCycle()
setInterval(runCycle, 20_000)
