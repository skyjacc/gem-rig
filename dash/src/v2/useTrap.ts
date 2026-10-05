// Ловушка фокуса для окон v2 (§4.3, §5.7) — то же, что делал прежний Modal:
//
// - открылось — фокус на первом поле окна, а не на кнопке позади: иначе
//   клавиатура продолжает обходить панель под окном;
// - Tab не уходит из окна, а пришедший извне (фокус остался позади)
//   заворачивается на край окна, а не выпускается;
// - закрылось — фокус туда, откуда открыли: без этого он падает в начало
//   страницы, и обход начинается заново;
// - Esc — то, что окно разрешает, или ничего (для необратимого).
//
// enabled = false — окно уступает клавиатуру окну поверх себя (подтверждение
// сброса в «Настроить»). Уступая, запоминает, где был фокус, и возвращает его
// туда, когда верхнее окно закроется.
//
// Закрывалка живёт в ссылке, а не в зависимостях: родитель пересоздаёт её
// на каждой перерисовке, состояние приходит потоком — эффект перезапускался
// бы и выбивал фокус посреди набора (так было у прежнего Modal).

import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const focusable = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(n => n.offsetParent !== null || n === document.activeElement)

export function useTrap(box: RefObject<HTMLDivElement | null>, onEsc: (() => void) | null, enabled = true) {
  const esc = useRef(onEsc)
  esc.current = onEsc
  const back = useRef<HTMLElement | null>(null)

  // Откуда открыли — запоминается до того, как фокус уйдёт в окно (этот
  // эффект объявлен первым), и возвращается при закрытии.
  useEffect(() => {
    const from = document.activeElement as HTMLElement | null
    return () => { if (from && from.isConnected) from.focus() }
  }, [])

  useEffect(() => {
    if (!enabled) return
    const el = box.current
    if (!el) return
    if (!el.contains(document.activeElement)) {
      const to = back.current && back.current.isConnected && el.contains(back.current) ? back.current : focusable(el)[0]
      to?.focus()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); esc.current?.(); return }
      if (e.key !== 'Tab') return
      const f = focusable(el)
      if (!f.length) { e.preventDefault(); return }
      const first = f[0], last = f[f.length - 1]
      const here = document.activeElement
      if (!el.contains(here)) { e.preventDefault(); (e.shiftKey ? last : first).focus() }
      else if (e.shiftKey && here === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && here === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', key, true)
    return () => {
      // Уступаем окну поверх (или закрываемся): запомнить, где был фокус.
      back.current = document.activeElement as HTMLElement | null
      document.removeEventListener('keydown', key, true)
    }
  }, [box, enabled])
}
