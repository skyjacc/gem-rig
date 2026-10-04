// Режим «сеть матчей» на Обзоре (§5.1: «сеть — нынешний режим Graph.tsx»).
//
// Перенос Net из views/Graph.tsx: раскладка (lib/force.ts), кадр мимо React,
// затухание, «уменьшить движение» (досчитать разом), перетаскивание узла,
// панорама и зум — без изменения логики. Изменено только:
//   - цвета — токены v2 (значениями: var() в атрибутах SVG не работает);
//   - кнопки, поиск, карточка, ошибка — кирпичи v2;
//   - цель — settings.goal (в Graph.tsx — цель работника с запасным числом);
//     нет цели — «не задана»;
//   - загрузка — Loadable: скелетон не дольше 8 секунд (§5.7).
// Временная копия: старый Graph.tsx удаляется на этапе 9.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Maximize, Minus, Plus, Search } from 'lucide-react'
import { icon as steamIcon, nf, useJson, type GraphData, type State } from '../../lib/api.ts'
import { seed, step, type Link, type Sim } from '../../lib/force.ts'
import { Loadable } from '../States.tsx'
import { IconBtn } from '../ui.tsx'

// Токены §4.1: --ink, --ink2, --bg (фон холста), --ac.
const FG = '#ecebe8'
const DIM = '#a7a5a0'
const BG = '#0c0c0e'
const AC = '#b8f25c'

type View = { x: number; y: number; k: number }

function useCalm() {
  const q = '(prefers-reduced-motion: reduce)'
  const [calm, setCalm] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const m = matchMedia(q)
    const on = () => setCalm(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return calm
}

function useCanvas(size: { w: number; h: number }, extent: () => { x1: number; y1: number; x2: number; y2: number } | null) {
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)

  const fit = useCallback(() => {
    const e = extent()
    if (!e) return
    const pad = 90
    const w = Math.max(1, e.x2 - e.x1)
    const h = Math.max(1, e.y2 - e.y1)
    const k = Math.min((size.w - pad * 2) / w, (size.h - pad * 2) / h, 1.6)
    setView({ k, x: size.w / 2 - ((e.x1 + e.x2) / 2) * k, y: size.h / 2 - ((e.y1 + e.y2) / 2) * k })
  }, [extent, size.w, size.h])

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest('[data-node]')) return
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    setView(v => ({ ...v, x: drag.current!.vx + (e.clientX - drag.current!.x), y: drag.current!.vy + (e.clientY - drag.current!.y) }))
  }
  const onUp = () => { drag.current = null }

  const zoom = (factor: number, at?: { x: number; y: number }) => {
    setView(v => {
      const k = Math.max(0.15, Math.min(4, v.k * factor))
      const px = at?.x ?? size.w / 2
      const py = at?.y ?? size.h / 2
      return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k }
    })
  }

  const onWheel = (e: React.WheelEvent) => {
    const box = (e.currentTarget as Element).getBoundingClientRect()
    zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, { x: e.clientX - box.left, y: e.clientY - box.top })
  }

  return { view, fit, zoom, handlers: { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp, onWheel } }
}

function Label({ x, y, text, size = 12.5, weight = 400, fill = DIM }: {
  x: number; y: number; text: string; size?: number; weight?: number; fill?: string
}) {
  return (
    <text x={x} y={y} dominantBaseline="middle" textAnchor="start" fill={fill} stroke={BG} strokeWidth={3}
      paintOrder="stroke" strokeLinejoin="round" fontSize={size} fontWeight={weight} letterSpacing="-0.015em"
      style={{ pointerEvents: 'none' }}>
      {text}
    </text>
  )
}

export function Network({ state, goal }: { state: State; goal: number | null }) {
  const wrap = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1200, h: 800 })
  const [scope, setScope] = useState<'owned' | 'all'>('owned')
  const [q, setQ] = useState('')
  const { data, loading, error, reload } = useJson<GraphData>('/api/graph?scope=' + scope, state.ts)

  useEffect(() => {
    if (!wrap.current) return
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect
      setSize({ w: Math.max(400, r.width), h: Math.max(320, r.height) })
    })
    ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="v2-ov-stage v2-net" ref={wrap}>
      <div className="v2-net-bar">
        <div className="v2-seg" role="group" aria-label="Какие узлы">
          <button type="button" aria-pressed={scope === 'owned'} onClick={() => setScope('owned')}>мои</button>
          <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>весь каталог</button>
        </div>
        <label className="v2-net-find">
          <Search size={13} aria-hidden="true" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="найти" aria-label="Найти узел" />
        </label>
      </div>
      <Loadable what="сеть пересечений" loading={loading} error={error} ready={!!data} onRetry={reload}>
        {data ? <Net data={data} goal={goal} size={size} q={q} /> : null}
      </Loadable>
      {error ? (
        <p className="v2-hint v2-net-why">Граф считается по локальной карте матчей. Если её ещё не строили, считать нечего: запустите обход — node rig/crawl.ts.</p>
      ) : null}
    </div>
  )
}

function Net({ data, goal, size, q }: { data: GraphData; goal: number | null; size: { w: number; h: number }; q: string }) {
  const calm = useCalm()
  const [hot, setHot] = useState<string | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const alpha = useRef(1)
  const grab = useRef<{ key: string; dx: number; dy: number } | null>(null)
  const sims = useRef<Sim[]>([])

  const shape = useMemo(() => (data?.nodes ?? []).map(n => n.key).join('|'), [data])

  if (!sims.current.length && shape) {
    sims.current = seed(shape.split('|'), size.w, size.h)
    alpha.current = 1
  }

  // Раскладка пересобирается, когда меняется состав узлов, а не на каждый ответ.
  useEffect(() => {
    if (!shape) return
    sims.current = seed(shape.split('|'), size.w, size.h)
    alpha.current = 1
  }, [shape, size.w, size.h])

  const maxShared = useMemo(() => Math.max(...(data?.edges ?? []).map(e => e.shared), 1), [data])
  const links: Link[] = useMemo(() => {
    if (!data?.edges?.length) return []
    return data.edges.map(e => ({ a: e.a, b: e.b, w: e.shared / maxShared }))
  }, [data, maxShared])

  // Кадр пишется прямо в атрибуты, мимо примирения React.
  const edgeEls = useRef<(SVGPathElement | null)[]>([])
  const nodeEls = useRef(new Map<string, SVGGElement>())
  const linksRef = useRef<Link[]>(links)
  linksRef.current = links

  const paint = useCallback(() => {
    const by = new Map(sims.current.map(s => [s.key, s]))
    const edges = data?.edges ?? []
    for (let i = 0; i < edges.length; i++) {
      const el = edgeEls.current[i]
      if (!el) continue
      const a = by.get(edges[i].a)
      const b = by.get(edges[i].b)
      if (!a || !b) continue
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const off = Math.hypot(b.x - a.x, b.y - a.y) * 0.12
      el.setAttribute('d', `M ${a.x} ${a.y} Q ${mx + off * 0.2} ${my - off} ${b.x} ${b.y}`)
    }
    for (const s of sims.current) {
      nodeEls.current.get(s.key)?.setAttribute('transform', `translate(${s.x} ${s.y})`)
    }
  }, [data])

  // Считаем, пока раскладка не устоялась; при «уменьшить движение» — разом.
  useEffect(() => {
    if (calm) {
      if (!sims.current.length) return
      let a = 1
      for (let i = 0; i < 400 && a > 0.03; i++) {
        step(sims.current, linksRef.current, a, size.w, size.h)
        a *= 0.97
      }
      alpha.current = 0
      paint()
      return
    }
    let raf = 0
    const loop = () => {
      const busy = alpha.current > 0.03 || grab.current
      if (sims.current.length && busy) {
        step(sims.current, linksRef.current, alpha.current, size.w, size.h)
        if (!grab.current) alpha.current *= 0.992
        paint()
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [paint, size.w, size.h, calm, shape])

  useLayoutEffect(() => { paint() })

  const extent = useCallback(() => {
    if (!sims.current.length) return null
    const xs = sims.current.map(s => s.x)
    const ys = sims.current.map(s => s.y)
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
  }, [])

  const { view, fit, zoom, handlers } = useCanvas(size, extent)

  const toWorld = (e: React.PointerEvent) => {
    const box = (e.currentTarget as Element).getBoundingClientRect()
    return { x: (e.clientX - box.left - view.x) / view.k, y: (e.clientY - box.top - view.y) / view.k }
  }

  const onNodeDown = (key: string) => (e: React.PointerEvent) => {
    e.stopPropagation()
    const s = sims.current.find(n => n.key === key)
    if (!s) return
    const p = toWorld(e)
    grab.current = { key, dx: s.x - p.x, dy: s.y - p.y }
    s.fixed = true
    alpha.current = Math.max(alpha.current, 0.35)
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onNodeMove = (e: React.PointerEvent) => {
    if (!grab.current) return
    const s = sims.current.find(n => n.key === grab.current!.key)
    if (!s) return
    const p = toWorld(e)
    s.x = p.x + grab.current.dx
    s.y = p.y + grab.current.dy
    paint()
  }
  const onNodeUp = () => { grab.current = null }

  const byKey = new Map(data.nodes.map(n => [n.key, n]))
  const pos = new Map(sims.current.map(s => [s.key, s]))
  const near = new Set<string>()
  if (hot) {
    near.add(hot)
    for (const e of data.edges) {
      if (e.a === hot) near.add(e.b)
      if (e.b === hot) near.add(e.a)
    }
  }
  const chosen = pick ? byKey.get(pick) : null
  const match = (k: string) => !q || k.toLowerCase().includes(q.toLowerCase())

  return (
    <>
      <svg
        className="v2-net-svg"
        {...handlers}
        onPointerMove={e => { handlers.onPointerMove(e); onNodeMove(e) }}
        onPointerUp={() => { handlers.onPointerUp(); onNodeUp() }}
        aria-label="Сеть общих матчей"
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {data.edges.map((e, i) => {
            const a = pos.get(e.a)
            const b = pos.get(e.b)
            if (!a || !b) return null
            const w = 0.75 + (e.shared / maxShared) * 2.6
            const dim = hot ? !(e.a === hot || e.b === hot) : false
            const mx = (a.x + b.x) / 2
            const my = (a.y + b.y) / 2
            const off = Math.hypot(b.x - a.x, b.y - a.y) * 0.12
            return (
              <path key={e.a + e.b} ref={el => { edgeEls.current[i] = el }}
                d={`M ${a.x} ${a.y} Q ${mx + off * 0.2} ${my - off} ${b.x} ${b.y}`}
                fill="none" stroke={DIM} strokeWidth={w} strokeLinecap="round" opacity={dim ? 0.08 : 0.34} />
            )
          })}

          {data.nodes.map(n => {
            const p = pos.get(n.key)
            if (!p) return null
            const dim = (hot && !near.has(n.key)) || !match(n.key)
            const done = goal != null && n.counter >= goal
            const spent = n.pool ? n.burned / n.pool : 0
            const R = n.owned ? 13 + Math.min(9, Math.sqrt(n.owned) * 2.2) : 8
            const clip = 'v2clip-' + n.key.replace(/\W/g, '')
            return (
              <g key={n.key} data-node
                ref={el => { if (el) nodeEls.current.set(n.key, el); else nodeEls.current.delete(n.key) }}
                transform={`translate(${p.x} ${p.y})`}
                opacity={dim ? 0.22 : 1}
                style={{ cursor: 'pointer', transition: 'opacity .18s' }}
                onMouseEnter={() => setHot(n.key)}
                onMouseLeave={() => setHot(null)}
                onPointerDown={onNodeDown(n.key)}
                onClick={() => setPick(pick === n.key ? null : n.key)}
              >
                {n.owned && n.icon ? (
                  <>
                    <circle r={R + 3.5} fill="none" stroke={FG} strokeOpacity={0.1} strokeWidth={2} />
                    <circle r={R + 3.5} fill="none" stroke={done ? AC : FG} strokeOpacity={done ? 0.9 : 0.5} strokeWidth={2}
                      strokeDasharray={`${2 * Math.PI * (R + 3.5) * spent} ${2 * Math.PI * (R + 3.5)}`} transform="rotate(-90)" />
                    <clipPath id={clip}><circle r={R} /></clipPath>
                    <image href={steamIcon(n.icon, 128)} x={-R} y={-R} width={R * 2} height={R * 2}
                      preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clip})`} />
                  </>
                ) : (
                  <circle r={2.4} fill={DIM} opacity={0.75} />
                )}
                <Label x={0} y={n.owned ? R + 14 : 12} text={n.key} size={n.owned ? 13 : 12} weight={n.owned ? 500 : 400} fill={n.owned ? FG : DIM} />
              </g>
            )
          })}
        </g>
      </svg>

      {chosen ? (
        <div className="v2-net-card">
          <div className="v2-net-card-h">
            {chosen.icon ? <img src={steamIcon(chosen.icon, 64)} alt="" /> : null}
            <b>{chosen.key}</b>
          </div>
          <dl className="v2-rows">
            <div><dt>счётчик</dt><dd className="v2-num">{nf(chosen.counter)}{goal != null ? ' / ' + nf(goal) : ' · цель не задана'}</dd></div>
            <div><dt>потолок</dt><dd className="v2-num">{nf(chosen.pool)}</dd></div>
            <div><dt>израсходовано</dt><dd className="v2-num">{nf(chosen.burned)}</dd></div>
            <div><dt>вещей</dt><dd className="v2-num">{chosen.owned ? nf(chosen.owned) : 'нет'}</dd></div>
            {chosen.price != null ? <div><dt>цена</dt><dd className="v2-num">{'$' + chosen.price.toFixed(2)}</dd></div> : null}
          </dl>
          <p className="v2-hint">
            общих матчей с соседями: {nf(data.edges.filter(e => e.a === chosen.key || e.b === chosen.key).reduce((n, e) => n + e.shared, 0))}
          </p>
        </div>
      ) : null}

      <div className="v2-ov-zoom">
        <IconBtn label="Приблизить" tip="left" onClick={() => zoom(1.25)}><Plus size={15} /></IconBtn>
        <IconBtn label="Отдалить" tip="left" onClick={() => zoom(1 / 1.25)}><Minus size={15} /></IconBtn>
        <IconBtn label="Вписать" tip="left" onClick={fit}><Maximize size={15} /></IconBtn>
      </div>
      <p className="v2-hint v2-net-tip">тянуть узел — закрепить · фон — панорама · колесо — зум</p>
    </>
  )
}
