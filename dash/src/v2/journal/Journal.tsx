// Экран «Журнал» (§5.6, план 2.5): что уйдёт, что ушло и почему.
//
// Плитки — за всё время (журнал расхода, byState) и очередь; вкладки —
// отправки с пульсом, очередь, израсходовано, приход, решения. Выбранная
// отправка подробно — справа (JournalSide). Данные — data.ts.

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { clock, icon, nf, plural, useAction, type SendEvent, type State } from '../../lib/api.ts'
import { Loadable } from '../States.tsx'
import { Btn, Chip, Src } from '../ui.tsx'
import { answerOf, counts, dotaMatch, filterEvents, itemsWord, keyOf, leagueNames, pulse, usedByGem, type Filter } from './model.ts'
import { dupsOf, eventsOf, type ArrivalRow, type JournalData } from './data.ts'

export type Tab = 'feed' | 'queue' | 'used' | 'arrivals' | 'log'

export function MatchLink({ id }: { id: string }) {
  return (
    <a className="v2-id v2-jr-link" href={dotaMatch(id)} target="_blank" rel="noopener noreferrer" title="матч на OpenDota">
      {id}<ExternalLink size={11} aria-hidden="true" />
    </a>
  )
}

export function JournalScreen({ state, data, tab, onTab, sel, onSel, top }: {
  state: State
  data: JournalData
  tab: Tab
  onTab: (t: Tab) => void
  sel: string | null
  onSel: (key: string) => void
  top: number
}) {
  const events = eventsOf(state)
  const log = state.autopilot.log ?? []
  const q = data.queue.data
  const tabs: { id: Tab; label: string; n: number | null }[] = [
    { id: 'feed', label: 'Отправки', n: events.length },
    { id: 'queue', label: 'Очередь', n: q?.total ?? null },
    { id: 'used', label: 'Израсходовано', n: state.burned },
    { id: 'arrivals', label: 'Приход', n: data.arrivals.data ? mine(data.arrivals.data.rows, state).length : null },
    { id: 'log', label: 'Решения', n: log.length },
  ]
  const icons = iconMap(state)

  return (
    <div className="v2-jr">
      <header className="v2-inv-head">
        <div>
          <h1 className="v2-h1">Журнал</h1>
          <p className="v2-hint">Что уйдёт, что ушло и почему работник решил именно так. Сюда смотрят, когда что-то пошло не так.</p>
        </div>
      </header>

      <Tiles state={state} data={data} />

      <div className="v2-jr-tabs" role="tablist" aria-label="Разделы журнала">
        {tabs.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => onTab(t.id)}>
            {t.label}{t.n != null ? <span className="v2-num">{nf(t.n)}</span> : null}
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-label={tabs.find(t => t.id === tab)!.label}>
        {tab === 'feed' ? <Feed events={events} data={data} sel={sel} onSel={onSel} />
          : tab === 'queue' ? <Queue data={data} icons={icons} />
          : tab === 'used' ? <UsedTab data={data} top={top} icons={icons} />
          : tab === 'arrivals' ? <ArrivalsTab state={state} data={data} />
          : <Log log={log} />}
      </div>
    </div>
  )
}

// ── плитки ──

function Tiles({ state, data }: { state: State; data: JournalData }) {
  const b = data.burned.data?.byState
  const d = dupsOf(state)
  const q = data.queue.data
  const tile = (k: ReactNode, v: ReactNode, n: ReactNode, cls?: string) => (
    <div className={'v2-tile v2-jr-tile' + (cls ? ' ' + cls : '')}><span>{k}</span><b className="v2-num">{v}</b><small>{n}</small></div>
  )
  return (
    <div className="v2-jr-tiles">
      {tile(<>засчитано <Src>журнал</Src></>, b ? nf(b.confirmed) : '—', b ? 'msg 26 — единственное подтверждение, которому верим' : data.burned.loading ? 'загружается…' : 'журнал расхода не загрузился', 'is-ok')}
      {tile(<>спорных <Src>журнал</Src></>, b ? nf(b.dup) : '—',
        d ? 'ждут повтора ' + nf(d.waiting) + ' · брошены ' + nf(d.exhausted) + ' · со второй ' + nf(d.resolved) : 'дубль или отказ — снаружи не различить', 'is-warn')}
      {tile('сожжено на аккаунте', nf(state.burned), 'навсегда и только здесь; другому аккаунту они свежие')}
      {tile(<>в очереди <Src>очередь</Src></>, q ? nf(q.total) : '—', q ? nf(q.weight2) + ' из них поднимают сразу два гема' : data.queue.loading ? 'загружается…' : 'очередь не загрузилась')}
    </div>
  )
}

// ── отправки ──

function Feed({ events, data, sel, onSel }: { events: SendEvent[]; data: JournalData; sel: string | null; onSel: (k: string) => void }) {
  const [only, setOnly] = useState<Filter>('all')
  const c = counts(events)
  const rows = filterEvents(events, only)
  const names = leagueNames(data.tree.data, data.burned.data)
  if (!events.length) return <p className="v2-unavail">Отправок ещё не было — лента пуста.</p>
  return (
    <>
      <Pulse events={events} sel={sel} onSel={onSel} />
      <div className="v2-jr-filters" role="group" aria-label="Какие ответы показывать">
        {([['all', 'все'], ['update', 'засчитаны'], ['dup', 'спорные'], ['silent', 'без ответа']] as [Filter, string][]).map(([f, l]) => (
          <button key={f} type="button" aria-pressed={only === f} onClick={() => setOnly(f)}>{l}<span className="v2-num">{nf(c[f])}</span></button>
        ))}
      </div>
      <div className="v2-jr-list v2-jr-feed">
        <div className="v2-jr-lh" aria-hidden="true"><span>время</span><span>матч</span><span>лига</span><span>ответ</span><span className="is-r">изменено вещей</span></div>
        <ul>
          {rows.map(e => {
            const a = answerOf(e.result)
            const k = keyOf(e)
            const it = itemsWord(e)
            return (
              <li key={k} className={sel === k ? 'is-on' : undefined}>
                <button type="button" className="v2-jr-when v2-num" aria-pressed={sel === k} onClick={() => onSel(k)} title="подробно справа">{clock(e.ts)}</button>
                <MatchLink id={e.match_id} />
                <span className="v2-hint v2-jr-lg">{names.get(e.league_id) ?? (e.league_id ? 'лига ' + e.league_id : '—')}</span>
                <span><Chip tone={a.tone === 'idle' ? undefined : a.tone} dot>{a.word}</Chip>{e.bytes ? <span className="v2-hint v2-num"> {nf(e.bytes)} Б</span> : null}</span>
                <span className="is-r v2-num v2-jr-items" title={it.why ?? 'по ответу GC'}>{it.v}</span>
              </li>
            )
          })}
        </ul>
      </div>
      <p className="v2-note">«Спорный» и «уже израсходован» снаружи неразличимы: ответ Valve (7204) пустой по протоколу. Поэтому спорное не вычитается из остатка — матч мог остаться целым. «Изменено вещей» — число из ответа GC (msg 26), не оценка; у отправок до этапа 2.5 его нет.</p>
    </>
  )
}

// Пульс: каждая отправка — черта цвета ответа, слева направо по времени.
// В порядке Tab — одна черта (выбранная или последняя), дальше — стрелки.
function Pulse({ events, sel, onSel }: { events: SendEvent[]; sel: string | null; onSel: (k: string) => void }) {
  const line = pulse(events)
  const box = useRef<HTMLDivElement>(null)
  const at = Math.max(0, line.findIndex(e => keyOf(e) === sel))
  const focusIdx = sel && line.some(e => keyOf(e) === sel) ? at : line.length - 1
  const move = (e: KeyboardEvent, i: number) => {
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? line.length - 1 : null
    if (next == null) return
    e.preventDefault()
    const j = Math.max(0, Math.min(line.length - 1, next))
    onSel(keyOf(line[j]))
    box.current?.querySelectorAll<HTMLButtonElement>('button')[j]?.focus()
  }
  return (
    <div className="v2-panel v2-jr-pulse">
      <div className="v2-jr-pulse-h"><b>Пульс отправок</b><span className="v2-hint">последние {nf(line.length)} {plural(line.length, 'отправка', 'отправки', 'отправок')} · слева направо по времени · ← → — по одной</span></div>
      <div className="v2-jr-ticks" ref={box}>
        {line.map((e, i) => {
          const a = answerOf(e.result)
          const k = keyOf(e)
          return (
            <button
              key={k}
              type="button"
              className={'v2-jr-tick is-' + e.result + (sel === k ? ' is-on' : '')}
              tabIndex={i === focusIdx ? 0 : -1}
              aria-pressed={sel === k}
              aria-label={clock(e.ts) + ' · матч ' + e.match_id + ' · ' + a.word}
              title={clock(e.ts) + ' · ' + a.word}
              onClick={() => onSel(k)}
              onKeyDown={ev => move(ev, i)}
            />
          )
        })}
      </div>
      <div className="v2-jr-ax v2-hint v2-num"><span>{line.length ? new Date(line[0].ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</span><span>{line.length ? clock(line[line.length - 1].ts) : ''}</span></div>
    </div>
  )
}

// ── очередь ──

function Queue({ data, icons }: { data: JournalData; icons: Map<string, string> }) {
  const { queue } = data
  const q = queue.data
  return (
    <Loadable what="очередь" loading={queue.loading} error={queue.error} ready={!!q} onRetry={queue.reload}>
      {q && !q.rows.length ? (
        <p className="v2-unavail">Очередь пуста — либо в инвентаре нет гемов с известной сущностью, либо все их матчи уже израсходованы на этом аккаунте.</p>
      ) : q ? (
        <>
          <div className="v2-jr-list v2-jr-queue">
            <div className="v2-jr-lh" aria-hidden="true"><span>матч</span><span>лига</span><span>каким гемам</span><span className="is-r">поднимет</span></div>
            <ul>
              {q.rows.map(r => (
                <li key={r.match}>
                  <MatchLink id={r.match} />
                  <span className="v2-hint v2-num">{r.league || '—'}</span>
                  <span className="v2-jr-gems">{r.entities.map(g => <GemTag key={g} gem={g} icons={icons} />)}</span>
                  <span className="is-r">{r.weight > 1 ? <Chip tone="ok">×{r.weight}</Chip> : <span className="v2-hint v2-num">×{r.weight}</span>}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="v2-note">Показаны первые {nf(q.rows.length)} из {nf(q.total)}. Двойные идут первыми: один такой матч поднимает два гема одной отправкой — чтобы остановка пришлась на дешёвый хвост.</p>
        </>
      ) : null}
    </Loadable>
  )
}

function GemTag({ gem, icons }: { gem: string; icons: Map<string, string> }) {
  const ic = icons.get(gem)
  return <span className="v2-jr-gem"><i style={{ backgroundImage: ic ? `url('${icon(ic, 64)}')` : undefined }} aria-hidden="true" />{gem}</span>
}

// ── израсходовано ──

function UsedTab({ data, top, icons }: { data: JournalData; top: number; icons: Map<string, string> }) {
  const { tree } = data
  const used = usedByGem(tree.data, top)
  return (
    <Loadable what="израсходовано" loading={tree.loading} error={tree.error} ready={!!tree.data} onRetry={tree.reload}>
      {!used.length ? <p className="v2-unavail">Гемов с известной сущностью нет — считать нечего.</p> : (
        <>
          <div className="v2-jr-used">
            {used.map(g => {
              const max = Math.max(1, ...g.leagues.map(l => l.value))
              const ic = g.icon ?? icons.get(g.gem)
              return (
                <section key={g.gem} className="v2-panel v2-jr-ug" aria-label={'Гем ' + g.gem}>
                  <header>
                    <i style={{ backgroundImage: ic ? `url('${icon(ic, 64)}')` : undefined }} aria-hidden="true" />
                    <span><b>{g.gem}</b><span className="v2-hint">матчей всего {nf(g.value)} <Src>карта</Src></span></span>
                    <span className="v2-jr-ug-v"><b className="v2-num">{nf(g.burned)}</b><span className="v2-hint">сожжено</span></span>
                  </header>
                  <ul>
                    {g.leagues.map(l => (
                      <li key={l.id}>
                        <span className="v2-jr-ug-n" title={l.label}>{l.label}</span>
                        <span className="v2-jr-bar" aria-hidden="true">
                          <i style={{ width: (l.value / max * 100) + '%' }} />
                          {l.burned ? <i className="is-burned" style={{ width: (l.burned / max * 100) + '%' }} /> : null}
                        </span>
                        <span className="v2-num v2-hint is-r">{l.burned ? nf(l.burned) + ' / ' : ''}{nf(l.value)}</span>
                      </li>
                    ))}
                  </ul>
                  {g.rest ? <p className="v2-hint v2-num">{g.rest.label} · {nf(g.rest.value)} матчей</p> : null}
                </section>
              )
            })}
          </div>
          <p className="v2-note">Матч сгорает навсегда и только на этом аккаунте. По каждому гему — крупнейшие турниры его матчей (не больше {nf(top)}); жёлтым — сколько из них уже сожжено.</p>
        </>
      )}
    </Loadable>
  )
}

// ── приход ──

const VERDICT: Record<ArrivalRow['verdict'], { word: string; tone?: 'ok' }> = {
  'выигрыш': { word: 'выигрыш', tone: 'ok' },
  'наш': { word: 'наш' },
  'чисто': { word: 'чисто' },
}

// Строки прихода — только активного аккаунта: «вещи уже нет» сервер считает
// по его инвентарю, у чужих строк это было бы неправдой.
const mine = (rows: ArrivalRow[], state: State) => rows.filter(r => !r.account || r.account === state.autopilot.steamid)

function ArrivalsTab({ state, data }: { state: State; data: JournalData }) {
  const { arrivals } = data
  const a = arrivals.data
  const act = useAction()
  const [only, setOnly] = useState<'all' | ArrivalRow['verdict']>('all')
  const own = a ? mine(a.rows, state) : []
  const others = a ? a.rows.length - own.length : 0
  const rows = own.filter(r => only === 'all' || r.verdict === only)
  const flip = async (r: ArrivalRow) => {
    const res: any = await act.run('/api/arrivals/aside', { assetid: r.assetid, aside: !r.aside })
    if (!res?.error) arrivals.reload()
  }
  return (
    <Loadable what="приход" loading={arrivals.loading} error={arrivals.error} ready={!!a} onRetry={arrivals.reload}>
      {!own.length ? (
        <div className="v2-unavail v2-jr-legend">
          <p>Приходов на этом аккаунте пока нет. Здесь появится каждая купленная вещь: с каким числом приехала и чьё оно.</p>
          <Legend />
        </div>
      ) : (
        <>
          <div className="v2-jr-filters" role="group" aria-label="Какие вердикты показывать">
            {(['all', 'выигрыш', 'наш', 'чисто'] as const).map(v => (
              <button key={v} type="button" aria-pressed={only === v} onClick={() => setOnly(v)}>
                {v === 'all' ? 'все' : v}<span className="v2-num">{nf(v === 'all' ? own.length : own.filter(r => r.verdict === v).length)}</span>
              </button>
            ))}
          </div>
          <div className="v2-jr-list v2-jr-arr">
            <div className="v2-jr-lh" aria-hidden="true"><span>вещь</span><span>вердикт</span><span className="is-r">приехала · сейчас</span><span /></div>
            <ul>
              {rows.map(r => {
                const v = VERDICT[r.verdict] ?? { word: r.verdict }
                return (
                  <li key={r.assetid} className={r.gone ? 'is-gone' : undefined}>
                    <span className="v2-jr-item"><b>{r.item}</b><span className="v2-hint">{r.gem} · {r.carrier === 'gem' ? 'голый гем' : 'в вещи'}{r.gone ? ' · вещи уже нет' : ''}</span></span>
                    <span><Chip tone={v.tone} dot>{v.word}</Chip>{r.unexplained ? <span className="v2-hint v2-num"> чужих {nf(r.unexplained)}</span> : null}</span>
                    <span className="is-r v2-num">{nf(r.value)} · {r.now == null ? '—' : nf(r.now)}</span>
                    <span className="is-r">
                      {r.verdict === 'выигрыш' && !r.gone ? <Btn tone="soft" className="v2-jr-aside" loading={act.busy} onClick={() => flip(r)}>{r.aside ? 'вернуть в фарм' : 'отложить'}</Btn> : r.aside ? <span className="v2-hint">отложена</span> : null}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
          {act.error ? <p className="v2-note is-stop" role="alert">Не вышло: {act.error}</p> : null}
          <p className="v2-note">«Выигрыш» — чужих просмотров от 50: такую вещь выгоднее продать как есть, «отложить» убирает её из фарма. Показаны вещи активного аккаунта{others ? '; ещё ' + nf(others) + ' — на других аккаунтах' : ''}; сервер отдаёт не больше 400 строк.</p>
          <Legend />
        </>
      )}
    </Loadable>
  )
}

function Legend() {
  return (
    <dl className="v2-jr-verdicts">
      <div><dt>старое</dt><dd>лежало до сканера — в список не попадает</dd></div>
      <div><dt>чисто</dt><dd>приехала нулевой — обычное сырьё</dd></div>
      <div><dt>наш</dt><dd>число объясняется нашими отправками</dd></div>
      <div><dt className="is-ok">выигрыш</dt><dd>чужих просмотров от 50 — продать как есть</dd></div>
    </dl>
  )
}

// ── решения ──

function Log({ log }: { log: State['autopilot']['log'] }) {
  if (!log.length) return <p className="v2-unavail">Решений ещё не было.</p>
  return (
    <>
      <ol className="v2-jr-list v2-jr-log">
        {[...log].sort((a, b) => b.ts - a.ts).map((l, i) => (
          <li key={l.ts + ':' + i}>
            <span className="v2-hint v2-num">{new Date(l.ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            <Chip>{l.action}</Chip>
            <span>{l.why}</span>
          </li>
        ))}
      </ol>
      <p className="v2-note">Каждое решение работника активного аккаунта — запустить, подождать, встать — с причиной словами.</p>
    </>
  )
}

function iconMap(state: State) {
  const m = new Map<string, string>()
  for (const x of state.catalog) if (x.icon) m.set(x.short, x.icon)
  for (const g of state.mine) if (g.icon) m.set(g.gem, g.icon)
  return m
}
