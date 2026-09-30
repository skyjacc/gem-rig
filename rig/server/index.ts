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
import { accountList, accountsApi, arrivalAside, arrivalList, burnedList, graph, itemPool, marketScan, queuePreview, tree } from './api.ts'
import { purchaseState, startPurchase, stopPurchase, vetLines } from './purchase.ts'
import { ACCOUNT, active as activeAccount, activeId as activeAccountId, byId as accountById, list as accountList2 } from './accounts.ts'
import { buyKey, checkKey, removeKey, setKey } from './marketkeys.ts'
import { autopilotState, setAutopilot, tick, TICK } from './autopilot.ts'
import { reset as resetSettings, settings, update as updateSettings } from './settings.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
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
  const r = accountsApi.linkStart(String(req.body?.label ?? ''), () => push())
  push()
  return r
})

app.post('/api/accounts/link/cancel', async () => {
  const r = accountsApi.linkCancel()
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
  const r = await startPurchase(vet.lines, currency, () => push(), { key: k.key, id: who.id, label: who.label })
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
    reply.type('text/html').send('<pre style="font:14px monospace;padding:24px">Фронт не собран.\n\nnpm run build   — собрать\nnpm run dev     — режим разработки на http://localhost:5173</pre>')
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
