// Плавающий пульт (§4.2): на всех экранах, по центру снизу страницы.
//
// Лампа, слово, причина; пауза, темп, до конца, последнее подтверждение;
// «настроить» и главное действие. «Накрутить» никогда не уходит в работу
// с первого нажатия — открывает подтверждение (§3.4). Во время работы на её
// месте серая «Остановить».
//
// Слова и числа — из lib/worker.ts, те же, что в старом Пульте.

import { Play, Settings2, Square } from 'lucide-react'
import { ago, nf, span, useAction, type Live, type State } from '../lib/api.ts'
import { lamp, pace } from '../lib/worker.ts'
import { Btn, Lamp } from './ui.tsx'

export function Pult({ state, live, now, onTune, onBurn }: {
  state: State
  live: Live
  now: number
  onTune: () => void
  onBurn: () => void
}) {
  const ap = state.autopilot
  const stop = useAction()

  // Данные устарели: показываем последнее известное слово с вопросом,
  // а не выдаём его за нынешнее (§5.7). lamp() сам при этом сказал бы
  // «нет связи» — то же самое, но без того, что было до обрыва.
  const l = lamp(state, live.stale ? { ...live, stale: false } : live)
  const word = live.stale ? l.word + '?' : l.word
  const fresh = !live.stale && state.confirmed && now - state.confirmed.ts < 15_000

  return (
    <div className={'v2-pult' + (live.stale ? ' is-stale' : '')} role="region" aria-label="Пульт работника">
      <div className="v2-pult-st" title={l.why}>
        <Lamp tone={live.stale ? 'idle' : l.tone} word={word} pulse={!live.stale && l.tone === 'ok'} />
        <span className="v2-pult-why">{l.why}</span>
      </div>
      <span className="v2-pult-div" aria-hidden="true" />
      <Kv k="пауза" v={pace(ap)} />
      <Kv k="темп" v={state.rate ? nf(state.rate) + '/мин' : '—'} why={state.rate ? undefined : 'отправок сейчас нет'} />
      <Kv k="до конца" v={span(ap.etaMinutes)} why={ap.etaMinutes ? undefined : 'очередь пуста или срок не задан'} />
      <Kv
        k="подтверждение"
        v={state.confirmed ? ago(state.confirmed.ts, now) + ' назад' : 'нет'}
        tone={fresh ? 'ok' : undefined}
      />
      <span className="v2-pult-div" aria-hidden="true" />
      <Btn tone="soft" onClick={onTune}>
        <Settings2 size={14} aria-hidden="true" />
        настроить
      </Btn>
      {ap.enabled ? (
        <Btn tone="soft" loading={stop.busy} onClick={() => stop.run('/api/autopilot', { id: ap.id, on: false })}>
          <Square size={14} aria-hidden="true" />
          {stop.error ? 'остановить ещё раз' : 'Остановить'}
        </Btn>
      ) : (
        <Btn tone="go" onClick={onBurn}>
          <Play size={14} aria-hidden="true" />
          Накрутить
        </Btn>
      )}
      {stop.error ? (
        <span className="v2-pult-err" role="alert" title={stop.error}>не остановился — отправщик мог остаться живым</span>
      ) : null}
    </div>
  )
}

// Показание. Прочерк — всегда с причиной: в подсказке и для чтения с экрана.
function Kv({ k, v, why, tone }: { k: string; v: string; why?: string; tone?: 'ok' }) {
  return (
    <span className="v2-pult-kv" title={why}>
      <span>{k}</span>
      <b className={'v2-num' + (tone === 'ok' ? ' is-ok' : '')} aria-label={why ? v + ' — ' + why : undefined}>{v}</b>
    </span>
  )
}
