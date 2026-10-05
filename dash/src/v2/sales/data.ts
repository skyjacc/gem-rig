// Откуда экран «Продажи» берёт данные (план 2.6, решение 1).
//
//   журнал операций  GET /api/money?id=<активный>&limit=5000 (сервер — не больше 5 000)
//   ключи TF2        GET /api/keys?id=<активный> (последний снимок, план 3.4)
//   выплаты Clover   GET /api/money/payouts?id=<активный> — все, без предела
//                    общего журнала (план 3.2, решение 11)
// Запросы — только пока экран открыт. В показе (VITE_DEMO) денег и ключей в
// снимке нет — они из demo/sales.json, составленного руками (решение 8).

import fixture from '../../demo/sales.json'
import { DEMO, useJson, type Accounts, type State } from '../../lib/api.ts'
import type { KeysResp, Op, PayoutList } from './model.ts'

const FIX: any = fixture

export const LIMIT = 5_000

export function useSales(state: State | null, on: boolean, accounts: Accounts | null) {
  const id = accounts?.active ?? null
  const ts = state?.ts
  const money = useJson<Op[]>(on && !DEMO && id ? '/api/money?id=' + encodeURIComponent(id) + '&limit=' + LIMIT : null, ts)
  const keys = useJson<KeysResp>(on && !DEMO && id ? '/api/keys?id=' + encodeURIComponent(id) : null, ts)
  const payouts = useJson<PayoutList>(on && !DEMO && id ? '/api/money/payouts?id=' + encodeURIComponent(id) : null, ts)
  const canned = <T,>(d: T) => ({ data: d, loading: false, error: null as string | null, reload: () => { } })
  return {
    account: id,
    accounts: (accounts?.list ?? []).map(a => ({ id: a.id, label: a.label })),
    money: DEMO ? canned(FIX.money as Op[]) : money,
    keys: DEMO ? canned(FIX.keys as KeysResp) : keys,
    payouts: DEMO ? canned(FIX.payouts as PayoutList) : payouts,
  }
}

export type SalesData = ReturnType<typeof useSales>
