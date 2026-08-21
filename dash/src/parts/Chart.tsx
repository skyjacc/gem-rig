import { useMemo, useState } from 'react'

// График роста счётчиков.
//
// Своими руками, без библиотеки: рядов четыре, точек сорок, а любая
// библиотека графиков весит больше всей панели и тянет свою типографику,
// которую потом надо переучивать под наше оформление.
//
// Линии волосяные, как связи в графе. Заливки нет: четыре полупрозрачных
// пятна друг на друге читаются хуже, чем четыре линии.

export type Series = { gem: string; points: (number | null)[] }

const W = 640
const H = 150
const PAD = { top: 10, right: 8, bottom: 18, left: 8 }

export function Chart({
  stamps,
  series,
  colors,
}: {
  stamps: number[]
  series: Series[]
  colors: string[]
}) {
  const [hot, setHot] = useState<string | null>(null)

  const laid = useMemo(() => {
    const all = series.flatMap(s => s.points).filter((v): v is number => v != null)
    if (!all.length || stamps.length < 2) return null
    const max = Math.max(...all, 1)
    const x = (i: number) => PAD.left + (i / (stamps.length - 1)) * (W - PAD.left - PAD.right)
    const y = (v: number) => H - PAD.bottom - (v / max) * (H - PAD.top - PAD.bottom)

    const paths = series.map(s => {
      let d = ''
      let started = false
      s.points.forEach((v, i) => {
        if (v == null) return
        d += (started ? ' L ' : 'M ') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)
        started = true
      })
      const last = [...s.points].reverse().find(v => v != null) ?? 0
      const lastIndex = s.points.length - 1 - [...s.points].reverse().findIndex(v => v != null)
      return { gem: s.gem, d, last, lx: x(lastIndex), ly: y(last) }
    })
    return { max, paths }
  }, [stamps, series])

  if (!laid) {
    return <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">срезов пока мало</div>
  }

  const from = new Date(stamps[0]).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
  const to = new Date(stamps[stamps.length - 1]).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" onMouseLeave={() => setHot(null)}>
        <line
          x1={PAD.left} x2={W - PAD.right}
          y1={H - PAD.bottom} y2={H - PAD.bottom}
          stroke="white" strokeOpacity={0.08}
        />
        {laid.paths.map((p, i) => {
          const dim = hot && hot !== p.gem
          return (
            <g key={p.gem} opacity={dim ? 0.18 : 1} style={{ transition: 'opacity .15s' }}>
              <path d={p.d} fill="none" stroke={colors[i % colors.length]} strokeWidth={1.25} strokeLinecap="round" />
              <circle cx={p.lx} cy={p.ly} r={2} fill={colors[i % colors.length]} />
            </g>
          )
        })}
        <text x={PAD.left} y={H - 5} fontSize={10} className="fill-white/35">{from}</text>
        <text x={W - PAD.right} y={H - 5} fontSize={10} textAnchor="end" className="fill-white/35">{to}</text>
      </svg>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {laid.paths.map((p, i) => (
          <button
            key={p.gem}
            type="button"
            onMouseEnter={() => setHot(p.gem)}
            onMouseLeave={() => setHot(null)}
            className="flex items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="h-[2px] w-3 shrink-0" style={{ background: colors[i % colors.length] }} />
            <span>{p.gem}</span>
            <span className="tnum font-mono text-foreground/80">{p.last}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
