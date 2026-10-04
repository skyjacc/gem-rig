// Разовое живое чтение истории рынка Steam (план 3.3, задача 1).
//
// Зачем: у Valve нет публичной документации истории рынка. Здесь читается,
// подходят ли куки steam-session, какая форма ответа, где цена покупателя,
// комиссии и пришедшее, как отличить продажу от покупки, какой номер у
// операции. Смысл полей фиксируется в плане до того, как попадёт в код.
//
// Только чтение: ничего не выставляется, не снимается, не покупается.
// Сервер не запускается, база не открывается. Куки — webCookieHeader():
// только в памяти, не аргументом, не в вывод, не на диск (§14 п. 4).
// Сырой ответ — только ВНЕ репозитория (он публичный, в ответе личные суммы).
// Не чаще 1 запроса в 3 секунды; на 429 — сразу стоп, без повторов.
//
//   node rig/scripts/steam-history-dump.ts --out <папка вне gem-rig> --tag read1 [--account main] [--pages 2]
//
// Печатает только форму ответа — ключи, типы и счётчики, без значений.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { byId } from '../server/accounts.ts'
import { webCookieHeader } from '../server/steamweb.ts'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PAGE = 100
const GAP_MS = 3_000
// Адрес — HYPOTHESIS (документации нет); его проверка — цель этого чтения.
const URL_OF = (start: number) => `https://steamcommunity.com/market/myhistory?norender=1&start=${start}&count=${PAGE}`

const arg = (name: string) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const inside = (p: string, root: string) => {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Форма значения без самого значения: ключи, типы, длины массивов.
function shape(v: unknown, depth = 0): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'массив[' + v.length + ']' + (v.length && depth < 3 ? ' из ' + shape(v[0], depth + 1) : '')
  if (typeof v === 'object') {
    const keys = Object.keys(v as object)
    if (depth >= 3) return '{' + keys.length + ' ключей}'
    // У словарей по номерам (id → запись) показываем один пример, а не все.
    if (keys.length > 6 && keys.every(k => /^\d+$/.test(k))) return 'словарь[' + keys.length + '] номер → ' + shape((v as any)[keys[0]], depth + 1)
    return '{' + keys.map(k => k + ': ' + shape((v as any)[k], depth + 1)).join(', ') + '}'
  }
  if (typeof v === 'string') return /^-?\d+$/.test(v) ? 'строка-целое' : /^-?\d+\.\d+$/.test(v) ? 'строка-дробь' : 'строка'
  if (typeof v === 'number') return Number.isInteger(v) ? 'целое' : 'дробь'
  return typeof v
}

async function main() {
  const out = arg('out')
  const tag = arg('tag')
  const id = arg('account') ?? 'main'
  const pages = Math.max(1, Math.min(2, Math.trunc(Number(arg('pages') ?? 2))))
  if (!out || !tag) throw new Error('нужно --out <папка вне gem-rig> и --tag <имя чтения>')
  const dir = path.resolve(out)
  if (inside(dir, REPO)) throw new Error('папка внутри репозитория — сырьё сюда нельзя (репозиторий публичный)')
  const a = byId(id)
  if (!a) throw new Error('нет аккаунта «' + id + '»')

  const cookie = await webCookieHeader(a)
  const secrets = cookie.split(';').map(s => s.split('=').slice(1).join('=').trim()).filter(s => s.length >= 8)

  const dump: { tag: string; account: string; readAt: number; pages: { start: number; status: number; contentType: string; body: unknown }[] } =
    { tag, account: id, readAt: Date.now(), pages: [] }

  for (let p = 0; p < pages; p++) {
    if (p) await sleep(GAP_MS)
    const start = p * PAGE
    const r = await fetch(URL_OF(start), { headers: { Cookie: cookie, 'User-Agent': 'gemtrack', Accept: 'application/json' }, redirect: 'manual' })
    const text = await r.text()
    let body: unknown = text
    try { body = JSON.parse(text) } catch { /* не JSON — сохраняем как есть */ }
    dump.pages.push({ start, status: r.status, contentType: r.headers.get('content-type') ?? '', body })
    console.log('страница', p + 1, '· HTTP', r.status, '·', r.headers.get('content-type') ?? '—', '· JSON:', typeof body !== 'string')
    if (r.status === 429) { console.log('429 — стоп, без повторов'); break }
    if (r.status !== 200 || typeof body === 'string') break
  }

  const text = JSON.stringify(dump, null, 1)
  if (secrets.some(s => text.includes(s))) throw new Error('в ответе оказались куки сессии — не сохраняю')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'steam-' + tag + '-' + dump.readAt + '.json')
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
  console.log('сохранено вне репозитория:', file)
  for (const pg of dump.pages) console.log('форма страницы с', pg.start + ':', typeof pg.body === 'string' ? 'не JSON, ' + pg.body.length + ' символов' : shape(pg.body))
}

main().catch(e => { console.error('стоп:', e?.message ?? e); process.exitCode = 1 })
