import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { clock, nf, useJson, type QueueData, type State } from '../lib/api.ts'
import { Card, Dot, Empty, Field, PageHead, Segmented } from '../parts/ui.tsx'

// Разбор.
//
// Всё, что нужно, когда что-то пошло не так, и не нужно в остальное время:
// что уйдёт, что ушло, и почему работник решил именно так. Раньше это были
// три вкладки в одном ряду с ежедневной работой и создавали ощущение,
// что панель сложнее, чем есть.

export function Review({ state }: { state: State }) {
  const [tab, setTab] = useState<'queue' | 'used' | 'feed' | 'log'>('queue')

  return (
    <div className="view-in space-y-4">
      <PageHead
        title="Разбор"
        sub="что уйдёт, что ушло и почему работник решил именно так"
        right={
          <Segmented
            value={tab}
            items={[
              { id: 'queue' as const, label: 'очередь' },
              { id: 'used' as const, label: 'израсходованные' },
              { id: 'feed' as const, label: 'отправки' },
              { id: 'log' as const, label: 'решения' },
            ]}
            onPick={setTab}
          />
        }
      />
      {tab === 'queue' ? <Queue state={state} /> : null}
      {tab === 'used' ? <Used state={state} /> : null}
      {tab === 'feed' ? <Feed state={state} /> : null}
      {tab === 'log' ? <Log state={state} /> : null}
    </div>
  )
}

function Queue({ state }: { state: State }) {
  const { data } = useJson<QueueData>('/api/queue?limit=300', state.ts)
  if (!data) return <Card><Empty>собираю…</Empty></Card>
  if (!data.rows.length) return <Card><Empty>очередь пуста</Empty></Card>

  return (
    <>
      <p className="text-[12px] text-muted-foreground">
        {nf(data.total)} матчей · {nf(data.weight2)} поднимают сразу два гема одной отправкой ·
        жирные идут первыми, чтобы остановка пришлась на дешёвый хвост
      </p>
      <Card>
        <div className="scroll-thin max-h-[calc(100svh-260px)] overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-[#0f0f0f]">
              <tr className="ui-label border-b border-white/[0.06] text-left text-muted-foreground/75">
                <th className="px-3.5 py-2 font-medium">матч</th>
                <th className="px-3.5 py-2 font-medium">турнир</th>
                <th className="px-3.5 py-2 font-medium">каким гемам</th>
                <th className="px-3.5 py-2 font-medium">поднимет</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map(r => (
                <tr key={r.match} className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02]">
                  <td className="tnum px-3.5 py-1.5 font-mono">{r.match}</td>
                  <td className="tnum px-3.5 py-1.5 font-mono text-muted-foreground">{r.league}</td>
                  <td className="px-3.5 py-1.5">{r.entities.join(' · ')}</td>
                  <td className="tnum px-3.5 py-1.5 font-mono" style={{ color: r.weight > 1 ? 'var(--ok)' : undefined }}>
                    ×{r.weight}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  )
}

const RESULT = {
  update: { tone: 'ok' as const, word: 'засчитан' },
  dup: { tone: 'warn' as const, word: 'спорный' },
  silent: { tone: 'idle' as const, word: 'без ответа' },
}

function Feed({ state }: { state: State }) {
  const [only, setOnly] = useState<'all' | 'update' | 'dup' | 'silent'>('all')
  const rows = state.events.filter(e => only === 'all' || e.result === only)
  const n = (r: string) => state.events.filter(e => e.result === r).length

  return (
    <>
      <Segmented
        value={only}
        items={[
          { id: 'all' as const, label: 'все ' + nf(state.events.length) },
          { id: 'update' as const, label: 'засчитаны ' + n('update') },
          { id: 'dup' as const, label: 'спорные ' + n('dup') },
          { id: 'silent' as const, label: 'молчание ' + n('silent') },
        ]}
        onPick={setOnly}
      />
      <Card className="mt-2">
        {rows.length === 0 ? <Empty>событий нет</Empty> : (
          <ul className="scroll-thin max-h-[calc(100svh-280px)] divide-y divide-white/[0.06] overflow-auto">
            {rows.map(e => {
              const r = RESULT[e.result] ?? RESULT.silent
              return (
                <li key={e.ts} className="flex items-center gap-3 px-3.5 py-1.5 text-[13px]">
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
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        «Спорный» и «уже израсходован» снаружи неразличимы: ответ Valve пустой по протоколу.
        Поэтому спорное не вычитается из остатка — матч мог остаться целым.
      </p>
    </>
  )
}

function Log({ state }: { state: State }) {
  const log = state.autopilot.log ?? []
  return (
    <Card>
      {log.length === 0 ? <Empty>решений ещё не было</Empty> : (
        <ul className="divide-y divide-white/[0.06]">
          {log.map((l, i) => (
            <li key={l.ts + ':' + i} className="flex items-baseline gap-3 px-3.5 py-2 text-[13px]">
              <span className="tnum shrink-0 font-mono text-[11px] text-muted-foreground/60">{clock(l.ts)}</span>
              <span className="ui-label shrink-0 w-16 text-muted-foreground/60">{l.action}</span>
              <span className="min-w-0">{l.why}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// Израсходованные матчи.
//
// Матч расходуется навсегда и только на этом аккаунте, поэтому «какие катки
// уже ушли» — вопрос, на который человек должен отвечать сам, глядя в список,
// а не спрашивать. Номер матча кликается: открывается его страница.

type Used = {
  total: number
  rows: { match: string; league: string; leagueName: string; ts: number | null; state: string; gems: string[] }[]
}

const STATE: Record<string, { tone: 'ok' | 'warn' | 'idle'; word: string }> = {
  confirmed: { tone: 'ok', word: 'засчитан' },
  dup: { tone: 'warn', word: 'спорный' },
  ledger: { tone: 'idle', word: 'из журнала' },
  reconstructed: { tone: 'idle', word: 'восстановлен' },
}

function Used({ state }: { state: State }) {
  const { data } = useJson<Used>('/api/burned?limit=500', state.ts)
  const [q, setQ] = useState('')
  if (!data) return <Card><Empty>читаю журнал…</Empty></Card>

  const rows = data.rows.filter(r =>
    !q ||
    r.match.includes(q) ||
    r.leagueName.toLowerCase().includes(q.toLowerCase()) ||
    r.gems.some(g => g.toLowerCase().includes(q.toLowerCase())))

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[12px] text-muted-foreground">
          {nf(data.total)} матчей израсходовано на этом аккаунте · на другом они остались бы свежими
        </p>
        <div className="ml-auto"><Field value={q} onChange={setQ} placeholder="матч, турнир, гем" width="w-56" /></div>
      </div>
      <Card className="mt-2">
        {rows.length === 0 ? <Empty>ничего не нашлось</Empty> : (
          <div className="scroll-thin max-h-[calc(100svh-280px)] overflow-auto">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-[#0f0f0f]">
                <tr className="ui-label border-b border-white/[0.06] text-left text-muted-foreground/75">
                  <th className="px-3.5 py-2 font-medium">матч</th>
                  <th className="px-3.5 py-2 font-medium">турнир</th>
                  <th className="px-3.5 py-2 font-medium">каким гемам</th>
                  <th className="px-3.5 py-2 font-medium">когда</th>
                  <th className="px-3.5 py-2 font-medium">итог</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const s = STATE[r.state] ?? STATE.confirmed
                  return (
                    <tr key={r.match} className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02]">
                      <td className="px-3.5 py-1.5">
                        <a
                          href={'https://www.opendota.com/matches/' + r.match}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="tnum inline-flex items-center gap-1.5 font-mono transition-colors hover:text-foreground"
                        >
                          {r.match}
                          <ExternalLink className="h-3 w-3 text-muted-foreground" />
                        </a>
                      </td>
                      <td className="px-3.5 py-1.5 text-muted-foreground">{r.leagueName || '—'}</td>
                      <td className="px-3.5 py-1.5">{r.gems.length ? r.gems.join(' · ') : <span className="text-muted-foreground/50">не из моих</span>}</td>
                      <td className="tnum px-3.5 py-1.5 font-mono text-[12px] text-muted-foreground">
                        {r.ts ? new Date(r.ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
                      </td>
                      <td className="px-3.5 py-1.5">
                        <span className="flex items-center gap-2">
                          <Dot tone={s.tone} />
                          <span className="text-[12px] text-muted-foreground">{s.word}</span>
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
