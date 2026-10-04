// История операций market.dota2.net → журнал операций (план 3.1).
//
// Смысл полей взят из живого чтения, не из docs-v2 (план 3.1, «Проверено
// вживую»): у buy нет price/received — сумма лежит в paid, строкой с целым
// в мелких единицах; id у buy нет; событий refund вживую не было.
//
// В деньги идёт только завершённая покупка самоцвета (stage 2). Всё
// остальное — в пропущенные с причиной, деньги не трогает:
//   stage 5   сделка отменена; возврат денег API не подтверждает
//             (вариант (а), решение сверки) — такие покупки отдаются
//             отдельным списком для сверки;
//   stage 1   не завершена — подберёт следующий импорт, запись потом
//             не придётся менять;
//   refund, sell, checkin, checkout, не-самоцветы, непонятные строки.

import type { DatabaseSync } from 'node:sqlite'
import { operationHistory } from './market.ts'
import { addOp, type NewOp } from './money.ts'

const DAY = 86_400

// Окно не длиннее 7 суток — наше ограничение импорта, не факт площадки:
// пределы периода и постраничность operation-history в docs-v2 не описаны.
export const WINDOW_DAYS = 7

// Повторы окна с ошибкой: живое чтение один раз получило ошибку окна
// с пустым текстом. Через тот же ограничитель — call() в market.ts.
export const RETRIES = 2

// Период [from, to] в unix-секундах → окна подряд, без дыр и наложений:
// каждое следующее начинается там, где кончилось предыдущее.
export function windows(from: number, to: number, days = WINDOW_DAYS): { from: number; to: number }[] {
  const a = Math.trunc(from)
  const b = Math.trunc(to)
  if (!(b > a) || !(days > 0)) return []
  const step = Math.trunc(days * DAY)
  const out: { from: number; to: number }[] = []
  for (let s = a; s < b; s += step) out.push({ from: s, to: Math.min(s + step, b) })
  return out
}

const str = (v: unknown) => (v == null ? '' : String(v))
const GEM = /^(Genuine\s+)?Spectator:\s*/

// Внешний номер покупки. Заменяемая функция: схема знает только
// UNIQUE(source, external_id). custom_id площадка не даёт повторить, а наш
// робот шлёт его в каждой покупке; без него — item_id и время (защита от
// повторной покупки того же лота).
export function externalId(row: Record<string, unknown>): string | null {
  const cid = str(row.custom_id)
  if (cid) return 'buy:cid:' + cid
  const item = str(row.item_id)
  if (!item) return null
  return 'buy:item:' + item + ':' + str(row.time)
}

export type Cancelled = { customId: string | null; itemId: string; time: number }

export type Parsed = {
  ops: NewOp[]
  skipped: Record<string, number>
  cancelled: Cancelled[]
}

const NO_TYPE = new Set(['sell', 'checkin', 'checkout'])

export function parseHistory(rows: unknown[], accountId: string): Parsed {
  const out: Parsed = { ops: [], skipped: {}, cancelled: [] }
  const skip = (why: string) => { out.skipped[why] = (out.skipped[why] ?? 0) + 1 }

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { skip('не разобрано: строка не объект'); continue }
    const r = raw as Record<string, unknown>
    const event = str(r.event)

    if (event === 'refund') { skip('возврат: вживую не наблюдался, форма не проверена'); continue }
    if (NO_TYPE.has(event)) { skip('нет денежного типа в §16: ' + event); continue }
    if (event !== 'buy') { skip('не разобрано: событие ' + (event || '—')); continue }

    if (!GEM.test(str(r.market_hash_name))) { skip('не самоцвет'); continue }
    if (!/^\d+$/.test(str(r.time))) { skip('не разобрано: time'); continue }
    const time = Number(str(r.time)) * 1000

    const stage = str(r.stage)
    if (stage === '5') {
      out.cancelled.push({ customId: str(r.custom_id) || null, itemId: str(r.item_id), time })
      skip('сделка отменена (stage 5): возврат денег по API не подтверждён')
      continue
    }
    if (stage === '' || stage === '1') { skip('не завершена (stage 1 или нет stage) — подберёт следующий импорт'); continue }
    if (stage !== '2') { skip('не разобрано: stage ' + stage); continue }

    const paid = str(r.paid)
    if (!/^\d+$/.test(paid)) { skip('не разобрано: paid не целое в мелких единицах'); continue }
    const currency = str(r.currency)
    if (!currency) { skip('не разобрано: нет валюты'); continue }
    const ext = externalId(r)
    if (!ext) { skip('не разобрано: нет custom_id и item_id'); continue }

    out.ops.push({
      accountId,
      type: 'покупка гема',
      source: 'market.dota2.net',
      externalId: ext,
      happenedAt: time,
      currency,
      gross: Number(paid),
      net: -Number(paid),
      status: 'передан',
      rawRef: JSON.stringify(r),
      createdBy: 'импорт истории площадки',
    })
  }
  return out
}

export type SyncResult = {
  windows: number
  rows: number
  inserted: number
  existing: number
  failed: { from: number; to: number; error: string }[]
  skipped: Record<string, number>
  cancelled: Cancelled[]
}

type Read = (key: string, from: number, to: number) => Promise<any>

// Импорт истории аккаунта за период (unix-секунды). Окно с ошибкой
// повторяется до RETRIES раз; не вышло — оно в failed, а вставленное из
// других окон остаётся. Запроса «на весь период разом» нет: вживую он не
// ответил.
export async function syncHistory(db: DatabaseSync, o: {
  accountId: string
  key: string
  from: number
  to: number
  read?: Read
  retries?: number
}): Promise<SyncResult> {
  const read = o.read ?? operationHistory
  const tries = 1 + Math.max(0, o.retries ?? RETRIES)
  const res: SyncResult = { windows: 0, rows: 0, inserted: 0, existing: 0, failed: [], skipped: {}, cancelled: [] }

  for (const w of windows(o.from, o.to)) {
    res.windows++
    let got: any = null
    let error = ''
    for (let i = 0; i < tries; i++) {
      const r = await read(o.key, w.from, w.to)
      if (r?.success && Array.isArray(r.data)) { got = r; break }
      error = str(r?.error) || 'площадка не ответила (ошибка без текста)'
    }
    if (!got) { res.failed.push({ ...w, error }); continue }

    res.rows += got.data.length
    const p = parseHistory(got.data, o.accountId)
    for (const [why, n] of Object.entries(p.skipped)) res.skipped[why] = (res.skipped[why] ?? 0) + n
    res.cancelled.push(...p.cancelled)
    for (const op of p.ops) {
      const r = addOp(db, op)
      if ('error' in r) { res.skipped['не записано: ' + r.error] = (res.skipped['не записано: ' + r.error] ?? 0) + 1; continue }
      if (r.inserted) res.inserted++
      else res.existing++
    }
  }
  return res
}
