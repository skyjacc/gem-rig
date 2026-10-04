// Откуда экран Аккаунтов берёт данные. В показе (VITE_DEMO) у аккаунта в
// снимке нет ни сессий, ни ключа — список и второй работник берутся из
// demo/accounts.json, составленного руками (план 2.4, решение 6).

import fixture from '../../demo/accounts.json'
import { DEMO, type Accounts, type State, type Unit } from '../../lib/api.ts'

const FIX: any = fixture

// Аккаунты экрана: в показе — из файла показа, иначе — с сервера.
export const accountsOf = (a: Accounts | null): Accounts | null => DEMO ? FIX.accounts : a

// Работник аккаунта. У активного инвентарь лежит ещё и в state.inv —
// берём его, если в работнике снимка нет.
export function unitOf(state: State, accs: Accounts | null, id: string | null): Unit | undefined {
  const all: Unit[] = DEMO ? [...state.autopilot.units, ...FIX.units] : state.autopilot.units
  const u = all.find(x => x.id === id)
  if (u && !u.inv && accs?.active === id) return { ...u, inv: state.inv }
  return u
}
