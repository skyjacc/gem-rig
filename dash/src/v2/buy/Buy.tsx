// Экран «Скупка» (§5.3, план 2.3): конвейер робота, прогресс, лента покупок, план.
//
// Данные:
//   разбор площадки   GET /api/market?cur=   (план, цель, ключ, баланс)
//   ход закупки       state.purchase         (приходит потоком)
//   приход            GET /api/arrivals      (нижняя граница — model.ts)
//   общие с моими     число — overlap сервера; аватарки — /api/graph?scope=all
// В показе (VITE_DEMO) разбора, хода закупки и прихода в снимке нет — берутся
// из demo/buy.json, составленного руками (план 2.3, решение 1).
//
// Состояние экрана живёт в useBuy(), его держит AppV2: план и корзину справа
// (BuySide, задача 3) видят оба — степперы здесь, корзина там.

import { useMemo, useState, type ReactNode } from 'react'
import { RefreshCw, Search, Square } from 'lucide-react'
import snapshot from '../../demo/snapshot.json'
import fixture from '../../demo/buy.json'
import {
  DEMO, icon, nf, plural, useAction, useJson,
  type Accounts, type GraphData, type PurchaseRun, type Settings, type State,
} from '../../lib/api.ts'
import { Loadable } from '../States.tsx'
import { useCalm } from '../overview/Canvas.tsx'
import { Btn, Chip, Panel, Src } from '../ui.tsx'
import {
  arrivedSince, cartOf, feed, launchBlock, maxTake, planOrder, SPEED,
  type Arrival, type Cur, type FeedKind, type Offer, type Scan,
} from './model.ts'

const FIX: any = fixture
const SNAP: any = snapshot

const CURS: Cur[] = ['USD', 'RUB', 'EUR', 'UAH']
const SIGN: Record<Cur, string> = { RUB: '₽', USD: '$', EUR: '€', UAH: '₴' }

// Как в старой Скупке: доллар знаком спереди и точкой, остальные — знаком
// сзади и запятой; полцента остаётся полцентом.
export function money(v: number, c: string) {
  const n = Number(v) || 0
  if (c === 'USD') return '$' + n.toFixed(Math.abs(n) < 0.01 && n !== 0 ? 3 : 2)
  const [w, f] = n.toFixed(Math.abs(n) < 1 && n !== 0 ? 3 : 2).split('.')
  return w.replace(/\B(?=(\d{3})+$)/g, ' ') + ',' + f + ' ' + (SIGN[c as Cur] ?? c)
}

// Отправки → время при SPEED в минуту. Это оценка (§5.3).
export function minutes(sends: number) {
  const m = Math.round(sends / SPEED)
  if (m < 60) return nf(m) + ' мин'
  return nf(Math.floor(m / 60)) + ' ч ' + nf(m % 60) + ' мин'
}

export type Buy = ReturnType<typeof useBuy>

export function useBuy(state: State | null, on: boolean, settings: Settings | null, accounts: Accounts | null) {
  const [cur, setCur] = useState<Cur>('USD')
  const [take, setTake] = useState<Record<string, number>>({})
  const [budget, setBudget] = useState('')
  const ts = state?.ts

  // Вне Скупки ничего не запрашиваем: разбор площадки дорогой (api.ts).
  const market = useJson<Scan>(on && !DEMO ? '/api/market?cur=' + cur : null, ts)
  const graph = useJson<GraphData>(on && !DEMO ? '/api/graph?scope=all' : null, ts)
  const run: PurchaseRun | null = DEMO ? ((state as any)?.purchase ?? FIX.purchase) : state?.purchase ?? null
  const arrivals = useJson<{ rows: Arrival[] }>(on && !DEMO && run?.startedAt ? '/api/arrivals' : null, ts)

  // В показе разбор есть только в одной валюте — той, что в buy.json.
  const scan: Scan | null = DEMO ? (cur === FIX.market.currency ? FIX.market : null) : market.data
  const edges: GraphData['edges'] | null = DEMO ? SNAP.graphAll.edges : graph.data?.edges ?? null
  const rows: Arrival[] | null = DEMO ? FIX.arrivals.rows : arrivals.data?.rows ?? null

  const cart = cartOf(scan, take)
  const cap = settings?.purchaseCap
  const running = !!run?.active
  const block = launchBlock({ scan, running, cart, cur, cap })
  const steamid = accounts?.list.find(a => a.id === run?.account?.id)?.steamid ?? null
  const arrived = run ? arrivedSince(rows, run.startedAt, steamid) : null

  return {
    cur, setCur, take, setTake, budget, setBudget,
    scan, market, edges, run, running, cart, cap, block, arrived,
    settings,
  }
}

// Значки гемов: у разбора площадки их нет — берём из каталога и своих гемов.
const icons = (state: State) => {
  const m = new Map<string, string>()
  for (const c of state.catalog) if (c.icon) m.set(c.short, c.icon)
  for (const g of state.mine) if (g.icon) m.set(g.gem, g.icon)
  return m
}

export function BuyScreen({ state, buy }: { state: State; buy: Buy }) {
  const { scan, cur } = buy
  const [only, setOnly] = useState<'fit' | 'free' | 'all'>('fit')
  const [q, setQ] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const pics = useMemo(() => icons(state), [state])
  // «Мои» — как «в работе» у сервера (autopilot.ts picks()): свои гемы из
  // карты. С ними сервер и считает overlap.
  const mine = useMemo(() => new Set(state.mine.filter(m => m.kind === 'team' || m.kind === 'player').map(m => m.gem)), [state])

  const refresh = async () => {
    // Сначала сервер идёт на площадку заново, потом перечитываем — иначе
    // кнопка обновила бы экран старым кешем (так же в старой Скупке).
    setRefreshing(true)
    await fetch('/api/market?force=1&cur=' + cur).catch(() => { })
    setRefreshing(false)
    buy.market.reload()
  }

  return (
    <div className="v2-buy">
      <header className="v2-inv-head">
        <div>
          <h1 className="v2-h1">Скупка</h1>
          <p className="v2-hint">робот сам покупает на market.dota2.net по вашему плану — лот за лотом, сверяя цену перед каждым</p>
        </div>
        <div className="v2-buy-tools">
          <div className="v2-seg" role="group" aria-label="Валюта цен">
            {CURS.map(c => (
              <button key={c} type="button" aria-pressed={cur === c} onClick={() => buy.setCur(c)}>{SIGN[c]} {c}</button>
            ))}
          </div>
          <Btn tone="soft" loading={refreshing} disabled={DEMO} title={DEMO ? 'в показе цены не обновляются' : undefined} onClick={refresh}>
            <RefreshCw size={14} aria-hidden="true" />обновить цены
          </Btn>
        </div>
      </header>
      {scan ? (
        <p className="v2-hint v2-buy-scanned">
          {scan.error ? <span className="is-stop">площадка: {scan.error}</span> : 'просмотрено ' + nf(scan.scanned) + ' ' + plural(scan.scanned, 'позиция', 'позиции', 'позиций')}
          {scan.updated ? ' · цены от ' + new Date(scan.updated).toLocaleTimeString('ru-RU') : ''}
          {scan.converted ? ' · гривна — пересчёт по курсу НБУ ' + scan.rate.toFixed(2) + ', только для прикидки' : ''}
        </p>
      ) : null}

      <Robot buy={buy} />

      <Panel title="План" aside={<>цены — <Src>площадка</Src> · аватарки общих — <Src>граф</Src> · доп. время — <Chip tone="warn">оценка</Chip></>}>
        {DEMO && !scan ? (
          <p className="v2-text">В показе разбор площадки есть только в {FIX.market.currency} — переключите валюту.</p>
        ) : (
          <Loadable what="цены площадки" loading={buy.market.loading} error={scan ? null : buy.market.error} ready={!!scan} onRetry={buy.market.reload} lines={6}>
            {scan ? <Plan buy={buy} scan={scan} only={only} setOnly={setOnly} q={q} setQ={setQ} pics={pics} mine={mine} /> : null}
          </Loadable>
        )}
      </Panel>
    </div>
  )
}

// ── робот: конвейер, прогресс, лента ──

function Robot({ buy }: { buy: Buy }) {
  const { run, cart, scan, arrived, cap } = buy
  const calm = useCalm()
  const stop = useAction()
  const on = !!run?.active
  const started = !!run && (run.active || run.done > 0)
  const c = run?.currency || scan?.balanceCurrency || buy.cur
  // Чем кончилась закупка — по последней записи ленты: стоп (вручную, нет
  // денег, неясно, отказ по custom_id) — это не «закончена».
  const last = !run || run.active ? null : feed(run.log.slice(0, 1))[0] ?? null
  const halted = last?.kind === 'stop' ? last.l.reason : null
  const word = on ? 'работает' : !started ? 'ждёт запуска' : run?.error ? 'сбой'
    : halted === 'остановлено' ? 'остановлена вручную' : halted ? 'остановлена: ' + halted : 'закупка закончена'
  const tone = on ? 'ok' : run?.error || (halted && halted !== 'остановлено') ? 'stop' : halted ? 'warn' : undefined
  const pos = run?.positions ?? []
  const at = run ? pos.findIndex(p => p.gem === run.current) : -1
  const pct = run?.planned ? Math.min(100, (run.done / run.planned) * 100) : 0

  return (
    <section className="v2-buy-pipe" aria-label="Робот закупки">
      <div className="v2-buy-pipe-l">
        <div className="v2-buy-pipe-h">
          <h2>Робот закупки</h2>
          <Chip tone={tone} dot={on}>{word}</Chip>
          {run?.account ? <span className="v2-hint">на «{run.account.label}»</span> : null}
        </div>

        <div className={'v2-buy-stages' + (on ? ' is-on' : '')}>
          <Stage n={1} title="План" live={on}
            big={started ? nf(run!.planned) : nf(cart.units)} unit={plural(started ? run!.planned : cart.units, 'лот', 'лота', 'лотов')}
            note={started ? 'заказано на этот запуск' : cart.units ? 'в корзине · до ' + money(cart.cost, c) : 'соберите ниже или по бюджету справа'} />
          <Wire on={on && !calm} />
          <Stage n={2} title="Покупка" live={on}
            big={nf(run?.ok ?? 0)} unit="куплено"
            note="перед каждым лотом — свежая цена; дороже плана не берёт" />
          <Wire on={on && !calm} />
          <Stage n={3} title="Приход в Steam" live={on}
            big={arrived ? '≥ ' + nf(arrived.total) : '—'} unit="пришло"
            note={arrived ? 'по последним строкам прихода; всё новое на аккаунте, не только купленное' : started ? 'приход не пришёл' : 'появится после запуска'}
            src="журнал">
            {arrived ? (
              <div className="v2-buy-verd">
                <Chip>чисто {nf(arrived.clean)}</Chip>
                <Chip>наш {nf(arrived.ours)}</Chip>
                <Chip tone={arrived.win ? 'ok' : undefined}>выигрыш {nf(arrived.win)}</Chip>
              </div>
            ) : null}
          </Stage>
        </div>

        <div className="v2-buy-prog">
          <div className="v2-buy-prog-t">
            <span>куплено <b className="v2-num">{nf(run?.ok ?? 0)}</b> из <b className="v2-num">{nf(run?.planned ?? 0)}</b></span>
            <span>потрачено <b className="v2-num">{money(run?.spent ?? 0, c)}</b>
              {cap != null && cap > 0 ? <> из потолка <b className="v2-num">{money(cap, c)}</b></> : <> · потолок не задан</>}
            </span>
            <Btn tone="stop" disabled={!on} loading={stop.busy} onClick={() => stop.run('/api/market/stop', {})}>
              <Square size={12} aria-hidden="true" />Остановить
            </Btn>
          </div>
          <div className="v2-meter-bar" role="progressbar" aria-label="ход закупки" aria-valuemin={0} aria-valuemax={run?.planned ?? 0} aria-valuenow={run?.done ?? 0}>
            <i style={{ width: pct + '%', background: run?.error ? 'var(--stop)' : undefined }} />
          </div>
          <p className="v2-hint v2-buy-now">
            {on
              ? 'сейчас: ' + (run!.current || 'запускаюсь') +
                ' · лот ' + nf(Math.min(run!.done + 1, run!.planned)) + ' из ' + nf(run!.planned) +
                (at >= 0 ? ' · позиция ' + (at + 1) + ' из ' + pos.length : '') +
                (run!.pass > 1 ? ' · заход ' + run!.pass : '')
              : started ? word + (run!.finishedAt ? ' · ' + new Date(run!.finishedAt).toLocaleTimeString('ru-RU') : '')
              : 'робот стоит. Запуск — кнопкой «Запустить закупку» в корзине'}
          </p>
          {run?.error ? <p className="v2-note is-stop" role="alert">Сбой закупки: {run.error}</p> : null}
          {stop.error ? <p className="v2-note is-stop" role="alert">Не остановилось: {stop.error}</p> : null}
        </div>
      </div>

      <Feed run={run} c={c} />
    </section>
  )
}

function Stage({ n, title, big, unit, note, live, src, children }: {
  n: number; title: string; big: string; unit: string; note: string; live: boolean; src?: string; children?: ReactNode
}) {
  return (
    <div className={'v2-buy-stage' + (live ? ' is-live' : '')}>
      <div className="v2-buy-stage-h"><i>{n}</i>{title}{src ? <Src>{src}</Src> : null}</div>
      <div className="v2-buy-big"><b className="v2-num">{big}</b> <small>{unit}</small></div>
      {children}
      <p className="v2-buy-d">{note}</p>
    </div>
  )
}

// Связь между узлами. Во время закупки по ней бежит импульс; при
// «уменьшить движение» — без него (и общий запрет анимаций в v2.css).
function Wire({ on }: { on: boolean }) {
  return (
    <span className={'v2-buy-wire' + (on ? ' is-on' : '')} aria-hidden="true">
      {on ? <i /> : null}
    </span>
  )
}

const MARK: Record<FeedKind, string> = { ok: '✓', skip: '↑', retry: '↻', stop: '■' }

function Feed({ run, c }: { run: PurchaseRun | null; c: string }) {
  const rows = feed(run?.log ?? [])
  return (
    <div className="v2-buy-feed" aria-label="Лента покупок">
      <div className="v2-buy-feed-h">
        <span>Лента покупок</span>
        <span className="v2-hint">{rows.length ? 'последние ' + nf(rows.length) : ''}</span>
      </div>
      {rows.length ? (
        <ol className="v2-buy-feed-l">
          {rows.map((r, i) => (
            <li key={r.l.ts + ':' + i} className={'is-' + r.kind} title={r.l.detail || undefined}>
              <span className="v2-buy-mark" aria-hidden="true">{MARK[r.kind]}</span>
              <span className="v2-buy-feed-m">
                <span><b>{r.l.gem}</b> <span className="v2-hint v2-num">{new Date(r.l.ts).toLocaleTimeString('ru-RU')}</span></span>
                <span className="v2-buy-feed-t">{r.text}</span>
              </span>
              <span className="v2-buy-feed-p v2-num">
                {money(r.l.price, c)}
                {r.l.planned != null && Math.abs(r.l.planned - r.l.price) > 1e-9 ? <small>план {money(r.l.planned, c)}</small> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="v2-buy-empty">здесь каждый лот: цена в плане и цена в момент покупки</p>
      )}
    </div>
  )
}

// ── план ──

function Plan({ buy, scan, only, setOnly, q, setQ, pics, mine }: {
  buy: Buy; scan: Scan
  only: 'fit' | 'free' | 'all'; setOnly: (v: 'fit' | 'free' | 'all') => void
  q: string; setQ: (v: string) => void
  pics: Map<string, string>; mine: Set<string>
}) {
  const goal = scan.goal
  // Порядок по умолчанию — порядок «собрать план» (§5.3); не дойдущие — в конце,
  // в порядке сервера.
  const ordered = useMemo(() => {
    const first = planOrder(scan.offers)
    const seen = new Set(first.map(o => o.gem))
    return [...first, ...scan.offers.filter(o => !seen.has(o.gem))]
  }, [scan])

  const count = {
    fit: scan.offers.filter(o => o.reaches).length,
    free: scan.offers.filter(o => o.burning).length,
    all: scan.offers.length,
  }
  const shown = ordered
    .filter(o => (only === 'all' ? true : only === 'free' ? o.burning : o.reaches))
    .filter(o => !q || o.gem.toLowerCase().includes(q.toLowerCase()))

  // С кем общие матчи — пары графа, где второй конец — мой гем. Число берём
  // у сервера (overlap): сумма пар завышает (§5.3).
  // Пара может встретиться дважды (демо-снимок снят до PR #17, где сервер
  // убрал дубли узлов) — по партнёру оставляем одну, с большим числом.
  const withMine = (gem: string) => {
    const by = new Map<string, number>()
    for (const e of buy.edges ?? []) {
      const other = e.a === gem ? e.b : e.b === gem ? e.a : null
      if (other && mine.has(other)) by.set(other, Math.max(by.get(other) ?? 0, e.shared))
    }
    return [...by].map(([g, n]) => ({ gem: g, n })).sort((a, b) => b.n - a.n).slice(0, 3)
  }

  const bump = (o: Offer, d: number) =>
    buy.setTake(t => ({ ...t, [o.gem]: Math.max(0, Math.min(maxTake(o, scan.perGem), (t[o.gem] ?? 0) + d)) }))

  const FILTERS: [typeof only, string][] = [['fit', 'дойдут до цели'], ['free', 'без отправок'], ['all', 'все']]

  return (
    <div className="v2-buy-plan">
      <div className="v2-inv-bar">
        <div className="v2-inv-filters" role="group" aria-label="Что показать">
          {FILTERS.map(([k, label]) => (
            <button key={k} type="button" className="v2-fchip" aria-pressed={only === k} onClick={() => setOnly(k)}>
              {label} <span>{nf(count[k])}</span>
            </button>
          ))}
        </div>
        <label className="v2-net-find v2-inv-find">
          <Search size={13} aria-hidden="true" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="гем" aria-label="Поиск по гему" />
        </label>
      </div>

      <div className="v2-buy-table" role="table" aria-label="План закупки">
        <div className="v2-buy-th" role="row">
          <span role="columnheader">гем</span>
          <span role="columnheader" className="is-r">цена</span>
          {/* Единица цены (per1000 сервера — за тысячу просмотров), не цель. */}
          <span role="columnheader" className="is-r">за 1 000</span>
          <span role="columnheader">потолок · цель {nf(goal)}</span>
          {/* Число общих сервер считает по карте матчей (api.ts marketScan, entityIds) —
              метка «карта»; аватарки — пары /api/graph, метка «граф» в шапке панели. */}
          <span role="columnheader">общих с моими <Src>карта</Src></span>
          <span role="columnheader" className="is-r">лотов</span>
          <span role="columnheader" className="is-r" title={'отправок сверх уже идущего; при ' + SPEED + ' в минуту'}>доп. время</span>
          <span role="columnheader" className="is-r">взять</span>
        </div>
        {shown.length ? shown.map(o => {
          const n = buy.take[o.gem] ?? 0
          const max = maxTake(o, scan.perGem)
          const w = withMine(o.gem)
          const scale = Math.max(o.pool, goal) || 1
          const why = o.burning
            ? 'гем уже крутится: новые копии поднимут те же отправки'
            : 'min(потолок ' + nf(o.pool) + ', цель ' + nf(goal) + ') − общие ' + nf(Math.min(o.overlap, goal)) + ' = ' + nf(o.sends) + ' ' + plural(o.sends, 'отправка', 'отправки', 'отправок') +
              '; при ' + SPEED + ' в минуту это ' + minutes(o.sends)
          return (
            <div key={o.gem} role="row" className={'v2-buy-tr' + (o.burning ? ' is-free' : '') + (o.reaches ? '' : ' is-no') + (buy.running && buy.run?.current === o.gem ? ' is-buying' : '')}>
              <span role="cell" className="v2-buy-who">
                <span className="v2-item-ico" style={{ backgroundImage: pics.get(o.gem) ? `url('${icon(pics.get(o.gem)!, 64)}')` : undefined }} aria-hidden="true" />
                <span className="v2-buy-nm">
                  <b>{o.gem}</b>
                  <span className="v2-hint">
                    {o.burning ? 'в работе' : o.reaches ? 'дойдёт до цели' : 'не дойдёт: матчей меньше цели'}
                    {o.owned ? ' · у меня ' + nf(o.owned) : ''}
                  </span>
                </span>
              </span>
              <span role="cell" className="is-r v2-num">{money(o.price, scan.currency)}</span>
              <span role="cell" className="is-r v2-num">{Number.isFinite(o.per1000) ? money(o.per1000, scan.currency) : '—'}</span>
              <span role="cell" className="v2-buy-cap">
                <span className="v2-num">{nf(o.pool)}</span>
                <span className="v2-buy-capbar" aria-hidden="true">
                  <i style={{ width: (o.pool / scale) * 100 + '%', background: o.reaches ? undefined : 'var(--warn)' }} />
                  <em style={{ left: (goal / scale) * 100 + '%' }} />
                </span>
              </span>
              <span role="cell" className="v2-buy-with">
                {o.burning ? <span className="v2-hint">—</span> : (
                  <>
                    <span className="v2-num">{nf(o.overlap)}</span>
                    {w.length ? (
                      <span className="v2-buy-avs" title={w.map(x => x.gem + ' ' + nf(x.n)).join(', ') + ' — пары из графа'}>
                        {w.map(x => <i key={x.gem} style={{ backgroundImage: pics.get(x.gem) ? `url('${icon(pics.get(x.gem)!, 64)}')` : undefined }} />)}
                      </span>
                    ) : null}
                  </>
                )}
              </span>
              <span role="cell" className="is-r v2-num">{nf(o.volume)}</span>
              <span role="cell" className={'is-r v2-buy-tm' + (o.burning ? ' is-free' : '')} title={why}>
                {o.burning ? <><b>бесплатно</b><small>уже крутится</small></>
                  : <><b className="v2-num">+{minutes(o.sends)}</b><small className="v2-num">{nf(o.sends)} {plural(o.sends, 'отправка', 'отправки', 'отправок')}</small></>}
              </span>
              <span role="cell" className="is-r">
                <span className={'v2-step' + (n ? ' has' : '')}>
                  <button type="button" aria-label={'убрать лот ' + o.gem} disabled={buy.running || n <= 0} onClick={() => bump(o, -1)}>−</button>
                  <span className="v2-num" aria-label={'взять ' + o.gem}>{nf(n)}</span>
                  <button type="button" aria-label={'добавить лот ' + o.gem} disabled={buy.running || n >= max} onClick={() => bump(o, 1)}>+</button>
                </span>
              </span>
            </div>
          )
        }) : <p className="v2-inv-empty">Под фильтр ничего не подходит.</p>}
      </div>
      <p className="v2-hint">
        показано {nf(shown.length)} из {nf(scan.offers.length)} · не больше {nf(scan.perGem)} лотов одного гема · во время закупки план не меняется
      </p>
    </div>
  )
}
