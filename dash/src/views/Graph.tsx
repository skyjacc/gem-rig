import { useMemo, useState } from 'react'
import { nf, useJson, type GraphData, type State } from '../lib/api.ts'
import { Card, Empty, Head, ItemIcon, Segmented } from '../parts/ui.tsx'

// Граф пересечений.
//
// Он показывает не «кто с кем играл», а что выгодно держать вместе.
// Одно сообщение поднимает ВСЕ подходящие вещи разом, поэтому матч,
// входящий в наборы двух сущностей, стоит одну отправку, а счётчик даёт
// обеим. Толстое ребро — дешёвые счётчики.
//
// Раскладка по кругу, а не физикой: на полусотне узлов физика даёт кашу
// и прыгает при каждом обновлении, а круг стоит на месте и читается.

const SIZE = 860
const R = 320
const CX = SIZE / 2
const CY = SIZE / 2

export function Graph({ state }: { state: State }) {
  const [scope, setScope] = useState<'owned' | 'all'>('owned')
  const [hot, setHot] = useState<string | null>(null)
  const { data } = useJson<GraphData>('/api/graph?scope=' + scope, state.ts)

  const laid = useMemo(() => {
    if (!data?.nodes?.length) return null
    // Порядок — по пулу: соседи на круге получаются сопоставимого размера.
    const nodes = [...data.nodes].sort((a, b) => b.pool - a.pool)
    const step = (Math.PI * 2) / nodes.length
    const pos = new Map<string, { x: number; y: number; a: number }>()
    nodes.forEach((n, i) => {
      const a = -Math.PI / 2 + i * step
      pos.set(n.key, { x: CX + Math.cos(a) * R, y: CY + Math.sin(a) * R, a })
    })
    const max = Math.max(...data.edges.map(e => e.shared), 1)
    return { nodes, pos, max }
  }, [data])

  if (!data) return <Card><Empty>считаю пересечения…</Empty></Card>
  if (!laid) return <Card><Empty>нет сущностей с известным набором матчей</Empty></Card>

  const { nodes, pos, max } = laid
  const goal = state.autopilot.goal || 2000
  const shown = hot ? data.edges.filter(e => e.a === hot || e.b === hot) : data.edges
  const pairs = data.edges.slice(0, 14)

  return (
    <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[1fr_380px]">
      <div>
        <Head
          title="Пересечения"
          note={`${nf(nodes.length)} сущностей · ${nf(data.edges.length)} связей`}
          right={
            <Segmented
              value={scope}
              items={[{ id: 'owned' as const, label: 'мои' }, { id: 'all' as const, label: 'весь каталог' }]}
              onPick={setScope}
            />
          }
        />
        <Card className="overflow-hidden">
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="block h-auto w-full" onMouseLeave={() => setHot(null)}>
            {/* рёбра: толщина — число общих матчей */}
            {shown.map(e => {
              const a = pos.get(e.a)!
              const b = pos.get(e.b)!
              if (!a || !b) return null
              const w = 0.6 + (e.shared / max) * 5
              const dim = hot && e.a !== hot && e.b !== hot
              return (
                <path
                  key={e.a + e.b}
                  d={`M ${a.x} ${a.y} Q ${CX} ${CY} ${b.x} ${b.y}`}
                  fill="none"
                  stroke="white"
                  strokeWidth={w}
                  strokeOpacity={dim ? 0.03 : 0.10 + (e.shared / max) * 0.28}
                />
              )
            })}

            {/* узлы */}
            {nodes.map(n => {
              const p = pos.get(n.key)!
              const r = 10 + Math.sqrt(n.owned) * 5
              const dim = hot && hot !== n.key && !data.edges.some(e =>
                (e.a === hot && e.b === n.key) || (e.b === hot && e.a === n.key))
              const done = n.counter >= goal
              const spent = n.pool ? n.burned / n.pool : 0
              const right = Math.cos(p.a) > -0.1
              return (
                <g
                  key={n.key}
                  opacity={dim ? 0.25 : 1}
                  onMouseEnter={() => setHot(n.key)}
                  style={{ cursor: 'default' }}
                >
                  {/* доля израсходованного — дуга вокруг узла */}
                  <circle cx={p.x} cy={p.y} r={r + 4} fill="none" stroke="white" strokeOpacity={0.08} strokeWidth={2} />
                  <circle
                    cx={p.x} cy={p.y} r={r + 4}
                    fill="none"
                    stroke={done ? 'var(--ok)' : 'oklch(70.8% 0 0)'}
                    strokeWidth={2}
                    strokeDasharray={`${2 * Math.PI * (r + 4) * spent} ${2 * Math.PI * (r + 4)}`}
                    transform={`rotate(-90 ${p.x} ${p.y})`}
                  />
                  <circle
                    cx={p.x} cy={p.y} r={r}
                    fill={n.owned ? 'oklch(26.9% 0 0)' : 'oklch(17% 0 0)'}
                    stroke="white"
                    strokeOpacity={n.owned ? 0.22 : 0.08}
                  />
                  {n.owned ? (
                    <text x={p.x} y={p.y + 4} textAnchor="middle" className="fill-white/80 font-mono" fontSize={11}>
                      {n.owned}
                    </text>
                  ) : null}
                  <text
                    x={p.x + (right ? r + 10 : -(r + 10))}
                    y={p.y + 4}
                    textAnchor={right ? 'start' : 'end'}
                    fontSize={13}
                    className={n.owned ? 'fill-white/85' : 'fill-white/40'}
                  >
                    {n.key}
                  </text>
                </g>
              )
            })}
          </svg>
        </Card>
        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          Размер — сколько вещей с этим гемом лежит в инвентаре. Кольцо — доля пула,
          израсходованная этим аккаунтом. Толщина связи — общие матчи: они уходят одной
          отправкой и поднимают счётчик обеим сущностям.
        </p>
      </div>

      <div>
        <Head title="Выгодные пары" note="общих матчей" />
        <Card>
          {pairs.length === 0 ? <Empty>пересечений нет</Empty> : (
            <ul className="divide-y divide-white/[0.06]">
              {pairs.map(e => {
                const a = nodes.find(n => n.key === e.a)
                const b = nodes.find(n => n.key === e.b)
                return (
                  <li
                    key={e.a + e.b}
                    className="flex items-center gap-2 px-4 py-2.5 text-[13px] transition-colors hover:bg-white/[0.03]"
                    onMouseEnter={() => setHot(e.a)}
                    onMouseLeave={() => setHot(null)}
                  >
                    <ItemIcon hash={a?.icon ?? ''} size={20} />
                    <span className="min-w-0 flex-1 truncate">{e.a}</span>
                    <ItemIcon hash={b?.icon ?? ''} size={20} />
                    <span className="min-w-0 flex-1 truncate">{e.b}</span>
                    <span className="tnum shrink-0 font-mono">{nf(e.shared)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
