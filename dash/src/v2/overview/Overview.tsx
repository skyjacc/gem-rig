// Экран «Обзор» (§5.1): ежедневный экран — работает ли, что с гемами,
// что требует внимания. Холст в странице; инспектор выбранного гема —
// в правой колонке (задача 3). Режим «сеть матчей» — задача 4.

import type { Accounts, State } from '../../lib/api.ts'
import { Canvas } from './Canvas.tsx'

export function Overview({ state, accounts, goal, sel, onSel }: {
  state: State
  accounts: Accounts | null
  goal: number | null
  sel: string | null
  onSel: (gem: string) => void
}) {
  return (
    <div className="v2-ov">
      <header className="v2-ov-head">
        <div>
          <h1 className="v2-h1">Обзор</h1>
          <p className="v2-hint">аккаунт → гемы → вещи · выбор гема открывает его справа</p>
        </div>
      </header>
      <Canvas state={state} accounts={accounts} goal={goal} sel={sel} onSel={onSel} />
    </div>
  )
}
