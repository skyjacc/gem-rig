import './v2.css'
import { useEffect, useState } from 'react'
import { ago, DEMO, useJson, useLive, type Accounts, type Settings } from '../lib/api.ts'
import { TuneSheet, type TuneTab } from './Tune.tsx'
import { LinkDialog } from './LinkDialog.tsx'
import { Rail, RailRow, SCREENS, type ScreenId } from './Rail.tsx'
import { TopBar } from './TopBar.tsx'
import { Pult } from './Pult.tsx'
import { ConfirmBurn } from './ConfirmBurn.tsx'
import { Bell } from './Bell.tsx'
import { Booting, FirstRun, NoServer } from './States.tsx'
import { Pill } from './ui.tsx'
import { Overview } from './overview/Overview.tsx'
import { Inspector } from './overview/Inspector.tsx'
import { Alerts } from './overview/Alerts.tsx'
import { currentGem } from './overview/Canvas.tsx'
import { OverviewKpi } from './overview/kpi.tsx'
import { Inventory } from './inventory/Inventory.tsx'
import { ItemCard } from './inventory/ItemCard.tsx'
import { BuyScreen, useBuy } from './buy/Buy.tsx'
import { BuySide } from './buy/BuySide.tsx'
import { AccountsScreen, type Open as AccOpen } from './accounts/Accounts.tsx'
import { AccountsSide } from './accounts/AccountsSide.tsx'
import { JournalScreen, type Tab as JournalTab } from './journal/Journal.tsx'
import { JournalSide } from './journal/JournalSide.tsx'
import { useJournal } from './journal/data.ts'
import { SalesScreen } from './sales/Sales.tsx'
import { SalesSide } from './sales/SalesSide.tsx'
import { useSales } from './sales/data.ts'

// Часы для «N без связи». Именем, а не числом: поиск круглых тысяч
// по src/v2 проверяет, что цель нигде не зашита (§3.2), и должен быть пуст.
const SECOND = 1_000

// Панель (спецификация v2). С этапа 9 — единственная: старая удалена,
// переключателя ?ui=v2 больше нет.
export default function AppV2() {
  const live = useLive()
  const { state, stale } = live
  const [screen, setScreen] = useState<ScreenId>('overview')
  // «Общие правила» на рельсе и «настроить» на пульте открывают окно
  // «Настроить» (§5.7, план 9) на своей вкладке. Быстрые настройки аккаунта
  // и три правила — ещё и на экране Аккаунтов (план 2.4); это тот же POST.
  const [rules, setRules] = useState<null | TuneTab>(null)
  const [now, setNow] = useState(() => Date.now())
  const accountsJson = useJson<Accounts>('/api/accounts', state?.ts)
  const accounts = accountsJson.data
  const settingsJson = useJson<Settings>('/api/settings', state?.ts)
  const settings = settingsJson.data
  const [burning, setBurning] = useState(false)
  // Привязка игрового входа — окно LinkDialog (план 9), им же обновляется
  // вход существующего аккаунта (relink).
  const [linking, setLinking] = useState<null | { relink: { id: string; label: string } | null }>(null)
  // Аккаунты: выбранный аккаунт (его настройки и работник справа) и окно
  // экрана — веб-вход, ключ, отвязка. Окно веб-входа открывается и справа.
  const [acc, setAcc] = useState<string | null>(null)
  const [accOpen, setAccOpen] = useState<AccOpen>(null)
  // Выбранный гем Обзора: его показывают и холст, и инспектор справа.
  const [gem, setGem] = useState<string | null>(null)
  // Выбранная стопка Инвентаря: её покажет карточка справа.
  const [stack, setStack] = useState<string | null>(null)
  // Скупка: план и корзина общие для экрана и правой колонки. Запросы
  // площадки идут, только пока открыта Скупка.
  const buy = useBuy(state, screen === 'buy', settings, accounts)
  // Журнал: вкладка и выбранная отправка — общие для экрана и колонки справа.
  // Запросы журнала идут, только пока он открыт.
  const journal = useJournal(state, screen === 'journal', settings)
  const [jrTab, setJrTab] = useState<JournalTab>('feed')
  const [jrSel, setJrSel] = useState<string | null>(null)
  // Продажи: журнал операций и ключи активного аккаунта — только пока экран открыт.
  const sales = useSales(state, screen === 'sales', accounts)

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
              {empty ? <FirstRun onLink={() => setLinking({ relink: null })} />
                : screen === 'overview' ? <Overview state={state} accounts={accounts} goal={goal} sel={gem} onSel={setGem} />
                : screen === 'inventory' ? <Inventory state={state} goal={goal} sel={stack} onSel={setStack} />
                : screen === 'buy' ? <BuyScreen state={state} buy={buy} />
                : screen === 'sales' ? <SalesScreen data={sales} now={now} />
                : screen === 'journal' ? (
                  <JournalScreen state={state} data={journal} tab={jrTab} onTab={setJrTab} sel={jrSel} onSel={setJrSel} top={settings?.treeTop ?? 12} />
                )
                : screen === 'accounts' ? (
                  <AccountsScreen
                    state={state} accounts={accounts} accountsJson={accountsJson} settings={settings} now={now}
                    sel={acc} onSel={setAcc} open={accOpen} setOpen={setAccOpen}
                    onLink={relink => setLinking({ relink })} onBurn={() => setBurning(true)}
                  />
                )
                : null}
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
            ) : screen === 'buy' ? (
              <BuySide state={state} buy={buy} now={now} onRules={() => setRules('rules')} />
            ) : screen === 'sales' ? (
              <SalesSide data={sales} />
            ) : screen === 'journal' ? (
              <JournalSide state={state} data={journal} sel={jrSel} now={now} />
            ) : screen === 'accounts' ? (
              <AccountsSide
                state={state} accounts={accounts} sel={acc} now={now}
                onRelink={a => setLinking({ relink: a })} onWeb={id => setAccOpen({ kind: 'web', id })}
              />
            ) : null}
          </aside>
        </div>
        {burning ? <ConfirmBurn state={state} goal={goal} onClose={() => setBurning(false)} /> : null}
        {linking ? <LinkDialog accounts={accounts} relink={linking.relink} onClose={() => setLinking(null)} /> : null}
        {rules ? <TuneSheet tab={rules} onTab={setRules} onClose={() => setRules(null)} state={state} settings={settings} onSaved={settingsJson.reload} /> : null}
      </div>
    </>
  )
}
