// Экран «Инвентарь» (§5.2, макет 2-inventar.html): что лежит, что дойдёт
// до цели, что можно продавать.
//
// Модель — inventory/model.ts (статус вещи, стопки, сводка, фильтры).
// Порядок копий в стопке задаёт модель (по счётчику вниз, при равенстве
// надетые первыми) — здесь не пересортировывается.
// Связки и очередь — внешние источники (/api/graph, /api/queue): пока их нет
// или они не ответили — состояние данных, а не ноль (план 2.2, критерий 4).

import { useMemo, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { icon, nf, plural, useJson, type GraphData, type QueueData, type State } from '../../lib/api.ts'
import { gemStatus } from '../../lib/worker.ts'
import { orderGems } from '../overview/Canvas.tsx'
import { Loadable } from '../States.tsx'
import { Chip, Panel, Src } from '../ui.tsx'
import { countFor, passes, stacksOf, summarize, type Filter, type ItemState, type Stack } from './model.ts'

const things = (n: number) => nf(n) + ' ' + plural(n, 'вещь', 'вещи', 'вещей')

export const STATE: Record<ItemState, { word: string; tone: 'ok' | 'warn' | 'stop' | undefined }> = {
  ready: { word: 'готово', tone: 'ok' },
  going: { word: 'дойдёт', tone: undefined },
  stuck: { word: 'не дойдёт', tone: 'warn' },
  unknown: { word: 'потолок неизвестен', tone: 'stop' },
}

const FILTERS: { id: Filter; label: string; needsGoal: boolean }[] = [
  { id: 'all', label: 'все', needsGoal: false },
  { id: 'going', label: 'дойдут', needsGoal: true },
  { id: 'stuck', label: 'не дойдут', needsGoal: true },
  { id: 'ready', label: 'готово', needsGoal: true },
  { id: 'dups', label: 'есть копии', needsGoal: false },
]

// Стопки и порядок гемов — один расчёт для экрана и карточки.
export function useStacks(state: State, goal: number | null) {
  return useMemo(() => {
    const gems = orderGems(state.mine, goal, new Set(state.autopilot.picked ?? []))
    return { gems, stacks: stacksOf(gems, goal) }
  }, [state.mine, state.autopilot.picked, goal])
}

export function withOf(edges: GraphData['edges'] | undefined, gem: string) {
  return (edges ?? [])
    .filter(e => e.a === gem || e.b === gem)
    .map(e => ({ gem: e.a === gem ? e.b : e.a, n: e.shared }))
    .sort((a, b) => b.n - a.n)
}

export function Inventory({ state, goal, sel, onSel }: {
  state: State
  goal: number | null
  sel: string | null
  onSel: (key: string) => void
}) {
  const ap = state.autopilot
  const { gems, stacks } = useStacks(state, goal)
  const sum = summarize(gems, goal)
  const graph = useJson<GraphData>('/api/graph?scope=owned', state.ts)
  const queue = useJson<QueueData>('/api/queue', state.ts)

  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [bond, setBond] = useState<[string, string] | null>(null)
  const [allBonds, setAllBonds] = useState(false)
  const [closed, setClosed] = useState<Set<string>>(new Set())

  const current = stacks.find(s => s.key === sel) ?? stacks[0] ?? null
  const icons = new Map(gems.map(g => [g.gem, g.icon]))
  const edges = graph.data?.edges
  const bonds = [...(edges ?? [])].sort((a, b) => b.shared - a.shared)
  const top = bonds.reduce((m, e) => Math.max(m, e.shared), 1)
  const shown = allBonds ? bonds : bonds.slice(0, 6)
  const toggle = (gem: string) => setClosed(c => { const n = new Set(c); n.has(gem) ? n.delete(gem) : n.add(gem); return n })

  const bars = goal == null || sum.ready == null ? null : { ready: sum.ready, going: sum.going!, stuck: sum.stuck! }

  return (
    <div className="v2-inv">
      <header className="v2-inv-head">
        <div>
          <h1 className="v2-h1">Инвентарь</h1>
          <p className="v2-hint">
            {goal == null ? 'цель не задана — «готово / дойдёт» не считается' : 'товар — вещь со счётчиком от ' + nf(goal)} · у каждой цифры подписано, откуда она
          </p>
        </div>
        <div className="v2-seg" role="group" aria-label="Чей инвентарь">
          <button type="button" aria-pressed="true">{ap.label}</button>
          <button type="button" disabled title="появится на этапе 3.5 (С3): сейчас сервер отдаёт инвентарь только активного аккаунта">все аккаунты</button>
        </div>
      </header>

      <div className="v2-inv-sum">
        <div className="v2-tile v2-inv-big">
          <span className="v2-inv-l">готово к продаже <Src>инвентарь</Src></span>
          {bars ? (
            <>
              <b className="v2-num v2-inv-v">{nf(bars.ready)} <small>/ {nf(sum.total)}</small></b>
              <span className="v2-inv-stack" aria-hidden="true">
                <i style={{ flex: bars.ready || 0.001, background: 'var(--ac)' }} />
                <i style={{ flex: bars.going, background: 'var(--acg)' }} />
                <i style={{ flex: bars.stuck, background: '#f2b44a88' }} />
              </span>
              <span className="v2-inv-n">готово · дойдут · не дойдут</span>
            </>
          ) : (
            <span className="v2-kpi-none">— цель не задана</span>
          )}
        </div>
        <div className="v2-tile">
          <span className="v2-inv-l">дойдут при этой работе</span>
          {bars ? <b className="v2-num v2-inv-v is-ok">{nf(bars.going)}</b> : <span className="v2-kpi-none">—</span>}
          <span className="v2-inv-n">матчей у их команд хватает до цели</span>
        </div>
        <div className="v2-tile">
          <span className="v2-inv-l">не дойдут</span>
          {bars ? <b className="v2-num v2-inv-v is-warn">{nf(bars.stuck)}</b> : <span className="v2-kpi-none">—</span>}
          <span className="v2-inv-n">потолок ниже цели или неизвестен</span>
        </div>
        <div className="v2-tile">
          <span className="v2-inv-l">сожжено <Src>журнал</Src></span>
          <b className="v2-num v2-inv-v">{nf(ap.burned)}</b>
          <span className="v2-inv-n">у аккаунта «{ap.label}»; другому аккаунту эти матчи ещё доступны</span>
        </div>
      </div>

      <div className="v2-inv-mid">
        <Panel title="Связки" aside={edges ? (allBonds || bonds.length <= 6 ? nf(bonds.length) : <button type="button" className="v2-linkbtn" onClick={() => setAllBonds(true)}>все {nf(bonds.length)}</button>) : undefined}>
          <p className="v2-hint v2-inv-why">Одна отправка матча поднимает все гемы, чьи команды или игроки в нём были, — каждому по +1 <Src>README §2</Src></p>
          <Loadable what="связки гемов" loading={graph.loading} error={graph.error} ready={!!graph.data} onRetry={graph.reload}>
            {bonds.length ? (
              <ul className="v2-bonds">
                {shown.map(e => {
                  const on = !!bond && bond[0] === e.a && bond[1] === e.b
                  return (
                    <li key={e.a + '+' + e.b}>
                      <button type="button" className={'v2-bond' + (on ? ' is-on' : '')} aria-pressed={on} onClick={() => setBond(on ? null : [e.a, e.b])}>
                        <span className="v2-bond-pair" aria-hidden="true">
                          <i style={{ backgroundImage: icons.get(e.a) ? `url('${icon(icons.get(e.a)!, 64)}')` : undefined }} />
                          <i style={{ backgroundImage: icons.get(e.b) ? `url('${icon(icons.get(e.b)!, 64)}')` : undefined }} />
                        </span>
                        <span className="v2-bond-nm">
                          <span>{e.a} <span className="v2-mute">+</span> {e.b}</span>
                          <span className="v2-gem-bar"><i style={{ width: (e.shared / top) * 100 + '%' }} /></span>
                        </span>
                        <span className="v2-bond-v"><b className="v2-num">{nf(e.shared)}</b><span>общих матчей</span></span>
                      </button>
                    </li>
                  )
                })}
                {allBonds && bonds.length > 6 ? <li><button type="button" className="v2-linkbtn" onClick={() => setAllBonds(false)}>свернуть</button></li> : null}
              </ul>
            ) : (
              <p className="v2-text">Общих матчей между гемами нет — каждый поднимается своими отправками.</p>
            )}
          </Loadable>
        </Panel>

        <Panel title="В очереди" aside={<Src>очередь</Src>}>
          <Loadable what="очередь" loading={queue.loading} error={queue.error} ready={!!queue.data} onRetry={queue.reload} lines={2}>
            {queue.data ? (
              <p className="v2-text">
                <b className="v2-num">{nf(queue.data.weight2)}</b> из <b className="v2-num">{nf(queue.data.total)}</b>{' '}
                {plural(queue.data.total, 'матча', 'матчей', 'матчей')} поднимают сразу два гема.
              </p>
            ) : null}
          </Loadable>
        </Panel>
      </div>

      <section className="v2-inv-items" aria-label="Вещи">
        <div className="v2-inv-bar">
          <h2 className="v2-inv-h2">Вещи <span className="v2-hint">{things(sum.total)} · одинаковые сложены в стопку</span></h2>
          <div className="v2-inv-filters" role="group" aria-label="Фильтр">
            {FILTERS.map(f => {
              const off = f.needsGoal && goal == null
              return (
                <button key={f.id} type="button" className="v2-fchip" aria-pressed={filter === f.id} disabled={off}
                  title={off ? 'цель не задана' : undefined} onClick={() => setFilter(f.id)}>
                  {f.label}<span className="v2-num">{off ? '—' : nf(countFor(stacks, f.id, bond, query))}</span>
                </button>
              )
            })}
            {bond ? (
              <button type="button" className="v2-fchip" aria-pressed="true" onClick={() => setBond(null)}>
                связка {bond[0]} + {bond[1]} ✕
              </button>
            ) : null}
          </div>
          <label className="v2-net-find v2-inv-find">
            <Search size={13} aria-hidden="true" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="вещь, гем, герой" aria-label="Найти вещь" />
          </label>
        </div>

        {gems.map(g => {
          const mine = stacks.filter(s => s.gem === g && passes(s, filter, bond, query))
          if (!mine.length) return null
          const best = Math.max(...g.rows.map(r => r.value))
          const cap = g.supply
          const gs = gemStatus(g, goal)
          const capChip = gs === 'reach' ? <Chip tone="warn" dot>потолок {nf(cap ?? 0)}</Chip>
            : gs === 'map' ? <Chip tone="stop" dot>потолок неизвестен</Chip> : null
          const who = g.kind === 'player' ? 'игрока' : 'команды'
          const w = withOf(edges, g.gem).slice(0, 3)
          const isClosed = closed.has(g.gem)
          return (
            <section key={g.gem} className="v2-bay">
              <button type="button" className="v2-bay-h" aria-expanded={!isClosed} onClick={() => toggle(g.gem)}>
                <ChevronDown size={16} className={'v2-bay-chev' + (isClosed ? ' is-closed' : '')} aria-hidden="true" />
                <span className="v2-gem-ico" style={{ backgroundImage: g.icon ? `url('${icon(g.icon, 96)}')` : undefined }} aria-hidden="true" />
                <span className="v2-bay-meta">
                  <span className="v2-bay-nm">{g.gem} {capChip}</span>
                  <span className="v2-gem-hr">
                    {(g.heroes || '—') + ' · ' + things(g.rows.length) + ' · надето ' + nf(g.rows.filter(r => r.equipped).length) + ' · '}
                    {cap == null ? 'потолок не измерен'
                      : <>матчей у {who} {g.supplyKind === 'estimated' ? '≈ ' : ''}{nf(cap)}{g.supplyKind === 'estimated' ? <> <Chip tone="warn">оценка</Chip></> : null}</>}
                  </span>
                  {w.length ? (
                    <span className="v2-bay-with">
                      <span className="v2-mute">вместе с</span>
                      {w.map(x => <span key={x.gem} className="v2-chip">{x.gem} <b className="v2-num">{nf(x.n)}</b></span>)}
                    </span>
                  ) : null}
                </span>
                <span className="v2-bay-prog">
                  <span className="v2-hint">лучший счётчик <b className="v2-num">{nf(best)}</b>{goal != null ? ' / ' + nf(goal) : ' · цель не задана'}</span>
                  {goal != null ? <span className="v2-gem-bar"><i style={{ width: Math.max(Math.min(100, (best / goal) * 100), best ? 1.5 : 0) + '%', background: gs === 'reach' ? 'var(--warn)' : undefined }} /></span> : null}
                </span>
              </button>
              {isClosed ? null : (
                <div className="v2-cells">
                  {mine.map(s => <Cell key={s.key} st={s} goal={goal} on={current?.key === s.key} onClick={() => onSel(s.key)} />)}
                </div>
              )}
            </section>
          )
        })}
        {!stacks.some(s => passes(s, filter, bond, query)) ? (
          <p className="v2-inv-empty">Ничего не нашлось — сбросьте фильтр или поиск.</p>
        ) : null}
      </section>
    </div>
  )
}

function Cell({ st, goal, on, onClick }: { st: Stack; goal: number | null; on: boolean; onClick: () => void }) {
  const n = st.rows.length
  return (
    <button type="button" className={'v2-cell' + (on ? ' is-on' : '')} aria-pressed={on} onClick={onClick}>
      <span className="v2-cell-r1">
        <span className="v2-cell-ico" style={{ backgroundImage: st.gem.icon ? `url('${icon(st.gem.icon, 96)}')` : undefined }} aria-hidden="true">
          {n > 1 ? <span className="v2-cell-cnt v2-num">×{n}</span> : null}
        </span>
        <span className="v2-cell-nm">{st.name}</span>
        <span className="v2-cell-val"><b className="v2-num">{nf(st.max)}</b>{goal != null ? <span className="v2-num">/ {nf(goal)}</span> : null}</span>
      </span>
      {n > 1 ? (
        <span className="v2-pips" title={st.rows.map(r => r.value).join(' · ')}>
          {st.rows.map(r => <i key={r.assetid} className={(r.value > 0 ? 'is-on' : '') + (r.equipped ? ' is-eq' : '')} />)}
          <span className="v2-num">{st.rows.map(r => nf(r.value)).join(' · ')}</span>
        </span>
      ) : null}
      <span className="v2-cell-chips">
        {st.state ? <Chip tone={STATE[st.state].tone} dot>{STATE[st.state].word}</Chip> : <Chip>цель не задана</Chip>}
        {st.equipped ? <Chip>надето{n > 1 ? ' ' + nf(st.equipped) : ''}</Chip> : null}
        {st.bare ? <Chip>голый самоцвет</Chip> : null}
      </span>
    </button>
  )
}
