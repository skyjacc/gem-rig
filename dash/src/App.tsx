import { useEffect, useState } from 'react'
import { Gauge, Network, ShoppingCart, Users, Wrench } from 'lucide-react'
import { ago, DEMO, useJson, useLive, type Accounts as AccountsData } from './lib/api.ts'
import { Dot } from './parts/ui.tsx'
import { Sidebar, TopNav, type ViewId } from './parts/Sidebar.tsx'
import { LinkAccount } from './parts/LinkAccount.tsx'
import { Work } from './views/Work.tsx'
import { Graph } from './views/Graph.tsx'
import { Accounts } from './views/Accounts.tsx'
import { Review } from './views/Review.tsx'
import { Buy } from './views/Buy.tsx'

export default function App() {
  const live = useLive()
  const { state, online, stale } = live
  const [view, setView] = useState<ViewId>('work')
  // Привязка открывается поверх любого экрана: кнопка в колонке не должна
  // уводить человека на другую вкладку ради второй кнопки.
  const [linking, setLinking] = useState(false)
  // Обновление сессии существующего аккаунта: тот же вход по QR, но для него.
  const [relink, setRelink] = useState<{ id: string; label: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const { data: accounts } = useJson<AccountsData>('/api/accounts', state?.ts)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  if (!state) {
    return (
      <>
        <div className="bg-ambient" aria-hidden="true" />
        <main className="grid h-svh place-items-center px-6">
          <div className="text-center">
            <div className="text-2xl font-medium tracking-[-0.04em] text-foreground/95">Gemtrack</div>
            <div className="ui-label mt-2 text-muted-foreground/75">
              {online ? 'соединение с сервером' : 'сервер не отвечает — запустите его: npm run server в папке rig'}
            </div>
          </div>
        </main>
      </>
    )
  }

  // Пять вкладок в порядке того, как часто на них заходят. Первая —
  // ежедневная работа, остальные по случаю: докупить, посмотреть карту,
  // привязать аккаунт, разобрать поломку.
  const items = [
    { id: 'work' as const, label: 'Пульт', icon: <Gauge className="h-3.5 w-3.5" />, count: state.mine.filter(m => m.gem !== '—').length },
    { id: 'buy' as const, label: 'Скупка', icon: <ShoppingCart className="h-3.5 w-3.5" /> },
    { id: 'graph' as const, label: 'Граф', icon: <Network className="h-3.5 w-3.5" /> },
    { id: 'accounts' as const, label: 'Аккаунты', icon: <Users className="h-3.5 w-3.5" />, count: accounts?.list.length },
    { id: 'review' as const, label: 'Разбор', icon: <Wrench className="h-3.5 w-3.5" /> },
  ]

  return (
    <>
      <div className="bg-ambient" aria-hidden="true" />
      <div className="flex h-svh">
        <Sidebar view={view} onView={setView} onLink={() => { setRelink(null); setLinking(true) }} state={state} accounts={accounts} items={items} />

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-white/[0.08] px-4 sm:px-8">
            {DEMO ? (
              <span className="ui-label flex items-center gap-2 border border-white/[0.08] px-2.5 py-1 text-muted-foreground">
                <span className="h-[6px] w-[6px] shrink-0" style={{ background: 'var(--warn)' }} />
                показ — снимок данных, ничего никуда не отправляется
              </span>
            ) : null}
            {/* Устаревшие данные не выдаём за свежие: пока поток молчит,
                на экране прошлое, и это должно быть написано, а не угадано. */}
            {stale ? (
              <span className="ui-label flex items-center gap-2 border px-2.5 py-1" style={{ borderColor: 'var(--stop)', color: 'var(--stop)' }}>
                <span className="h-[6px] w-[6px] shrink-0" style={{ background: 'var(--stop)' }} />
                данные устарели — {ago(live.at, now)} без связи
              </span>
            ) : null}
            <div className="ml-auto flex items-center gap-4">
              <span className="ui-label hidden text-muted-foreground/75 sm:inline">
                {DEMO ? 'снимок 21 августа' : 'инвентарь ' + (state.inv.age != null ? ago(Date.now() - state.inv.age * 1000, now) + ' назад' : '—')}
              </span>
              <span className="flex items-center gap-2">
                <Dot tone={stale ? 'stop' : online ? 'ok' : 'stop'} pulse={online && !stale} />
                <span className="ui-label text-muted-foreground">
                  {DEMO ? 'без сервера' : stale ? 'молчит' : online ? 'в эфире' : 'нет связи'}
                </span>
              </span>
            </div>
          </header>

          <TopNav view={view} onView={setView} state={state} accounts={accounts} items={items} />

          <main
            key={view}
            className={'scroll-thin min-w-0 flex-1 ' + (view === 'graph' ? 'overflow-hidden p-0' : 'view-in overflow-auto px-4 py-6 sm:px-8 sm:py-10')}
          >
            {view === 'work' && <Work state={state} live={live} now={now} />}
            {view === 'buy' && <Buy state={state} />}
            {view === 'graph' && <Graph state={state} />}
            {view === 'accounts' && <Accounts state={state} accounts={accounts} onLink={r => { setRelink(r ?? null); setLinking(true) }} />}
            {view === 'review' && <Review state={state} />}
          </main>
        </div>
      </div>

      <LinkAccount open={linking} onClose={() => { setLinking(false); setRelink(null) }} accounts={accounts} relink={relink} />
    </>
  )
}
