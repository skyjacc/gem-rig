import { Check, Plus } from 'lucide-react'
import type { Accounts, State } from '../lib/api.ts'
import { post } from '../lib/api.ts'
import { Dot } from './ui.tsx'

export type ViewId = 'work' | 'gems' | 'graph' | 'queue' | 'feed' | 'buy' | 'accounts'

export function Sidebar({
  view,
  onView,
  state,
  accounts,
  items,
}: {
  view: ViewId
  onView: (v: ViewId) => void
  state: State
  accounts: Accounts | null
  items: { id: ViewId; label: string; icon: React.ReactNode; count?: number }[]
}) {
  const units = state.autopilot.units ?? []

  return (
    <aside className="flex h-svh w-[248px] shrink-0 flex-col border-r border-white/[0.08]">
      <div className="flex h-14 items-center gap-2 border-b border-white/[0.08] px-4">
        <span className="text-[15px] font-medium tracking-[-0.03em]">Gemtrack</span>
      </div>

      {/* Аккаунты. Переключение меняет то, чей журнал расхода считается. */}
      <div className="border-b border-white/[0.08] py-2">
        {(accounts?.list ?? []).map(a => {
          const u = units.find(x => x.id === a.id)
          const on = accounts?.active === a.id
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => post('/api/accounts/active', { id: a.id })}
              className={
                'flex w-full items-center gap-2 px-4 py-2 text-left transition-colors ' +
                (on ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]')
              }
            >
              <Dot tone={u?.running ? 'ok' : u?.enabled ? 'warn' : a.session ? 'idle' : 'stop'} pulse={u?.running} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{a.label}</span>
                <span className="block truncate font-mono text-[10px] text-muted-foreground/60">{a.steamid}</span>
              </span>
              {on ? <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
            </button>
          )
        })}
        <button
          type="button"
          onClick={() => onView('accounts')}
          className="flex w-full items-center gap-2 px-4 py-2 text-left text-muted-foreground transition-colors hover:bg-white/[0.03] hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="ui-label">привязать аккаунт</span>
        </button>
      </div>

      <nav className="flex-1 overflow-auto py-2">
        {items.map(it => (
          <button
            key={it.id}
            type="button"
            onClick={() => onView(it.id)}
            className={
              'flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors ' +
              (view === it.id ? 'bg-white/[0.08] text-foreground' : 'text-muted-foreground hover:bg-white/[0.03] hover:text-foreground')
            }
          >
            <span className="shrink-0">{it.icon}</span>
            <span className="ui-label flex-1">{it.label}</span>
            {it.count !== undefined ? (
              <span className="tnum font-mono text-[11px] text-muted-foreground/60">{it.count}</span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="border-t border-white/[0.08] px-4 py-3">
        <div className="flex items-center gap-2">
          <Dot tone={state.autopilot.running ? 'ok' : state.autopilot.enabled ? 'warn' : 'idle'} pulse={state.autopilot.running} />
          <span className="ui-label text-muted-foreground">
            {state.autopilot.enabled ? (state.autopilot.running ? 'жжёт' : 'ждёт') : 'выключен'}
          </span>
        </div>
      </div>
    </aside>
  )
}
