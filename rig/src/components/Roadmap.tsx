import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { reduceMotion } from '../lib/format.ts'

type Status = 'done' | 'active' | 'todo' | 'blocked'
type Node = { id: string; title: string; detail?: string; status: Status; metric?: string; evidence?: string }
type Phase = { id: string; title: string; subtitle: string; status: Status; progress: { done: number; total: number }; nodes: Node[] }
type Data = { phases: Phase[]; updated: number }

const DOT: Record<Status, string> = {
  done: 'bg-malachite border-malachite',
  active: 'bg-vein border-vein',
  todo: 'bg-ink border-rule',
  blocked: 'bg-oxide border-oxide',
}
const TEXT: Record<Status, string> = {
  done: 'text-malachite',
  active: 'text-vein',
  todo: 'text-dust',
  blocked: 'text-oxide',
}
const WORD: Record<Status, string> = {
  done: 'готово', active: 'в работе', todo: 'впереди', blocked: 'заблокировано',
}

function Bar({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((100 * done) / total) : 0
  return (
    <div className="flex items-center gap-2.5">
      <div className="h-[3px] w-24 overflow-hidden rounded-full bg-rule">
        <div
          className={pct === 100 ? 'h-full bg-malachite' : 'h-full bg-vein'}
          style={{ width: pct + '%' }}
        />
      </div>
      <span className="tnum text-[11px] text-dust">{done}/{total}</span>
    </div>
  )
}

export function Roadmap() {
  const [data, setData] = useState<Data | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const drawn = useRef(false)

  // Живое обновление: узлы считаются на сервере из базы и файлов,
  // поэтому достаточно перечитывать, а не держать сокет.
  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const r = await fetch('/api/roadmap')
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const j = await r.json()
        if (alive) { setData(j); setErr(null) }
      } catch (e: any) { if (alive) setErr(e.message) }
    }
    pull()
    const t = setInterval(pull, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  useEffect(() => {
    if (!data || drawn.current || reduceMotion() || !root.current) return
    drawn.current = true
    gsap.from(root.current.querySelectorAll('[data-node]'), {
      x: -10, opacity: 0, duration: 0.35, stagger: 0.015, ease: 'power2.out',
    })
  }, [data])

  if (err && !data) return <div className="py-16 text-center text-[12px] text-oxide">roadmap недоступен — {err}</div>
  if (!data) return <div className="py-16 text-center text-[12px] text-dust">считаю состояние…</div>

  return (
    <div ref={root} className="mx-auto max-w-[900px] py-8">
      <div className="mb-8 flex items-baseline justify-between">
        <div>
          <h2 className="font-display text-[26px] font-extrabold leading-none tracking-[-0.02em]">Roadmap</h2>
          <p className="mt-1.5 text-[11px] text-dust">
            каждый узел считается живьём — из базы, из файлов, из числа тестов
          </p>
        </div>
        <span className="tnum text-[10px] uppercase tracking-[0.18em] text-dust">
          {new Date(data.updated).toLocaleTimeString('ru-RU')}
        </span>
      </div>

      {data.phases.map((p, pi) => (
        <section key={p.id} className="relative pl-8">
          {/* ветка вниз */}
          {pi < data.phases.length - 1 && (
            <span className="absolute left-[9px] top-6 bottom-0 w-px bg-rule" aria-hidden />
          )}
          {/* узел фазы */}
          <span
            className={`absolute left-[3px] top-[7px] h-[13px] w-[13px] rounded-full border-2 ${DOT[p.status]}`}
            aria-hidden
          />

          <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pb-3">
            <h3 className="font-display text-[17px] font-bold tracking-[-0.01em]">{p.title}</h3>
            <span className="text-[11px] text-dust">{p.subtitle}</span>
            <span className="ml-auto"><Bar done={p.progress.done} total={p.progress.total} /></span>
          </header>

          <ul className="space-y-px pb-7">
            {p.nodes.map(n => (
              <li
                key={n.id}
                data-node
                className="group relative flex gap-3 border-l border-rule/60 py-[7px] pl-4 transition-colors hover:bg-raise/40"
              >
                <span
                  className={`mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full border ${DOT[n.status]}`}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className={`text-[13px] ${n.status === 'todo' ? 'text-dust' : 'text-chalk'}`}>
                      {n.title}
                    </span>
                    {n.metric && (
                      <span className="tnum text-[12px] text-vein">{n.metric}</span>
                    )}
                    <span className={`ml-auto text-[9px] uppercase tracking-[0.16em] ${TEXT[n.status]}`}>
                      {WORD[n.status]}
                    </span>
                  </div>
                  {n.detail && (
                    <div className="mt-0.5 text-[11px] leading-[1.5] text-dust">{n.detail}</div>
                  )}
                  {n.evidence && (
                    <div className="mt-0.5 text-[10px] leading-[1.5] text-dust/70">
                      <span className="uppercase tracking-[0.14em]">доказано:</span> {n.evidence}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <p className="pl-8 text-[10px] leading-[1.6] text-dust/70">
        Ничего не захардкожено. Узлы «Данные» тянут числа из карты матчей, «Код» проверяет наличие
        модулей и считает вызовы <span className="tnum">test(</span> в исходниках, «Производство» —
        счётчики из последнего среза инвентаря против потолка сущности. Откатится назад — узел покраснеет сам.
      </p>
    </div>
  )
}
