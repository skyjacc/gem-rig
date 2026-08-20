import { useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { reduceMotion } from '../lib/format.ts'

type Status = 'done' | 'active' | 'todo' | 'blocked'
type RNode = { id: string; title: string; detail?: string; status: Status; metric?: string; evidence?: string }
type Phase = { id: string; title: string; subtitle: string; status: Status; progress: { done: number; total: number }; nodes: RNode[] }
type Data = { phases: Phase[]; updated: number }

// Палитра shadcn/ui, нейтральная база — та же, что у референса.
// Держим её локально в компоненте: мигрировать всю панель одним махом
// незачем, а вкладка должна выглядеть так, как договорились.
const SKIN = `
.rm {
  --bg: oklch(14.5% 0 0);
  --card: oklch(17% 0 0);
  --card-hover: oklch(20% 0 0);
  --fg: oklch(98.5% 0 0);
  --muted: oklch(63% 0 0);
  --faint: oklch(45% 0 0);
  --border: oklch(26.9% 0 0);
  --ring: oklch(43.9% 0 0);
  --ok: oklch(72% 0.16 155);
  --run: oklch(70% 0.15 235);
  --stop: oklch(64% 0.21 27);
  --radius: 0.625rem;
  color: var(--fg);
  font-feature-settings: "cv02","cv03","cv04","cv11";
}
.rm-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition: background .15s, border-color .15s, transform .15s;
}
.rm-card:hover { background: var(--card-hover); border-color: var(--ring); }
.rm-chip {
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 10px;
  letter-spacing: .08em;
  text-transform: uppercase;
  padding: 2px 8px;
}
`

const COLOR: Record<Status, string> = {
  done: 'var(--ok)', active: 'var(--run)', todo: 'var(--faint)', blocked: 'var(--stop)',
}
const WORD: Record<Status, string> = {
  done: 'готово', active: 'идёт', todo: 'впереди', blocked: 'стоп',
}

// Геометрия. Фазы идут по хребту вниз, узлы ветвятся вправо.
const SPINE = 34
const CARD_X = 96
const CARD_W = 700
const ROW_H = 62
const PHASE_GAP = 42
const PHASE_HEAD = 54

type Placed = { phase: Phase; y: number; rows: { node: RNode; y: number }[]; height: number }

function layout(phases: Phase[]): { placed: Placed[]; height: number } {
  let y = 20
  const placed: Placed[] = []
  for (const phase of phases) {
    const top = y
    y += PHASE_HEAD
    const rows = phase.nodes.map(node => { const at = y; y += ROW_H; return { node, y: at } })
    y += PHASE_GAP
    placed.push({ phase, y: top, rows, height: y - top })
  }
  return { placed, height: y }
}

export function Roadmap() {
  const [data, setData] = useState<Data | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const drawn = useRef(false)

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

  const { placed, height } = useMemo(
    () => data ? layout(data.phases) : { placed: [], height: 0 }, [data])

  useEffect(() => {
    if (!data || drawn.current || reduceMotion() || !svgRef.current) return
    drawn.current = true
    const el = svgRef.current
    // drawSVG — платный плагин GSAP, его тут нет. Рисуем штрихом вручную.
    el.querySelectorAll<SVGPathElement>('[data-edge]').forEach((p, i) => {
      const len = p.getTotalLength()
      gsap.fromTo(p,
        { strokeDasharray: len, strokeDashoffset: len },
        { strokeDashoffset: 0, duration: 0.5, delay: i * 0.008, ease: 'power2.out' })
    })
    gsap.from(el.querySelectorAll('[data-card]'), {
      opacity: 0, duration: 0.4, stagger: 0.012, ease: 'power2.out',
    })
  }, [data])

  if (err && !data) {
    return <div className="rm py-20 text-center text-[13px]" style={{ color: 'var(--stop)' }}>
      <style>{SKIN}</style>roadmap недоступен — {err}
    </div>
  }
  if (!data) {
    return <div className="rm py-20 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
      <style>{SKIN}</style>считаю состояние…
    </div>
  }

  const totalDone = data.phases.reduce((a, p) => a + p.progress.done, 0)
  const totalAll = data.phases.reduce((a, p) => a + p.progress.total, 0)

  return (
    <div className="rm mx-auto max-w-[900px] py-10">
      <style>{SKIN}</style>

      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-[28px] font-semibold leading-none tracking-[-0.02em]">Roadmap</h2>
          <p className="mt-2 text-[12px]" style={{ color: 'var(--muted)' }}>
            каждый узел считается живьём — из базы, из файлов, из числа тестов
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="rm-chip" style={{ color: 'var(--muted)' }}>
            {totalDone} / {totalAll}
          </span>
          <span className="tnum text-[11px]" style={{ color: 'var(--faint)' }}>
            {new Date(data.updated).toLocaleTimeString('ru-RU')}
          </span>
        </div>
      </header>

      <svg
        ref={svgRef}
        width="100%"
        viewBox={`0 0 ${CARD_X + CARD_W + 16} ${height}`}
        style={{ overflow: 'visible' }}
        role="img"
        aria-label="Граф состояния проекта: фазы по вертикали, задачи ветвями вправо"
      >
        {/* хребет */}
        <line
          x1={SPINE} y1={28} x2={SPINE} y2={height - PHASE_GAP}
          stroke="var(--border)" strokeWidth={1.5}
        />

        {placed.map(({ phase, y, rows }) => {
          const c = COLOR[phase.status]
          const pct = phase.progress.total ? phase.progress.done / phase.progress.total : 0
          const R = 11
          const circ = 2 * Math.PI * R
          return (
            <g key={phase.id}>
              {/* кольцо прогресса на узле фазы */}
              <circle cx={SPINE} cy={y + 12} r={R} fill="var(--bg)" stroke="var(--border)" strokeWidth={2.5} />
              <circle
                cx={SPINE} cy={y + 12} r={R}
                fill="none" stroke={c} strokeWidth={2.5} strokeLinecap="round"
                strokeDasharray={`${circ * pct} ${circ}`}
                transform={`rotate(-90 ${SPINE} ${y + 12})`}
              />
              <circle cx={SPINE} cy={y + 12} r={3.2} fill={c} />

              {/* заголовок фазы */}
              <text x={CARD_X - 30} y={y + 9} fontSize={15} fontWeight={600} fill="var(--fg)">
                {phase.title}
              </text>
              <text x={CARD_X - 30} y={y + 26} fontSize={11} fill="var(--muted)">
                {phase.subtitle}
              </text>
              <text x={CARD_X + CARD_W} y={y + 9} fontSize={11} textAnchor="end" fill="var(--faint)" className="tnum">
                {phase.progress.done}/{phase.progress.total}
              </text>

              {/* ветви к узлам */}
              {rows.map(({ node, y: ny }) => {
                const nc = COLOR[node.status]
                const on = hover === node.id
                const midY = ny + 22
                return (
                  <g
                    key={node.id}
                    onMouseEnter={() => setHover(node.id)}
                    onMouseLeave={() => setHover(null)}
                    style={{ cursor: 'default' }}
                  >
                    <path
                      data-edge
                      d={`M ${SPINE} ${y + 23} V ${midY - 16} Q ${SPINE} ${midY} ${SPINE + 22} ${midY} H ${CARD_X - 14}`}
                      fill="none"
                      stroke={on ? nc : 'var(--border)'}
                      strokeWidth={on ? 1.6 : 1.2}
                    />
                    <circle cx={CARD_X - 9} cy={midY} r={4} fill={nc} opacity={node.status === 'todo' ? 0.5 : 1} />

                    <foreignObject data-card x={CARD_X} y={ny} width={CARD_W} height={ROW_H - 8}>
                      <div
                        className="rm-card flex h-full items-center gap-3 px-4"
                        style={on ? { borderColor: nc } : undefined}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span
                              className="text-[13px]"
                              style={{ color: node.status === 'todo' ? 'var(--muted)' : 'var(--fg)' }}
                            >
                              {node.title}
                            </span>
                            {node.metric && (
                              <span className="tnum text-[12px]" style={{ color: nc }}>{node.metric}</span>
                            )}
                          </div>
                          {(node.detail || node.evidence) && (
                            <div className="truncate text-[11px]" style={{ color: 'var(--faint)' }}>
                              {node.detail}
                              {node.evidence && <span> · {node.evidence}</span>}
                            </div>
                          )}
                        </div>
                        <span className="rm-chip shrink-0" style={{ color: nc, borderColor: nc + '55' }}>
                          {WORD[node.status]}
                        </span>
                      </div>
                    </foreignObject>
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>

      <p className="mt-6 pl-[96px] text-[11px] leading-[1.6]" style={{ color: 'var(--faint)' }}>
        Ничего не захардкожено. «Данные» тянут числа из карты матчей, «Код» проверяет наличие
        модулей и считает вызовы <span className="tnum">test(</span> в исходниках, «Производство» —
        счётчики из последнего среза инвентаря против потолка сущности. Откатится назад — узел покраснеет сам.
      </p>
    </div>
  )
}
