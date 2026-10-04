// История рынка Steam → журнал операций (план 3.3, С4).
//
// Смысл полей — из живого чтения market/myhistory?norender=1 (план 3.3,
// «Проверено вживую»), документации у Valve нет:
//   purchases   словарь «listingid_purchaseid» → сделка;
//   steamid_purchaser = мой steamid — моя покупка, иначе — моя продажа;
//   paid_amount — доля продавца, paid_fee = steam_fee + publisher_fee;
//               цена покупателя = paid_amount + paid_fee (§16);
//   у продажи paid_* — в валюте покупателя, received_amount — в моей;
//   у покупки я плачу paid_amount + paid_fee в своей валюте.
//
// В деньги:
//   продажа        net = +received_amount, валюта — моя (received_currencyid);
//                  цена покупателя и комиссии — только если валюта покупателя
//                  та же; иначе пусто (план 3.3, решение В): в валюте журнала
//                  этих чисел в источнике нет;
//   покупка ключа  gross = paid_amount + paid_fee, net = −gross.
// Всё остальное — пропуск с причиной. Валюта — номер Steam как есть
// («steam:2018»): что 2018 в этом ответе = ECurrency 18 — пока OPEN.

import type { DatabaseSync } from 'node:sqlite'
import { addOp, type NewOp } from './money.ts'
import { createLimiter } from './ratelimit.ts'

export const KEY_NAME = 'Mann Co. Supply Crate Key'
const CREATED_BY = 'импорт истории рынка Steam'

// Номер сделки — «listingid_purchaseid». Нет любой части — номера нет:
// строка «undefined_undefined» внешним номером операции не является.
const part = (v: unknown) => (v == null ? '' : String(v).trim())
export function steamExternalId(p: { listingid?: unknown; purchaseid?: unknown }): string | null {
  const l = part(p.listingid), q = part(p.purchaseid)
  return l && q ? l + '_' + q : null
}

export type SteamParsed = { ops: NewOp[]; skipped: Record<string, number> }

const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v)

export function parseSteamHistory(page: any, me: string, accountId: string): SteamParsed {
  const out: SteamParsed = { ops: [], skipped: {} }
  const skip = (why: string, n = 1) => { out.skipped[why] = (out.skipped[why] ?? 0) + n }
  if (!page?.success) { skip('не разобрано: страница без success'); return out }

  // Выставление и снятие лота — события без сделки: денег не двигают.
  const lots = (Array.isArray(page.events) ? page.events : []).filter((e: any) => e?.event_type === 1 || e?.event_type === 2).length
  if (lots) skip('выставление или снятие лота — не движение денег', lots)

  const nameOf = (a: any) => page.assets?.[a?.appid]?.[a?.contextid]?.[a?.id]?.market_hash_name as string | undefined

  for (const p of Object.values(page.purchases ?? {}) as any[]) {
    const ext = steamExternalId(p ?? {})
    if (!ext) { skip('не разобрано: нет listingid/purchaseid'); continue }
    // Кто покупатель — решает, продажа это или покупка. Нет поля — не знаем:
    // непонятное не становится «продажей».
    if (!part(p.steamid_purchaser)) { skip('не разобрано: нет steamid покупателя'); continue }
    if (p?.failed || p?.needs_rollback) { skip('сделка не прошла (failed / needs_rollback)'); continue }
    if (p?.funds_returned) { skip('деньги возвращены (funds_returned)'); continue }
    if (![p?.paid_amount, p?.paid_fee, p?.steam_fee, p?.publisher_fee, p?.received_amount].every(isInt)) { skip('не разобрано: суммы не целые'); continue }
    if (!isInt(p.time_sold)) { skip('не разобрано: time_sold'); continue }
    if (!String(p.currencyid ?? '') || !String(p.received_currencyid ?? '')) { skip('не разобрано: нет валюты'); continue }

    const mine = String(p.steamid_purchaser) === String(me)
    const name = nameOf(p.asset)
    // raw_ref — только эта сделка и без steamid покупателя: чужие данные не храним.
    const rawRef = JSON.stringify({
      side: mine ? 'покупка' : 'продажа',
      listingid: String(p.listingid), purchaseid: String(p.purchaseid), time_sold: p.time_sold,
      appid: p.asset?.appid ?? null, market_hash_name: name ?? null,
      paid_amount: p.paid_amount, paid_fee: p.paid_fee, steam_fee: p.steam_fee, publisher_fee: p.publisher_fee,
      publisher_fee_app: p.publisher_fee_app ?? null, currencyid: String(p.currencyid),
      received_amount: p.received_amount, received_currencyid: String(p.received_currencyid),
    })
    const base = { accountId, source: 'рынок Steam' as const, externalId: ext, happenedAt: p.time_sold * 1000, createdBy: CREATED_BY, rawRef }
    const paid = p.paid_amount + p.paid_fee

    if (mine) {
      if (name !== KEY_NAME) { skip('покупка не ключа — нет типа в §16'); continue }
      out.ops.push({ ...base, type: 'покупка ключа', currency: 'steam:' + p.currencyid, gross: paid, feeSteam: p.steam_fee, feeGame: p.publisher_fee, net: -paid })
      continue
    }

    const same = String(p.currencyid) === String(p.received_currencyid)
    out.ops.push({
      ...base,
      type: 'продажа вещи',
      currency: 'steam:' + p.received_currencyid,
      gross: same ? paid : null,
      feeSteam: same ? p.steam_fee : null,
      feeGame: same ? p.publisher_fee : null,
      net: p.received_amount,
    })
  }
  return out
}

// ── импорт (задача 3) ──
//
// Осторожность — наша, не известные пределы Steam (их нет в документации):
// не чаще 1 запроса в 3 секунды на аккаунт, страница — 100 записей, на 429 —
// сразу стоп без повторов и пауза аккаунту. Только по запросу человека.

export const STEAM_PAGE = 100
export const STEAM_COOL_MS = 10 * 60_000
export const MAX_PAGES = 20
export const steamLimiter = createLimiter(1 / 3)

export const steamHistoryUrl = (start: number) =>
  `https://steamcommunity.com/market/myhistory?norender=1&start=${Math.trunc(start)}&count=${STEAM_PAGE}`

type Fetcher = (url: string, init: { headers: Record<string, string>; redirect: 'manual' }) => Promise<Response>

export type SteamSyncResult = {
  pages: number
  inserted: number
  existing: number
  skipped: Record<string, number>
  stoppedBy: string
  error?: string
}

// Страницы от новых к старым — пока не встретится уже записанная сделка,
// не кончится история или лимит страниц. Повторный импорт ничего не добавляет
// (UNIQUE source + external_id). Куки — только в заголовке запроса.
export async function steamSync(db: DatabaseSync, o: {
  accountId: string
  me: string
  cookie: string
  pages?: number
  fetcher?: Fetcher
}): Promise<SteamSyncResult> {
  const res: SteamSyncResult = { pages: 0, inserted: 0, existing: 0, skipped: {}, stoppedBy: 'лимит страниц' }
  if (!o.me) return { ...res, stoppedBy: 'ошибка', error: 'нет своего steamid — продажу от покупки не отличить' }
  const limit = o.pages == null ? 3 : Math.max(1, Math.min(MAX_PAGES, Math.trunc(Number(o.pages)) || 1))
  const fetcher: Fetcher = o.fetcher ?? ((url, init) => fetch(url, init))
  const headers = { Cookie: o.cookie, 'User-Agent': 'gemtrack', Accept: 'application/json' }

  for (let i = 0; i < limit; i++) {
    const start = i * STEAM_PAGE
    const r = await steamLimiter.run(o.accountId, () => fetcher(steamHistoryUrl(start), { headers, redirect: 'manual' }))
    res.pages++
    if (r.status === 429) {
      steamLimiter.cool(o.accountId, STEAM_COOL_MS)
      return { ...res, stoppedBy: '429', error: 'Steam просит реже — импорт остановлен, повторите через ' + Math.round(STEAM_COOL_MS / 60_000) + ' мин' }
    }
    if (r.status !== 200) return { ...res, stoppedBy: 'ошибка', error: 'Steam ответил HTTP ' + r.status }
    let page: any
    try { page = JSON.parse(await r.text()) } catch {
      return { ...res, stoppedBy: 'ошибка', error: 'ответ не JSON — возможно, Steam не принял веб-сессию' }
    }
    if (!page?.success) return { ...res, stoppedBy: 'ошибка', error: 'Steam ответил без success' }

    const p = parseSteamHistory(page, o.me, o.accountId)
    for (const [why, n] of Object.entries(p.skipped)) res.skipped[why] = (res.skipped[why] ?? 0) + n
    let known = 0
    for (const op of p.ops) {
      const w = addOp(db, op)
      if ('error' in w) { res.skipped['не записано: ' + w.error] = (res.skipped['не записано: ' + w.error] ?? 0) + 1; continue }
      if (w.inserted) res.inserted++
      else { res.existing++; known++ }
    }
    if (known) return { ...res, stoppedBy: 'дошли до записанного' }
    const events = Array.isArray(page.events) ? page.events.length : 0
    if (events < STEAM_PAGE || start + STEAM_PAGE >= Number(page.total_count ?? 0)) return { ...res, stoppedBy: 'конец истории' }
  }
  return res
}
