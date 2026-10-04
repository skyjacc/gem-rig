// Ключи TF2: на руках, на удержании, когда можно передать (план 3.4, С5).
//
// Из живого чтения инвентаря TF2 (план 3.4, «Проверено вживую»):
//   - время пишется в descriptions[].value описания предмета строкой
//     «\nTradable After: Tuesday, October 6, 2026 (7:00:00) GMT»;
//     owner_descriptions в ответе нет;
//   - у ключей всё, что нужно (tradable и строка времени), одинаково под
//     куками владельца и без кук — читаем без кук, как инвентарь Dota.
//
// Это состояние, не деньги: в money_ops ничего не пишется. Каждое чтение —
// новый снимок; «текущий» — с наибольшим id. Неполный инвентарь (есть
// продолжение, а страницы кончились, или ошибка) не сохраняется вовсе.

import type { DatabaseSync } from 'node:sqlite'
import { steamLimiter, STEAM_COOL_MS } from './steammarket.ts'

export const KEY_NAME = 'Mann Co. Supply Crate Key'
const DAY = 86_400_000

// ── строка времени ──

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const RE = new RegExp(`^Tradable After: (${DAYS.join('|')}), (${MONTHS.join('|')}) (\\d{1,2}), (\\d{4}) \\((\\d{1,2}):(\\d{2}):(\\d{2})\\) GMT$`)

// Строго в наблюдённом формате (l=english). Не тот формат, несуществующая
// дата или день недели не сходится с датой — null: время не угадываем.
export function parseTradableAfter(s: string | null | undefined): number | null {
  const m = RE.exec(String(s ?? '').trim())
  if (!m) return null
  const [, day, month, d, y, h, mi, se] = m
  const mo = MONTHS.indexOf(month)
  const t = Date.UTC(Number(y), mo, Number(d), Number(h), Number(mi), Number(se))
  const dt = new Date(t)
  if (dt.getUTCMonth() !== mo || dt.getUTCDate() !== Number(d) || dt.getUTCHours() !== Number(h)) return null
  if (DAYS[dt.getUTCDay()] !== day) return null
  return t
}

// ── страница инвентаря ──

export type Key = { assetid: string; tradable: 0 | 1; tradableAfter: number | null; tradableAfterRaw: string | null }

export type Page = { keys: Key[]; others: number; more: boolean; last: string | null; total: number | null }

export function parseInventoryPage(page: any): Page | { error: string } {
  if (!page?.success) return { error: 'страница инвентаря без success' }
  const descs = new Map<string, any>()
  for (const d of Array.isArray(page.descriptions) ? page.descriptions : []) descs.set(d.classid + '_' + d.instanceid, d)
  const out: Page = {
    keys: [], others: 0, more: !!page.more_items,
    last: page.last_assetid != null ? String(page.last_assetid) : null,
    total: Number.isFinite(Number(page.total_inventory_count)) ? Number(page.total_inventory_count) : null,
  }
  for (const a of Array.isArray(page.assets) ? page.assets : []) {
    const d = descs.get(a.classid + '_' + a.instanceid)
    if (d?.market_hash_name !== KEY_NAME) { out.others++; continue }
    const line = (Array.isArray(d.descriptions) ? d.descriptions : [])
      .map((x: any) => String(x?.value ?? '').trim())
      .find((v: string) => v.startsWith('Tradable After:')) ?? null
    out.keys.push({ assetid: String(a.assetid), tradable: d.tradable === 1 ? 1 : 0, tradableAfter: parseTradableAfter(line), tradableAfterRaw: line })
  }
  return out
}

// ── состояние и итог ──

export type KeyState = 'можно передать' | 'на удержании' | 'на удержании, время неизвестно' | 'расходится'

// Два признака Steam; противоречие видно, молча не выбирается (§3.3).
export function keyState(k: Pick<Key, 'tradable' | 'tradableAfter'>, now = Date.now()): KeyState {
  const t = k.tradableAfter
  if (k.tradable === 1) return t != null && t > now ? 'расходится' : 'можно передать'
  if (t == null) return 'на удержании, время неизвестно'
  return t > now ? 'на удержании' : 'расходится'
}

export type Summary = {
  onHand: number
  tradableNow: number
  held: number            // включая «время неизвестно»
  unknownTime: number
  conflict: number
  releases: { at: number; keys: number }[]   // по одинаковому времени (§5.4), по возрастанию
  nextRelease: { at: number; keys: number } | null
}

export function summarize(keys: Pick<Key, 'tradable' | 'tradableAfter'>[], now = Date.now()): Summary {
  const s: Summary = { onHand: keys.length, tradableNow: 0, held: 0, unknownTime: 0, conflict: 0, releases: [], nextRelease: null }
  const at = new Map<number, number>()
  for (const k of keys) {
    const st = keyState(k, now)
    if (st === 'можно передать') s.tradableNow++
    else if (st === 'расходится') s.conflict++
    else {
      s.held++
      if (st === 'на удержании, время неизвестно') s.unknownTime++
      else at.set(k.tradableAfter!, (at.get(k.tradableAfter!) ?? 0) + 1)
    }
  }
  s.releases = [...at].sort((a, b) => a[0] - b[0]).map(([t, n]) => ({ at: t, keys: n }))
  s.nextRelease = s.releases[0] ?? null
  return s
}

// Когда точного времени нет: «покупка + 7 суток» — оценка (§5.4), в снимок
// не пишется; применяет её экран Продаж (2.6) с меткой.
export const estimateRelease = (purchasedAt: number) => ({ at: purchasedAt + 7 * DAY, label: 'оценка' as const })

// ── снимок ──

const frozen = (t: string) => `
  create trigger if not exists ${t}_no_update before update on ${t}
  begin select raise(abort, '${t}: запись не меняется'); end;
  create trigger if not exists ${t}_no_delete before delete on ${t}
  begin select raise(abort, '${t}: удаление запрещено'); end;
`

export const TF2_DDL = `
  create table if not exists tf2_snapshots (
    id         integer primary key autoincrement,
    account_id text not null,
    seen_at    integer not null,
    keys       integer not null
  );
  ${frozen('tf2_snapshots')}
  create table if not exists tf2_keys (
    snapshot_id        integer not null references tf2_snapshots(id),
    assetid            text not null check (assetid <> ''),
    tradable           integer not null check (tradable in (0, 1)),
    tradable_after     integer,
    tradable_after_raw text,
    unique (snapshot_id, assetid)
  );
  ${frozen('tf2_keys')}
`

export function saveSnapshot(db: DatabaseSync, accountId: string, seenAt: number, keys: Key[]): number {
  db.exec('begin immediate')
  try {
    const id = Number(db.prepare('insert into tf2_snapshots (account_id, seen_at, keys) values (?,?,?)').run(accountId, seenAt, keys.length).lastInsertRowid)
    const ins = db.prepare('insert into tf2_keys (snapshot_id, assetid, tradable, tradable_after, tradable_after_raw) values (?,?,?,?,?)')
    for (const k of keys) ins.run(id, k.assetid, k.tradable, k.tradableAfter, k.tradableAfterRaw)
    db.exec('commit')
    return id
  } catch (e) {
    db.exec('rollback')
    throw e
  }
}

export function lastSnapshot(db: DatabaseSync, accountId: string): { id: number; seenAt: number; keys: Key[] } | null {
  const s = db.prepare('select id, seen_at from tf2_snapshots where account_id = ? order by id desc limit 1').get(accountId) as any
  if (!s) return null
  const keys = (db.prepare('select assetid, tradable, tradable_after, tradable_after_raw from tf2_keys where snapshot_id = ?').all(s.id) as any[])
    .map(r => ({ assetid: r.assetid, tradable: r.tradable, tradableAfter: r.tradable_after, tradableAfterRaw: r.tradable_after_raw }))
  return { id: s.id, seenAt: s.seen_at, keys }
}

// ── чтение ──

export const inventoryUrl = (steamid: string, start?: string | null) =>
  `https://steamcommunity.com/inventory/${steamid}/440/2?l=english&count=2000` + (start ? '&start_assetid=' + encodeURIComponent(start) : '')

type Fetcher = (url: string, init: { headers: Record<string, string>; redirect: 'manual' }) => Promise<Response>

// Инвентарь целиком, страницами; только полный — в снимок. Без кук: время
// ключей видно и так (живое чтение), сессию не тратим.
export async function syncKeys(db: DatabaseSync, o: {
  accountId: string
  steamid: string
  fetcher?: Fetcher
  maxPages?: number
  now?: number
}): Promise<{ snapshotId: number; summary: Summary; pages: number } | { error: string; pages: number }> {
  if (!o.steamid) return { error: 'нет steamid аккаунта', pages: 0 }
  const fetcher: Fetcher = o.fetcher ?? ((u, i) => fetch(u, i))
  const max = Math.max(1, Math.min(5, Math.trunc(o.maxPages ?? 5)))
  const keys: Key[] = []
  let start: string | null = null
  for (let p = 0; p < max; p++) {
    const r = await steamLimiter.run(o.accountId, () => fetcher(inventoryUrl(o.steamid, start), { headers: { 'User-Agent': 'gemtrack', Accept: 'application/json' }, redirect: 'manual' }))
    if (r.status === 429) {
      steamLimiter.cool(o.accountId, STEAM_COOL_MS)
      return { error: 'Steam просит реже (429) — снимок не сохранён', pages: p + 1 }
    }
    if (r.status !== 200) return { error: 'снимок неполный: Steam ответил HTTP ' + r.status, pages: p + 1 }
    let body: any
    try { body = JSON.parse(await r.text()) } catch { return { error: 'снимок неполный: ответ не JSON', pages: p + 1 } }
    const page = parseInventoryPage(body)
    if ('error' in page) return { error: 'снимок неполный: ' + page.error, pages: p + 1 }
    keys.push(...page.keys)
    if (!page.more) {
      const now = o.now ?? Date.now()
      const snapshotId = saveSnapshot(db, o.accountId, now, keys)
      return { snapshotId, summary: summarize(keys, now), pages: p + 1 }
    }
    if (!page.last) return { error: 'снимок неполный: продолжение есть, а с чего продолжать — нет', pages: p + 1 }
    start = page.last
  }
  return { error: 'снимок неполный: инвентарь длиннее ' + max + ' страниц', pages: max }
}
