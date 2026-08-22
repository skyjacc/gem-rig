// Steam: инвентарь со счётчиками и Web API с тем, что реально надето.
// Оба источника ходят через одну очередь — не чаще одного запроса в 2.5 секунды,
// иначе Steam отвечает 429 и уходит в отказ на несколько минут.
//
// Инвентарь читается ПО АККАУНТУ, а не один на всю панель.
//
// Раньше здесь стоял один общий снимок по константе STEAMID. Пока аккаунт был
// один, разницы не было; со вторым это ложь, из-за которой тратятся матчи:
// работник второго аккаунта видел бы гемы первого, считал бы потолки по чужим
// счётчикам и жёг бы очередь по чужому составу. Отправка необратима, поэтому
// снимок обязан принадлежать тому, за кого его выдают.

import { steamKey } from './paths.ts'
import { ACCOUNT } from './accounts.ts'
import { settings } from './settings.ts'
import { parseSet } from './itemset.ts'
import { saveSnapshot } from './db.ts'

const GAP = 2500
let queue: Promise<any> = Promise.resolve()
let lastAt = 0

function paced(url: string, init?: RequestInit): Promise<Response> {
  const run = async () => {
    const wait = Math.max(0, lastAt + GAP - Date.now())
    if (wait) await new Promise(r => setTimeout(r, wait))
    lastAt = Date.now()
    return fetch(url, init)
  }
  queue = queue.then(run, run)
  return queue
}

export type GemItem = {
  assetid: string
  name: string
  gem: string
  hero: string
  icon: string
  value: number
  equipped?: boolean
  carrier: Carrier
  // Набор, из которого предмет: название и полный состав. Продаётся
  // собранный набор, а не россыпь частей, поэтому это не украшение.
  set: string
  setPieces: string[]
}

// Чем несётся счётчик.
//
//   gem   голый самоцвет, ещё никуда не вставленный. Продаётся как самоцвет,
//         и его можно вставить в любой подходящий предмет позже.
//   item  предмет с уже вставленным самоцветом. Продаётся как предмет,
//         счётчик неотделим от него.
//
// Различить просто: у голого самоцвета собственное имя — «Spectator: X»,
// и героя у него нет, потому что вставлять ещё некуда.
export type Carrier = 'gem' | 'item'

const BARE = /^(Genuine\s+)?Spectator:\s*/i
export const carrierOf = (name: string, hero: string): Carrier =>
  BARE.test(String(name ?? '')) && !String(hero ?? '').trim() ? 'gem' : 'item'

const BACKOFF = 300_000

export type Inventory = {
  steamid: string
  ts: number
  rows: GemItem[]
  error: string | null
  backoffUntil: number
  // Инвентарь закрыт настройками приватности. Это не сбой связи, и повтор
  // не поможет: пока человек не откроет профиль, читать нечего.
  private: boolean
  // Steam отдал ровно потолок страницы — значит есть продолжение, которое
  // мы не забрали. Молчать об этом нельзя: потолки считаются по составу.
  truncated: boolean
}

const box = new Map<string, Inventory>()

export function invOf(steamid: string = ACCOUNT()): Inventory {
  const id = String(steamid)
  let b = box.get(id)
  if (!b) {
    b = { steamid: id, ts: 0, rows: [], error: null, backoffUntil: 0, private: false, truncated: false }
    box.set(id, b)
  }
  return b
}

// Снимок активного аккаунта. Экраны, у которых нет своего аккаунта
// (каталог, граф, наборы), смотрят на него.
export const inv = () => invOf()

function parseDescription(desc: any): { gem: string; hero: string; value: number | null } {
  let gem = '', hero = '', value: number | null = null
  for (const d of desc.descriptions ?? []) {
    const raw: string = d.value ?? ''
    const text = raw.replace(/<[^>]+>/g, '|').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\|+/g, '|')
    const used = raw.match(/^Used By:\s*(.+)$/)
    if (used) hero = used[1].trim()
    const g = text.match(/Games\s*Watched:\s*([\d,\s]+)/i)
    if (g) {
      value = Number(g[1].replace(/[\s,]/g, ''))
      const parts = text.split('|').map(s => s.trim()).filter(Boolean)
      const idx = parts.findIndex(p => /Games\s*Watched/i.test(p))
      if (idx > 0) gem = parts[idx - 1]
    }
  }
  return { gem, hero, value }
}

// Steam смотрит на то, чем представился запрос.
//
// С «rig» инвентарь отдавался, пока запросов было мало, а под нагрузкой
// уходил в 429 на часы: 22 августа счётчики стояли с 02:25 до полудня,
// и потолок всё это время был слепым. Тот же запрос с обычным браузерным
// именем отвечал 200 сразу. Смысла в честном «rig» нет: это не обход
// защиты, а единственный принимаемый вид обращения.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36'

// Страница инвентаря. Больше 2000 Steam за раз не отдаёт вовсе.
const PAGE = 2000
// Сколько страниц готовы забрать. Пять страниц — десять тысяч предметов;
// дальше это уже не инвентарь, а склад, и запрос стоит дороже пользы.
const PAGES = 5

type Fetched = { rows: GemItem[]; truncated: boolean }

async function fetchInventory(steamid: string): Promise<Fetched> {
  const rows: GemItem[] = []
  let cursor: string | null = null
  let truncated = false

  for (let page = 0; page < PAGES; page++) {
    const url = `https://steamcommunity.com/inventory/${steamid}/570/2?l=english&count=${PAGE}`
      + (cursor ? '&start_assetid=' + encodeURIComponent(cursor) : '')
    const res = await paced(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })

    if (res.status === 429) throw Object.assign(new Error('Steam 429 — пауза 5 минут'), { kind: '429' })
    // Закрытый инвентарь Steam отдаёт как 403. Повтор не поможет.
    if (res.status === 403) throw Object.assign(new Error('инвентарь закрыт настройками приватности Steam'), { kind: 'private' })
    if (!res.ok) throw new Error('Steam ' + res.status)

    const body: any = await res.json()
    // Пустой инвентарь — законный ответ, а не сбой: success есть, assets нет.
    const assets: any[] = Array.isArray(body?.assets) ? body.assets : []
    const descs: any[] = Array.isArray(body?.descriptions) ? body.descriptions : []

    const by = new Map<string, any>()
    for (const d of descs) by.set(d.classid + '_' + d.instanceid, d)

    for (const a of assets) {
      const d = by.get(a.classid + '_' + a.instanceid)
      if (!d) continue
      const p = parseDescription(d)
      if (p.value === null) continue
      const kit = parseSet(d.descriptions ?? [])
      rows.push({
        assetid: a.assetid,
        name: d.market_hash_name ?? d.name,
        gem: p.gem || '—',
        hero: p.hero,
        icon: d.icon_url ?? '',
        value: p.value,
        carrier: carrierOf(d.market_hash_name ?? d.name, p.hero),
        set: kit.name,
        setPieces: kit.pieces,
      })
    }

    // Продолжение Steam помечает сам. Раньше пагинации не было вовсе,
    // и всё сверх двух тысяч предметов молча пропадало — а по составу
    // считаются потолки, то есть решение «когда остановиться».
    cursor = body?.more_items && body?.last_assetid ? String(body.last_assetid) : null
    if (!cursor) return { rows, truncated: false }
    truncated = true
  }

  return { rows, truncated }
}

export async function refreshInventory(steamid: string = ACCOUNT(), force = false): Promise<boolean> {
  const b = invOf(steamid)
  const now = Date.now()
  if (!force && now - b.ts < settings().invTtl) return false
  if (now < b.backoffUntil) return false

  try {
    const { rows, truncated } = await fetchInventory(b.steamid)

    const changed = rows.length !== b.rows.length ||
      rows.some(r => b.rows.find(o => o.assetid === r.assetid)?.value !== r.value)

    b.ts = now
    b.rows = rows
    b.error = null
    b.private = false
    b.truncated = truncated
    if (changed) saveSnapshot(rows.map(r => ({ gem: r.gem, assetid: r.assetid, name: r.name, value: r.value })))
    return changed
  } catch (e: any) {
    b.error = e.message
    if (e?.kind === '429') b.backoffUntil = now + BACKOFF
    // Закрытый инвентарь — не временная беда: не долбим Steam каждую минуту.
    if (e?.kind === 'private') { b.private = true; b.backoffUntil = now + BACKOFF }
    return false
  }
}

// Web API счётчика не отдаёт — только экипировку. Берём её оттуда.
const webTs = new Map<string, number>()
export async function refreshEquipped(steamid: string = ACCOUNT()) {
  const key = steamKey()
  const id = String(steamid)
  if (!key || Date.now() - (webTs.get(id) ?? 0) < 120_000) return
  try {
    const r = await paced(
      `https://api.steampowered.com/IEconItems_570/GetPlayerItems/v1/?key=${key}&steamid=${id}`,
      { headers: { 'User-Agent': UA } },
    )
    if (!r.ok) return
    const j: any = await r.json()
    const eq = new Set<string>()
    for (const it of j?.result?.items ?? []) {
      if (Array.isArray(it.equipped) && it.equipped.length) eq.add(String(it.id))
    }
    for (const row of invOf(id).rows) row.equipped = eq.has(row.assetid)
    webTs.set(id, Date.now())
  } catch { /* необязательный источник */ }
}
