// Правая колонка Продаж (§5.4, план 2.6, решение 10): куда продать ключи,
// выплаты, что подключить. Слежения за площадками (этап 4) и выплат (3.2)
// ещё нет — честные пустые состояния, без нулей.

import { nf } from '../../lib/api.ts'
import { Chip, Panel } from '../ui.tsx'
import type { SalesData } from './data.ts'

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

      <Panel title="Выплаты" aside="Clover.tf">
        <p className="v2-hint">
          История выплат у Clover есть только на сайте после входа. Ручной ввод — площадка, ключей, получено $, способ выплаты и номер транзакции (обязателен и уникален) — подключается на этапе 3.2.
        </p>
      </Panel>

      <Panel title="Что подключить">
        <ul className="v2-sl-todo">
          <li><Chip tone="ok" dot>идёт</Chip><span>история площадки — покупки гемов (по запросу)</span></li>
          <li><Chip tone="ok" dot>идёт</Chip><span>история рынка Steam — продажи и покупки ключей (по запросу)</span></li>
          <li><Chip tone="ok" dot>идёт</Chip><span>ключи TF2 — точное время освобождения (кнопкой)</span></li>
          <li><Chip dot>ждёт</Chip><span>выплаты Clover — этап 3.2</span></li>
          <li><Chip dot>ждёт</Chip><span>площадки ключей и тревоги о них — этап 4</span></li>
          <li><Chip dot>ждёт</Chip><span>курсы на дату операции — отчёт в $</span></li>
          <li><Chip dot>ждёт</Chip><span>прочие покупки на Steam и баланс кошелька</span></li>
          <li><Chip dot>ждёт</Chip><span>сверка журнала с источниками — этап 5</span></li>
        </ul>
      </Panel>
    </>
  )
}
