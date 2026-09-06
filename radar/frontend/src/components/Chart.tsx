import { useMemo, useState } from 'react'

/**
 * A small SVG plotting kit. No charting library: the shapes needed here are a
 * line, an area and a bar, and a dependency would cost more than it saves.
 *
 * Everything is drawn in a fixed 0..100 user space and stretched by the
 * viewBox, so a chart fits whatever column it lands in without measuring the
 * DOM. `preserveAspectRatio="none"` would distort strokes, so line width is
 * given in absolute units via `vectorEffect`.
 */

export type Point = { x: number; y: number; label?: string }

export type Series = {
  name: string
  color: string
  points: Point[]
  /** Fill the area under the line. Use for one dominant series only. */
  area?: boolean
  /** Draw as a dashed line: good for a reference such as the order price. */
  dashed?: boolean
}

const W = 100
const H = 100

function scale(series: Series[]) {
  const xs = series.flatMap((s) => s.points.map((p) => p.x))
  const ys = series.flatMap((s) => s.points.map((p) => p.y))
  if (xs.length === 0) return null
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(0, ...ys)
  // Headroom, or the topmost series is drawn exactly on the frame and loses
  // half its stroke to the clip. A flat line at the maximum is the common case
  // here — a gem whose price has not moved — and it must still look like a line.
  const rawMax = Math.max(...ys)
  const maxY = rawMax + (rawMax - minY || Math.abs(rawMax) || 1) * 0.08
  const spanX = maxX - minX || 1
  const spanY = maxY - minY || 1
  return {
    minX,
    maxX,
    minY,
    maxY: rawMax,
    x: (v: number) => ((v - minX) / spanX) * W,
    y: (v: number) => H - ((v - minY) / spanY) * H,
  }
}

function path(points: Point[], s: NonNullable<ReturnType<typeof scale>>): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${s.x(p.x).toFixed(2)},${s.y(p.y).toFixed(2)}`).join(' ')
}

/** A line chart with an optional filled area and a hover readout. */
export function LineChart({
  series,
  height = 140,
  format = (v: number) => String(Math.round(v)),
  formatX,
  empty = 'Данных пока нет',
}: {
  series: Series[]
  height?: number
  format?: (v: number) => string
  formatX?: (v: number) => string
  empty?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const withPoints = series.filter((s) => s.points.length > 0)
  const s = useMemo(() => scale(withPoints), [withPoints])

  if (!s || withPoints.every((x) => x.points.length < 2)) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-line-soft bg-panel-2/40 text-xs text-faint"
        style={{ height }}
      >
        {empty}
      </div>
    )
  }

  // The hover readout follows the densest series, which is the one the
  // operator is most likely reading.
  const primary = withPoints.reduce((a, b) => (b.points.length > a.points.length ? b : a))
  const hoverPoint = hover === null ? null : primary.points[hover]

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ height, width: '100%' }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect()
          const rel = ((e.clientX - box.left) / box.width) * W
          let best = 0
          let bestDist = Infinity
          primary.points.forEach((p, i) => {
            const d = Math.abs(s.x(p.x) - rel)
            if (d < bestDist) {
              bestDist = d
              best = i
            }
          })
          setHover(best)
        }}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1="0"
            x2={W}
            y1={H * f}
            y2={H * f}
            stroke="currentColor"
            strokeOpacity="0.08"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            className="text-text"
          />
        ))}

        {withPoints.map((serie) => (
          <g key={serie.name}>
            {serie.area && serie.points.length > 1 && (
              <path
                d={`${path(serie.points, s)} L${s.x(serie.points[serie.points.length - 1].x).toFixed(2)},${H} L${s.x(serie.points[0].x).toFixed(2)},${H} Z`}
                fill={serie.color}
                fillOpacity="0.12"
              />
            )}
            <path
              d={path(serie.points, s)}
              fill="none"
              stroke={serie.color}
              strokeWidth="1.6"
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={serie.dashed ? '4 3' : undefined}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}

        {hoverPoint && (
          <line
            x1={s.x(hoverPoint.x)}
            x2={s.x(hoverPoint.x)}
            y1="0"
            y2={H}
            stroke="currentColor"
            strokeOpacity="0.35"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            className="text-text"
          />
        )}
      </svg>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
        {withPoints.map((serie) => {
          // Look the value up by timestamp, not by index. Series here are not
          // parallel: "верхний ордер" only has points where an order existed,
          // so indexing it with the median series' position printed a value
          // from a different moment — or a stale last value for a gap.
          const value = hoverPoint
            ? serie.points.find((p) => p.x === hoverPoint.x)?.y
            : serie.points[serie.points.length - 1]?.y
          return (
            <span key={serie.name} className="inline-flex items-center gap-1.5 text-faint">
              <span
                className="inline-block h-0.5 w-3 rounded"
                style={{ background: serie.color, opacity: serie.dashed ? 0.6 : 1 }}
              />
              {serie.name}
              <span className="font-mono text-text">{value === undefined ? '—' : format(value)}</span>
            </span>
          )
        })}
        <span className="ml-auto font-mono text-faint">
          {hoverPoint && formatX ? formatX(hoverPoint.x) : formatX ? formatX(s.maxX) : ''}
        </span>
      </div>
    </div>
  )
}

/** A horizontal distribution: how many offers fall into each profit band. */
export function Histogram({
  bins,
  color = 'var(--color-accent)',
  format = (v: number) => String(v),
}: {
  bins: { label: string; count: number; negative?: boolean }[]
  color?: string
  format?: (v: number) => string
}) {
  const max = Math.max(1, ...bins.map((b) => b.count))
  if (bins.every((b) => b.count === 0)) {
    return (
      <div className="rounded-lg border border-line-soft bg-panel-2/40 px-3 py-6 text-center text-xs text-faint">
        Нечего распределять — пока ни одного оценённого оффера.
      </div>
    )
  }
  return (
    <ul className="space-y-1.5">
      {bins.map((b) => (
        <li key={b.label} className="flex items-center gap-3 text-xs">
          <span className="w-28 shrink-0 text-right font-mono text-faint">{b.label}</span>
          <span className="h-3 flex-1 overflow-hidden rounded bg-panel-3">
            <span
              className="bar-grow block h-full rounded"
              style={{
                width: `${(b.count / max) * 100}%`,
                background: b.negative ? 'var(--color-danger)' : color,
                opacity: b.negative ? 0.6 : 0.85,
              }}
            />
          </span>
          <span className="w-8 shrink-0 font-mono text-text">{format(b.count)}</span>
        </li>
      ))}
    </ul>
  )
}
