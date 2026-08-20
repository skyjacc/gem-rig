// Fastify + SSE. Сервер сам толкает состояние, когда меняются файлы отправщика
// или обновляется инвентарь. Браузер ничего не опрашивает.

import Fastify from 'fastify'
import fstatic from '@fastify/static'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GC, TOOLS, readJson } from './paths.ts'
import { importLegacy, markBurned, pushEvent, supplyRows } from './db.ts'
import { refreshEquipped, refreshInventory } from './steam.ts'
import { entityMatches, type Kind } from './opendota.ts'
import { buildState } from './state.ts'
import { isBurned } from './db.ts'
import { listFiles, senderState, start, stop } from './sender.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(here, '..', 'dist')
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

// ───────────────────────── управление отправщиком ─────────────────────────
app.post('/api/sender/start', async (req: any) => {
  const { file, delay } = req.body ?? {}
  const r = start(String(file), Number(delay) || 30000, () => push())
  push()
  return r
})

app.post('/api/sender/stop', async () => {
  const r = stop()
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
let seenEventTs = 0

function ingestStatus() {
  const st = readJson<any>(path.join(GC, 'status.json'), null)
  if (!st?.recent) return
  for (const e of st.recent) {
    if (!e?.ts || e.ts <= seenEventTs) continue
    pushEvent(e)
    if (e.match) markBurned(String(e.match), e.league ? String(e.league) : null, 'live')
  }
  const top = st.recent[0]?.ts
  if (top) seenEventTs = Math.max(seenEventTs, top)
}

function watchSender() {
  if (!fs.existsSync(GC)) return
  let t: NodeJS.Timeout | null = null
  fs.watch(GC, (_ev, name) => {
    if (!name || !/^(status\.json|delay\.txt|sent-.*\.json)$/.test(String(name))) return
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
console.log('Жила: http://localhost:' + PORT)
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
cycle()
setInterval(cycle, 20_000)
