import { ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react'
import { ago, type TradeAlert } from '../api'
import { Badge, Panel } from './ui'

const severityMeta = {
  critical: {
    tone: 'bad' as const,
    icon: ShieldAlert,
    label: 'Опасно',
  },
  warn: {
    tone: 'warn' as const,
    icon: TriangleAlert,
    label: 'Проверь',
  },
  ok: {
    tone: 'good' as const,
    icon: ShieldCheck,
    label: 'Совпадает',
  },
}

export function Guard({
  alerts,
  lastRun,
  error,
}: {
  alerts: TradeAlert[]
  lastRun: string
  error: string
}) {
  return (
    <Panel
      title="Trade Guard"
      action={<span className="text-xs text-mute">проверено {ago(lastRun)}</span>}
    >
      <p className="mb-4 text-sm text-mute">
        Сверяет <span className="font-mono text-text">instanceid</span> каждого предмета во входящем
        обмене с тем, за который ты заплатил на маркете. Сам ничего не принимает и не отклоняет —
        только поднимает тревогу.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {alerts.length === 0 && !error && (
        <p className="text-sm text-mute">Активных входящих обменов нет.</p>
      )}

      <div className="space-y-3">
        {alerts.map((a) => {
          const meta = severityMeta[a.severity] ?? severityMeta.ok
          const Icon = meta.icon
          return (
            <article
              key={a.offer_id}
              className={`rounded-xl border px-4 py-3 ${
                a.severity === 'critical'
                  ? 'border-danger/50 bg-danger/8'
                  : a.severity === 'warn'
                    ? 'border-warn/40 bg-warn/8'
                    : 'border-line bg-panel-2'
              }`}
            >
              <header className="flex flex-wrap items-center gap-3">
                <Icon
                  size={18}
                  className={
                    a.severity === 'critical'
                      ? 'text-danger'
                      : a.severity === 'warn'
                        ? 'text-warn'
                        : 'text-accent'
                  }
                />
                <span className="font-medium">{a.headline}</span>
                <Badge tone={meta.tone}>{meta.label}</Badge>
                <span className="font-mono text-xs text-mute">
                  оффер {a.offer_id} · партнёр {a.partner}
                </span>
              </header>

              {a.details && a.details.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm">
                  {a.details.map((d, i) => (
                    <li key={i} className="text-mute">
                      {d}
                    </li>
                  ))}
                </ul>
              )}

              {a.items && a.items.length > 0 && (
                <table className="mt-3 w-full text-xs">
                  <tbody>
                    {a.items.map((it) => (
                      <tr key={it.assetid} className="border-t border-line/60">
                        <td className="py-1.5 pr-3">{it.name || '—'}</td>
                        <td className="py-1.5 pr-3 font-mono text-mute">
                          {it.classid}_{it.instanceid}
                        </td>
                        <td className="py-1.5 pr-3">
                          {it.gems && it.gems.length > 0 ? (
                            <span className="text-accent">{it.gems.join(', ')}</span>
                          ) : (
                            <span className="text-mute">без кинетика</span>
                          )}
                        </td>
                        <td className="py-1.5">
                          <span className={it.expected ? 'text-accent' : 'text-warn'}>
                            {it.note}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </article>
          )
        })}
      </div>
    </Panel>
  )
}
