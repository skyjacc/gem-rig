// Fastify + SSE. Сервер сам толкает состояние, когда меняются файлы отправщика
// или обновляется инвентарь. Браузер ничего не опрашивает.
//
// Здесь — запуск: база, токен, порт, такты. Маршруты — app.ts (план 7.2).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GC } from './paths.ts'
import { db, importLegacy, supplyRows } from './db.ts'
import { refreshEquipped, refreshInventory } from './steam.ts'
import { entityMatches, type Kind } from './opendota.ts'
import { buildState } from './state.ts'
import { allowedHosts, loadToken } from './auth.ts'
import { ACCOUNT, list as accountList2 } from './accounts.ts'
import { checkSession } from './steamweb.ts'
import { tick, TICK } from './autopilot.ts'
import { buildApp, prepareDb } from './app.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

prepareDb()
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

// ─────────────────────────────── вход ───────────────────────────────
// Host, Origin и сессия на каждый запрос — см. auth.ts. Адрес 127.0.0.1
// защищает от сети, но не от страницы в том же браузере.
const ALLOWED = allowedHosts()
const { token: PANEL_TOKEN, created: tokenCreated } = loadToken()

const moved = importLegacy()
if (!moved.skipped) console.log('перенёс из JSON:', moved)

const { app, push, hub, ingestStatus, watchSender, enforceAccess } = await buildApp({ token: PANEL_TOKEN, allowed: ALLOWED, dist: DIST })

// Пульс. Без него обрыв канала по дороге (сон машины, прокси, спящая
// вкладка) выглядит для браузера как тишина: EventSource молчит, панель
// показывает вчерашние числа как сегодняшние. Комментарий SSE не событие
// и состояние не пересобирает.
// Заодно — проверка сессий открытых потоков: истёкшая, отозванная или
// отключённый пользователь — поток закрывается не позже чем через 15 с.
setInterval(() => {
  hub.sweep(db)
  // Допуск для приёмки истёк по сроку — сессии и работа того, кто им входил,
  // встают не позже чем через 15 с (ревью PR #34).
  enforceAccess()
  hub.broadcast(': ping\n\n')
}, 15_000)

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
  if (changed || hub.size()) push()
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
