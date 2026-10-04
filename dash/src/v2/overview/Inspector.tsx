// Инспектор выбранного гема — правая колонка Обзора (§5.1): иконка, кольцо
// к цели, факты, вещи, «только этот гем», «в инвентаре».
//
// Статус — gemStatus(), цель — settings.goal; нет цели — кольца нет, так и
// написано. «Только этот гем» — POST /api/autopilot {id, only: [гем]}
// (контракт сверен по коду, план этапа 2.1) через окно с последствиями.

import { useState } from 'react'
import { icon, nf, plural, type State } from '../../lib/api.ts'
import { gemStatus } from '../../lib/worker.ts'
import { ActionDialog } from '../Dialog.tsx'
import { Btn, Chip, Panel } from '../ui.tsx'

type Gem = State['mine'][number]

const things = (n: number) => nf(n) + ' ' + plural(n, 'вещь', 'вещи', 'вещей')

function Ring({ value, goal }: { value: number; goal: number }) {
  const r = 58, c = 2 * Math.PI * r, p = Math.min(1, value / goal)
  return (
    <svg width="132" height="132" aria-hidden="true">
      <circle cx="66" cy="66" r={r} fill="none" stroke="var(--s3)" strokeWidth="8" />
      <circle cx="66" cy="66" r={r} fill="none" stroke="var(--ac)" strokeWidth="8" strokeLinecap="round"
        strokeDasharray={`${Math.max(c * p, 4)} ${c}`} transform="rotate(-90 66 66)" style={{ filter: 'drop-shadow(0 0 6px #b8f25c88)' }} />
    </svg>
  )
}

export function Inspector({ state, gem, goal, onInventory }: {
  state: State
  gem: Gem | null
  goal: number | null
  onInventory: () => void
}) {
  const [only, setOnly] = useState(false)
  if (!gem) return <Panel title="Гем"><p className="v2-text">Гемов в инвентаре нет.</p></Panel>

  const ap = state.autopilot
  const s = gemStatus(gem, goal)
  const inWork = (ap.picked ?? []).includes(gem.gem)
  const chip = s === 'map' ? <Chip tone="stop" dot>нет в карте</Chip>
    : s === 'reach' ? <Chip tone="warn" dot>не дойдёт</Chip>
      : inWork ? <Chip tone="ok" dot>в работе</Chip> : <Chip dot>не в работе</Chip>

  // Дойдёт ли: по запасу матчей команды. Нет запаса — неизвестно; оценённый
  // запас — с меткой «оценка» (§3.3).
  // Гем не в карте — неизвестно, чьи матчи считать, и запас ни к чему не относится.
  const reach = s === 'map' ? { v: 'неизвестно', why: 'гема нет в карте' }
    : goal == null ? { v: '—', why: 'цель не задана' }
      : gem.supply == null ? { v: 'неизвестно', why: 'запас матчей не посчитан' }
      : { v: gem.supply >= goal ? 'да' : 'нет', why: '' }

  const rows = [...gem.rows].sort((a, b) => b.value - a.value || Number(b.equipped) - Number(a.equipped))
  const onlyNow = ap.only ?? null

  return (
    <Panel title="Гем" aside="Spectator Gem">
      <div className="v2-insp-hero">
        <span className="v2-insp-ico" style={{ backgroundImage: gem.icon ? `url('${icon(gem.icon, 96)}')` : undefined }} aria-hidden="true" />
        <div>
          <h2>{gem.gem}</h2>
          <p className="v2-hint">{(gem.heroes || '—') + ' · ' + things(gem.items) + ', надето ' + nf(gem.equipped)}</p>
          <div className="v2-insp-chip">{chip}</div>
        </div>
      </div>

      <div className="v2-insp-ring">
        {goal ? (
          <div className="v2-ring-box">
            <Ring value={gem.max} goal={goal} />
            <div className="v2-ring-c"><b className="v2-num">{nf(gem.max)}</b><span>из {nf(goal)}</span></div>
          </div>
        ) : (
          <div className="v2-ring-box is-none"><b className="v2-num">{nf(gem.max)}</b><span>цель не задана</span></div>
        )}
        <div className="v2-facts">
          <div className="v2-tile"><span>разброс по вещам</span><b className="v2-num">{gem.min == null || gem.min === gem.max ? nf(gem.max) : nf(gem.min) + ' – ' + nf(gem.max)}</b></div>
          <div className="v2-tile"><span>осталось до цели</span><b className="v2-num">{goal == null ? '—' : nf(Math.max(0, goal - gem.max))}</b></div>
          <div className="v2-tile">
            <span>дойдёт до цели</span>
            <b>{reach.v} {s !== 'map' && gem.supplyKind === 'estimated' && goal != null && gem.supply != null ? <Chip tone="warn">оценка</Chip> : null}</b>
            {reach.why ? <span>{reach.why}</span> : null}
          </div>
        </div>
      </div>

      <ul className="v2-insp-list">
        {rows.slice(0, 5).map(r => (
          <li key={r.assetid}>
            <span className="v2-item-ico" style={{ backgroundImage: gem.icon ? `url('${icon(gem.icon, 64)}')` : undefined }} aria-hidden="true" />
            <span className="v2-item-n" title={r.name}>{r.name}</span>
            {r.equipped ? <span className="v2-item-eq">надето</span> : null}
            <span className="v2-num">{nf(r.value)}</span>
          </li>
        ))}
        {gem.items > 5 ? <li className="v2-insp-more">ещё {nf(gem.items - 5)} — в инвентаре</li> : null}
      </ul>

      <div className="v2-insp-acts">
        <Btn
          tone="soft"
          onClick={() => setOnly(true)}
          disabled={s === 'map'}
          title={s === 'map' ? 'гема нет в карте — работнику нечего будет жечь' : undefined}
        >
          только этот гем
        </Btn>
        <Btn tone="soft" onClick={onInventory}>в инвентаре</Btn>
      </div>
      {s === 'map' ? <p className="v2-hint">«Только этот гем» недоступно: гема нет в карте — работнику нечего будет жечь.</p> : null}

      {only ? (
        <ActionDialog
          title="Только этот гем"
          aside={ap.label}
          verb="жечь только его"
          url="/api/autopilot"
          body={{ id: ap.id, only: [gem.gem] }}
          onClose={() => setOnly(false)}
          rows={[
            { k: 'аккаунт', v: ap.label },
            { k: 'сейчас жжёт', v: onlyNow == null ? 'все гемы из инвентаря' : onlyNow.length ? onlyNow.join(', ') : 'ничего не выбрано' },
            { k: 'будет жечь', v: gem.gem },
            { k: 'вернуть все', v: '«Настроить» → «все»' },
          ]}
        >
          <p className="v2-note">Работник этого аккаунта пересоберёт очередь только из матчей {gem.gem}. Другие аккаунты не меняются.</p>
        </ActionDialog>
      ) : null}
    </Panel>
  )
}
