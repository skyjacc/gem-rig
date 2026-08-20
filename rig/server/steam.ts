// Steam: инвентарь со счётчиками и Web API с тем, что реально надето.
// Оба источника ходят через одну очередь — не чаще одного запроса в 2.5 секунды,
// иначе Steam отвечает 429 и уходит в отказ на несколько минут.

import { STEAMID, steamKey } from './paths.ts'
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

const TTL = 60_000
const BACKOFF = 300_000

export const inv = {
  ts: 0,
  rows: [] as GemItem[],
  error: null as string | null,
  backoffUntil: 0,
}

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

export async function refreshInventory(force = false): Promise<boolean> {
  const now = Date.now()
  if (!force && now - inv.ts < TTL) return false
  if (now < inv.backoffUntil) return false

  try {
    const res = await paced(
      `https://steamcommunity.com/inventory/${STEAMID}/570/2?l=english&count=2000`,
      { headers: { 'User-Agent': 'rig', Accept: 'application/json' } },
    )
    if (res.status === 429) {
      inv.backoffUntil = now + BACKOFF
      throw new Error('Steam 429 — пауза 5 минут')
    }
    if (!res.ok) throw new Error('Steam ' + res.status)

    const body: any = await res.json()
    const by = new Map<string, any>()
    for (const d of body.descriptions) by.set(d.classid + '_' + d.instanceid, d)

    const rows: GemItem[] = []
    for (const a of body.assets) {
      const d = by.get(a.classid + '_' + a.instanceid)
      if (!d) continue
      const p = parseDescription(d)
      if (p.value === null) continue
      rows.push({
        assetid: a.assetid,
        name: d.market_hash_name ?? d.name,
        gem: p.gem || '—',
        hero: p.hero,
        icon: d.icon_url ?? '',
        value: p.value,
        carrier: carrierOf(d.market_hash_name ?? d.name, p.hero),
      })
    }

    const changed = rows.length !== inv.rows.length ||
      rows.some(r => inv.rows.find(o => o.assetid === r.assetid)?.value !== r.value)

    inv.ts = now
    inv.rows = rows
    inv.error = null
    if (changed) saveSnapshot(rows.map(r => ({ gem: r.gem, assetid: r.assetid, name: r.name, value: r.value })))
    return changed
  } catch (e: any) {
    inv.error = e.message
    return false
  }
}

// Web API счётчика не отдаёт — только экипировку. Берём её оттуда.
let webTs = 0
export async function refreshEquipped() {
  const key = steamKey()
  if (!key || Date.now() - webTs < 120_000) return
  try {
    const r = await paced(
      `https://api.steampowered.com/IEconItems_570/GetPlayerItems/v1/?key=${key}&steamid=${STEAMID}`,
      { headers: { 'User-Agent': 'rig' } },
    )
    if (!r.ok) return
    const j: any = await r.json()
    const eq = new Set<string>()
    for (const it of j?.result?.items ?? []) {
      if (Array.isArray(it.equipped) && it.equipped.length) eq.add(String(it.id))
    }
    for (const row of inv.rows) row.equipped = eq.has(row.assetid)
    webTs = Date.now()
  } catch { /* необязательный источник */ }
}
