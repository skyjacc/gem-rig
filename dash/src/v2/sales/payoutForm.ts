// Черновик формы выплаты и что с ним делать после ответа сервера (план 3.2).
// Только чистые функции — без React: проверяются тестами в Node
// (rig/server/payoutform.test.ts), в том числе с задержанным ответом.

import type { PayoutRow } from './model.ts'

export type Draft = {
  tx: string; asset: string; assetAmount: string; network: string; usd: string; at: string; keys: string; note: string
}

// datetime-local — местное время без пояса: «2026-10-05T14:30».
const local = (ts: number) => {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}

export const emptyDraft = (now = Date.now()): Draft =>
  ({ tx: '', asset: '', assetAmount: '', network: '', usd: '', at: local(now), keys: '', note: '' })

export const draftOf = (r: PayoutRow): Draft => ({
  tx: r.tx, asset: r.asset, assetAmount: r.assetAmount ?? '', network: r.network ?? '',
  usd: (r.op.net / 100).toFixed(2), at: local(r.op.happened_at), keys: r.keys == null ? '' : String(r.keys), note: r.note ?? '',
})

export const bodyOf = (d: Draft, accountId: string) => ({
  accountId,
  tx: d.tx,
  asset: d.asset,
  assetAmount: d.assetAmount,
  network: d.network,
  usd: d.usd,
  happenedAt: d.at ? new Date(d.at).getTime() : undefined,
  keys: d.keys,
  note: d.note,
})

export const short = (tx: string) => (tx.length > 18 ? tx.slice(0, 10) + '…' + tx.slice(-6) : tx)

const same = (a: Draft, b: Draft, accA: string, accB: string) =>
  accA === accB && (Object.keys(a) as (keyof Draft)[]).every(k => a[k] === b[k])

// После ответа (ревью PR #31): очистить черновик или закрыть окно можно,
// только если с момента нажатия ничего не меняли. Поля на время запроса
// заблокированы — это вторая защита: что бы ни поменялось, пока ждали
// ответа, сервер этого не получал, и оно не пропадает.
//
//   sent / sentAcc — черновик и аккаунт на момент нажатия;
//   now / nowAcc   — какими они стали к приходу ответа;
//   fresh          — пустой черновик для следующей выплаты.
export function afterSend(
  mode: 'new' | 'fix', r: any, sent: Draft, sentAcc: string, now: Draft, nowAcc: string, fresh: Draft,
): { draft: Draft; note: string | null; close: boolean } {
  if (!r || r.error) return { draft: now, note: null, close: false }
  const dup = r.inserted === false
  if (!same(sent, now, sentAcc, nowAcc)) {
    return {
      draft: now,
      note: (dup ? (mode === 'fix' ? 'Это исправление уже было внесено' : 'Эта выплата уже была внесена') : 'Внесено')
        + ' — в том виде, как было на момент нажатия. Правки после нажатия не отправлены.',
      close: false,
    }
  }
  if (mode === 'fix') {
    return dup ? { draft: now, note: 'Это исправление уже внесено — новой записи нет.', close: false } : { draft: now, note: null, close: true }
  }
  return { draft: dup ? now : fresh, note: dup ? 'Эта выплата уже внесена — новой записи нет.' : 'Внесено.', close: false }
}
