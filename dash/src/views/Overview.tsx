import { ago, clock, nf, span, type State } from '../lib/api.ts'
import { Bar, Card, Dot, Empty, Head, ItemIcon, Label, Num } from '../parts/ui.tsx'
import { Launcher } from '../parts/Launcher.tsx'

type Alert = { level: 'stop' | 'warn'; text: string }

function alerts(s: State, now: number): Alert[] {
  const a: Alert[] = []
  const ap = s.autopilot
  const goal = ap.goal || 2000

  for (const u of ap.units ?? []) {
    if (u.action === 'halt' && u.failures >= 5) a.push({ level: 'stop', text: u.label + ': ' + u.why })
    if (u.failures > 0 && u.failures < 5) a.push({ level: 'warn', text: u.label + ': отправщик не поднялся ' + u.failures + ' раз' })
  }
  if (s.inv.error) a.push({ level: 'stop', text: 'Steam: ' + s.inv.error })
  if (s.inv.age != null && s.inv.age > 300) a.push({ level: 'warn', text: 'инвентарь не читался ' + Math.round(s.inv.age / 60) + ' мин' })
  if (!s.keys.opendota) a.push({ level: 'warn', text: 'нет ключа OpenDota — новые сущности не подтянутся' })
  if (ap.enabled && ap.running && s.confirmed && now - s.confirmed.ts > 120_000) {
    a.push({ level: 'warn', text: 'больше двух минут без подтверждений' })
  }

  for (const m of s.mine) {
    if (m.gem === '—') continue
    if (!m.entityId || !m.kind || m.kind === 'unknown') {
      a.push({ level: 'warn', text: m.gem + ' — сущность не опознана, в очередь не попадёт' })
      continue
    }
    if (m.supply != null && m.supply < goal) {
      a.push({ level: 'warn', text: m.gem + ' — матчей всего ' + nf(m.supply) + ', до ' + nf(goal) + ' не дойдёт' })
    }
  }
  return a
}

export function Overview({ state, now }: { state: State; now: number }) {
  const ap = state.autopilot
  const goal = ap.goal || 2000
  const owned = state.mine.filter(m => m.gem !== '—')
  const warns = alerts(state, now)
  const ready = owned.reduce((n, m) => n + (m.max >= goal ? m.items : 0), 0)
  const items = owned.reduce((n, m) => n + m.items, 0)
  const units = ap.units ?? []
  const live = units.filter(u => u.enabled)

  return (
    <div className="space-y-6">
      <Launcher state={state} unit={ap} />

      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        <Metric label="в очереди" roll={ap.queueLength} note={ap.rebuiltAt ? 'собрана ' + ago(ap.rebuiltAt, now) + ' назад' : undefined} />
        <Metric label="до конца" value={span(ap.etaMinutes)} />
        <Metric label="темп" roll={state.rate || undefined} value={state.rate ? undefined : '—'} note={state.rate ? 'отправок в минуту' : undefined} />
        <Metric
          label="подтверждение"
          value={state.confirmed ? ago(state.confirmed.ts, now) + ' назад' : 'нет'}
          tone={state.confirmed && now - state.confirmed.ts < 15_000 ? 'ok' : undefined}
        />
      </div>

      {live.length > 1 ? (
        <div>
          <Head title="В работе" note={live.length + ' аккаунта одновременно'} />
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 xl:grid-cols-3">
            {live.map(u => (
              <Card key={u.id} className="flex items-center gap-3 p-4">
                <Dot tone={u.running ? 'ok' : 'warn'} pulse={u.running} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{u.label}</span>
                  <span className="block truncate text-[12px] text-muted-foreground">{u.why}</span>
                </span>
                <span className="tnum shrink-0 font-mono text-[13px]">{nf(u.done)}</span>
              </Card>
            ))}
          </div>
        </div>
      ) : null}

      <div>
        <Head title="Товар" note={`${nf(ready)} из ${nf(items)} вещей за ${nf(goal)}`} />
        {owned.length === 0 ? (
          <Card><Empty>гемов нет — купите, работник заметит сам</Empty></Card>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {owned.map((m, i) => {
              const done = m.max >= goal
              const capped = m.supply != null && m.supply < goal
              return (
                <Card key={m.gem} hover className="rise flex flex-col gap-2.5 p-4" style={{ animationDelay: i * 35 + 'ms' }}>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <ItemIcon hash={m.icon} size={32} />
                    <span className="block min-w-0 flex-1 truncate text-[15px] font-medium">{m.gem}</span>
                    <span className="tnum shrink-0 font-mono text-[12px] text-muted-foreground">×{m.items}</span>
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <Num
                      value={m.max}
                      className="font-mono text-2xl font-medium tracking-tight"
                      style={{ color: done ? 'var(--ok)' : capped ? 'var(--warn)' : undefined }}
                    />
                    <span className="tnum font-mono text-[13px] text-muted-foreground/60">/ {nf(goal)}</span>
                  </div>
                  <Bar pct={(m.max / goal) * 100} tone={done ? 'ok' : capped ? 'warn' : 'run'} />
                  <div className="flex items-center justify-between gap-2 text-[12px] text-muted-foreground">
                    <span className="truncate">
                      {m.supply != null ? 'потолок ' + nf(m.supply) + (m.supplyKind === 'estimated' ? ' (оценка)' : '') : 'потолок неизвестен'}
                    </span>
                    <span className="tnum shrink-0 font-mono">{m.left != null ? nf(m.left) : ''}</span>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
        <div>
          <Head title="Требует внимания" note={warns.length ? nf(warns.length) : 'чисто'} />
          <Card>
            {warns.length === 0 ? <Empty>ничего не требует вмешательства</Empty> : (
              <ul className="divide-y divide-white/[0.06]">
                {warns.map((w, i) => (
                  <li key={i} className="flex items-start gap-2.5 px-4 py-2.5 text-[13px] leading-relaxed">
                    <span className="mt-[7px]"><Dot tone={w.level} /></span>
                    <span>{w.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div>
          <Head title="Работник" note={ap.lastTick ? ago(ap.lastTick, now) + ' назад' : undefined} />
          <Card>
            {(ap.log ?? []).length === 0 ? <Empty>решений ещё не было</Empty> : (
              <ul className="scroll-thin max-h-[300px] divide-y divide-white/[0.06] overflow-auto">
                {ap.log.map((l, i) => (
                  <li key={l.ts + ':' + i} className="flex items-baseline gap-3 px-4 py-2 text-[13px]">
                    <span className="tnum shrink-0 font-mono text-[11px] text-muted-foreground/60">{clock(l.ts)}</span>
                    <span className="min-w-0 truncate">{l.why}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value, roll, note, tone }: {
  label: string; value?: string; roll?: number; note?: string; tone?: 'ok'
}) {
  const color = tone === 'ok' ? 'var(--ok)' : undefined
  return (
    <Card hover className="rise p-4">
      <Label>{label}</Label>
      <div className="mt-2 font-mono text-2xl font-medium tracking-tight" style={{ color }}>
        {roll !== undefined ? <Num value={roll} /> : value}
      </div>
      {note ? <div className="mt-1.5 text-[12px] text-muted-foreground">{note}</div> : null}
    </Card>
  )
}
