import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import type { State } from '../lib/types.ts'
import { nf, reduceMotion } from '../lib/format.ts'
import { Odometer } from './ui.tsx'

// Герой страницы. Главное здесь не прогресс, а то, что матчи кончаются:
// каждый засчитанный сгорает для аккаунта навсегда.
export function Seam({ state }: { state: State }) {
  const fill = useRef<HTMLDivElement>(null)
  const s = state.seam

  useEffect(() => {
    const el = fill.current
    if (!el || !s) return
    const pct = (100 * s.spent) / Math.max(1, s.total)
    if (reduceMotion()) { el.style.width = pct + '%'; return }
    gsap.to(el, { width: pct + '%', duration: 0.9, ease: 'power3.out' })
  }, [s?.spent, s?.total])

  if (!s) {
    return (
      <section className="border-b border-rule px-6 py-8">
        <div className="text-[10px] uppercase tracking-[0.28em] text-dust">
          {state.inv.error ? `запас не считается — ${state.inv.error}` : 'читаю инвентарь'}
        </div>
      </section>
    )
  }

  return (
    <section className="border-b border-rule px-6 py-8" data-anim="seam">
      <div className="text-[10px] uppercase tracking-[0.28em] text-dust">
        осталось матчей · {s.gem}
      </div>

      <div className="my-1 flex items-end gap-4">
        <Odometer value={s.left} className="font-display text-[clamp(48px,9vw,104px)] font-extrabold leading-[0.85] tracking-[-0.03em]" />
        <p className="mb-2.5 max-w-[260px] text-[12px] text-dust">
          матчей, которые ещё можно засчитать. Каждый поднимает {s.items} предмет
          {s.items % 10 === 1 && s.items !== 11 ? '' : 'ов'} разом.
        </p>
      </div>

      <div className="relative mt-3 h-3.5 overflow-hidden border border-rule bg-seam">
        <div ref={fill} className="absolute inset-y-0 left-0 bg-oxide" style={{ width: 0 }} />
      </div>

      <div className="mt-1.5 flex justify-between text-[11px] text-dust">
        <span>сожжено {nf(s.spent)}</span>
        <span>всего в жиле {nf(s.total)}</span>
      </div>
    </section>
  )
}
