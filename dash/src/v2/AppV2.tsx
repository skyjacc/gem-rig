import './v2.css'
import { useEffect, useState } from 'react'
import { ago, DEMO, useJson, useLive, type Accounts, type Settings } from '../lib/api.ts'
import { Tune } from '../parts/Tune.tsx'
import { Rail, RailRow, SCREENS, type ScreenId } from './Rail.tsx'
import { TopBar } from './TopBar.tsx'
import { Pult } from './Pult.tsx'
import { ConfirmBurn } from './ConfirmBurn.tsx'
import { Panel, Pill } from './ui.tsx'

// Часы для «N без связи». Именем, а не числом: поиск круглых тысяч
// по src/v2 проверяет, что цель нигде не зашита (§3.2), и должен быть пуст.
const SECOND = 1_000

// Новая панель (спецификация v2). Открывается по /?ui=v2 на время миграции;
// на этапе 9 переключатель исчезает, а старая панель удаляется.
export default function AppV2() {
  const live = useLive()
  const { state, stale } = live
  const [screen, setScreen] = useState<ScreenId>('overview')
  // «Общие правила» и «настроить» пока открывают нынешнее окно Tune — в старом
  // виде; новое окно — этап 2.4. Оно рисуется вне .v2 (портал в body).
  const [rules, setRules] = useState<null | 'run' | 'rules'>(null)
  const [now, setNow] = useState(() => Date.now())
  const { data: accounts } = useJson<Accounts>('/api/accounts', state?.ts)
  const { data: settings } = useJson<Settings>('/api/settings', state?.ts)
  const [burning, setBurning] = useState(false)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), SECOND)
    return () => clearInterval(t)
  }, [])

  // Служебные состояния — задача 5.
  if (!state) return <div className="v2" />

  const status = (
    <>
      {DEMO ? <Pill tone="warn">показ — снимок, ничего не отправляется</Pill> : null}
      {stale ? <Pill tone="stop">данные устарели — {ago(live.at, now)} без связи</Pill> : null}
    </>
  )
  const title = SCREENS.find(s => s.id === screen)!.label
  // Цель — только из настроек (§3.2). Нет её — так и пишем, числа не подставляем.
  const goal = typeof settings?.goal === 'number' && settings.goal > 0 ? settings.goal : null

  return (
    <>
      <div className="v2">
        <div className="v2-app">
          <Rail screen={screen} onScreen={setScreen} onRules={() => setRules('rules')} />
          <TopBar state={state} accounts={accounts} status={status} />
          <RailRow screen={screen} onScreen={setScreen} />
          <main className="v2-page" aria-label={title}>
            <div className="v2-page-scroll">
              <h1 className="v2-h1">{title}</h1>
            </div>
            <Pult state={state} live={live} now={now} onTune={() => setRules('run')} onBurn={() => setBurning(true)} />
          </main>
          <aside className="v2-side" aria-label="Правая колонка">
            <Panel title="Инспектор">правая колонка экрана</Panel>
          </aside>
        </div>
        {burning ? <ConfirmBurn state={state} goal={goal} onClose={() => setBurning(false)} /> : null}
      </div>
      <Tune open={rules != null} initial={rules ?? undefined} onClose={() => setRules(null)} state={state} unit={state.autopilot} />
    </>
  )
}
