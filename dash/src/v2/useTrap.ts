// Ловушка фокуса для окон v2 (§4.3, §5.7): Tab не уходит из окна; Esc —
// то, что окно разрешает, или ничего (для необратимого).

import { useEffect, type RefObject } from 'react'

// enabled = false — окно уступает клавиатуру окну поверх себя.
export function useTrap(box: RefObject<HTMLDivElement | null>, onEsc: (() => void) | null, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onEsc?.(); return }
      if (e.key !== 'Tab' || !box.current) return
      const f = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')]
      if (!f.length) return
      const first = f[0], last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [box, onEsc, enabled])
}

