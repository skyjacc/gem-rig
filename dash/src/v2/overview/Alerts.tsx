// «Требует внимания» под инспектором Обзора (§5.1): тот же список, что в
// колокольчике (alertList), но с действиями там, где их умеет сервер.
//
// Сейчас умеет одно: у «не дойдёт» — «снизить цель до N» (POST /api/settings
// {goal}; сервер меняет только goal, целое в пределах 1…100 000 — settings.ts).
// Цель общая: для всех гемов и всех аккаунтов, поэтому — через окно.
// «Не считать товаром» и «указать команду» API не имеют — остаются текстом.

import { useState } from 'react'
import { nf, type Live, type State } from '../../lib/api.ts'
import type { Alert } from '../../lib/worker.ts'
import { alertList } from '../alerts.ts'
import { ActionDialog } from '../Dialog.tsx'
import { Chip, Panel } from '../ui.tsx'

export function Alerts({ state, live, now, goal }: {
  state: State
  live: Live
  now: number
  goal: number | null
}) {
  const list = alertList(state, live, now, goal)
  const [lower, setLower] = useState<{ gem: string; to: number } | null>(null)

  // Куда можно снизить цель: запас матчей этого гема. Ноль сервер поднял бы
  // до единицы — такой кнопки не показываем.
  const target = (a: Alert) => {
    if (a.kind !== 'reach' || !a.gem || goal == null) return null
    const m = state.mine.find(x => x.gem === a.gem)
    return m?.supply != null && m.supply >= 1 && m.supply < goal ? m.supply : null
  }

  return (
    <Panel title="Требует внимания" aside={list.length ? nf(list.length) : undefined}>
      {list.length ? (
        <ul className="v2-alerts">
          {list.map((a, i) => {
            const to = target(a)
            return (
              <li key={i} className={'v2-alert' + (a.level === 'stop' ? ' is-stop' : '')}>
                <Chip tone={a.level} dot>{a.level === 'stop' ? 'работа стоит' : 'внимание'}</Chip>
                <span className="v2-alert-t">{a.text}</span>
                {a.todo ? <span className="v2-alert-d">{a.todo}</span> : null}
                {to != null && a.gem ? (
                  <span className="v2-alert-a">
                    <button type="button" className="v2-btn is-soft" onClick={() => setLower({ gem: a.gem!, to })}>
                      снизить цель до {nf(to)}
                    </button>
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="v2-pop-empty">Всё в порядке</p>
      )}

      {lower && goal != null ? (
        <ActionDialog
          title="Снизить цель счётчика"
          verb={'снизить до ' + nf(lower.to)}
          url="/api/settings"
          body={{ goal: lower.to }}
          onClose={() => setLower(null)}
          rows={[
            { k: 'сейчас', v: nf(goal) },
            { k: 'станет', v: nf(lower.to) },
            { k: 'из-за гема', v: lower.gem + ' — матчей у команды всего ' + nf(lower.to) },
            { k: 'касается', v: 'всех гемов и всех аккаунтов', tone: 'warn' },
          ]}
        >
          <p className="v2-note is-warn">
            От цели считаются «готово к продаже», «не дойдёт» и план закупки. Вернуть прежнюю — в «Общих правилах».
          </p>
        </ActionDialog>
      ) : null}
    </Panel>
  )
}
