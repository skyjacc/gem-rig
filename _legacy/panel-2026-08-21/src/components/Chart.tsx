import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { State } from '../lib/types.ts'

const COLORS = ['#34d3a6', '#e2673a', '#7fb7ff', '#8a6bd1', '#d8c15a', '#5fd0d0', '#e28fb0', '#9fd14f']

// uPlot держит десятки тысяч точек без нагрузки — на ленте прожига это пригодится.
export function Chart({ state }: { state: State }) {
  const host = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const { stamps, series } = state.chart
    if (stamps.length < 2) { el.innerHTML = '<div class="p-3.5 text-dust">нужно минимум два среза инвентаря</div>'; return }

    const data: uPlot.AlignedData = [
      stamps.map(t => t / 1000),
      ...series.map(s => s.points.map(p => (p == null ? null : p))),
    ] as uPlot.AlignedData

    const opts: uPlot.Options = {
      width: el.clientWidth || 900,
      height: 210,
      padding: [10, 12, 0, 0],
      cursor: { y: false, points: { size: 5 } },
      axes: [
        { stroke: '#7d8f89', grid: { stroke: '#243230', width: 1 }, ticks: { stroke: '#243230' }, font: '10px "IBM Plex Mono"' },
        { stroke: '#7d8f89', grid: { stroke: '#243230', width: 1 }, ticks: { stroke: '#243230' }, font: '10px "IBM Plex Mono"', size: 46 },
      ],
      series: [
        {},
        ...series.map((s, i) => ({
          label: s.gem,
          stroke: COLORS[i % COLORS.length],
          width: 1.75,
          points: { show: false },
        })),
      ],
    }

    plot.current?.destroy()
    el.innerHTML = ''
    plot.current = new uPlot(opts, data, el)

    const ro = new ResizeObserver(() => plot.current?.setSize({ width: el.clientWidth, height: 210 }))
    ro.observe(el)
    return () => { ro.disconnect(); plot.current?.destroy(); plot.current = null }
  }, [state.chart])

  return (
    <div className="p-3.5">
      <div ref={host} />
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-dust">
        {state.chart.series.map((s, i) => (
          <span key={s.gem} className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2 w-2" style={{ background: COLORS[i % COLORS.length] }} />
            {s.gem}
          </span>
        ))}
      </div>
    </div>
  )
}
