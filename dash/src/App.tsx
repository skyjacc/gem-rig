import { useEffect, useState } from 'react'
import {
  Activity,
  LayoutGrid,
  ListOrdered,
  Network,
  Settings2,
  ShoppingCart,
  Sparkles,
  Users,
} from 'lucide-react'
import { ago, useJson, useLive, type Accounts as AccountsData } from './lib/api.ts'
import { Dot } from './parts/ui.tsx'
import { Sidebar, type ViewId } from './parts/Sidebar.tsx'
import { Overview } from './views/Overview.tsx'
import { Graph } from './views/Graph.tsx'
import { Accounts } from './views/Accounts.tsx'
import { Settings } from './views/Settings.tsx'
import { Buy, Feed, Queue } from './views/Tables.tsx'
import { Gems } from './views/Gems.tsx'

export default function App() {
  const { state, online } = useLive()
  const [view, setView] = useState<ViewId>('work')
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
        <main className="grid h-svh place-items-center">
          <div className="text-center">
            <div className="text-2xl font-medium tracking-[-0.04em] text-foreground/95">Gemtrack</div>
            <div className="ui-label mt-2 text-muted-foreground/75">соединение с сервером</div>
          </div>
        </main>
      </>
    )
  }

  const items = [
    { id: 'work' as const, label: 'Работа', icon: <LayoutGrid className="h-3.5 w-3.5" /> },
    { id: 'gems' as const, label: 'Мои гемы', icon: <Sparkles className="h-3.5 w-3.5" />, count: state.mine.filter(m => m.gem !== '—').length },
    { id: 'graph' as const, label: 'Граф', icon: <Network className="h-3.5 w-3.5" /> },
    { id: 'queue' as const, label: 'Очередь', icon: <ListOrdered className="h-3.5 w-3.5" />, count: state.autopilot.queueLength },
    { id: 'feed' as const, label: 'Лента', icon: <Activity className="h-3.5 w-3.5" /> },
    { id: 'buy' as const, label: 'Закупка', icon: <ShoppingCart className="h-3.5 w-3.5" />, count: state.catalog.length },
    { id: 'accounts' as const, label: 'Аккаунты', icon: <Users className="h-3.5 w-3.5" />, count: accounts?.list.length },
    { id: 'settings' as const, label: 'Настройки', icon: <Settings2 className="h-3.5 w-3.5" /> },
  ]


  return (
    <>
      <div className="bg-ambient" aria-hidden="true" />
      <div className="flex h-svh">
        <Sidebar view={view} onView={setView} state={state} accounts={accounts} items={items} />

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-white/[0.08] px-8">
            <div className="ml-auto flex items-center gap-4">
              <span className="ui-label text-muted-foreground/75">
                инвентарь {state.inv.age != null ? ago(Date.now() - state.inv.age * 1000, now) + ' назад' : '—'}
              </span>
              <span className="flex items-center gap-2">
                <Dot tone={online ? 'ok' : 'stop'} pulse={online} />
                <span className="ui-label text-muted-foreground">{online ? 'в эфире' : 'нет связи'}</span>
              </span>
            </div>
          </header>

          <main
            key={view}
            className={'scroll-thin min-w-0 flex-1 ' + (view === 'graph' ? 'overflow-hidden p-0' : 'view-in overflow-auto px-8 py-10')}
          >
            {view === 'work' && <Overview state={state} now={now} />}
            {view === 'gems' && <Gems state={state} />}
            {view === 'graph' && <Graph state={state} />}
            {view === 'queue' && <Queue state={state} />}
            {view === 'feed' && <Feed state={state} />}
            {view === 'buy' && <Buy state={state} />}
            {view === 'accounts' && <Accounts state={state} accounts={accounts} />}
            {view === 'settings' && <Settings state={state} />}
          </main>
        </div>
      </div>
    </>
  )
}
