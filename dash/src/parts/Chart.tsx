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
// Своими руками, без библиотеки: линии волосяные, как связи в графе,
// заливки нет — несколько полупрозрачных пятен друг на друге читаются хуже.

type Line = { gem: string; points: (number | null)[]; items: number }
type Data = { stamps: number[]; lines: Line[] }

const W = 640
const H = 170
const PAD = { top: 10, right: 8, bottom: 18, left: 8 }

// Цвет по гему, чтобы ветки одного гема читались вместе.
const HUES = [162, 235, 70, 304, 16, 190, 45, 265]
const colorOf = (gems: string[], gem: string, dim = false) => {
  const h = HUES[gems.indexOf(gem) % HUES.length]
  return `oklch(${dim ? 55 : 70}% 0.16 ${h})`
}

export function Chart({ state }: { state: State }) {
  const { data } = useJson<Data>('/api/counters', state.ts)
  const [hot, setHot] = useState<string | null>(null)

  const laid = useMemo(() => {
    if (!data?.lines?.length || data.stamps.length < 2) return null
    const all = data.lines.flatMap(l => l.points).filter((v): v is number => v != null)
    const max = Math.max(...all, 1)
    const x = (i: number) => PAD.left + (i / (data.stamps.length - 1)) * (W - PAD.left - PAD.right)
    const y = (v: number) => H - PAD.bottom - (v / max) * (H - PAD.top - PAD.bottom)

    const gems = [...new Set(data.lines.map(l => l.gem))]
    const paths = data.lines.map((l, n) => {
      let d = ''
      let started = false
      l.points.forEach((v, i) => {
        if (v == null) return
        d += (started ? ' L ' : 'M ') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)
        started = true
      })
      const lastIndex = l.points.length - 1 - [...l.points].reverse().findIndex(v => v != null)
      const last = l.points[lastIndex] ?? 0
      return { key: l.gem + ':' + n, gem: l.gem, items: l.items, d, last, lx: x(lastIndex), ly: y(last) }
    })
    return { max, paths, gems }
  }, [data])

  if (!laid) {
    return <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">срезов пока мало</div>
  }

  const { paths, gems } = laid
  const stamps = data!.stamps
  const day = (t: number) => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" onMouseLeave={() => setHot(null)}>
        <line
          x1={PAD.left} x2={W - PAD.right}
          y1={H - PAD.bottom} y2={H - PAD.bottom}
          stroke="white" strokeOpacity={0.08}
        />
        {paths.map(p => {
          const dim = hot && hot !== p.gem
          return (
            <g key={p.key} opacity={dim ? 0.12 : 1} style={{ transition: 'opacity .15s' }}>
              <path
                d={p.d}
                fill="none"
                stroke={colorOf(gems, p.gem)}
                strokeWidth={p.items > 1 ? 1.6 : 1}
                strokeOpacity={p.items > 1 ? 0.9 : 0.6}
                strokeLinecap="round"
              />
              <circle cx={p.lx} cy={p.ly} r={p.items > 1 ? 2.4 : 1.6} fill={colorOf(gems, p.gem)} />
            </g>
          )
        })}
        <text x={PAD.left} y={H - 5} fontSize={10} className="fill-white/35">{day(stamps[0])}</text>
        <text x={W - PAD.right} y={H - 5} fontSize={10} textAnchor="end" className="fill-white/35">
          {day(stamps[stamps.length - 1])}
        </text>
      </svg>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {paths.map(p => (
          <button
            key={p.key}
            type="button"
            onMouseEnter={() => setHot(p.gem)}
            onMouseLeave={() => setHot(null)}
            className="flex items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="h-[2px] w-3 shrink-0" style={{ background: colorOf(gems, p.gem) }} />
            <span className="truncate">{p.gem}</span>
            {p.items > 1 ? <span className="tnum font-mono text-[11px] text-muted-foreground/60">×{p.items}</span> : null}
            <span className="tnum font-mono text-foreground/80">{nf(p.last)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
