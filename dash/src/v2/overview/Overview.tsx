// Экран «Обзор» (§5.1): ежедневный экран — работает ли, что с гемами,
// что требует внимания. Холст в странице, два режима: «дерево» (аккаунт →
// гемы → вещи) и «сеть матчей» (общие матчи между командами). Инспектор
// выбранного гема — в правой колонке. Режим «список» — этап 8.

import { useState } from 'react'
import type { Accounts, State } from '../../lib/api.ts'
import { Canvas } from './Canvas.tsx'
import { Network } from './Network.tsx'

export function Overview({ state, accounts, goal, sel, onSel }: {
  state: State
  accounts: Accounts | null
  goal: number | null
  sel: string | null
  onSel: (gem: string) => void
}) {
  const [mode, setMode] = useState<'tree' | 'net'>('tree')
  return (
    <div className="v2-ov">
      <header className="v2-ov-head">
        <div>
          <h1 className="v2-h1">Обзор</h1>
          <p className="v2-hint">
            {mode === 'tree' ? 'аккаунт → гемы → вещи · выбор гема открывает его справа' : 'команды и игроки · толщина связи — общие матчи: одна отправка, счётчик обоим'}
          </p>
        </div>
        <div className="v2-seg" role="group" aria-label="Режим холста">
          <button type="button" aria-pressed={mode === 'tree'} onClick={() => setMode('tree')}>дерево</button>
          <button type="button" aria-pressed={mode === 'net'} onClick={() => setMode('net')}>сеть матчей</button>
        </div>
      </header>
      {mode === 'tree'
        ? <Canvas state={state} accounts={accounts} goal={goal} sel={sel} onSel={onSel} />
        : <Network state={state} goal={goal} />}
    </div>
  )
}
