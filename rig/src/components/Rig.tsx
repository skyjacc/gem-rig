import type { State } from '../lib/types.ts'
import { clock, dur, nf } from '../lib/format.ts'

import { Block, Card, Odometer, Row } from './ui.tsx'
import { Chart } from './Chart.tsx'
import { Control } from './Control.tsx'

const RESULT = {
  update: { cls: 'text-malachite', text: (b: number) => `засчитан · ${b} байт` },
  dup: { cls: 'text-oxide', text: () => 'уже сожжён' },
  silent: { cls: 'text-dust', text: () => 'нет ответа' },
} as const

export function Rig({ state }: { state: State }) {
  const c = state.current

  return (
    <div className="space-y-5 py-5">
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        <Control state={state} />

        <Card title="Отправка">
          <div className="font-display text-[30px] font-extrabold leading-none tnum">
            {c ? <>{c.n} <span className="text-[15px] text-dust">/ {c.total}</span></> : '—'}
          </div>
          <div className="mt-3">
            <Row label="осталось">{c ? dur((c.total - c.n) * (state.delay ?? c.delay ?? 0)) : '—'}</Row>
            <Row label="засчитано / ответов">
              <span className="text-malachite">{c ? c.updates : '—'}</span> / {c ? c.responses : '—'}
            </Row>
            <Row label="последний">{c?.match ?? '—'}</Row>
          </div>
        </Card>

        <Card title="Инвентарь">
          <Odometer value={state.watched} className="font-display text-[30px] font-extrabold leading-none text-malachite" />
          <div className="mt-3">
            <Row label="сумма счётчиков"><span /></Row>
            <Row label="предметов со счётчиком">{state.inv.items}</Row>
            <Row label="групп гемов">{state.mine.length}</Row>
            <Row label="прочитан">{state.inv.age != null ? `${state.inv.age} с назад` : '—'}</Row>
            {state.inv.error ? <Row label="Steam"><span className="text-oxide">{state.inv.error}</span></Row> : null}
          </div>
        </Card>

        <Card title="Сожжено">
          <Odometer value={state.burned} className="font-display text-[30px] font-extrabold leading-none text-oxide" />
          <div className="mt-3">
            <Row label="матчей израсходовано"><span /></Row>
            <Row label="ключ OpenDota">{state.keys.opendota ? <span className="text-malachite">есть</span> : 'нет'}</Row>
            <Row label="ключ Steam Web API">{state.keys.steam ? <span className="text-malachite">есть</span> : 'нет'}</Row>
            <Row label="наборов с гемом">{state.bundles.length}</Row>
          </div>
        </Card>
      </div>

      <Block title="События" note={`последние ${state.events.length}`}>
        <div className="max-h-[300px] overflow-auto text-[11.5px]">
          {state.events.length === 0 ? (
            <div className="p-3.5 text-dust">событий пока нет</div>
          ) : (
            state.events.map(e => {
              const r = RESULT[e.result] ?? RESULT.silent
              return (
                <div key={e.ts} className="whitespace-nowrap border-b border-rule/50 px-3.5 py-1">
                  <span className="text-dust">{clock(e.ts)}</span>
                  <span className="px-2 text-dust">{e.n}/{e.total}</span>
                  <span className="tnum">{e.match_id}</span>
                  <span className="px-2 text-dust">лига {e.league_id || '—'}</span>
                  <span className={r.cls}>{r.text(e.bytes)}</span>
                </div>
              )
            })
          )}
        </div>
      </Block>

      <Block title="Рост счётчиков" note={`${state.chart.stamps.length} срезов`}>
        <Chart state={state} />
      </Block>

      <div className="pb-6 text-[11px] text-dust">
        Матч засчитывается аккаунту один раз. Гемы, купленные после прожига, уже сожжённые матчи не получат —
        поэтому состав собирают до запуска, а не после. Всего сожжено {nf(state.burned)}.
      </div>
    </div>
  )
}
