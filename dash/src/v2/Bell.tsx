// Колокольчик тревог (§5.7): то же, что «Требует внимания» в старом Пульте,
// но с любого экрана. Список и порядок — alertList() (alerts.ts): работа
// стоит → «не дойдёт» → справочные; тот же список — под инспектором Обзора.
//
// В колокольчике — текст и «что делать», без кнопок: действия живут там,
// где виден их предмет, — у тревог под инспектором Обзора.

import { useEffect, useRef, useState } from 'react'
import { Bell as BellIcon } from 'lucide-react'
import { nf, plural, type Live, type State } from '../lib/api.ts'
import { alertList } from './alerts.ts'
import { Chip, IconBtn } from './ui.tsx'

export function Bell({ state, live, now, goal }: {
  state: State
  live: Live
  now: number
  goal: number | null
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  const sorted = alertList(state, live, now, goal)
  const bad = sorted.filter(a => a.level === 'stop').length

  useEffect(() => {
    if (!open) return
    const btn = () => box.current?.querySelector<HTMLButtonElement>('.v2-ibtn')
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn()?.focus() } }
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('keydown', key)
    document.addEventListener('mousedown', away)
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('mousedown', away) }
  }, [open])

  return (
    <div className="v2-bell" ref={box}>
      <IconBtn
        label={sorted.length ? 'Тревоги: ' + sorted.length : 'Тревог нет'}
        boxed
        tip="bottom-end"
        badge={sorted.length || undefined}
        badgeTone={bad ? 'stop' : 'warn'}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(o => !o)}
      >
        <BellIcon size={15} strokeWidth={1.8} />
      </IconBtn>
      {open ? (
        <div className="v2-pop" role="dialog" aria-label="Тревоги">
          <header className="v2-pop-head">
            <b>Тревоги</b>
            <span>{sorted.length ? nf(sorted.length) + ' ' + plural(sorted.length, 'вопрос', 'вопроса', 'вопросов') : ''}</span>
          </header>
          {sorted.length ? (
            <ul className="v2-alerts">
              {sorted.map((a, i) => (
                <li key={i} className={'v2-alert' + (a.level === 'stop' ? ' is-stop' : '')}>
                  {/* Слово, а не только цвет полосы (§4.3). */}
                  <Chip tone={a.level} dot>{a.level === 'stop' ? 'работа стоит' : 'внимание'}</Chip>
                  <span className="v2-alert-t">{a.text}</span>
                  {a.todo ? <span className="v2-alert-d">{a.todo}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="v2-pop-empty">Всё в порядке</p>
          )}
        </div>
      ) : null}
    </div>
  )
}
