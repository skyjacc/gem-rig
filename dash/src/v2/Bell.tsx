// Колокольчик тревог (§5.7): то же, что «Требует внимания» в старом Пульте,
// но с любого экрана. Сначала то, из-за чего работа стоит (stop), потом
// остальное (warn). Список — attention() из lib/worker.ts, без своих правил.
//
// Кнопок действий у тревог пока нет: их нет и в attention() — появятся
// вместе с действиями на Обзоре (этап 2.1). Сейчас — текст и «что делать».

import { useEffect, useRef, useState } from 'react'
import { Bell as BellIcon } from 'lucide-react'
import { nf, plural, type Live, type State } from '../lib/api.ts'
import { attention, type Alert } from '../lib/worker.ts'
import { Chip, IconBtn } from './ui.tsx'

export function Bell({ state, live, now, goal }: {
  state: State
  live: Live
  now: number
  goal: number | null
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  // Цели нет в настройках — «не дойдёт» не посчитать; об этом и говорим,
  // а не молчим (§3.2).
  const list: Alert[] = [
    ...(goal == null ? [{ level: 'warn' as const, text: 'цель счётчика не задана в настройках', todo: '«дойдёт / не дойдёт» не считается, пока её нет — задайте в «Общих правилах»' }] : []),
    ...attention(state, live, now, goal),
  ]
  // Порядок §5.7: то, из-за чего работа стоит (stop), → «не дойдёт» (reach) →
  // справочные. Сортировка стабильная: внутри группы — порядок attention().
  const rank = (a: Alert) => (a.level === 'stop' ? 0 : a.kind === 'reach' ? 1 : 2)
  const sorted = [...list].sort((a, b) => rank(a) - rank(b))
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
