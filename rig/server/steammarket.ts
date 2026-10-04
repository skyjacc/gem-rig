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

import type { NewOp } from './money.ts'

export const KEY_NAME = 'Mann Co. Supply Crate Key'
const CREATED_BY = 'импорт истории рынка Steam'

export const steamExternalId = (p: { listingid: unknown; purchaseid: unknown }) => String(p.listingid) + '_' + String(p.purchaseid)

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
    const base = { accountId, source: 'рынок Steam' as const, externalId: steamExternalId(p), happenedAt: p.time_sold * 1000, createdBy: CREATED_BY, rawRef }
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
