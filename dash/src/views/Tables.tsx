import { useMemo, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { clock, nf, useJson, type QueueData, type State } from '../lib/api.ts'
import { Card, Dot, Empty, Field, Head, ItemIcon, Segmented } from '../parts/ui.tsx'

// ── очередь ──

export function Queue({ state }: { state: State }) {
  const { data } = useJson<QueueData>('/api/queue?limit=300', state.ts)

  return (
    <div>
      <Head
        title="Очередь"
        note={data ? `${nf(data.total)} матчей · ${nf(data.weight2)} поднимают сразу две сущности` : 'считаю…'}
      />
      <Card>
        {!data ? <Empty>собираю…</Empty> : data.rows.length === 0 ? <Empty>очередь пуста</Empty> : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="ui-label border-b border-white/[0.06] text-left text-muted-foreground/75">
                <th className="px-4 py-2 font-medium">матч</th>
                <th className="px-4 py-2 font-medium">турнир</th>
                <th className="px-4 py-2 font-medium">поднимет</th>
                <th className="px-4 py-2 font-medium">вес</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map(r => (
                <tr key={r.match} className="border-b border-white/[0.06] transition-colors last:border-0 hover:bg-white/[0.03]">
                  <td className="tnum px-4 py-2 font-mono">{r.match}</td>
                  <td className="tnum px-4 py-2 font-mono text-muted-foreground">{r.league}</td>
                  <td className="px-4 py-2">{r.entities.join(' · ')}</td>
                  <td className="tnum px-4 py-2 font-mono" style={{ color: r.weight > 1 ? 'var(--ok)' : undefined }}>×{r.weight}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {data && data.total > data.rows.length ? (
        <p className="mt-2 text-[12px] text-muted-foreground">показаны первые {nf(data.rows.length)}</p>
      ) : null}
    </div>
  )
}

// ── лента ──

const RESULT = {
  update: { tone: 'ok' as const, word: 'засчитан' },
  dup: { tone: 'warn' as const, word: 'спорный' },
  silent: { tone: 'idle' as const, word: 'без ответа' },
}

export function Feed({ state }: { state: State }) {
  const [filter, setFilter] = useState<'all' | 'update' | 'dup' | 'silent'>('all')
  const rows = state.events.filter(e => filter === 'all' || e.result === filter)
  const tally = useMemo(() => ({
    update: state.events.filter(e => e.result === 'update').length,
    dup: state.events.filter(e => e.result === 'dup').length,
    silent: state.events.filter(e => e.result === 'silent').length,
  }), [state.events])

  return (
    <div>
      <Head
        title="Лента"
        note={`${nf(state.events.length)} последних`}
        right={
          <Segmented
            value={filter}
            items={[
              { id: 'all' as const, label: 'все' },
              { id: 'update' as const, label: 'засчитаны ' + tally.update },
              { id: 'dup' as const, label: 'спорные ' + tally.dup },
              { id: 'silent' as const, label: 'молчание ' + tally.silent },
            ]}
            onPick={setFilter}
          />
        }
      />
      <Card>
        {rows.length === 0 ? <Empty>событий нет</Empty> : (
          <ul className="scroll-thin max-h-[calc(100svh-220px)] divide-y divide-white/[0.06] overflow-auto">
            {rows.map(e => {
              const r = RESULT[e.result] ?? RESULT.silent
              return (
                <li key={e.ts} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                  <Dot tone={r.tone} />
                  <span className="tnum shrink-0 font-mono text-[11px] text-muted-foreground/60">{clock(e.ts)}</span>
                  <span className="tnum shrink-0 font-mono">{e.match_id}</span>
                  <span className="tnum shrink-0 font-mono text-[12px] text-muted-foreground">лига {e.league_id || '—'}</span>
                  <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">
                    {r.word}{e.bytes ? <span className="tnum font-mono"> · {nf(e.bytes)} Б</span> : null}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}

// ── закупка ──

export function Buy({ state }: { state: State }) {
  const [q, setQ] = useState('')
  const [only, setOnly] = useState<'all' | 'new'>('all')
  const goal = state.autopilot.goal || 2000

  const rows = state.catalog
    .filter(c => (only === 'all' || !c.ownedItems))
    .filter(c => c.short.toLowerCase().includes(q.toLowerCase()))

  return (
    <div>
      <Head
        title="Закупка"
        note={`${nf(rows.length)} из ${nf(state.catalog.length)}`}
        right={
          <>
            <Segmented
              value={only}
              items={[{ id: 'all' as const, label: 'все' }, { id: 'new' as const, label: 'ещё нет' }]}
              onPick={setOnly}
            />
            <Field value={q} onChange={setQ} placeholder="поиск" width="w-56" />
          </>
        }
      />
      <Card>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="ui-label border-b border-white/[0.06] text-left text-muted-foreground/75">
              <th className="px-4 py-2 font-medium">гем</th>
              <th className="px-4 py-2 font-medium">цена</th>
              <th className="px-4 py-2 font-medium">лотов</th>
              <th className="px-4 py-2 font-medium">потолок</th>
              <th className="px-4 py-2 font-medium">дойдёт до {nf(goal)}</th>
              <th className="px-4 py-2 font-medium">у меня</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(c => {
              const reach = c.supply != null && c.supply >= goal
              return (
                <tr key={c.name} className="border-b border-white/[0.06] transition-colors last:border-0 hover:bg-white/[0.03]">
                  <td className="px-4 py-2.5">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <ItemIcon hash={c.icon} size={24} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{c.short}</span>
                        <span className="block truncate text-[11px] text-muted-foreground/60">{c.kind ?? '—'}</span>
                      </span>
                    </span>
                  </td>
                  <td className="tnum px-4 py-2.5 font-mono">{c.price}</td>
                  <td className="tnum px-4 py-2.5 font-mono text-muted-foreground">{c.listings}</td>
                  <td className="tnum px-4 py-2.5 font-mono">
                    {c.supply != null ? nf(c.supply) : '—'}
                    {c.supplyKind === 'estimated' ? <span className="text-muted-foreground/60"> оц.</span> : null}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2">
                      <Dot tone={reach ? 'ok' : 'warn'} />
                      <span className="text-muted-foreground">{reach ? 'да' : 'нет'}</span>
                    </span>
                  </td>
                  <td className="tnum px-4 py-2.5 font-mono text-muted-foreground">{c.ownedItems || '—'}</td>
                  <td className="px-4 py-2.5 text-right">
                    <a
                      href={c.market}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="ui-label inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <span>рынок</span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 ? <Empty>ничего не нашлось</Empty> : null}
      </Card>
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        Второй и десятый экземпляр одного гема стоят ноль отправок: одно сообщение
        поднимает все подходящие вещи разом. Дешевле докупить копию того, что уже жжётся,
        чем начинать новую сущность.
      </p>
    </div>
  )
}
