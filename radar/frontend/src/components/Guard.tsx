import { ShieldAlert, ShieldCheck, ShieldQuestion, TriangleAlert } from 'lucide-react'
import { ago, type TradeAlert } from '../api'
import { Badge, Panel } from './ui'

/**
 * «Не проверено» is its own verdict, not a milder «Совпадает».
 *
 * The guard used to grade an offer green whenever nothing had gone visibly
 * wrong — including when the purchase list had failed to load and there was
 * nothing to compare against at all. A green shield over an unexamined offer
 * is worse than no guard: it invites the operator to accept the swap this
 * tool exists to catch.
 */
const severityMeta = {
  critical: { tone: 'bad' as const, icon: ShieldAlert, label: 'Опасно', accent: 'text-danger' },
  warn: { tone: 'warn' as const, icon: TriangleAlert, label: 'Проверь', accent: 'text-warn' },
  unknown: { tone: 'default' as const, icon: ShieldQuestion, label: 'Не проверено', accent: 'text-faint' },
  ok: { tone: 'good' as const, icon: ShieldCheck, label: 'Совпадает', accent: 'text-accent' },
}

/** What each check proves, spelled out rather than implied by a colour. */
function Provenance({ alert }: { alert: TradeAlert }) {
  const checks: [string, boolean, string][] = [
    ['список покупок', alert.checked?.purchases ?? false, 'сверка instanceid с тем, за что ты заплатил'],
    ['сокеты Steam', alert.checked?.sockets ?? false, 'какие гемы реально стоят в присланных предметах'],
  ]
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
      <span className="tracking-[0.1em] text-faint uppercase">проверено:</span>
      {checks.map(([label, ok, hint]) => (
        <span key={label} title={hint} className={ok ? 'text-accent' : 'text-warn'}>
          {ok ? '✓' : '✕'} {label}
        </span>
      ))}
      {(alert.checked?.blockers ?? []).map((b, i) => (
        <span key={i} className="basis-full text-warn">
          {b}
        </span>
      ))}
    </div>
  )
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
                    : a.severity === 'unknown'
                      ? 'border-line bg-panel-2'
                      : 'border-accent/35 bg-accent/[0.05]'
              }`}
            >
              <header className="flex flex-wrap items-center gap-3">
                <Icon size={18} className={meta.accent} />
                <span className="font-medium">{a.headline}</span>
                <Badge tone={meta.tone}>{meta.label}</Badge>
                <span className="font-mono text-xs text-mute">
                  оффер {a.offer_id} · партнёр {a.partner}
                </span>
              </header>

              <Provenance alert={a} />

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
                          {!it.sockets_read ? (
                            <span className="text-warn" title="Steam не описал этот предмет — что в нём стоит, неизвестно">
                              сокеты не прочитаны
                            </span>
                          ) : it.gems && it.gems.length > 0 ? (
                            <span className="text-accent">{it.gems.join(', ')}</span>
                          ) : (
                            <span className="text-mute" title="Steam описал предмет, кинетического сокета в нём нет">
                              без кинетика
                            </span>
                          )}
                        </td>
                        <td className="py-1.5">
                          <span className={it.expected ? 'text-accent' : a.severity === 'unknown' ? 'text-faint' : 'text-warn'}>
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
