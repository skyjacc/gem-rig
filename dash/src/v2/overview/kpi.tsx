// KPI Обзора в верхней полосе (§4.2, макет 1-obzor.html): вещей, гемов,
// в очереди, готово к продаже, возраст инвентаря.
//
// Честность чисел (§3.3):
//   - «готово к продаже» — по каждой вещи: rows[].value >= goal (план 2.1,
//     п. 4) — так же, как плитка «готово к продаже» старого Пульта (output()).
//     Фраза старого Пульта «N из M вещей готово» (verdict()) считает грубее
//     (все вещи гема, если max >= goal) и не меняется.
//   - цели нет — прочерк и «цель не задана», а не ноль;
//   - инвентарь виден не весь (inv.truncated) — числа по вещам «≈ … оценка»;
//   - инвентарь закрыт или Steam не отдаёт — прочерк и причина;
//   - инвентарь старше settings.invStale — серее, «устарел»;
//   - в показе возраст из снимка к сегодняшнему дню не относится — «из снимка».

import { ago, DEMO, nf, type Settings, type State } from '../../lib/api.ts'
import { Chip, Pill } from '../ui.tsx'

// inv.age — в секундах. Именем: поиск круглых тысяч по src/v2 ловит зашитую цель.
const MS = 1_000

export function OverviewKpi({ state, goal, settings, now }: {
  state: State
  goal: number | null
  settings: Settings | null
  now: number
}) {
  const inv = state.inv
  const mine = state.mine.filter(m => m.gem !== '—')
  const items = mine.reduce((n, m) => n + m.items, 0)
  const rows = mine.flatMap(m => m.rows)
  const partial = inv.truncated || rows.length < items
  const ready = goal == null ? null : rows.filter(r => r.value >= goal).length
  const est = (v: string) => (partial ? '≈ ' + v : v)
  const tag = partial ? <Chip tone="warn">оценка</Chip> : null

  const age = inv.age == null ? null : inv.age * MS
  const old = age != null && settings?.invStale ? age > settings.invStale : false
  const invText = DEMO ? <b>из снимка</b>
    : inv.private ? <span className="v2-kpi-none">— закрыт в Steam</span>
      : inv.error ? <span className="v2-kpi-none">— Steam не отдаёт</span>
        : age == null ? <span className="v2-kpi-none">— ещё не читался</span>
          : <b className={old ? 'v2-kpi-old' : undefined}>{ago(now - age, now)} назад{old ? ' · устарел' : ''}</b>

  return (
    <>
      <Pill>вещей <b className="v2-num">{est(nf(items))}</b>{tag}</Pill>
      <Pill>гемов <b className="v2-num">{nf(mine.length)}</b></Pill>
      <Pill>в очереди <b className="v2-num">{nf(state.autopilot.queueLength)}</b></Pill>
      <Pill title={goal == null ? undefined : 'по каждой вещи: счётчик не меньше цели'}>
        готово к продаже{' '}
        {ready == null
          ? <span className="v2-kpi-none">— цель не задана</span>
          : <><b className="v2-num">{est(nf(ready))}</b> / <span className="v2-num">{nf(items)}</span>{tag}</>}
      </Pill>
      <Pill>инвентарь {invText}</Pill>
    </>
  )
}
