import { useEffect, useMemo, useState } from 'react'
import { api, rub, type Finding, type SweepPoint } from '../api'
import { Histogram, LineChart, type Series } from './Chart'
import { Panel } from './ui'

const ACCENT = 'var(--color-accent)'
const INFO = 'var(--color-info)'
const VIOLET = 'var(--color-violet)'

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

/** Profit bands, chosen so a loss is never hidden inside a "small" bucket. */
function profitBins(findings: Finding[]) {
  const bands = [
    { label: 'убыток', min: -Infinity, max: 0, negative: true },
    { label: 'до 50 ₽', min: 0, max: 50 },
    { label: '50 – 150 ₽', min: 50, max: 150 },
    { label: '150 – 400 ₽', min: 150, max: 400 },
    { label: '400 – 1000 ₽', min: 400, max: 1000 },
    { label: 'от 1000 ₽', min: 1000, max: Infinity },
  ]
  return bands.map((b) => ({
    label: b.label,
    negative: b.negative,
    count: findings.filter((f) => {
      const net = f.deal?.priced ? f.deal.net : null
      return net !== null && net > b.min && net <= b.max
    }).length,
  }))
}

/** Where the money would come from, by venue of the chosen exit. */
function venueBins(findings: Finding[]) {
  const counts = new Map<string, number>()
  for (const f of findings) {
    if (!f.deal?.priced) continue
    for (const leg of f.deal.gems) {
      if (leg.best) counts.set(leg.best.venue, (counts.get(leg.best.venue) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([venue, count]) => ({ label: venue, count }))
}

export function Charts({ findings }: { findings: Finding[] }) {
  const [sweeps, setSweeps] = useState<SweepPoint[]>([])
  const [retained, setRetained] = useState({ sweeps: 0, gems: 0, points: 0 })
  const [error, setError] = useState('')

  useEffect(() => {
    const load = () =>
      api
        .history()
        .then((d) => {
          setSweeps(d.sweeps ?? [])
          setRetained(d.retained ?? { sweeps: 0, gems: 0, points: 0 })
        })
        .catch((e: Error) => setError(e.message))
    load()
    const id = window.setInterval(load, 30000)
    return () => window.clearInterval(id)
  }, [])

  const offerSeries: Series[] = useMemo(() => {
    const at = (s: SweepPoint) => Date.parse(s.at)
    return [
      {
        name: 'прибыльных',
        color: ACCENT,
        area: true,
        points: sweeps.map((s) => ({ x: at(s), y: s.profitable })),
      },
      {
        name: 'оценено',
        color: INFO,
        points: sweeps.map((s) => ({ x: at(s), y: s.priced })),
      },
      {
        name: 'всего найдено',
        color: VIOLET,
        dashed: true,
        points: sweeps.map((s) => ({ x: at(s), y: s.findings })),
      },
    ]
  }, [sweeps])

  const moneySeries: Series[] = useMemo(() => {
    const at = (s: SweepPoint) => Date.parse(s.at)
    return [
      {
        name: 'сумма прибыли',
        color: ACCENT,
        area: true,
        points: sweeps.map((s) => ({ x: at(s), y: s.total_net })),
      },
      {
        name: 'лучший оффер',
        color: INFO,
        points: sweeps.map((s) => ({ x: at(s), y: s.best_net })),
      },
    ]
  }, [sweeps])

  const coverageSeries: Series[] = useMemo(() => {
    const at = (s: SweepPoint) => Date.parse(s.at)
    return [
      {
        name: 'вариантов с гемом',
        color: VIOLET,
        area: true,
        points: sweeps.map((s) => ({ x: at(s), y: s.with_gems })),
      },
      {
        name: 'гемов с ценой',
        color: ACCENT,
        points: sweeps.map((s) => ({ x: at(s), y: s.gems_priced })),
      },
      {
        name: 'стаканов прочитано',
        color: INFO,
        dashed: true,
        points: sweeps.map((s) => ({ x: at(s), y: s.order_books })),
      },
    ]
  }, [sweeps])

  const bins = useMemo(() => profitBins(findings), [findings])
  const venues = useMemo(() => venueBins(findings), [findings])

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel
          title="Офферы во времени"
          subtitle="одна точка на обход · показывает, сохраняется ли поток находок"
        >
          <LineChart
            series={offerSeries}
            formatX={clock}
            empty={
              error
                ? `История недоступна: ${error}`
                : 'Нужно хотя бы два завершённых обхода. Первый уже идёт.'
            }
          />
        </Panel>

        <Panel
          title="Деньги во времени"
          subtitle="сумма чистой прибыли по всем прибыльным офферам и лучший из них"
        >
          <LineChart series={moneySeries} format={(v) => rub(v)} formatX={clock} />
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel
          title="Распределение прибыли"
          subtitle="сколько офферов в каждой полосе — видно, где на самом деле деньги"
        >
          <Histogram bins={bins} />
          <p className="mt-3 text-xs text-faint">
            Убыточные считаются отдельно и не сливаются с мелкой прибылью: оффер на −5 ₽ и оффер на
            +5 ₽ это разные решения.
          </p>
        </Panel>

        <Panel
          title="Куда уходит выход"
          subtitle="какую площадку расчёт выбирает для продажи гема"
        >
          <Histogram bins={venues} color={INFO} />
          <p className="mt-3 text-xs text-faint">
            Если всё уходит на одну площадку — остальные либо не котируют эти гемы, либо их выходы
            проигрывают по деньгам или по скорости.
          </p>
        </Panel>
      </div>

      <Panel
        title="Покрытие во времени"
        subtitle={`удержано: ${retained.sweeps} обходов, ${retained.gems} гемов, ${retained.points} точек цены`}
      >
        <LineChart series={coverageSeries} formatX={clock} height={120} />
        <p className="mt-3 text-xs text-faint">
          Ряды пишутся на диск в <span className="font-mono">radar-data/history.json</span> и
          переживают перезапуск. Одна точка на обход, повторяющиеся значения цены не сохраняются —
          неделя без движения не должна вытеснить день, когда цена сдвинулась.
        </p>
      </Panel>
    </div>
  )
}
