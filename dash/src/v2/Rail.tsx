// Рейка (§4.2): гем-логотип, капсула из шести экранов, отдельной капсулой
// внизу — «Общие правила». Ниже 768 px (§4.4) рейка уходит, а экраны
// переезжают строкой под верхнюю полосу — так же, как TopNav в старой панели.

import { Gem, Network, Package, ScrollText, ShieldCheck, ShoppingCart, SlidersHorizontal, Users, Wallet } from 'lucide-react'
import type { ReactNode } from 'react'
import { IconBtn } from './ui.tsx'

export type ScreenId = 'overview' | 'inventory' | 'buy' | 'sales' | 'accounts' | 'journal' | 'users'

export const SCREENS: { id: ScreenId; label: string; icon: ReactNode }[] = [
  { id: 'overview', label: 'Обзор', icon: <Network size={16} strokeWidth={1.75} /> },
  { id: 'inventory', label: 'Инвентарь', icon: <Package size={16} strokeWidth={1.75} /> },
  { id: 'buy', label: 'Скупка', icon: <ShoppingCart size={16} strokeWidth={1.75} /> },
  { id: 'sales', label: 'Продажи', icon: <Wallet size={16} strokeWidth={1.75} /> },
  { id: 'accounts', label: 'Аккаунты', icon: <Users size={16} strokeWidth={1.75} /> },
  { id: 'journal', label: 'Журнал', icon: <ScrollText size={16} strokeWidth={1.75} /> },
]

// Только владельцу (план 7.3, макет 8): иконка щита — отдельно, внизу рейки.
export const USERS_SCREEN = { id: 'users' as ScreenId, label: 'Пользователи', icon: <ShieldCheck size={16} strokeWidth={1.75} /> }
export const screenLabel = (id: ScreenId) => (id === 'users' ? USERS_SCREEN.label : SCREENS.find(s => s.id === id)!.label)

export function Rail({ screen, onScreen, onRules, owner = false }: {
  screen: ScreenId
  onScreen: (s: ScreenId) => void
  onRules: () => void
  owner?: boolean
}) {
  return (
    <nav className="v2-rail" aria-label="Экраны">
      <span className="v2-logo" aria-hidden="true"><Gem size={20} strokeWidth={1.6} /></span>
      <div className="v2-rail-grp">
        {SCREENS.map(s => (
          <IconBtn key={s.id} label={s.label} tip="right" current={s.id === screen} onClick={() => onScreen(s.id)}>
            {s.icon}
          </IconBtn>
        ))}
      </div>
      <span className="v2-rail-sp" />
      <div className="v2-rail-grp">
        {owner ? (
          <IconBtn label={USERS_SCREEN.label} tip="right" current={screen === 'users'} onClick={() => onScreen('users')}>
            {USERS_SCREEN.icon}
          </IconBtn>
        ) : null}
        <IconBtn label="Общие правила" tip="right" onClick={onRules}>
          <SlidersHorizontal size={16} strokeWidth={1.75} />
        </IconBtn>
      </div>
    </nav>
  )
}

// Узкий экран: те же экраны строкой, с подписями — места под всплывающие
// подсказки там нет, а иконка без слова непонятна.
export function RailRow({ screen, onScreen, owner = false }: { screen: ScreenId; onScreen: (s: ScreenId) => void; owner?: boolean }) {
  return (
    <nav className="v2-railrow" aria-label="Экраны">
      {(owner ? [...SCREENS, USERS_SCREEN] : SCREENS).map(s => (
        <button
          key={s.id}
          type="button"
          className="v2-railrow-it"
          aria-current={s.id === screen ? 'page' : undefined}
          onClick={() => onScreen(s.id)}
        >
          {s.icon}
          <span>{s.label}</span>
        </button>
      ))}
    </nav>
  )
}
