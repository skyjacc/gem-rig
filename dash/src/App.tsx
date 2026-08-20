import { useEffect, useState } from 'react'
import {
  Activity,
  Boxes,
  Clock,
  Gauge,
  ListChecks,
  Power,
  TriangleAlert,
} from 'lucide-react'
import { ago, clock, nf, post, span, useLive, type Gem, type State } from './lib/api.ts'
import { Bar, Button, Card, Dot, Label, Segmented } from './parts/ui.tsx'

// Дашборд.
//
// Оформление снято с osint-catalog.xyz: контейнер в пять пятых ширины,
// плитка на два пикселя зазора, карточки без углов, подписи не капсом.
// Смысл — наш: одна страница отвечает, идёт ли работа, сколько осталось
// и требует ли что-то человека.

const PACE: [number, string][] = [[1000, '1 с'], [2000, '2 с'], [5000, '5 с'], [30000, '30 с']]

type Alert = { level: 'stop' | 'warn'; text: string }

// Что человек должен увидеть, не читая логов. По срочности.
function alerts(s: State, now: number): Alert[] {
  const a: Alert[] = []
  const ap = s.autopilot
  const goal = ap.goal || 2000

  if (ap.action === 'halt') a.push({ level: 'stop', text: 'работник остановился сам: ' + ap.why })
  if (ap.failures > 0) a.push({ level: 'warn', text: 'отправщик не запустился ' + ap.failures + ' раз подряд' })
  if (s.inv.error) a.push({ level: 'stop', text: 'Steam: ' + s.inv.error })
  if (s.inv.age != null && s.inv.age > 300) a.push({ level: 'warn', text: 'инвентарь не читался ' + Math.round(s.inv.age / 60) + ' мин' })
  if (!s.keys.opendota) a.push({ level: 'warn', text: 'нет ключа OpenDota — новые сущности не подтянутся' })
  if (ap.enabled && s.sender.running && s.confirmed && now - s.confirmed.ts > 120_000) {
    a.push({ level: 'warn', text: 'больше двух минут без подтверждений' })
  }
  if (!ap.enabled && s.sender.running) {
    a.push({ level: 'warn', text: 'отправщик запущен вручную — работник его не ведёт' })
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

export default function App() {
  const { state, online } = useLive()
  const [now, setNow] = useState(() => Date.now())
  const [view, setView] = useState<'work' | 'feed'>('work')

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  if (!state) {
    return (
      <>
        <div className="bg-ambient" aria-hidden="true" />
        <main className="grid min-h-svh place-items-center">
          <div className="text-center">
            <div className="text-2xl font-medium tracking-[-0.04em] text-foreground/95">Gemtrack</div>
            <div className="ui-label mt-2 text-muted-foreground/75">соединение с сервером</div>
          </div>
        </main>
      </>
    )
  }

  const ap = state.autopilot
  const goal = ap.goal || 2000
  const owned = state.mine.filter(m => m.gem !== '—')
  const warns = alerts(state, now)
  const ready = owned.reduce((n, m) => n + (m.max >= goal ? m.items : 0), 0)
  const items = owned.reduce((n, m) => n + m.items, 0)

  return (
    <>
      <div className="bg-ambient" aria-hidden="true" />

      {/* Плавающий признак связи — единственное, что висит поверх. */}
      <div className="floating fixed right-3 top-3 z-50 inline-flex items-center gap-2 px-3 py-2">
        <Dot tone={online ? 'ok' : 'stop'} />
        <span className="font-mono text-[10px] tracking-[0.08em] text-white/60">
          {online ? 'В ЭФИРЕ' : 'НЕТ СВЯЗИ'}
        </span>
      </div>

      <main className="relative min-h-svh text-foreground [padding-top:env(safe-area-inset-top)] [padding-bottom:env(safe-area-inset-bottom)]">
        <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
          {/* Шапка по центру, как у референса. */}
          <header className="mb-12 flex flex-col items-center text-center sm:mb-16">
            <h1 className="text-balance text-3xl font-medium tracking-[-0.04em] text-foreground/95 sm:text-[2.5rem]">
              Gemtrack
            </h1>
            <p className="mt-4 flex max-w-[560px] items-center justify-center gap-1.5 text-sm leading-5 text-muted-foreground">
              счётчики просмотров на самоцветах наблюдателя ·{' '}
              <span className="font-mono text-[13px] text-foreground/80">{state.steamid}</span>
            </p>
          </header>

          {/* Управление. Одна полоса, как их фильтры. */}
          <section className="mb-8 flex flex-col items-stretch gap-2 md:flex-row md:flex-wrap md:items-center">
            <Button
              active={ap.enabled}
              onClick={() => post('/api/autopilot', { on: !ap.enabled, delay: ap.delay })}
              className="md:min-w-[190px]"
            >
              <Power className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{ap.enabled ? 'работник включён' : 'работник выключен'}</span>
            </Button>

            <div className="inline-flex items-center gap-2">
              <Label className="hidden md:inline">пауза</Label>
              <Segmented
                value={String(ap.delay)}
                items={PACE.map(([ms, label]) => ({ id: String(ms), label }))}
                onPick={id => post('/api/autopilot', { on: ap.enabled, delay: Number(id) })}
              />
            </div>

            <div className="md:ml-auto">
              <Segmented
                value={view}
                items={[
                  { id: 'work' as const, label: 'Работа', icon: <Boxes className="h-3.5 w-3.5" /> },
                  { id: 'feed' as const, label: 'Лента', icon: <Activity className="h-3.5 w-3.5" /> },
                ]}
                onPick={setView}
              />
            </div>
          </section>

          {/* Причина, по которой работник делает то, что делает. */}
          <Card className="mb-2 flex items-center gap-2.5 px-4 py-3">
            <Dot tone={ap.enabled ? (state.sender.running ? 'ok' : 'warn') : 'idle'} />
            <span className="text-[13px] text-muted-foreground">
              {ap.enabled ? ap.why : 'включите — очередь соберётся сама, до этого ни одного сообщения не уйдёт'}
            </span>
          </Card>

          {/* Четыре числа. */}
          <section className="mb-8 grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Metric
              icon={<ListChecks className="h-3.5 w-3.5" />}
              label="в очереди"
              value={nf(ap.queueLength)}
              note={ap.rebuiltAt ? 'собрана ' + ago(ap.rebuiltAt, now) : 'ещё не собиралась'}
            />
            <Metric
              icon={<Clock className="h-3.5 w-3.5" />}
              label="до конца очереди"
              value={span(ap.etaMinutes)}
              note={'при паузе ' + ap.delay / 1000 + ' с'}
            />
            <Metric
              icon={<Gauge className="h-3.5 w-3.5" />}
              label="темп"
              value={state.rate ? nf(state.rate) : '—'}
              note="отправок в минуту, за две последние"
            />
            <Metric
              icon={<Activity className="h-3.5 w-3.5" />}
              label="последнее подтверждение"
              value={state.confirmed ? ago(state.confirmed.ts, now) : 'нет'}
              note={state.confirmed ? 'матч ' + state.confirmed.match_id : 'ещё ни одного'}
              tone={state.confirmed && now - state.confirmed.ts < 15_000 ? 'ok' : undefined}
            />
          </section>

          {view === 'work' ? (
            <>
              <SectionHead title="Товар" note={`${nf(ready)} из ${nf(items)} вещей за ${nf(goal)}`} />
              {owned.length === 0 ? (
                <Card className="px-4 py-10 text-center text-[13px] text-muted-foreground">
                  гемов в инвентаре нет — купите, работник заметит сам
                </Card>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {owned.map(m => (
                    <GemCard key={m.gem} gem={m} goal={goal} inQueue={ap.gems.some(g => g.gem === m.gem)} />
                  ))}
                </div>
              )}

              <div className="mt-8 grid grid-cols-1 gap-2 lg:grid-cols-2">
                <div>
                  <SectionHead title="Требует внимания" note={warns.length ? nf(warns.length) : 'чисто'} />
                  <Card className="min-h-[132px]">
                    {warns.length === 0 ? (
                      <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">
                        ничего не требует вмешательства
                      </div>
                    ) : (
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
                  <SectionHead title="Что делал работник" note={ap.lastTick ? 'смотрел ' + ago(ap.lastTick, now) : '—'} />
                  <Card className="min-h-[132px]">
                    {ap.log.length === 0 ? (
                      <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">решений ещё не было</div>
                    ) : (
                      <ul className="scroll-thin max-h-[260px] divide-y divide-white/[0.06] overflow-auto">
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
            </>
          ) : (
            <Feed state={state} />
          )}

          <p className="mt-10 text-[13px] leading-relaxed text-muted-foreground">
            Работник смотрит инвентарь каждые двадцать секунд. Купленный гем попадает в очередь сам —
            нажимать ничего не нужно. Одно сообщение поднимает все подходящие вещи разом, поэтому
            второй и десятый экземпляр одного гема стоят ноль отправок.
          </p>
        </div>
      </main>
    </>
  )
}

function SectionHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mb-2 flex items-baseline gap-3">
      <h2 className="text-[15px] font-medium tracking-[-0.02em] text-foreground/95">{title}</h2>
      {note ? <span className="ui-label ml-auto text-muted-foreground/75">{note}</span> : null}
    </div>
  )
}

function Metric({
  icon,
  label,
  value,
  note,
  tone,
}: {
  icon: React.ReactNode
  label: string
  value: string
  note?: string
  tone?: 'ok'
}) {
  return (
    <Card hover className="flex min-h-[104px] flex-col gap-2.5 p-4">
      <div className="flex items-center gap-1.5 text-muted-foreground/75">
        {icon}
        <span className="ui-label">{label}</span>
      </div>
      <div
        className="tnum font-mono text-2xl font-medium tracking-tight"
        style={{ color: tone === 'ok' ? 'var(--ok)' : undefined }}
      >
        {value}
      </div>
      {note ? <div className="mt-auto text-[12px] leading-snug text-muted-foreground">{note}</div> : null}
    </Card>
  )
}

function GemCard({ gem, goal, inQueue }: { gem: Gem; goal: number; inQueue: boolean }) {
  const pct = (gem.max / goal) * 100
  const done = gem.max >= goal
  const capped = gem.supply != null && gem.supply < goal

  return (
    <Card hover className="flex min-h-[132px] flex-col">
      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <div className="flex min-w-0 items-center gap-2">
          {gem.icon ? (
            <span
              className="inline-flex shrink-0 overflow-hidden rounded-full bg-white/[0.92] ring-1 ring-black/20"
              style={{ width: 18, height: 18 }}
              aria-hidden="true"
            >
              <img src={gem.icon} alt="" className="h-full w-full object-cover" loading="lazy" />
            </span>
          ) : null}
          <span className="block min-w-0 flex-1 truncate text-[15px] font-medium text-foreground">{gem.gem}</span>
          <span className="tnum shrink-0 font-mono text-[12px] text-muted-foreground">×{gem.items}</span>
        </div>

        <div className="flex items-baseline gap-1.5">
          <span
            className="tnum font-mono text-2xl font-medium tracking-tight"
            style={{ color: done ? 'var(--ok)' : capped ? 'var(--warn)' : undefined }}
          >
            {nf(gem.max)}
          </span>
          <span className="tnum font-mono text-[13px] text-muted-foreground/60">/ {nf(goal)}</span>
        </div>

        <Bar pct={pct} tone={done ? 'ok' : inQueue ? 'run' : 'faint'} />

        <div className="mt-auto flex items-center justify-between gap-2 pt-1 text-[12px] leading-snug text-muted-foreground">
          <span className="min-w-0 truncate">
            {gem.supply != null
              ? 'потолок ' + nf(gem.supply) + (gem.supplyKind === 'estimated' ? ' (оценка)' : '')
              : 'потолок неизвестен'}
          </span>
          <span className="tnum shrink-0 font-mono">
            {gem.left != null ? 'осталось ' + nf(gem.left) : inQueue ? '' : 'не в очереди'}
          </span>
        </div>
      </div>
    </Card>
  )
}

const RESULT = {
  update: { tone: 'ok' as const, word: 'засчитан' },
  dup: { tone: 'warn' as const, word: 'спорный' },
  silent: { tone: 'idle' as const, word: 'без ответа' },
}

function Feed({ state }: { state: State }) {
  return (
    <>
      <SectionHead title="Лента отправок" note={`последние ${nf(state.events.length)}`} />
      <Card>
        {state.events.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">событий пока нет</div>
        ) : (
          <ul className="scroll-thin max-h-[560px] divide-y divide-white/[0.06] overflow-auto">
            {state.events.map(e => {
              const r = RESULT[e.result] ?? RESULT.silent
              return (
                <li key={e.ts} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                  <Dot tone={r.tone} />
                  <span className="tnum shrink-0 font-mono text-[11px] text-muted-foreground/60">{clock(e.ts)}</span>
                  <span className="tnum shrink-0 font-mono">{e.match_id}</span>
                  <span className="tnum shrink-0 font-mono text-[12px] text-muted-foreground">
                    лига {e.league_id || '—'}
                  </span>
                  <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">
                    {r.word}
                    {e.bytes ? <span className="tnum font-mono"> · {nf(e.bytes)} Б</span> : null}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Metric icon={<TriangleAlert className="h-3.5 w-3.5" />} label="сожжено всего" value={nf(state.burned)} note="матчей израсходовано" />
        <Metric icon={<Boxes className="h-3.5 w-3.5" />} label="предметов со счётчиком" value={nf(state.inv.items)} note={state.inv.age != null ? 'инвентарь прочитан ' + state.inv.age + ' с назад' : ''} />
        <Metric icon={<Activity className="h-3.5 w-3.5" />} label="сумма счётчиков" value={nf(state.watched)} note="по всем вещам" />
        <Metric icon={<Gauge className="h-3.5 w-3.5" />} label="отправщик" value={state.sender.running ? 'работает' : 'стоит'} note={state.sender.running ? 'pid ' + state.sender.pid : state.sender.exit ?? ''} />
      </div>
    </>
  )
}
