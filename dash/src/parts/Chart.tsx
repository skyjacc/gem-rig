import { useMemo, useState } from 'react'
import { nf, useJson, type State } from '../lib/api.ts'

// Рост счётчиков — по вещам.
//
// По гемам график врал: рисовал максимум и умалчивал, что под линией
// «Liquid`ixmike88 7» лежат одна вещь на семи, одна на трёх, одна на единице
// и девять на нуле. Продаётся вещь, значит и смотреть надо на вещь.
//
// Сто двенадцать линий читать нельзя, поэтому одинаковые ветки слиты в одну
// с числом вещей: «BZZ ×70» вместо семидесяти совпадающих кривых. Слияние
// делает сервер, сюда приходит уже готовое.
//
// Линии гладкие, а не ломаные. Счётчик снимается раз в несколько часов,
// и прямые между срезами рисовали лестницу там, где на деле ровный подъём:
// углы читались как события, которых не было. Сглаживание монотонное —
// кривая не может провалиться ниже соседних точек, а счётчики только
// растут, и выдуманный спуск был бы прямой ложью.
//
// Заливка появляется только под наведённой веткой: несколько полупрозрачных
// пятен друг на друге читаются хуже, чем ничего.

type Line = { gem: string; points: (number | null)[]; items: number }
type Data = { stamps: number[]; lines: Line[] }

const W = 1200
const H = 340
const PAD = { top: 14, right: 56, bottom: 26, left: 10 }

// Цвет по гему, чтобы ветки одного гема читались вместе.
const HUES = [162, 235, 70, 304, 16, 190, 45, 265]
const colorOf = (gems: string[], gem: string) => `oklch(70% 0.16 ${HUES[gems.indexOf(gem) % HUES.length]})`

type Pt = { x: number; y: number }

// Монотонное сглаживание Фрича — Карлсона.
//
// Обычная кривая через точки норовит выгнуться за них: между 480 и 483 она
// нарисовала бы 477, то есть падение счётчика, которого не бывает. Здесь
// наклон в точке зажимается соседними, и такого провала не выходит.
function smooth(pts: Pt[]): string {
  const n = pts.length
  if (!n) return ''
  const at = (p: Pt) => p.x.toFixed(1) + ' ' + p.y.toFixed(1)
  if (n === 1) return 'M ' + at(pts[0])

  const dx: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x
    slope[i] = dx[i] ? (pts[i + 1].y - pts[i].y) / dx[i] : 0
  }

  const m: number[] = new Array(n)
  m[0] = slope[0]
  m[n - 1] = slope[n - 2]
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) { m[i] = 0; continue }
    const w1 = 2 * dx[i] + dx[i - 1]
    const w2 = dx[i] + 2 * dx[i - 1]
    m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i])
  }

  let d = 'M ' + at(pts[0])
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3
    d += ' C ' + (pts[i].x + h).toFixed(1) + ' ' + (pts[i].y + m[i] * h).toFixed(1)
      + ' ' + (pts[i + 1].x - h).toFixed(1) + ' ' + (pts[i + 1].y - m[i + 1] * h).toFixed(1)
      + ' ' + at(pts[i + 1])
  }
  return d
}

export function Chart({ state }: { state: State }) {
  const { data } = useJson<Data>('/api/counters', state.ts)
  const [hot, setHot] = useState<string | null>(null)
  // Срез под курсором: терминальное перекрестие. Не украшение: волна
  // отвечает на вопрос «сколько было тогда», а без перекрестия на него
  // можно было ответить только глазами, по сетке.
  const [at, setAt] = useState<number | null>(null)

  const laid = useMemo(() => {
    if (!data?.lines?.length || data.stamps.length < 2) return null
    const all = data.lines.flatMap(l => l.points).filter((v): v is number => v != null)
    const max = Math.max(...all, 1)
    const x = (i: number) => PAD.left + (i / (data.stamps.length - 1)) * (W - PAD.left - PAD.right)
    const y = (v: number) => H - PAD.bottom - (v / max) * (H - PAD.top - PAD.bottom)

    const gems = [...new Set(data.lines.map(l => l.gem))]
    const paths = data.lines.map((l, n) => {
      const pts: Pt[] = []
      l.points.forEach((v, i) => { if (v != null) pts.push({ x: x(i), y: y(v) }) })
      const d = smooth(pts)
      const end = pts[pts.length - 1] ?? { x: PAD.left, y: H - PAD.bottom }
      const lastIndex = l.points.length - 1 - [...l.points].reverse().findIndex(v => v != null)
      return {
        key: l.gem + ':' + n,
        gem: l.gem,
        items: l.items,
        d,
        // Заливка под веткой — тот же путь, замкнутый по низу.
        area: d ? d + ' L ' + end.x.toFixed(1) + ' ' + (H - PAD.bottom) + ' L ' + pts[0].x.toFixed(1) + ' ' + (H - PAD.bottom) + ' Z' : '',
        last: l.points[lastIndex] ?? 0,
        lx: end.x,
        ly: end.y,
      }
    }).sort((a, b) => a.last - b.last)

    // Сетка: круглые числа между нулём и вершиной.
    const step = Math.max(1, Math.round(max / 4 / 100) * 100 || Math.round(max / 4))
    const grid: number[] = []
    for (let v = step; v < max; v += step) grid.push(v)

    return { max, paths, gems, x, y, grid }
  }, [data])

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!laid) return
    const box = e.currentTarget.getBoundingClientRect()
    const rel = (e.clientX - box.left) / box.width * W
    const n = data!.stamps.length
    const i = Math.round((rel - PAD.left) / (W - PAD.left - PAD.right) * (n - 1))
    setAt(Math.max(0, Math.min(n - 1, i)))
  }

  if (!laid) {
    return <div className="px-4 py-10 text-center text-[12px] text-muted-foreground">срезов пока мало</div>
  }

  const { paths, gems, x, y, grid } = laid
  const stamps = data!.stamps
  const day = (t: number) => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
  const time = (t: number) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  // Легенда — по гемам, а не по веткам. Веток четыреста двадцать четыре:
  // у каждой вещи Virtus.pro свой счётчик, и четыреста кнопок под графиком
  // читать невозможно. Гемов одиннадцать, и наведение на гем всё равно
  // подсвечивает все его ветки разом.
  const legend = [...new Map(paths.map(p => [p.gem, p])).keys()].map(gem => {
    const mine = paths.filter(p => p.gem === gem)
    const values = mine.map(p => p.last)
    return {
      gem,
      items: mine.reduce((n, p) => n + p.items, 0),
      low: Math.min(...values),
      high: Math.max(...values),
    }
  }).sort((a, b) => b.high - a.high)

  // Значения гемов на срезе под перекрестием: верхняя ветка гема и,
  // если вещи разъехались, разброс.
  const readout = at != null
    ? gems.map(gem => {
        const vals = data!.lines
          .filter(l => l.gem === gem)
          .map(l => l.points[at])
          .filter((v): v is number => v != null)
        if (!vals.length) return null
        return { gem, low: Math.min(...vals), high: Math.max(...vals) }
      }).filter(Boolean as unknown as (v: unknown) => boolean)
        .sort((a: any, b: any) => b.high - a.high)
    : null

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full"
        onMouseLeave={() => { setHot(null); setAt(null) }}
        onMouseMove={onMove}
      >
        {grid.map(v => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="white" strokeOpacity={0.05} />
            <text x={W - PAD.right + 8} y={y(v) + 3.5} fontSize={11} className="fill-white/55">{nf(v)}</text>
          </g>
        ))}
        <line
          x1={PAD.left} x2={W - PAD.right}
          y1={H - PAD.bottom} y2={H - PAD.bottom}
          stroke="white" strokeOpacity={0.1}
        />

        {paths.map(p => {
          const dim = hot != null && hot !== p.gem
          const lit = hot === p.gem
          return (
            <g key={p.key} opacity={dim ? 0.08 : 1} style={{ transition: 'opacity .15s' }}>
              {lit ? <path d={p.area} fill={colorOf(gems, p.gem)} fillOpacity={0.07} /> : null}
              <path
                d={p.d}
                fill="none"
                stroke={colorOf(gems, p.gem)}
                strokeWidth={lit ? 2.4 : p.items > 1 ? 1.6 : 1}
                strokeOpacity={lit ? 1 : p.items > 1 ? 0.9 : 0.55}
                strokeLinecap="round"
              />
              <circle cx={p.lx} cy={p.ly} r={lit ? 3.4 : p.items > 1 ? 2.4 : 1.6} fill={colorOf(gems, p.gem)} />
            </g>
          )
        })}

        {/* Перекрестие: линия среза и точки на верхних ветках гемов */}
        {at != null ? (
          <g pointerEvents="none">
            <line
              x1={x(at)} x2={x(at)}
              y1={PAD.top - 6} y2={H - PAD.bottom}
              stroke="white" strokeOpacity={0.22} strokeDasharray="3 4"
            />
            {gems.map(gem => {
              const top = Math.max(...data!.lines
                .filter(l => l.gem === gem)
                .map(l => l.points[at] ?? -1))
              if (top < 0) return null
              return <circle key={gem} cx={x(at)} cy={y(top)} r={hot === gem ? 4 : 2.8} fill={colorOf(gems, gem)} />
            })}
          </g>
        ) : null}

        {/* Даты: начало, четверти, конец — чтобы «когда» читалось без линейки */}
        {[0.25, 0.5, 0.75].map(f => {
          const i = Math.round(f * (stamps.length - 1))
          return (
            <text
              key={f}
              x={x(i)} y={H - 6} fontSize={11}
              textAnchor="middle" className="fill-white/55"
            >{day(stamps[i])}</text>
          )
        })}
        <text x={PAD.left} y={H - 6} fontSize={11} className="fill-white/55">{day(stamps[0])}</text>
        <text x={W - PAD.right} y={H - 6} fontSize={11} textAnchor="end" className="fill-white/55">
          {day(stamps[stamps.length - 1])}
        </text>
      </svg>

      {/* Табло перекрестия: моно, как строка терминала. Появляется только
          под курсором и не двигает график. */}
      {readout && readout.length ? (
        <div className="pointer-events-none absolute left-2 top-2 border border-white/[0.08] bg-[#0a0a0a]/92 px-2.5 py-2 backdrop-blur-sm">
          <div className="tnum font-mono text-[11px] text-muted-foreground">{time(stamps[at!])}</div>
          <div className="mt-1 space-y-0.5">
            {readout.slice(0, 7).map((r: any) => (
              <div key={r.gem} className="flex items-baseline gap-2 font-mono text-[11.5px] leading-4">
                <span className="h-[2px] w-3 shrink-0 rounded-full" style={{ background: colorOf(gems, r.gem) }} />
                <span className="max-w-[130px] truncate text-foreground/85">{r.gem}</span>
                <span className="tnum ml-auto text-foreground">
                  {r.low === r.high ? nf(r.high) : nf(r.low) + '…' + nf(r.high)}
                </span>
              </div>
            ))}
            {readout.length > 7 ? (
              <div className="pl-5 font-mono text-[11px] text-muted-foreground">+{readout.length - 7}</div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-white/[0.06] pt-3">
        {legend.map(g => (
          <button
            key={g.gem}
            type="button"
            onMouseEnter={() => setHot(g.gem)}
            onMouseLeave={() => setHot(null)}
            className="flex items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="h-[2px] w-3 shrink-0 rounded-full" style={{ background: colorOf(gems, g.gem) }} />
            <span className="truncate">{g.gem}</span>
            <span className="tnum font-mono text-[11px] text-muted-foreground/75">×{g.items}</span>
            <span className="tnum font-mono text-foreground/80">
              {g.low === g.high ? nf(g.high) : nf(g.low) + '…' + nf(g.high)}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
