// Fastify + SSE. Сервер сам толкает состояние, когда меняются файлы отправщика
// или обновляется инвентарь. Браузер ничего не опрашивает.

import Fastify from 'fastify'
import fstatic from '@fastify/static'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GC, TOOLS, readJson } from './paths.ts'
import { db, importLegacy, pushEvent, supplyRows } from './db.ts'
import { ingestOne } from './ledger.ts'
import { refreshEquipped, refreshInventory } from './steam.ts'
import { entityMatches, type Kind } from './opendota.ts'
import { buildState } from './state.ts'
import { isBurned } from './db.ts'
import { listFiles, senderState, start, statusFile, stop } from './sender.ts'
import { accountList, accountsApi, graph, queuePreview, tree } from './api.ts'
import { ACCOUNT, activeId as activeAccountId } from './accounts.ts'
import { roadmap } from './roadmap.ts'
import { autopilotState, setAutopilot, tick } from './autopilot.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
// Фронт живёт в отдельной папке: оформление переделано с нуля,
// и держать его внутри движка больше незачем.
const DIST = path.resolve(here, '..', '..', 'dash', 'dist')
const PORT = Number(process.env.PORT ?? 4322)

const app = Fastify({ logger: false })

const moved = importLegacy()
if (!moved.skipped) console.log('перенёс из JSON:', moved)

// ─────────────────────────────── SSE ───────────────────────────────
const clients = new Set<any>()
let pushing = false

async function push() {
  if (pushing || !clients.size) return
  pushing = true
  try {
    const line = 'data: ' + JSON.stringify(buildState()) + '\n\n'
    for (const res of clients) { try { res.raw.write(line) } catch { clients.delete(res) } }
  } finally { pushing = false }
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

app.get('/api/state', async () => buildState())

// Roadmap считается живьём и не дёшево — держим короткий кеш, чтобы
// частые опросы не гоняли счёт по трёмстам тысячам матчей.
let rmCache: any = null
let rmAt = 0
app.get('/api/roadmap', async () => {
  if (!rmCache || Date.now() - rmAt > 5000) { rmCache = roadmap(); rmAt = Date.now() }
  return rmCache
})

// ───────────────────────── управление отправщиком ─────────────────────────
app.post('/api/sender/start', async (req: any) => {
  const { file, delay, id } = req.body ?? {}
  const acc = accountList().list.find(a => a.id === String(id ?? activeAccountId()))
  if (!acc) return { error: 'нет такого аккаунта' }
  const r = start(acc.id, acc.token, String(file), Number(delay) || 30000, () => push())
  push()
  return r
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
  const r = setAutopilot(id, patch)
  push()
  return r
})

// ── аккаунты ──
app.get('/api/accounts', async () => accountList())

app.post('/api/accounts/active', async (req: any) => {
  const r = accountsApi.setActive(String(req.body?.id ?? ''))
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
app.post('/api/accounts/unlink', async (req: any) => {
  const r = accountsApi.unlink(String(req.body?.id ?? ''))
  push()
  return r
})

// ── граф и очередь ──
app.get('/api/graph', async (req: any) => graph(req.query?.scope === 'all' ? 'all' : 'owned'))
app.get('/api/queue', async (req: any) => queuePreview(Number(req.query?.limit) || 200))
app.get('/api/tree', async (req: any) => tree(Number(req.query?.top) || 12))

app.post('/api/sender/stop', async (req: any) => {
  const r = stop(String(req.body?.id ?? activeAccountId()))
  push()
  return r
})

app.post('/api/delay', async (req: any) => {
  const delay = Number(req.body?.delay)
  if (Number.isFinite(delay) && delay >= 500) fs.writeFileSync(path.join(GC, 'delay.txt'), String(delay))
  push()
  return { ok: true }
})

// Собирает список ещё не сожжённых матчей сущности и кладёт файл для отправщика.
app.post('/api/build', async (req: any) => {
  const { kind, id, count, name } = req.body ?? {}
  const rows = await entityMatches(kind as Kind, Number(id))
  if (!rows.length) return { error: 'OpenDota не отдал матчи' }

  const lines: string[] = []
  for (const m of rows) {
    if (isBurned(m.id)) continue
    lines.push(m.id + ',' + m.league)
    if (count && lines.length >= Number(count)) break
  }
  const safe = String(name ?? `${kind}-${id}`).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
  const file = path.join(GC, `build-${safe}.csv`)
  fs.writeFileSync(file, lines.join('\n'), 'utf8')
  push()
  return { file: path.basename(file), total: rows.length, fresh: lines.length, burned: rows.length - lines.length }
})

// ───────────────────── файлы отправщика: ловим изменения ─────────────────────
// Каждый аккаунт пишет свой отчёт: два отправщика в один файл затирали бы
// друг друга. Разбираем все и приписываем расход тому, кто его сделал —
// иначе журнал снова станет общим и второй аккаунт получит пустую очередь.
const seenBy = new Map<string, number>()

function ingestStatus() {
  for (const a of accountList().list) {
    const st = readJson<any>(path.join(GC, statusFile(a.id)), null)
    if (!st?.recent) continue
    const seen = seenBy.get(a.id) ?? 0
    for (const e of st.recent) {
      if (!e?.ts || e.ts <= seen) continue
      pushEvent(e, a.steamid)
      // В ленту попадает всё, включая silent. В журнал — только то, что GC
      // подтвердил: silent означает «не знаем», а не «сожжён».
      if (e.match) ingestOne(db, e, a.steamid)
    }
    const top = st.recent[0]?.ts
    if (top) seenBy.set(a.id, Math.max(seen, top))
  }
}

function watchSender() {
  if (!fs.existsSync(GC)) return
  let t: NodeJS.Timeout | null = null
  fs.watch(GC, (_ev, name) => {
    if (!name || !/^(status.*\.json|delay\.txt|sent-.*\.json)$/.test(String(name))) return
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

await app.listen({ port: PORT, host: '0.0.0.0' })
console.log('Gemtrack: http://localhost:' + PORT)
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
  const changed = await refreshInventory()
  await refreshEquipped()
  await warmOwned()
  if (changed || clients.size) push()
}

// Автопилот тикает отдельно и чаще: он должен замечать смерть отправщика
// быстрее, чем обновляется инвентарь.
setInterval(() => { tick(() => push()).catch(e => console.error('автопилот:', e.message)) }, 20_000)
cycle()
setInterval(cycle, 20_000)
