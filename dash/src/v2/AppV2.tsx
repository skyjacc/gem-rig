import './v2.css'
import { useEffect, useState } from 'react'
import { ago, DEMO, useJson, useLive, type Accounts, type Settings } from '../lib/api.ts'
import { Tune } from '../parts/Tune.tsx'
import { LinkAccount } from '../parts/LinkAccount.tsx'
import { Rail, RailRow, SCREENS, type ScreenId } from './Rail.tsx'
import { TopBar } from './TopBar.tsx'
import { Pult } from './Pult.tsx'
import { ConfirmBurn } from './ConfirmBurn.tsx'
import { Bell } from './Bell.tsx'
import { Booting, FirstRun, NoServer } from './States.tsx'
import { Pill } from './ui.tsx'
import { Screen, ScreenSide } from './screens.tsx'
import { Overview } from './overview/Overview.tsx'
import { Inspector } from './overview/Inspector.tsx'
import { Alerts } from './overview/Alerts.tsx'
import { currentGem } from './overview/Canvas.tsx'
import { OverviewKpi } from './overview/kpi.tsx'
import { Inventory } from './inventory/Inventory.tsx'
import { ItemCard } from './inventory/ItemCard.tsx'
import { BuyScreen, useBuy } from './buy/Buy.tsx'

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
  // Привязка — нынешнее окно LinkAccount (старый вид, портал вне .v2);
  // новое — вместе с экраном Аккаунтов (этап 2.4).
  const [linking, setLinking] = useState(false)
  // Выбранный гем Обзора: его показывают и холст, и инспектор справа.
  const [gem, setGem] = useState<string | null>(null)
  // Выбранная стопка Инвентаря: её покажет карточка справа.
  const [stack, setStack] = useState<string | null>(null)
  // Скупка: план и корзина общие для экрана и правой колонки. Запросы
  // площадки идут, только пока открыта Скупка.
  const buy = useBuy(state, screen === 'buy', settings, accounts)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), SECOND)
    return () => clearInterval(t)
  }, [])

  // Снимка ещё нет: связь есть — соединяемся, нет — сервер не отвечает.
  // Так же различала и старая панель.
  if (!state) {
    return <div className="v2">{live.online ? <Booting /> : <NoServer since={ago(live.at, now)} />}</div>
  }

  const status = (
    <>
      {DEMO ? <Pill tone="warn">показ — снимок, ничего не отправляется</Pill> : null}
      {stale ? <Pill tone="stop">данные устарели — {ago(live.at, now)} без связи</Pill> : null}
    </>
  )
  const title = SCREENS.find(s => s.id === screen)!.label
  // Цель — только из настроек (§3.2). Нет её — так и пишем, числа не подставляем.
  const goal = typeof settings?.goal === 'number' && settings.goal > 0 ? settings.goal : null
  // Аккаунтов нет (список пришёл и пуст) — показывать нечего, кроме первого шага.
  const empty = !!accounts && accounts.list.length === 0

  return (
    <>
      <div className="v2">
        <div className="v2-app">
          <Rail screen={screen} onScreen={setScreen} onRules={() => setRules('rules')} />
          <TopBar
            state={state}
            accounts={accounts}
            kpi={(screen === 'overview' || screen === 'inventory' || screen === 'buy') && !empty ? <OverviewKpi state={state} goal={goal} settings={settings} now={now} /> : undefined}
            status={status}
            bell={<Bell state={state} live={live} now={now} goal={goal} />}
          />
          <RailRow screen={screen} onScreen={setScreen} />
          <main className="v2-page" aria-label={title}>
            <div className="v2-page-scroll">
              {empty ? <FirstRun onLink={() => setLinking(true)} />
                : screen === 'overview' ? <Overview state={state} accounts={accounts} goal={goal} sel={gem} onSel={setGem} />
                : screen === 'inventory' ? <Inventory state={state} goal={goal} sel={stack} onSel={setStack} />
                : screen === 'buy' ? <BuyScreen state={state} buy={buy} />
                : <Screen id={screen} title={title} />}
            </div>
            <Pult state={state} live={live} now={now} onTune={() => setRules('run')} onBurn={() => setBurning(true)} />
          </main>
          <aside className="v2-side" aria-label="Правая колонка">
            {empty ? null : screen === 'overview' ? (
              <>
                <Inspector state={state} gem={currentGem(state, goal, gem)} goal={goal} onInventory={() => setScreen('inventory')} />
                <Alerts state={state} live={live} now={now} goal={goal} />
              </>
            ) : screen === 'inventory' ? (
              <ItemCard state={state} goal={goal} sel={stack} onOverview={g => { setGem(g); setScreen('overview') }} />
            ) : <ScreenSide id={screen} />}
          </aside>
        </div>
        {burning ? <ConfirmBurn state={state} goal={goal} onClose={() => setBurning(false)} /> : null}
      </div>
      <LinkAccount open={linking} onClose={() => setLinking(false)} accounts={accounts} />
      <Tune open={rules != null} initial={rules ?? undefined} onClose={() => setRules(null)} state={state} unit={state.autopilot} />
    </>
  )
}
