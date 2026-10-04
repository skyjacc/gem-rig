// Окно действия (§5.7): список того, что изменится, и кнопка. В отличие от
// подтверждения «Накрутить», закрывается и по Esc, и по фону — §5.7
// разрешает это всем окнам, кроме необратимого запуска.
//
// Запрос — через useAction; ошибка видна в окне, окно не закрывается.

import { useEffect, useRef, type ReactNode } from 'react'
import { useAction } from '../lib/api.ts'
import { Btn } from './ui.tsx'

export type Row = { k: string; v: string; tone?: 'warn' }

export function ActionDialog({ title, aside, rows, children, verb, url, body, onClose }: {
  title: string
  aside?: string
  rows: Row[]
  children?: ReactNode
  verb: string
  url: string
  body: unknown
  onClose: () => void
}) {
  const act = useAction()
  const box = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)

  useEffect(() => { cancel.current?.focus() }, [])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
      if (e.key !== 'Tab' || !box.current) return
      const f = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled])')]
      if (!f.length) return
      const first = f[0], last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [onClose])

  const go = async () => {
    const r: any = await act.run(url, body)
    if (r?.error) return
    onClose()
  }

  return (
    <div className="v2-veil" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={box} className="v2-dialog" role="dialog" aria-modal="true" aria-labelledby="v2-act-title">
        <header className="v2-dialog-head">
          <h2 id="v2-act-title">{title}</h2>
          {aside ? <span className="v2-aside">{aside}</span> : null}
        </header>
        <dl className="v2-rows">
          {rows.map(r => (
            <div key={r.k} className={r.tone === 'warn' ? 'is-warn' : undefined}>
              <dt>{r.k}</dt>
              <dd>{r.v}</dd>
            </div>
          ))}
        </dl>
        {children}
        {act.error ? <p className="v2-note is-stop" role="alert">Не вышло: {act.error}</p> : null}
        <footer className="v2-dialog-foot">
          <Btn ref={cancel} tone="soft" onClick={onClose} disabled={act.busy}>отмена</Btn>
          <Btn tone="go" loading={act.busy} onClick={go}>{act.error ? 'ещё раз' : verb}</Btn>
        </footer>
      </div>
    </div>
  )
}
