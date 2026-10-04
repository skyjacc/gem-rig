// Верхняя полоса (§4.2): переключатель аккаунта, KPI-пилюли экрана,
// справа — плашки состояния и колокольчик.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { post, type Accounts, type State } from '../lib/api.ts'
import { accountTone } from '../parts/Sidebar.tsx'
import { Dot, Pill } from './ui.tsx'

export function TopBar({ state, accounts, kpi, status, bell }: {
  state: State
  accounts: Accounts | null
  kpi?: ReactNode       // пилюли своего экрана; на этапе 1 экраны их не дают
  status?: ReactNode    // плашки «показ — снимок», «данные устарели»
  bell?: ReactNode
}) {
  return (
    <header className="v2-top">
      <AccountSwitch state={state} accounts={accounts} />
      <div className="v2-top-kpi">{kpi}</div>
      <div className="v2-top-right">
        {status}
        {bell}
      </div>
    </header>
  )
}

// Переключение меняет то, чей журнал расхода считается, — как в старой
// панели. Список закрывается по Esc и кликом мимо, фокус возвращается.
function AccountSwitch({ state, accounts }: { state: State; accounts: Accounts | null }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const list = accounts?.list ?? []
  const units = state.autopilot.units ?? []
  const cur = list.find(a => a.id === accounts?.active) ?? list[0]

  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus() } }
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('keydown', key)
    document.addEventListener('mousedown', away)
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('mousedown', away) }
  }, [open])

  if (!cur) return <Pill>аккаунтов нет</Pill>
  const tone = accountTone(units.find(u => u.id === cur.id), cur.session)

  return (
    <div className="v2-acc" ref={box}>
      <button
        ref={btn}
        type="button"
        className="v2-pill v2-acc-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className="v2-ava" aria-hidden="true">{cur.label.slice(0, 1).toUpperCase()}</span>
        <b className="v2-acc-name">{cur.label}</b>
        <Dot tone={tone} />
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <ul className="v2-menu" role="listbox" aria-label="Аккаунт">
          {list.map(a => {
            const on = a.id === cur.id
            return (
              <li key={a.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  className="v2-menu-it"
                  onClick={() => { setOpen(false); btn.current?.focus(); if (!on) void post('/api/accounts/active', { id: a.id }) }}
                >
                  <span className="v2-ava" aria-hidden="true">{a.label.slice(0, 1).toUpperCase()}</span>
                  <span className="v2-menu-name">{a.label}</span>
                  <Dot tone={accountTone(units.find(u => u.id === a.id), a.session)} />
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
