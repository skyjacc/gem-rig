import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { clock, nf, plural, useAction, useJson, type QueueData, type State } from '../lib/api.ts'
import { Button, Card, Dot, Empty, Field, Note, PageHead, RowsSkeleton, Segmented } from '../parts/ui.tsx'

// Разбор.
//
// Всё, что нужно, когда что-то пошло не так, и не нужно в остальное время:
// что уйдёт, что ушло, и почему работник решил именно так. Раньше это были
// три вкладки в одном ряду с ежедневной работой и создавали ощущение,
// что панель сложнее, чем есть.

export function Review({ state }: { state: State }) {
  const [tab, setTab] = useState<'queue' | 'used' | 'arrivals' | 'feed' | 'log'>('queue')
  const open = state.arrivals?.open ?? 0

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
              { id: 'arrivals' as const, label: open ? 'приход ' + nf(open) : 'приход' },
              { id: 'feed' as const, label: 'отправки' },
              { id: 'log' as const, label: 'решения' },
            ]}
            onPick={setTab}
          />
        }
      />
      {tab === 'queue' ? <Queue state={state} /> : null}
      {tab === 'used' ? <Used state={state} /> : null}
      {tab === 'arrivals' ? <Arrivals state={state} /> : null}
      {tab === 'feed' ? <Feed state={state} /> : null}
      {tab === 'log' ? <Log state={state} /> : null}
    </div>
  )
}

function Queue({ state }: { state: State }) {
  const { data, loading, error, reload } = useJson<QueueData>('/api/queue?limit=300', state.ts)
  if (error) {
    return (
      <Note title="очередь не собралась" action={<Button onClick={reload} loading={loading}>ещё раз</Button>}>
        {error}. Очередь строится по локальной карте матчей: если обход Valve
        ещё не запускали, строить не из чего — node rig/crawl.ts.
      </Note>
    )
  }
  if (!data) return <Card className="fade"><RowsSkeleton rows={10} cols={[96, 60, 220, 56, 44]} /></Card>
  if (!data.rows.length) {
    return (
      <Card>
        <Empty>
          очередь пуста — либо в инвентаре нет гемов с известной сущностью,
          либо все их матчи уже израсходованы на этом аккаунте
        </Empty>
      </Card>
    )
  }

  return (
    <>
      <p className="text-[12px] text-muted-foreground">
        {nf(data.total)} {plural(data.total, 'матч', 'матча', 'матчей')} · {nf(data.weight2)} поднимают сразу два гема одной отправкой ·
        жирные идут первыми, чтобы остановка пришлась на дешёвый хвост
      </p>
      <Card className="fade">
        <div className="scroll-thin max-h-[max(240px,calc(100svh-260px))] overflow-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead className="sticky top-0 bg-[#0f0f0f]">
              <tr className="ui-label border-b border-white/[0.06] text-left text-muted-foreground/75">
                <th scope="col" className="px-3.5 py-2 font-medium">матч</th>
                <th scope="col" className="px-3.5 py-2 font-medium">турнир</th>
                <th scope="col" className="px-3.5 py-2 font-medium">каким гемам</th>
                <th scope="col" className="px-3.5 py-2 font-medium">поднимет</th>
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
      <Card className="fade mt-2">
        {rows.length === 0 ? <Empty>событий нет</Empty> : (
          <ul className="scroll-thin max-h-[max(240px,calc(100svh-280px))] divide-y divide-white/[0.06] overflow-auto">
            {rows.map(e => {
              const r = RESULT[e.result] ?? RESULT.silent
              return (
                <li key={e.ts} className="flex items-center gap-3 px-3.5 py-1.5 text-[13px]">
                  <Dot tone={r.tone} />
                  <span className="tnum shrink-0 font-mono text-[11px] text-muted-foreground/75">{clock(e.ts)}</span>
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
              <span className="tnum shrink-0 font-mono text-[11px] text-muted-foreground/75">{clock(l.ts)}</span>
              <span className="ui-label shrink-0 w-16 text-muted-foreground/75">{l.action}</span>
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
  const { data, loading, error, reload } = useJson<Used>('/api/burned?limit=500', state.ts)
  const [q, setQ] = useState('')
  if (error) {
    return (
      <Note title="журнал не прочитался" action={<Button onClick={reload} loading={loading}>ещё раз</Button>}>
        {error}
      </Note>
    )
  }
  if (!data) return <Card className="fade"><RowsSkeleton rows={10} cols={[96, 140, 220, 90, 56]} /></Card>

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
        {state.dups ? (
          <p className="text-[12px] text-muted-foreground">
            спорных: ждут повтора {nf(state.dups.waiting)} · брошены после повтора {nf(state.dups.exhausted)} · засчитались со второй {nf(state.dups.resolved)}
          </p>
        ) : null}
        <div className="ml-auto"><Field value={q} onChange={setQ} placeholder="матч, турнир, гем" width="w-56" /></div>
      </div>
      <Card className="fade mt-2">
        {rows.length === 0 ? <Empty>ничего не нашлось</Empty> : (
          <div className="scroll-thin max-h-[max(240px,calc(100svh-280px))] overflow-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead className="sticky top-0 bg-[#0f0f0f]">
                <tr className="ui-label border-b border-white/[0.06] text-left text-muted-foreground/75">
                  <th scope="col" className="px-3.5 py-2 font-medium">матч</th>
                  <th scope="col" className="px-3.5 py-2 font-medium">турнир</th>
                  <th scope="col" className="px-3.5 py-2 font-medium">каким гемам</th>
                  <th scope="col" className="px-3.5 py-2 font-medium">когда</th>
                  <th scope="col" className="px-3.5 py-2 font-medium">итог</th>
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
                      <td className="px-3.5 py-1.5">{r.gems.length ? r.gems.join(' · ') : <span className="text-muted-foreground/75">не из моих</span>}</td>
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

// ── приходы ──
//
// Площадка продаёт по имени и счётчиков не видит: в лоте может лежать
// прокачанная вещь по цене пустой. Сканер сравнивает число при первом
// взгляде с тем, что наша работа успела бы добавить, и показывает
// излишек — чужие просмотры, заплаченные по цене нулевых. Выигрыш
// откладывается из фарма и продаётся как есть.

type ArrivalData = {
  summary: { open: number; wins: number; fresh: number }
  rows: {
    assetid: string
    gem: string
    item: string
    carrier: string
    value: number
    expected: number
    unexplained: number
    verdict: 'выигрыш' | 'наш' | 'чисто'
    aside: boolean
    ts: number | null
    now: number | null
    gone: boolean
  }[]
}

const ARRIVAL_VERDICT: Record<string, { tone: 'ok' | 'idle'; word: string }> = {
  'выигрыш': { tone: 'ok', word: 'чужие просмотры' },
  'наш': { tone: 'idle', word: 'наше число' },
  'чисто': { tone: 'idle', word: 'ноль' },
}

function Arrivals({ state }: { state: State }) {
  const { data, loading, error, reload } = useJson<ArrivalData>('/api/arrivals', state.ts)
  const act = useAction()

  if (error) {
    return (
      <Note title="приходы не прочитались" action={<Button onClick={reload} loading={loading}>ещё раз</Button>}>
        {error}
      </Note>
    )
  }
  if (!data) return <Card className="fade"><RowsSkeleton rows={6} cols={[90, 200, 70, 70, 70, 56]} /></Card>
  if (!data.rows.length) {
    return (
      <Card>
        <Empty>
          приходов пока нет — сканер смотрит только вперёд, с момента запуска.
          Следующая закупка появится здесь сама
        </Empty>
      </Card>
    )
  }

  const toggle = (r: ArrivalData['rows'][number]) =>
    act.run('/api/arrivals/aside', { assetid: r.assetid, aside: !r.aside }).then(() => reload())

  return (
    <>
      <p className="text-[12px] text-muted-foreground">
        {nf(data.summary.fresh)} {plural(data.summary.fresh, 'приход', 'прихода', 'приходов')} ·{' '}
        {nf(data.summary.wins)} {plural(data.summary.wins, 'выигрыш', 'выигрыша', 'выигрышей')} ·
        отложенное не жжётся: работник не тратит под него матчи
      </p>
      <Card className="fade">
        <div className="scroll-thin max-h-[max(240px,calc(100svh-280px))] overflow-auto">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead className="sticky top-0 bg-[#0f0f0f]">
              <tr className="ui-label border-b border-white/[0.06] text-left text-muted-foreground/75">
                <th scope="col" className="px-3.5 py-2 font-medium">когда</th>
                <th scope="col" className="px-3.5 py-2 font-medium">вещь</th>
                <th scope="col" className="px-3.5 py-2 font-medium">пришло с</th>
                <th scope="col" className="px-3.5 py-2 font-medium">наш вклад</th>
                <th scope="col" className="px-3.5 py-2 font-medium">излишек</th>
                <th scope="col" className="px-3.5 py-2 font-medium">сейчас</th>
                <th scope="col" className="px-3.5 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map(r => {
                const v = ARRIVAL_VERDICT[r.verdict] ?? ARRIVAL_VERDICT['чисто']
                return (
                  <tr
                    key={r.assetid}
                    className={'border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02] ' + (r.aside ? 'opacity-50' : '')}
                  >
                    <td className="tnum px-3.5 py-1.5 font-mono text-[12px] text-muted-foreground">
                      {r.ts ? new Date(r.ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
                    </td>
                    <td className="px-3.5 py-1.5">
                      {r.item}
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        {r.carrier === 'gem' ? 'россыпь' : 'в сокете'} · {r.gem}
                      </span>
                    </td>
                    <td className="tnum px-3.5 py-1.5 font-mono">{r.value ? nf(r.value) : '—'}</td>
                    <td className="tnum px-3.5 py-1.5 font-mono text-muted-foreground">{r.expected ? nf(r.expected) : '—'}</td>
                    <td className="tnum px-3.5 py-1.5 font-mono" style={{ color: r.verdict === 'выигрыш' ? 'var(--ok)' : undefined }}>
                      {r.unexplained ? nf(r.unexplained) : '—'}
                    </td>
                    <td className="tnum px-3.5 py-1.5 font-mono">
                      {r.gone ? <span className="text-[12px] text-muted-foreground">ушло</span> : nf(r.now ?? 0)}
                    </td>
                    <td className="px-3.5 py-1.5 text-right">
                      <span className="flex items-center justify-end gap-2">
                        <Dot tone={v.tone} />
                        <span className="hidden text-[12px] text-muted-foreground xl:inline">{v.word}</span>
                        {!r.gone ? (
                          <Button
                            className="!h-7"
                            active={r.aside}
                            disabled={act.busy}
                            onClick={() => void toggle(r)}
                          >
                            {r.aside ? 'вернуть' : 'отложить'}
                          </Button>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {act.error ? <p className="text-[12px]" style={{ color: 'var(--stop)' }}>{act.error}</p> : null}
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        «Наш вклад» — сколько подтверждённых отправок в эти гемы успело уйти за четверть часа
        до первого взгляда: между покупкой и чтением инвентаря панель работает, и свежая вещь
        поднимается сама. Излишек сверх вклада — то, что лежало в лоте до нас.
      </p>
    </>
  )
}
