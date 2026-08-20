import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import type { State } from '../lib/types.ts'
import { reduceMotion } from '../lib/format.ts'

const COLOR = { update: 'bg-malachite', dup: 'bg-oxide/70', silent: 'bg-[#7a2b2b]' } as const

// Подпись страницы: лента отправок. Один штрих на матч, поток идёт справа налево.
// Высота штриха — размер ответа GC, то есть сколько предметов подняло сообщение.
export function Tape({ state }: { state: State }) {
  const strip = useRef<HTMLDivElement>(null)
  const seen = useRef(new Set<number>())

  useEffect(() => {
    const el = strip.current
    if (!el) return
    const fresh = state.events.filter(e => !seen.current.has(e.ts)).sort((a, b) => a.ts - b.ts)
    for (const e of fresh) {
      seen.current.add(e.ts)
      const tick = document.createElement('div')
      const h = e.result === 'update' ? Math.min(52, 14 + (e.bytes || 0) / 22) : e.result === 'dup' ? 16 : 9
      tick.className = `w-[5px] shrink-0 ${COLOR[e.result] ?? 'bg-rule'}`
      tick.style.height = h + 'px'
      tick.title = `${e.match_id} · лига ${e.league_id || '—'} · ${e.result === 'update' ? e.bytes + ' байт' : e.result}`
      el.prepend(tick)
      if (!reduceMotion()) gsap.from(tick, { scaleY: 0.05, opacity: 0, duration: 0.45, ease: 'back.out(2)', transformOrigin: 'bottom' })
    }
    while (el.children.length > 220) el.lastChild?.remove()
  }, [state.events])

  const ups = state.events.filter(e => e.result === 'update').length

  return (
    <div className="flex items-center gap-5 border-b border-rule px-6 py-4">
      <div className="min-w-[104px]">
        <div className="text-[10px] uppercase tracking-[0.28em] text-dust">лента</div>
        <div className="text-[11px] text-dust">
          {state.events.length ? `${ups} из ${state.events.length} засчитано` : 'ожидание'}
        </div>
      </div>
      <div ref={strip} dir="rtl" className="flex h-[52px] flex-1 items-end gap-[2px] overflow-hidden" />
    </div>
  )
}
