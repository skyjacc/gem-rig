import { CircleAlert, CircleCheck, CircleSlash } from 'lucide-react'
import { ago, rub, type GemPrice, type SourceStatus } from '../api'
import { Badge, Panel } from './ui'
import { confidenceMeta, sourceLabel } from './meta'

/** One row per price source, so a silent failure is visible rather than felt. */
export function Sources({
  sources,
  gems,
  fxRate,
  fxSource,
}: {
  sources: SourceStatus[]
  gems: number
  fxRate: number
  fxSource: string
}) {
  return (
    <Panel
      title="Источники цен"
      subtitle={`${gems} гемов оценено · 1 $ = ${fxRate.toFixed(2)} ₽ (${fxSource})`}
    >
      <ul className="space-y-1.5">
        {sources.map((s) => {
          const Icon = !s.enabled ? CircleSlash : s.error ? CircleAlert : CircleCheck
          const tone = !s.enabled ? 'text-faint' : s.error ? 'text-danger' : 'text-accent'
          return (
            <li key={s.name} className="flex items-center gap-3 text-sm">
              <Icon size={15} className={`shrink-0 ${tone}`} />
              <span className="w-28 shrink-0 font-medium">{sourceLabel(s.name)}</span>
              {s.enabled ? (
                <span className="font-mono text-mute">{s.gems}</span>
              ) : (
                <span className="text-faint">выключен</span>
              )}
              {s.error ? (
                <span className="truncate text-xs text-danger" title={s.error}>
                  {s.error}
                </span>
              ) : (
                s.enabled && <span className="text-xs text-faint">{ago(s.at)}</span>
              )}
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

/** Per-source breakdown of one gem's valuation. */
export function GemBreakdown({ price }: { price: GemPrice }) {
  const meta = confidenceMeta[price.confidence]
  const quotes = price.quotes ?? []
  const spread = price.low > 0 ? price.high / price.low : 0
  // The spread note used to shout "цена ненадёжна" whenever the markets were
  // more than 2x apart, right next to a "надёжно" badge the backend had just
  // awarded — the two disagreed on screen. The badge is the graded verdict, so
  // the note follows it instead of running a second, stricter rule of its own.
  const weak = price.confidence === 'low' || price.confidence === 'none'

  return (
    <div className="rounded-xl border border-line bg-panel-2/50 px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{price.name}</span>
        <Badge tone={meta.tone} title={meta.hint}>
          {meta.label}
        </Badge>
        {price.median > 0 && (
          <span className="ml-auto font-mono text-accent">{rub(price.median)}</span>
        )}
      </div>

      {quotes.length === 0 ? (
        <p className="mt-2 text-xs text-faint">Ни один рынок не знает цену этого гема.</p>
      ) : (
        <>
          <table className="mt-2 w-full text-xs">
            <tbody>
              {quotes.map((q) => (
                <tr key={q.source} className="border-t border-line-soft/60">
                  <td className="py-1 pr-3 text-mute">{sourceLabel(q.source)}</td>
                  <td className="py-1 pr-3 font-mono">{rub(q.price)}</td>
                  <td className="py-1 pr-3">
                    {q.kind === 'sale' ? (
                      <span className="text-accent">продано</span>
                    ) : q.kind === 'demand' ? (
                      <span className="text-info">спрос</span>
                    ) : (
                      <span className="text-faint">аск</span>
                    )}
                  </td>
                  <td className="py-1 text-right text-faint">
                    {q.volume ? `${q.volume} шт` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {spread > 2 &&
            (weak ? (
              <p className="mt-2 text-xs text-warn">
                Рынки расходятся в {spread.toFixed(1)} раза — цена ненадёжна.
              </p>
            ) : (
              <p className="mt-2 text-xs text-faint">
                Рынки расходятся в {spread.toFixed(1)} раза. Оценка держится на подтверждённой
                продаже, поэтому расхождение асков её не роняет.
              </p>
            ))}
        </>
      )}
    </div>
  )
}
