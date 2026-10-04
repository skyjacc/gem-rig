// Разовое живое чтение истории операций market.dota2.net (план 3.1, задача 2).
//
// Зачем: в docs-v2 не описано, что лежит в price/received у buy и refund,
// совпадает ли id из buy с item_id в истории, меняются ли time/stage у
// записи, есть ли пределы и постраничность. Это читается здесь, а смысл
// полей фиксируется в плане — до того, как попадёт в код журнала.
//
// Только чтение. Сервер не запускается, база не открывается.
// Ключ — тем же путём, что берёт сервер (keyFor: MARKET_KEY или файл ключа
// аккаунта). Аргументом НЕ принимается, не печатается, не сохраняется (§14 п. 4).
// Сырой ответ — личные суммы — пишется только ВНЕ репозитория (он публичный).
//
//   node rig/scripts/history-dump.ts --out <папка вне gem-rig> --tag read1 [--account main] [--days 30]
//   node rig/scripts/history-dump.ts --compare <read1.json> <read2.json>
//
// Печатает только выводы и форму полей — без сумм и номеров.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buyInfo, operationHistory } from '../server/market.ts'
import { keyFor } from '../server/marketkeys.ts'
import { windows } from '../server/markethistory.ts'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DAY = 86_400
const MINOR: Record<string, number> = { RUB: 100, USD: 1000, EUR: 1000 }

const arg = (name: string) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const inside = (p: string, root: string) => {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

type Row = Record<string, any>
type Dump = {
  tag: string
  account: string
  readAt: number
  period: { from: number; to: number }
  windows: { from: number; to: number; ok: boolean; error?: string; rows: Row[] }[]
  wide: { ok: boolean; error?: string; rows: Row[] }
  checks: { customId: string; info: any }[]
}

async function read() {
  const out = arg('out')
  const tag = arg('tag')
  const account = arg('account') ?? 'main'
  const days = Number(arg('days') ?? 30)
  if (!out || !tag) throw new Error('нужно --out <папка вне gem-rig> и --tag <имя чтения>')
  const dir = path.resolve(out)
  if (inside(dir, REPO)) throw new Error('папка внутри репозитория — сырьё сюда нельзя (репозиторий публичный)')
  const key = keyFor({ id: account })
  if (!key) throw new Error('у аккаунта «' + account + '» нет ключа площадки')

  const to = Math.trunc(Date.now() / 1000)
  const from = to - Math.trunc(days * DAY)
  const dump: Dump = { tag, account, readAt: Date.now(), period: { from, to }, windows: [], wide: { ok: false, rows: [] }, checks: [] }

  for (const w of windows(from, to)) {
    const r: any = await operationHistory(key, w.from, w.to)
    dump.windows.push({ ...w, ok: !!r?.success, error: r?.success ? undefined : String(r?.error ?? 'нет ответа'), rows: Array.isArray(r?.data) ? r.data : [] })
  }
  // Тот же период одним запросом: если строк меньше, чем в окнах, — площадка режет.
  const wide: any = await operationHistory(key, from, to)
  dump.wide = { ok: !!wide?.success, error: wide?.success ? undefined : String(wide?.error ?? 'нет ответа'), rows: Array.isArray(wide?.data) ? wide.data : [] }

  // Наши покупки (custom_id gt-…): спросить площадку по custom_id — там
  // item_id и paid, сверяем с той же строкой истории. Не больше двух.
  const ours = [...new Set(dump.windows.flatMap(w => w.rows).filter(x => x.event === 'buy' && /^gt-/.test(String(x.custom_id ?? ''))).map(x => String(x.custom_id)))].slice(0, 2)
  for (const cid of ours) dump.checks.push({ customId: cid, info: await buyInfo(key, cid) })

  const text = JSON.stringify(dump, null, 1)
  if (text.includes(key)) throw new Error('в ответе оказался ключ — не сохраняю')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, tag + '-' + dump.readAt + '.json')
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
  console.log('сохранено вне репозитория:', file)
  summary(dump)
}

// Только форма и счётчики — без сумм, номеров и названий.
function summary(d: Dump) {
  const rows = d.windows.flatMap(w => w.rows)
  console.log('окна:', d.windows.map(w => (w.ok ? w.rows.length : 'ошибка: ' + w.error)).join(' · '))
  console.log('одним запросом:', d.wide.ok ? d.wide.rows.length : 'ошибка: ' + d.wide.error, '· сумма окон:', rows.length)
  const by = (k: string) => Object.entries(rows.reduce((m: Record<string, number>, r) => ((m[String(r[k])] = (m[String(r[k])] ?? 0) + 1), m), {})).map(([v, n]) => v + '×' + n).join(', ')
  console.log('event:', by('event'))
  console.log('stage:', by('stage'))
  console.log('currency:', by('currency'))
  console.log('app:', by('app'))
  console.log('поля строк:', [...new Set(rows.flatMap(r => Object.keys(r)))].sort().join(', '))
  console.log('custom_id есть:', rows.filter(r => r.custom_id).length, '· из них gt-…:', rows.filter(r => /^gt-/.test(String(r.custom_id ?? ''))).length)
  const times = rows.map(r => Number(r.time))
  const sorted = times.every((t, i) => i === 0 || t <= times[i - 1]) ? 'по убыванию' : times.every((t, i) => i === 0 || t >= times[i - 1]) ? 'по возрастанию' : 'без порядка'
  console.log('порядок по time внутри окон:', d.windows.map(w => {
    const ts = w.rows.map(r => Number(r.time))
    return ts.length < 2 ? '—' : ts.every((t, i) => i === 0 || t <= ts[i - 1]) ? '↓' : ts.every((t, i) => i === 0 || t >= ts[i - 1]) ? '↑' : '~'
  }).join(' '), '· все подряд:', sorted)
  for (const ev of ['buy', 'refund']) {
    const rs = rows.filter(r => r.event === ev)
    if (!rs.length) { console.log(ev + ': строк нет'); continue }
    const has = (k: string) => rs.filter(r => r[k] != null).length + ' из ' + rs.length
    console.log(ev + ': есть paid', has('paid'), '· price', has('price'), '· received', has('received'), '· amount', has('amount'),
      '· settlement > 0:', rs.filter(r => Number(r.settlement) > 0).length,
      '· самоцветов:', rs.filter(r => /^Spectator/.test(String(r.market_hash_name ?? ''))).length,
      '· stage:', [...new Set(rs.map(r => r.stage))].join('/'))
  }
  for (const c of d.checks) {
    const h = rows.find(r => r.event === 'buy' && String(r.custom_id) === c.customId)
    const info = c.info?.data
    if (!c.info?.success || !info || !h) { console.log('проверка по custom_id: ответа нет или строки истории нет'); continue }
    const unit = MINOR[String(h.currency)] ?? 0
    console.log('проверка по custom_id:',
      'item_id совпал:', String(info.item_id) === String(h.item_id) ? 'да' : 'нет',
      '· stage совпал:', String(info.stage) === String(h.stage) ? 'да' : 'нет',
      '· paid истории = paid проверки × единица:', unit && Math.round(Number(info.paid) * unit) === Number(h.paid) ? 'да' : 'нет',
      '· paid истории = paid проверки:', String(info.paid) === String(h.paid) ? 'да' : 'нет',
      '· refund в ответе:', info.refund ? 'есть' : 'нет')
  }
}

// Сравнение двух чтений: те же записи — что поменялось. Без значений.
//
// Запись сопоставляется по event + item_id + custom_id — так изменение
// самого id (кандидата во внешний номер) видно как изменение. У строк без
// item_id (checkin) так не различить две записи — их сопоставляем по id,
// и изменение id у них этим способом не увидеть: это пишется в выводе.
function compare(a: string, b: string) {
  const A: Dump = JSON.parse(fs.readFileSync(a, 'utf8'))
  const B: Dump = JSON.parse(fs.readFileSync(b, 'utf8'))
  console.log('между чтениями:', Math.round((B.readAt - A.readAt) / 60_000), 'мин')
  const rowsA = A.windows.flatMap(w => w.rows)
  const rowsB = B.windows.flatMap(w => w.rows)
  const byItem = (r: Row) => r.item_id != null
  const id = (r: Row) => byItem(r) ? ['item', r.event, r.item_id, r.custom_id ?? ''].join('|') : ['id', r.event, r.id].join('|')
  const mapB = new Map<string, Row[]>()
  for (const r of rowsB) mapB.set(id(r), [...(mapB.get(id(r)) ?? []), r])
  const dupA = rowsA.length - new Set(rowsA.map(id)).size
  console.log('строк: A', rowsA.length, '· B', rowsB.length, '· неразличимых по ключу в A:', dupA)
  const fields = ['id', 'time', 'stage', 'paid', 'amount', 'price', 'received', 'custom_id', 'item_id', 'assetid', 'settlement', 'for']
  for (const [label, pick] of [['с item_id (ключ event+item_id+custom_id)', byItem], ['без item_id (ключ — id; смену id не видно)', (r: Row) => !byItem(r)]] as const) {
    const part = rowsA.filter(pick)
    if (!part.length) { console.log(label + ': строк нет'); continue }
    let found = 0
    const changed: Record<string, number> = Object.fromEntries(fields.map(k => [k, 0]))
    for (const r of part) {
      const m = mapB.get(id(r))?.[0]
      if (!m) continue
      found++
      for (const k of fields) if (String(r[k] ?? '') !== String(m[k] ?? '')) changed[k]++
    }
    console.log(label + ': найдено в B', found, 'из', part.length)
    console.log('  изменилось:', fields.map(k => k + ' ' + changed[k]).join(' · '))
  }
}

const cmp = process.argv.indexOf('--compare')
const run = cmp >= 0 ? Promise.resolve(compare(process.argv[cmp + 1], process.argv[cmp + 2])) : read()
run.catch(e => { console.error('стоп:', e?.message ?? e); process.exitCode = 1 })
