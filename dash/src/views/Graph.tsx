import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, GitBranch, Minus, Network, Plus, Search } from 'lucide-react'
import { icon as steamIcon, nf, useJson, type GraphData, type State } from '../lib/api.ts'
import { seed, step, type Link, type Sim } from '../lib/force.ts'
import { RowsSkeleton } from '../parts/ui.tsx'

// Граф.
//
// Оформление узла и связи снято с osint-catalog.xyz/graph: точка радиусом
// 1,35, подпись с обводкой цветом фона (paint-order: stroke), связь —
// кубическая кривая волосяной толщины, всё на прозрачном полотне с панорамой
// и зумом. Никаких карточек и рамок: читается типографика, а не коробки.
//
// Два режима, потому что данные разной природы.
//
//   Дерево   аккаунт → гем → турниры. Из чего состоит потолок гема.
//   Сеть     сущности и общие матчи. Что выгодно держать вместе:
//            общий матч — одна отправка, счётчик обеим сущностям.
//
// Их граф — дерево. Наше дерево сделано так же. Сеть — то, чего у них нет,
// потому что у них нет пересечений.

// Уважает ли человек «уменьшить движение». Хук, а не константа: настройку
// меняют на ходу, и панель открыта часами.
function useCalm() {
  const [calm, setCalm] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const m = matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setCalm(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return calm
}

const FG = '#f4f4f5'
const DIM = '#d4d4d8'
const BG = '#0a0a0a'

type TreeNode = {
  id: string
  label: string
  kind: 'root' | 'gem' | 'league'
  value: number
  burned?: number
  counter?: number
  icon?: string
  children?: TreeNode[]
}

type View = { x: number; y: number; k: number }

export function Graph({ state }: { state: State }) {
  const [mode, setMode] = useState<'tree' | 'net'>('tree')
  const wrap = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1200, h: 800 })

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
    <div ref={wrap} className="relative h-full w-full overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center p-3">
        <div className="pointer-events-auto inline-flex items-stretch">
          <Ctl active={mode === 'tree'} onClick={() => setMode('tree')}>
            <GitBranch className="h-3.5 w-3.5" />
            <span>дерево</span>
          </Ctl>
          <Ctl active={mode === 'net'} onClick={() => setMode('net')} join>
            <Network className="h-3.5 w-3.5" />
            <span>сеть</span>
          </Ctl>
        </div>
      </div>

      {mode === 'tree'
        ? <Tree state={state} size={size} />
        : <Net state={state} size={size} />}
    </div>
  )
}

function Ctl({
  active, join, onClick, children,
}: { active?: boolean; join?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'floating ui-label inline-flex h-9 items-center gap-1.5 px-2.5 transition-colors ' +
        (join ? 'border-l border-white/[0.08] ' : '') +
        (active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')
      }
      style={active ? { background: 'rgba(255,255,255,0.08)' } : undefined}
    >
      {children}
    </button>
  )
}

// ── общая механика полотна: панорама, зум, вписать ──

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
    setView({
      k,
      x: size.w / 2 - ((e.x1 + e.x2) / 2) * k,
      y: size.h / 2 - ((e.y1 + e.y2) / 2) * k,
    })
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

  return { view, setView, fit, zoom, handlers: { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp, onWheel } }
}

function Zoomer({ onZoom, onFit }: { onZoom: (f: number) => void; onFit: () => void }) {
  return (
    <div className="pointer-events-auto absolute bottom-3 right-3 z-20 flex flex-col">
      <Ctl onClick={() => onZoom(1.25)}><Plus className="h-3.5 w-3.5" /></Ctl>
      <Ctl onClick={() => onZoom(1 / 1.25)}><Minus className="h-3.5 w-3.5" /></Ctl>
      <Ctl onClick={onFit}><Crosshair className="h-3.5 w-3.5" /></Ctl>
    </div>
  )
}

// Подпись как у них: обводка цветом фона, чтобы читалась поверх связей.
function Label({
  x, y, anchor, text, size = 12.5, weight = 400, fill = DIM, opacity = 1,
}: {
  x: number; y: number; anchor: 'start' | 'end'; text: string
  size?: number; weight?: number; fill?: string; opacity?: number
}) {
  return (
    <text
      x={x} y={y}
      dominantBaseline="middle"
      textAnchor={anchor}
      fill={fill}
      stroke={BG}
      strokeWidth={3}
      paintOrder="stroke"
      strokeLinejoin="round"
      fontSize={size}
      fontWeight={weight}
      letterSpacing="-0.015em"
      opacity={opacity}
      style={{ pointerEvents: 'none' }}
    >
      {text}
    </text>
  )
}

// ── дерево ──

const LEVEL = 340
const ROW = 26

type Placed = { node: TreeNode; x: number; y: number; depth: number; parent: Placed | null }

function Tree({ state, size }: { state: State; size: { w: number; h: number } }) {
  const { data, loading, error, reload } = useJson<TreeNode>('/api/tree?top=12', state.ts)
  const [open, setOpen] = useState<Set<string>>(new Set(['root']))
  const [hot, setHot] = useState<string | null>(null)

  const placed = useMemo(() => {
    if (!data) return []
    const out: Placed[] = []
    let y = 0
    const walk = (n: TreeNode, depth: number, parent: Placed | null) => {
      const kids = open.has(n.id) ? (n.children ?? []) : []
      const first = y
      if (!kids.length) {
        const p: Placed = { node: n, x: depth * LEVEL, y: y * ROW, depth, parent }
        out.push(p)
        y++
        return p
      }
      const self: Placed = { node: n, x: depth * LEVEL, y: 0, depth, parent }
      out.push(self)
      const children = kids.map(k => walk(k, depth + 1, self))
      self.y = (children[0].y + children[children.length - 1].y) / 2
      void first
      return self
    }
    walk(data, 0, null)
    return out
  }, [data, open])

  const extent = useCallback(() => {
    if (!placed.length) return null
    const xs = placed.map(p => p.x)
    const ys = placed.map(p => p.y)
    return { x1: Math.min(...xs) - 160, y1: Math.min(...ys), x2: Math.max(...xs) + 220, y2: Math.max(...ys) }
  }, [placed])

  const { view, fit, zoom, handlers } = useCanvas(size, extent)
  const fitted = useRef(false)
  useEffect(() => {
    if (!fitted.current && placed.length) { fitted.current = true; fit() }
  }, [placed.length, fit])

  const toggle = (id: string) => setOpen(s => {
    const n = new Set(s)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })

  const goal = state.autopilot.goal || 2000

  if (error) return <Fail title="дерево не собралось" text={error} onRetry={reload} busy={loading} />
  if (!data) {
    return (
      <div className="h-full overflow-auto p-6">
        <RowsSkeleton rows={9} cols={[190, 80, 120, 90]} />
      </div>
    )
  }

  return (
    <>
      <svg
        className="h-full w-full touch-none select-none"
        {...handlers}
        style={{ cursor: 'grab' }}
      >
        <defs>
          <filter id="logo-shadow" x="-60%" y="-60%" width="220%" height="220%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="#000" floodOpacity="0.72" />
          </filter>
        </defs>

        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {placed.filter(p => p.parent).map(p => {
            const a = p.parent!
            const mx = a.x + (p.x - a.x) * 0.48
            const dim = hot ? hot !== p.node.id && hot !== a.node.id : false
            return (
              <path
                key={'e' + p.node.id}
                d={`M ${a.x} ${a.y} C ${mx} ${a.y}, ${p.x - (p.x - mx)} ${p.y}, ${p.x} ${p.y}`}
                fill="none"
                stroke={DIM}
                strokeWidth={0.75}
                strokeLinecap="round"
                opacity={dim ? 0.14 : 0.52}
                className="tree-edge"
              />
            )
          })}

          {placed.map(p => {
            const n = p.node
            const kids = n.children?.length ?? 0
            const isOpen = open.has(n.id)
            const root = n.kind === 'root'
            const gem = n.kind === 'gem'
            const dim = hot ? hot !== n.id && p.parent?.node.id !== hot && !(n.children ?? []).some(c => c.id === hot) : false
            const label = n.label + (n.kind === 'league' ? '  ' + nf(n.value) : gem ? '  ' + nf(n.counter ?? 0) + ' / ' + nf(goal) : '')
            return (
              <g
                key={n.id}
                data-node
                tabIndex={kids ? 0 : -1}
                role={kids ? 'button' : undefined}
                aria-expanded={kids ? isOpen : undefined}
                aria-label={kids ? label + ', раскрыть' : undefined}
                transform={`translate(${p.x} ${p.y})`}
                opacity={dim ? 0.32 : 1}
                style={{ cursor: kids ? 'pointer' : 'default' }}
                onMouseEnter={() => setHot(n.id)}
                onMouseLeave={() => setHot(null)}
                onFocus={() => setHot(n.id)}
                onBlur={() => setHot(null)}
                onClick={() => kids && toggle(n.id)}
                onKeyDown={e => {
                  if (!kids || (e.key !== 'Enter' && e.key !== ' ')) return
                  e.preventDefault()
                  toggle(n.id)
                }}
              >
                <rect x={root ? -140 : -10} y={-13} width={root ? 150 : 260} height={26} fill="transparent" />
                {gem && n.icon ? (
                  <image
                    href={steamIcon(n.icon, 64)}
                    x={-13} y={-13} width={26} height={26}
                    preserveAspectRatio="xMidYMid slice"
                    filter="url(#logo-shadow)"
                    opacity={0.95}
                  />
                ) : (
                  <circle r={1.35} fill={root ? FG : DIM} />
                )}
                {kids ? (
                  <circle cx={gem ? 236 : 244} r={1.35} fill={FG} opacity={isOpen ? 0.9 : 0.25} className="out-dot" />
                ) : null}
                <Label
                  x={root ? -22 : gem ? 20 : 14}
                  y={0}
                  anchor={root ? 'end' : 'start'}
                  text={label}
                  size={root ? 13 : gem ? 13 : 12.5}
                  weight={root || gem ? 500 : 400}
                  fill={root || gem ? FG : DIM}
                />
                {gem && n.burned ? (
                  <rect x={20} y={9} width={Math.min(210, (n.burned / Math.max(1, n.value)) * 210)} height={1.5} fill={FG} opacity={0.35} />
                ) : null}
              </g>
            )
          })}
        </g>
      </svg>
      <Zoomer onZoom={zoom} onFit={fit} />
      <Hint text="клик по узлу — раскрыть · тянуть — панорама · колесо — зум" />
    </>
  )
}

// ── сеть ──

function Net({ state, size }: { state: State; size: { w: number; h: number } }) {
  const calm = useCalm()
  const [scope, setScope] = useState<'owned' | 'all'>('owned')
  const [q, setQ] = useState('')
  const { data, loading, error, reload } = useJson<GraphData>('/api/graph?scope=' + scope, state.ts)
  const [hot, setHot] = useState<string | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const alpha = useRef(1)
  const grab = useRef<{ key: string; dx: number; dy: number } | null>(null)
  const sims = useRef<Sim[]>([])

  const shape = useMemo(() => (data?.nodes ?? []).map(n => n.key).join('|'), [data])

  // Стартовая раскладка — при первом рендере, чтобы узлы не мелькали
  // в левом верхнем углу до первого кадра. Идемпотентно: эффект ниже
  // перезасеет теми же числами.
  if (!sims.current.length && shape) {
    sims.current = seed(shape.split('|'), size.w, size.h)
    alpha.current = 1
  }

  // Раскладка пересобирается, когда меняется СОСТАВ узлов, а не когда
  // приходит новый ответ. Зависимость от самого ответа означала, что каждый
  // перезапрос — а он шёл на каждый толчок состояния, то есть примерно раз
  // в секунду — сбрасывал раскладку в исходное и разгонял её заново: граф
  // дёргался всё время, пока идёт работа, и рассмотреть его было нельзя.
  useEffect(() => {
    if (!shape) return
    sims.current = seed(shape.split('|'), size.w, size.h)
    alpha.current = 1
  }, [shape, size.w, size.h])

  // Ширина ребра и сила связи живут на одном максимуме. Считать максимум
  // внутри карты по всем рёбрам значило пересчитывать его 896 раз за проход
  // — и так на каждый кадр, пока шла укладка.
  const maxShared = useMemo(
    () => Math.max(...(data?.edges ?? []).map(e => e.shared), 1), [data])
  const links: Link[] = useMemo(() => {
    if (!data?.edges?.length) return []
    return data.edges.map(e => ({ a: e.a, b: e.b, w: e.shared / maxShared }))
  }, [data, maxShared])

  // Кадр пишется прямо в атрибуты, мимо примирения React.
  //
  // На полном каталоге это 896 путей рёбер и 47 групп узлов. Прежний кадр
  // гнал их через setState: React пересобирал и сверял около тысячи
  // элементов шестьдесят раз в секунду восемь секунд укладки — и столько же
  // при каждом перетаскивании узла. Теперь структура монтируется один раз,
  // а кадр — это только setAttribute, без виртуального дерева.
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

  // Считаем, пока раскладка не устоялась. Устоялась — засыпаем: держать
  // шестьдесят кадров в секунду ради неподвижной картинки незачем.
  //
  // При «уменьшить движение» цикла нет вовсе. Это самая большая анимация
  // в панели — полсотни узлов, которые расходятся полминуты, — и оба
  // правила prefers-reduced-motion в index.css её не касаются: она живёт
  // в requestAnimationFrame, а не в CSS. Раскладка досчитывается разом
  // и рисуется один раз, уже стоящей.
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

  // Любой повторный рендер возвращает управляемые атрибуты к значениям
  // из JSX — positions из снимка на момент рендера. Возвращаем реальные
  // сразу после фиксации, до боли.
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

  if (error) {
    return (
      <Fail
        title="сеть пересечений не собралась"
        text={error}
        onRetry={reload}
        busy={loading}
      />
    )
  }
  if (!data) return <Hint text="считаю пересечения…" />

  const goal = state.autopilot.goal || 2000
  const byKey = new Map(data.nodes.map(n => [n.key, n]))
  const pos = new Map(sims.current.map(s => [s.key, s]))
  // Соседи подсвеченного: один проход по рёбрам на рендер. Рендеры здесь
  // редкие — наведение и выбор, — поэтому без хука: он стоял после ранних
  // выходов и менял число хуков между рендерами, от чего экран падал.
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
      <div className="pointer-events-none absolute inset-x-0 top-16 z-20 flex justify-center px-3">
        <div className="pointer-events-auto inline-flex items-stretch">
          <Ctl active={scope === 'owned'} onClick={() => setScope('owned')}>мои</Ctl>
          <Ctl active={scope === 'all'} onClick={() => setScope('all')} join>весь каталог</Ctl>
          <span className="floating inline-flex h-9 items-center gap-2 border-l border-white/[0.08] px-3">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="найти"
              className="ui-label w-28 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/75"
            />
          </span>
        </div>
      </div>

      <svg
        className="h-full w-full touch-none select-none"
        {...handlers}
        onPointerMove={e => { handlers.onPointerMove(e); onNodeMove(e) }}
        onPointerUp={e => { handlers.onPointerUp(); onNodeUp(); void e }}
        style={{ cursor: 'grab' }}
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
              <path
                key={e.a + e.b}
                ref={el => { edgeEls.current[i] = el }}
                d={`M ${a.x} ${a.y} Q ${mx + off * 0.2} ${my - off} ${b.x} ${b.y}`}
                fill="none"
                stroke={DIM}
                strokeWidth={w}
                strokeLinecap="round"
                opacity={dim ? 0.08 : 0.34}
              />
            )
          })}

          {data.nodes.map(n => {
            const p = pos.get(n.key)
            if (!p) return null
            const dim = (hot && !near.has(n.key)) || !match(n.key)
            const done = n.counter >= goal
            const spent = n.pool ? n.burned / n.pool : 0
            const R = n.owned ? 13 + Math.min(9, Math.sqrt(n.owned) * 2.2) : 8
            return (
              <g
                key={n.key}
                data-node
                ref={el => {
                  if (el) nodeEls.current.set(n.key, el)
                  else nodeEls.current.delete(n.key)
                }}
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
                    <circle
                      r={R + 3.5}
                      fill="none"
                      stroke={done ? 'oklch(69.6% 0.17 162.48)' : FG}
                      strokeOpacity={done ? 0.9 : 0.5}
                      strokeWidth={2}
                      strokeDasharray={`${2 * Math.PI * (R + 3.5) * spent} ${2 * Math.PI * (R + 3.5)}`}
                      transform="rotate(-90)"
                    />
                    <clipPath id={'clip-' + n.key.replace(/\W/g, '')}>
                      <circle r={R} />
                    </clipPath>
                    <image
                      href={steamIcon(n.icon, 128)}
                      x={-R} y={-R} width={R * 2} height={R * 2}
                      preserveAspectRatio="xMidYMid slice"
                      clipPath={`url(#clip-${n.key.replace(/\W/g, '')})`}
                    />
                  </>
                ) : (
                  <circle r={2.4} fill={DIM} opacity={0.75} />
                )}
                <Label
                  x={0}
                  y={n.owned ? R + 14 : 12}
                  anchor="start"
                  text={n.key}
                  size={n.owned ? 13 : 12}
                  weight={n.owned ? 500 : 400}
                  fill={n.owned ? FG : DIM}
                />
              </g>
            )
          })}
        </g>
      </svg>

      {chosen ? (
        <div className="floating absolute bottom-3 left-3 z-20 w-[280px] p-4">
          <div className="flex items-center gap-2.5">
            {chosen.icon ? <img src={steamIcon(chosen.icon, 64)} alt="" className="h-8 w-8 border border-white/[0.06]" /> : null}
            <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{chosen.key}</span>
          </div>
          <dl className="mt-3 space-y-1.5 text-[12px]">
            <Row k="счётчик" v={nf(chosen.counter) + ' / ' + nf(goal)} />
            <Row k="потолок" v={nf(chosen.pool)} />
            <Row k="израсходовано" v={nf(chosen.burned)} />
            <Row k="вещей" v={chosen.owned ? String(chosen.owned) : 'нет'} />
            {chosen.price != null ? <Row k="цена" v={'$' + chosen.price.toFixed(2)} /> : null}
          </dl>
          <div className="mt-3 text-[12px] text-muted-foreground">
            общих матчей с соседями:{' '}
            {nf(data.edges.filter(e => e.a === chosen.key || e.b === chosen.key).reduce((n, e) => n + e.shared, 0))}
          </div>
        </div>
      ) : null}

      <Zoomer onZoom={zoom} onFit={fit} />
      <Hint text="тянуть узел — закрепить · фон — панорама · колесо — зум" />
    </>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="tnum font-mono">{v}</dd>
    </div>
  )
}

// Полотно во весь экран не может показать ошибку строчкой внизу: её там
// никто не увидит. Поэтому поломка занимает середину и говорит, что делать.
function Fail({ title, text, onRetry, busy }: { title: string; text: string; onRetry: () => void; busy: boolean }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="max-w-[420px] text-center">
        <div className="text-[15px]" style={{ color: 'var(--stop)' }}>{title}</div>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{text}</p>
        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground/70">
          Граф считается по локальной карте матчей. Если её ещё не строили,
          считать нечего: запустите обход — node rig/crawl.ts.
        </p>
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          className="floating ui-label mt-4 inline-flex h-9 items-center px-3 text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          {busy ? 'считаю…' : 'ещё раз'}
        </button>
      </div>
    </div>
  )
}

function Hint({ text }: { text: string }) {
  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2 text-[11px] text-muted-foreground/75">
      {text}
    </div>
  )
}
