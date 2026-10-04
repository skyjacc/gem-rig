// Подтверждение «Накрутить» (§3.4, §5.7).
//
// Каждая отправка тратит матч навсегда, поэтому перед запуском — список
// последствий, а не «вы уверены?». Строки — те же, что в старой панели
// (preview из lib/worker.ts), запрос — тот же: POST /api/autopilot {id, on:true}.
//
// Окно закрывается ТОЛЬКО кнопками: ни Esc, ни щелчок по фону его не
// закрывают — чтобы не закрыть случайно в момент решения. Фокус не уходит
// из окна, пока оно открыто.

import { useEffect, useRef } from 'react'
import { preview } from '../lib/worker.ts'
import { useAction, type State } from '../lib/api.ts'
import { Btn } from './ui.tsx'

export function ConfirmBurn({ state, goal, onClose }: {
  state: State
  goal: number | null
  onClose: () => void
}) {
  const ap = state.autopilot
  const act = useAction()
  const box = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const owned = state.mine.filter(m => m.gem !== '—')
  const rows = preview(state, goal)

  // Фокус — на «отмену»: Enter по привычке не должен запускать необратимое.
  useEffect(() => { cancel.current?.focus() }, [])

  // Esc гасим, Tab держим внутри окна.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return }
      if (e.key !== 'Tab' || !box.current) return
      const f = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled])')]
      if (!f.length) return
      const first = f[0], last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [])

  const go = async () => {
    const r: any = await act.run('/api/autopilot', { id: ap.id, on: true })
    if (r?.error) return
    onClose()
  }

  return (
    <div className="v2-veil">
      <div ref={box} className="v2-dialog" role="dialog" aria-modal="true" aria-labelledby="v2-burn-title">
        <header className="v2-dialog-head">
          <h2 id="v2-burn-title">Запустить накрутку</h2>
          <span className="v2-aside">{ap.label}</span>
        </header>

        <dl className="v2-rows">
          {rows.map(r => (
            <div key={r.k} className={r.tone === 'warn' ? 'is-warn' : undefined}>
              <dt>{r.k}</dt>
              <dd className="v2-num">{r.v}</dd>
            </div>
          ))}
        </dl>

        <p className="v2-burn">
          Отправленный матч расходуется навсегда: тот же матч на этом же аккаунте
          второго раза счётчика не поднимет. Вернуть его нельзя — ни остановкой,
          ни отвязкой аккаунта. На другом аккаунте он останется свежим.
        </p>

        {owned.length === 0 ? (
          <p className="v2-note is-warn">
            В инвентаре нет гемов. Работник включится и будет ждать: без гемов жечь нечего. Ничего не потратится.
          </p>
        ) : null}

        {act.error ? (
          <p className="v2-note is-stop" role="alert">Не вышло: {act.error}</p>
        ) : null}

        <footer className="v2-dialog-foot">
          <Btn ref={cancel} tone="soft" onClick={() => { act.clear(); onClose() }} disabled={act.busy}>отмена</Btn>
          <Btn tone="go" loading={act.busy} onClick={go}>{act.busy ? 'запускаю…' : act.error ? 'ещё раз' : 'накрутить'}</Btn>
        </footer>
      </div>
    </div>
  )
}
