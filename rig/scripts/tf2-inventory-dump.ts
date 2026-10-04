// Разовое живое чтение инвентаря TF2 (план 3.4, задача 1).
//
// Зачем: увидеть, где и в каком виде Steam пишет время, когда ключ станет
// передаваемым («Tradable After: …»), и что видит владелец, а не посторонний.
// Два запроса: инвентарь под веб-куками владельца и тот же без кук.
//
// Только чтение. Сервер не запускается, база не открывается. Куки —
// webCookieHeader() веб-токена: не аргументом, не в вывод, не на диск.
// Сырой ответ — только ВНЕ репозитория. Пауза между запросами ≥ 3 с;
// на 429 — сразу стоп.
//
//   node rig/scripts/tf2-inventory-dump.ts --out <папка вне gem-rig> --tag read1 [--account main]
//
// Печатает форму ответа и тексты описаний ключей — без assetid и количеств
// по отдельным предметам, только счётчики.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { byId } from '../server/accounts.ts'
import { webCookieHeader } from '../server/steamweb.ts'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const KEY = 'Mann Co. Supply Crate Key'
const GAP_MS = 3_000
const url = (steamid: string) => `https://steamcommunity.com/inventory/${steamid}/440/2?l=english&count=2000`

const arg = (name: string) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const inside = (p: string, root: string) => {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function get(u: string, cookie: string | null) {
  const headers: Record<string, string> = { 'User-Agent': 'gemtrack', Accept: 'application/json' }
  if (cookie) headers.Cookie = cookie
  const r = await fetch(u, { headers, redirect: 'manual' })
  const text = await r.text()
  let body: unknown = text
  try { body = JSON.parse(text) } catch { /* не JSON */ }
  return { status: r.status, body }
}

// Тексты описаний: длинные числа маскируются — в выводе не должно быть номеров.
const mask = (s: string) => String(s).replace(/\d{6,}/g, '#')

function report(label: string, b: any) {
  if (!b || typeof b !== 'object') { console.log(label + ': не JSON'); return }
  const descs: any[] = Array.isArray(b.descriptions) ? b.descriptions : []
  const assets: any[] = Array.isArray(b.assets) ? b.assets : []
  const by = new Map(descs.map(d => [d.classid + '_' + d.instanceid, d]))
  const keys = assets.filter(a => by.get(a.classid + '_' + a.instanceid)?.market_hash_name === KEY)
  console.log(label + ': ключи верхнего уровня', Object.keys(b).join(', '), '· предметов', assets.length, '· ключей', keys.length,
    '· more_items', b.more_items ?? '—', '· last_assetid есть', b.last_assetid != null)
  const kd = [...new Set(keys.map(a => by.get(a.classid + '_' + a.instanceid)))]
  console.log('  поля описания ключа:', kd[0] ? Object.keys(kd[0]).join(', ') : '—')
  console.log('  tradable у ключей:', JSON.stringify(kd.reduce((m: any, d: any) => { m[d.tradable] = (m[d.tradable] ?? 0) + keys.filter(a => by.get(a.classid + '_' + a.instanceid) === d).length; return m }, {})),
    '· разных описаний ключа:', kd.length)
  const texts = new Map<string, number>()
  for (const d of kd) for (const f of ['descriptions', 'owner_descriptions', 'fraudwarnings']) {
    for (const x of Array.isArray(d?.[f]) ? d[f] : []) {
      const t = f + ': ' + mask(typeof x === 'string' ? x : (x?.value ?? JSON.stringify(x)))
      texts.set(t, (texts.get(t) ?? 0) + 1)
    }
  }
  for (const [t, n] of texts) console.log('   ', n + '×', t.slice(0, 160))
}

async function main() {
  const out = arg('out')
  const tag = arg('tag')
  const id = arg('account') ?? 'main'
  if (!out || !tag) throw new Error('нужно --out <папка вне gem-rig> и --tag <имя чтения>')
  const dir = path.resolve(out)
  if (inside(dir, REPO)) throw new Error('папка внутри репозитория — сырьё сюда нельзя (репозиторий публичный)')
  const a = byId(id)
  if (!a) throw new Error('нет аккаунта «' + id + '»')

  const cookie = await webCookieHeader(a)
  const secrets = cookie.split(';').map(s => s.split('=').slice(1).join('=').trim()).filter(s => s.length >= 8)

  const owner = await get(url(a.steamid), cookie)
  console.log('под куками владельца · HTTP', owner.status)
  let outsider: { status: number; body: unknown } | null = null
  if (owner.status !== 429) {
    await new Promise(r => setTimeout(r, GAP_MS))
    outsider = await get(url(a.steamid), null)
    console.log('без кук · HTTP', outsider.status)
  } else console.log('429 — стоп, без второго запроса')

  const dump = { tag, account: id, readAt: Date.now(), owner, outsider }
  const text = JSON.stringify(dump, null, 1)
  if (secrets.some(s => text.includes(s))) throw new Error('в ответе оказались куки сессии — не сохраняю')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'tf2-' + tag + '-' + dump.readAt + '.json')
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
  console.log('сохранено вне репозитория:', file)
  report('владелец', owner.body)
  if (outsider) report('посторонний', outsider.body)
}

main().catch(e => { console.error('стоп:', e?.message ?? e); process.exitCode = 1 })
