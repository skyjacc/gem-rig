// Экран «Продажи» (§5.4, план 2.6): сколько реальных денег принесла работа.
//
// Где данные есть (журнал операций, снимок ключей) — настоящие числа; где нет
// — пустое состояние со словами «подключается на этапе N», не ноль. Суммы
// разных валют не складываются; масштаб денег — по источнику (model.ts).

import { useState, type ReactNode } from 'react'
import { ArrowRight, RefreshCw } from 'lucide-react'
import { ago, DEMO, nf, plural, useAction } from '../../lib/api.ts'
import { Loadable } from '../States.tsx'
import { Btn, Chip, Panel, Src } from '../ui.tsx'
import {
  avg, clean, countdown, currencyName, dayLabel, gemBuysDays, gmt, inPeriod, keyBatches, money, path,
  PERIODS, salesDays, stornoNotes, walletCurrencies, walletDays, when, type Invested, type Period, type Sum,
} from './model.ts'
import { LIMIT, type SalesData } from './data.ts'

// Сумма словами валюты; масштаб не проверен — подсказка вместо денег.
function M({ source, currency, units }: { source: string; currency: string; units: number }) {
  const m = money(source, currency, units)
  const c = currencyName(currency)
  return <span className={'v2-num' + (m.known ? '' : ' v2-sl-raw')} title={[c.hint, m.known ? null : 'единицы источника; масштаб для этой пары не проверен'].filter(Boolean).join(' · ') || undefined}>{m.text}</span>
}

// Несколько валют — по строке на валюту, никогда не одной суммой.
function Sums({ sums, none }: { sums: Sum[]; none: string }) {
  if (!sums.length) return <span className="v2-hint">{none}</span>
  return <span className="v2-sl-sums">{sums.map(s => <M key={s.source + s.currency} source={s.source} currency={s.currency} units={s.units} />)}</span>
}

export function SalesScreen({ data, now }: { data: SalesData; now: number }) {
  const [period, setPeriod] = useState<Period>('all')
  const [cur, setCur] = useState<string | null>(null)
  const [day, setDay] = useState<string | null>(null)
  const raw = data.money.data
  const list = Array.isArray(raw) ? raw : []
  const c = clean(list)
  const ops = inPeriod(c.ops, period, now)
  const p = path(ops)
  const wcs = walletCurrencies(c.ops)
  const wc = cur && wcs.includes(cur) ? cur : wcs[0] ?? null

  return (
    <div className="v2-sl">
      <header className="v2-inv-head">
        <div>
          <h1 className="v2-h1">Продажи</h1>
          <p className="v2-hint">Сколько реальных денег принесла работа. Все суммы — в валютах операций; суммы разных валют не складываются. Отчёт в $ — когда появится история курсов на дату операции.</p>
        </div>
        <div className="v2-seg" role="group" aria-label="Период">
          {PERIODS.map(([id, l]) => <button key={id} type="button" aria-pressed={period === id} onClick={() => setPeriod(id)}>{l}</button>)}
        </div>
      </header>

      <Loadable what="журнал операций" loading={data.money.loading} error={data.money.error} ready={raw != null} onRetry={data.money.reload}>
        {list.length >= LIMIT ? <p className="v2-note is-warn">Загружен предел {nf(LIMIT)} операций — история может быть неполной.</p> : null}
        {stornoNotes(c, list.length < LIMIT).map(n => (
          <p key={n.text} className={n.tone === 'warn' ? 'v2-note is-warn' : 'v2-hint'}>{n.text}</p>
        ))}

        <Path p={p} data={data} now={now} />
        <Totals p={p} />

        {wc ? (
          <Panel title="Кошелёк Steam по дням" aside={<Src>журнал</Src>}>
            {wcs.length > 1 ? (
              <div className="v2-seg v2-sl-cur" role="group" aria-label="Валюта кошелька">
                {wcs.map(x => <button key={x} type="button" aria-pressed={wc === x} onClick={() => { setCur(x); setDay(null) }} title={currencyName(x).hint ?? undefined}>{currencyName(x).label}</button>)}
              </div>
            ) : null}
            <Wallet ops={ops} currency={wc} day={day} onDay={setDay} />
          </Panel>
        ) : null}

        <Panel title="Продажи на Steam" aside={<>четыре числа из истории рынка <Src>журнал</Src></>}>
          {wc ? <SalesTable ops={ops} currency={wc} /> : <p className="v2-hint">Продаж на Steam за период нет.</p>}
        </Panel>

        <Panel title="Покупки гемов" aside={<>market.dota2.net · с возвратами <Src>площадка</Src></>}>
          <BuysTable ops={ops} />
        </Panel>
      </Loadable>

      <Keys data={data} ops={ops} now={now} />
    </div>
  )
}

// ── путь денег (решение 5) ──

function Path({ p, data, now }: { p: ReturnType<typeof path>; data: SalesData; now: number }) {
  const k = data.keys.data
  const s = k?.summary
  const node = (title: ReactNode, big: ReactNode, body: ReactNode, cls?: string) => (
    <div className={'v2-sl-node' + (cls ? ' ' + cls : '')}>
      <span className="v2-sl-node-t">{title}</span>
      <b className="v2-num">{big}</b>
      <span className="v2-sl-node-b">{body}</span>
    </div>
  )
  const arrow = <ArrowRight size={14} className="v2-sl-arrow" aria-hidden="true" />
  return (
    <div className="v2-sl-path" aria-label="Путь денег">
      {node(<>Гемы куплены <Src>площадка</Src></>, nf(p.gems.n) + ' ' + plural(p.gems.n, 'покупка', 'покупки', 'покупок'), <Sums sums={p.gems.sums} none="покупок нет" />)}
      {arrow}
      {node(<>Продано на Steam <Src>журнал</Src></>, nf(p.sold.n) + ' ' + plural(p.sold.n, 'продажа', 'продажи', 'продаж'), <>пришло на кошелёк <Sums sums={p.sold.sums} none="—" /></>)}
      {arrow}
      {node(<>Куплено ключей <Src>журнал</Src></>, nf(p.keys.n) + ' ' + plural(p.keys.n, 'покупка', 'покупки', 'покупок'), <>
        <Sums sums={p.keys.sums} none="покупок нет" />
        {p.keys.sums.map(x => <span key={x.currency} className="v2-hint">в среднем за покупку <M source={x.source} currency={x.currency} units={avg(x)} /></span>)}
      </>)}
      {arrow}
      {node(<>Ждут анлока <Src>инвентарь</Src></>, s ? nf(s.held) + ' шт' : '—',
        s ? (s.nextRelease ? <>ближайшие {nf(s.nextRelease.keys)} — {when(s.nextRelease.at)}<span className="v2-hint">снимок {ago(k!.snapshot!.seenAt, now)} назад</span></> : 'удержанных нет')
          : data.keys.loading ? 'загружается…' : 'ключи ещё не читались — кнопка ниже, в «Ключи Mann Co.»')}
      {arrow}
      {node(<>Продано на Clover.tf</>, '—', 'выплаты подключаются на этапе 3.2', 'is-last')}
    </div>
  )
}

// ── три итога (решение 6, §16) ──

function Totals({ p }: { p: ReturnType<typeof path> }) {
  return (
    <div className="v2-sl-totals">
      <div className="v2-tile v2-sl-total">
        <span>Вложено <Src>площадка</Src></span>
        {p.gems.sums.length ? p.gems.sums.map((s: Invested) => (
          <span key={s.currency} className="v2-sl-total-v">
            {s.conflict ? <b className="v2-num">— <Chip tone="warn">расходится</Chip></b> : <b><M source={s.source} currency={s.currency} units={s.units} /></b>}
            <small>покупки гемов{s.refunds ? <> − возвраты <M source={s.source} currency={s.currency} units={s.refunds} /></> : ' · возвратов не было'}</small>
          </span>
        )) : <b className="v2-sl-none">—<small>покупок за период нет</small></b>}
      </div>
      <div className="v2-tile v2-sl-total">
        <span>Реализовано</span>
        <b className="v2-sl-none">—<small>дошло до рук — выплаты Clover; подключается на этапе 3.2</small></b>
      </div>
      <div className="v2-tile v2-sl-total">
        <span>В работе <Chip tone="warn">оценка</Chip></span>
        <b className="v2-sl-none">—<small>гемы, вещи, кошелёк, ключи — оценке нужны цена ключа (этап 4) и баланс кошелька (источника пока нет)</small></b>
      </div>
    </div>
  )
}

// ── кошелёк по дням ──

function Wallet({ ops, currency, day, onDay }: { ops: ReturnType<typeof clean>['ops']; currency: string; day: string | null; onDay: (d: string | null) => void }) {
  const days = walletDays(ops, currency)
  if (!days.length) return <p className="v2-hint">За период в этой валюте операций нет.</p>
  const max = Math.max(1, ...days.map(d => Math.max(d.sales, d.keys)))
  const sel = days.find(d => d.day === day) ?? null
  const src = 'рынок Steam'
  return (
    <>
      <div className="v2-sl-chart" role="group" aria-label="Кошелёк по дням: вверх — продажи, вниз — покупки ключей">
        {days.map(d => (
          <button
            key={d.day}
            type="button"
            className="v2-sl-col"
            aria-pressed={day === d.day}
            aria-label={dayLabel(d.day) + ': продажи ' + money(src, currency, d.sales).text + ', ключи ' + money(src, currency, d.keys).text}
            title={dayLabel(d.day) + '\nпродажи: ' + money(src, currency, d.sales).text + ' (' + d.salesN + ')\nключи: ' + money(src, currency, d.keys).text + ' (' + d.keysN + ')'}
            onClick={() => onDay(day === d.day ? null : d.day)}
          >
            <span className="v2-sl-up"><i style={{ height: (d.sales / max * 100) + '%' }} /></span>
            <span className="v2-sl-down"><i style={{ height: (d.keys / max * 100) + '%' }} /></span>
          </button>
        ))}
      </div>
      <div className="v2-sl-ax v2-hint v2-num"><span>{dayLabel(days[0].day)}</span><span>{dayLabel(days[days.length - 1].day)}</span></div>
      <p className="v2-hint v2-sl-legend">
        <i className="is-up" /> вверх — продажи на Steam (пришло на кошелёк) · <i className="is-down" /> вниз — покупки ключей · прочие покупки на Steam в журнал не импортируются
      </p>
      {sel ? (
        <p className="v2-sl-day" role="status">
          <b>{dayLabel(sel.day)}</b> · продаж {nf(sel.salesN)}, пришло <M source={src} currency={currency} units={sel.sales} /> · покупок ключей {nf(sel.keysN)}, потрачено <M source={src} currency={currency} units={sel.keys} />
        </p>
      ) : <p className="v2-hint">Нажмите на день — суммы за день.</p>}
    </>
  )
}

// ── продажи по дням (решение 4) ──

function SalesTable({ ops, currency }: { ops: ReturnType<typeof clean>['ops']; currency: string }) {
  const rows = salesDays(ops, currency)
  const src = 'рынок Steam'
  if (!rows.length) return <p className="v2-hint">Продаж в этой валюте за период нет.</p>
  const cell = (v: number | null, r: { missing: number; n: number }) => v == null
    ? <span className="v2-hint" title={'у ' + r.missing + ' из ' + r.n + ' продаж покупатель платил в другой валюте — Steam не отдаёт цену в валюте кошелька'}>— <small>{r.missing} из {r.n}</small></span>
    : <M source={src} currency={currency} units={v} />
  return (
    <div className="v2-sl-table" role="table" aria-label="Продажи на Steam по дням">
      <div className="v2-sl-tr is-head" role="row">
        <span role="columnheader">день</span><span role="columnheader" className="is-r">продаж</span>
        <span role="columnheader" className="is-r">заплатил покупатель</span><span role="columnheader" className="is-r">комиссия Steam</span>
        <span role="columnheader" className="is-r">комиссия игры</span><span role="columnheader" className="is-r">пришло на кошелёк</span>
      </div>
      {rows.map(r => (
        <div key={r.day} className="v2-sl-tr" role="row">
          <span role="cell">{dayLabel(r.day)}</span>
          <span role="cell" className="is-r v2-num">{nf(r.n)}</span>
          <span role="cell" className="is-r">{cell(r.gross, r)}</span>
          <span role="cell" className="is-r">{cell(r.feeSteam, r)}</span>
          <span role="cell" className="is-r">{cell(r.feeGame, r)}</span>
          <span role="cell" className="is-r"><b><M source={src} currency={currency} units={r.net} /></b></span>
        </div>
      ))}
      <p className="v2-hint v2-sl-foot">«—» с «N из M» — у части продаж дня покупатель платил в другой валюте; пересчёта «×1,15» нет (§16). Валюта: {currencyName(currency).label}.</p>
    </div>
  )
}

function BuysTable({ ops }: { ops: ReturnType<typeof clean>['ops'] }) {
  const rows = gemBuysDays(ops)
  if (!rows.length) return <p className="v2-hint">Покупок гемов за период нет.</p>
  return (
    <div className="v2-sl-table is-buys" role="table" aria-label="Покупки гемов по дням">
      <div className="v2-sl-tr is-head" role="row">
        <span role="columnheader">день</span><span role="columnheader" className="is-r">покупок</span>
        <span role="columnheader" className="is-r">потрачено</span><span role="columnheader" className="is-r">возвраты</span>
      </div>
      {rows.map(r => (
        <div key={r.day + r.currency} className="v2-sl-tr" role="row">
          <span role="cell">{dayLabel(r.day)}</span>
          <span role="cell" className="is-r v2-num">{nf(r.n)}</span>
          <span role="cell" className="is-r"><M source={r.source} currency={r.currency} units={r.cost} /></span>
          <span role="cell" className="is-r">{r.refunds ? <M source={r.source} currency={r.currency} units={r.refunds} /> : <span className="v2-hint">—</span>}</span>
        </div>
      ))}
      <p className="v2-hint v2-sl-foot">Возврат — площадка вернула деньги за лот, который продавец не передал; уменьшает «вложено».</p>
    </div>
  )
}

// ── ключи (решение 7) ──

function Keys({ data, ops, now }: { data: SalesData; ops: ReturnType<typeof clean>['ops']; now: number }) {
  const sync = useAction()
  const k = data.keys.data
  const s = k?.summary
  const batches = keyBatches(ops)
  const read = async () => {
    const r: any = await sync.run('/api/keys/sync', { id: data.account })
    if (!r?.error) data.keys.reload()
  }
  return (
    <Panel title="Ключи Mann Co." aside={<>куплены на деньги кошелька <Src>инвентарь</Src></>}>
      <div className="v2-sl-keyhead">
        {s ? (
          <div className="v2-sl-keytiles">
            <div className="v2-tile"><span>на руках</span><b className="v2-num">{nf(s.onHand)}</b></div>
            <div className="v2-tile"><span>на удержании</span><b className="v2-num">{nf(s.held)}</b>{s.unknownTime ? <small>время неизвестно у {nf(s.unknownTime)}</small> : null}</div>
            <div className="v2-tile is-ok"><span>можно передать сейчас</span><b className="v2-num">{nf(s.tradableNow)}</b></div>
            {s.conflict ? <div className="v2-tile is-warn"><span>расходится</span><b className="v2-num">{nf(s.conflict)}</b><small>признаки Steam противоречат — перечитать</small></div> : null}
          </div>
        ) : (
          <p className="v2-hint">{data.keys.loading ? 'Снимок ключей загружается…' : data.keys.error ? 'Снимок ключей не загрузился: ' + data.keys.error : 'Ключи ещё не читались — снимка нет.'}</p>
        )}
        <span className="v2-sl-keysync">
          <Btn tone="soft" loading={sync.busy} disabled={!data.account} onClick={read} title="один запрос инвентаря TF2 к Steam, без кук"><RefreshCw size={13} aria-hidden="true" />прочитать ключи</Btn>
          {k?.snapshot ? <span className="v2-hint">снимок от {when(k.snapshot.seenAt)}</span> : null}
          {sync.error ? <span className="v2-hint is-stop" role="alert">Не вышло: {sync.error}</span> : null}
          {DEMO ? <span className="v2-hint">в показе ничего не читается</span> : null}
        </span>
      </div>

      {s?.releases.length ? (
        <>
          <h3 className="v2-sl-h3">Когда станут передаваемыми <span className="v2-hint">точное время Steam · ваш часовой пояс</span></h3>
          <ul className="v2-sl-rel">
            {s.releases.map(r => {
              const rawLine = k?.keys?.find(x => x.tradableAfter === r.at)?.tradableAfterRaw
              return (
                <li key={r.at} title={'GMT: ' + gmt(r.at) + (rawLine ? '\nSteam: ' + rawLine : '')}>
                  <b className="v2-num">{nf(r.keys)} шт</b>
                  <span>{when(r.at)}</span>
                  <span className="v2-hint">{countdown(r.at, now)}</span>
                </li>
              )
            })}
          </ul>
        </>
      ) : null}

      <h3 className="v2-sl-h3">Партии покупок <span className="v2-hint">из журнала; какие именно ключи из партии — не видно (в истории рынка нет id предмета)</span></h3>
      {batches.length ? (
        <div className="v2-sl-table is-batches" role="table" aria-label="Партии покупок ключей">
          <div className="v2-sl-tr is-head" role="row">
            <span role="columnheader">день</span><span role="columnheader" className="is-r">покупок</span>
            <span role="columnheader" className="is-r">в среднем</span><span role="columnheader" className="is-r">сумма</span>
            <span role="columnheader">станут передаваемыми</span>
          </div>
          {batches.map(b => (
            <div key={b.day + b.currency} className="v2-sl-tr" role="row">
              <span role="cell">{dayLabel(b.day)}</span>
              <span role="cell" className="is-r v2-num">{nf(b.n)}</span>
              <span role="cell" className="is-r"><M source={b.source} currency={b.currency} units={b.avg} /></span>
              <span role="cell" className="is-r"><M source={b.source} currency={b.currency} units={b.spent} /></span>
              <span role="cell">≈ {when(b.estimate.from)}{b.estimate.to - b.estimate.from > 60_000 ? ' – ' + when(b.estimate.to) : ''} <Chip tone="warn">оценка</Chip></span>
            </div>
          ))}
          <p className="v2-hint v2-sl-foot">Счёт — по покупкам: поля количества в истории рынка нет. Оценка — время покупки + 7 суток. Точное время и число ключей — выше, из снимка инвентаря TF2.</p>
        </div>
      ) : <p className="v2-hint">Покупок ключей за период нет.</p>}
    </Panel>
  )
}
