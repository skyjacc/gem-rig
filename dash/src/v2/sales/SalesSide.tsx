// Правая колонка Продаж (§5.4, план 2.6, решение 10): куда продать ключи,
// выплаты, что подключить. Слежения за площадками (этап 4) ещё нет — честное
// пустое состояние. Выплаты Clover вносятся руками (план 3.2).

import { useState } from 'react'
import { nf } from '../../lib/api.ts'
import { Chip, Panel } from '../ui.tsx'
import type { SalesData } from './data.ts'
import { money, payoutRows, when, type PayoutRow } from './model.ts'
import { CorrectDialog, PayoutForm, short, StornoDialog } from './PayoutDialogs.tsx'

export function SalesSide({ data }: { data: SalesData }) {
  const s = data.keys.data?.summary
  return (
    <>
      <Panel title="Куда продать ключи" aside="по сумме на руки">
        <p className="v2-text">
          {s ? <>Можно передать сейчас: <b className="v2-num">{nf(s.tradableNow)}</b> {s.held ? <span className="v2-hint">· ещё {nf(s.held)} на удержании</span> : null}</> : 'Сколько ключей свободно — после первого чтения ключей.'}
        </p>
        <p className="v2-hint">
          Сравнение площадок (Clover.tf, Merchant.TF, instant.tf, Belethor, Mannco.store) — цена, тип цены, глубина, комиссии и способы выплаты — подключается на этапе 4: панель будет сама проверять их по расписанию.
        </p>
      </Panel>

      <Panel title="Выплаты" aside="Clover.tf · вручную">
        <p className="v2-hint">
          История выплат у Clover есть только на сайте после входа — сюда они вносятся руками. Выплата — это «дошло до рук»: в «реализовано» входит она, а не продажа ключей.
        </p>
        <PayoutForm account={data.account} accounts={data.accounts} onDone={data.payouts.reload} />
        <Payouts data={data} />
      </Panel>

      <Panel title="Что подключить">
        <ul className="v2-sl-todo">
          <li><Chip tone="ok" dot>идёт</Chip><span>история площадки — покупки гемов (по запросу)</span></li>
          <li><Chip tone="ok" dot>идёт</Chip><span>история рынка Steam — продажи и покупки ключей (по запросу)</span></li>
          <li><Chip tone="ok" dot>идёт</Chip><span>ключи TF2 — точное время освобождения (кнопкой)</span></li>
          <li><Chip tone="ok" dot>идёт</Chip><span>выплаты Clover — вручную, со сторно и исправлением</span></li>
          <li><Chip dot>ждёт</Chip><span>площадки ключей и тревоги о них — этап 4</span></li>
          <li><Chip dot>ждёт</Chip><span>курсы на дату операции — отчёт в $</span></li>
          <li><Chip dot>ждёт</Chip><span>прочие покупки на Steam и баланс кошелька</span></li>
          <li><Chip dot>ждёт</Chip><span>сверка журнала с источниками — этап 5</span></li>
        </ul>
      </Panel>
    </>
  )
}

// ── список выплат ──

function Payouts({ data }: { data: SalesData }) {
  const [storno, setStorno] = useState<PayoutRow | null>(null)
  const [fix, setFix] = useState<PayoutRow | null>(null)
  const list = data.payouts.data
  if (data.payouts.error) return <p className="v2-note is-stop" role="alert">Список выплат не загрузился: {data.payouts.error}</p>
  if (!list) return <p className="v2-hint">{data.payouts.loading ? 'Выплаты загружаются…' : 'Выплат нет.'}</p>
  const rows = payoutRows(list.ops)
  if (!rows.length) return <p className="v2-hint">Выплат ещё не было.</p>
  const label = (id: string | null) => data.accounts.find(a => a.id === id)?.label ?? id ?? '—'
  const corrected = new Set(rows.map(r => r.corrects).filter((x): x is number => x != null))
  return (
    <>
      {list.complete ? null : <p className="v2-note is-warn">Показаны не все выплаты — сервер упёрся в свой предел.</p>}
      <ul className="v2-po-list" aria-label="Выплаты Clover">
        {rows.map(r => (
          <li key={r.op.id} className={'v2-po-row' + (r.reversed ? ' is-reversed' : '')}>
            <div className="v2-po-main">
              <b className="v2-num">{money('Clover.tf', r.op.currency, r.op.net).text}</b>
              {r.usdBy !== 'получено' ? <Chip tone="warn">оценка</Chip> : null}
              {r.reversed ? <Chip tone="stop">сторнирована</Chip> : null}
              <span className="v2-hint">{when(r.op.happened_at)}</span>
            </div>
            <div className="v2-po-sub v2-hint">
              <span>пришло: {r.assetAmount ? r.assetAmount + ' ' : ''}{r.asset}{r.network ? ' · ' + r.network : ''}</span>
              {r.keys != null ? <span>ключей {nf(r.keys)}</span> : null}
              <span className="v2-po-tx" title={r.tx}>№ {short(r.tx)}</span>
              {r.version > 1 ? <span>исправление №{r.version}</span> : null}
              {r.movedFrom ? <span>перенесено с аккаунта «{label(r.movedFrom)}»</span> : null}
              {r.reversed && r.stornoReason ? <span>причина сторно: {r.stornoReason}</span> : null}
              {r.note ? <span>{r.note}</span> : null}
            </div>
            <div className="v2-po-acts">
              {!r.reversed ? <button type="button" className="v2-linkbtn" onClick={() => setStorno(r)}>сторно…</button> : null}
              {r.reversed && !corrected.has(r.op.id) ? <button type="button" className="v2-linkbtn" onClick={() => setFix(r)}>внести исправление…</button> : null}
            </div>
          </li>
        ))}
      </ul>
      {storno ? <StornoDialog row={storno} accountLabel={label(storno.op.account_id)} onClose={() => setStorno(null)} onDone={data.payouts.reload} /> : null}
      {fix ? <CorrectDialog row={fix} accounts={data.accounts} onClose={() => setFix(null)} onDone={data.payouts.reload} /> : null}
    </>
  )
}
