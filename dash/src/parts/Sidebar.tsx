import { Check, Plus } from 'lucide-react'
import type { Accounts, State, Unit } from '../lib/api.ts'
import { post } from '../lib/api.ts'
import { Dot } from './ui.tsx'

export type ViewId = 'work' | 'buy' | 'graph' | 'accounts' | 'review'
export type NavItem = { id: ViewId; label: string; icon: React.ReactNode; count?: number }

// Лампа аккаунта. Порядок проверок — по цене вопроса: сначала то, из-за чего
// работа не идёт и сама не пойдёт, потом то, что идёт само.
export function accountTone(u: Unit | undefined, session: boolean): 'ok' | 'warn' | 'stop' | 'idle' {
  if (!session) return 'stop'
  if (u?.fatal) return 'stop'
  if (u?.inv?.private || u?.inv?.error) return 'stop'
  if (u?.running) return 'ok'
  if (u?.enabled) return 'warn'
  return 'idle'
}

export function Sidebar({
  view,
  onView,
  onLink,
  state,
  accounts,
  items,
}: {
  view: ViewId
  onView: (v: ViewId) => void
  onLink: () => void
  state: State
  accounts: Accounts | null
  items: NavItem[]
}) {
  const units = state.autopilot.units ?? []

  return (
    // Ниже средней ширины колонка уходит: на узком экране двести пятьдесят
    // пикселей постоянной навигации — это половина места под данные.
    // Вкладки там переезжают в шапку.
    <aside className="hidden h-svh w-[212px] shrink-0 flex-col border-r border-white/[0.08] md:flex xl:w-[248px]">
      <div className="flex h-14 items-center gap-2 border-b border-white/[0.08] px-4">
        <span className="text-[15px] font-medium tracking-[-0.03em]">Gemtrack</span>
      </div>

      {/* Аккаунты. Переключение меняет то, чей журнал расхода считается. */}
      <div className="border-b border-white/[0.08] py-2">
        {(accounts?.list ?? []).map(a => {
          const u = units.find(x => x.id === a.id)
          const on = accounts?.active === a.id
          const tone = accountTone(u, a.session)
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => post('/api/accounts/active', { id: a.id })}
              aria-current={on || undefined}
              title={u?.fatal ?? (u?.inv?.private ? 'инвентарь закрыт' : u?.inv?.error ?? undefined)}
              className={
                'flex w-full items-center gap-2 px-4 py-2 text-left transition-colors ' +
                (on ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]')
              }
            >
              <Dot tone={tone} pulse={tone === 'ok'} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{a.label}</span>
                <span className="block truncate font-mono text-[10px] text-muted-foreground/75">{a.steamid}</span>
              </span>
              {on ? <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
            </button>
          )
        })}
        <button
          type="button"
          onClick={onLink}
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
            aria-current={view === it.id ? 'page' : undefined}
            className={
              'flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors ' +
              (view === it.id ? 'bg-white/[0.08] text-foreground' : 'text-muted-foreground hover:bg-white/[0.03] hover:text-foreground')
            }
          >
            <span className="shrink-0">{it.icon}</span>
            <span className="ui-label flex-1">{it.label}</span>
            {it.count !== undefined ? (
              <span className="tnum font-mono text-[11px] text-muted-foreground/75">{it.count}</span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="border-t border-white/[0.08] px-4 py-3">
        <div className="flex items-center gap-2">
          <Dot tone={state.autopilot.running ? 'ok' : state.autopilot.enabled ? 'warn' : 'idle'} pulse={state.autopilot.running} />
          <span className="ui-label truncate text-muted-foreground">
            {state.autopilot.enabled ? (state.autopilot.running ? 'накручивает' : 'ждёт') : 'выключен'}
          </span>
        </div>
      </div>
    </aside>
  )
}

// Узкий экран: вкладки в один ряд под шапкой, аккаунты — точками.
// Полноценная колонка там не помещается, а прятать навигацию за кнопку
// в инструменте, где переключаются по десять раз, значит мешать работать.
export function TopNav({
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
  items: NavItem[]
}) {
  const units = state.autopilot.units ?? []
  const list = accounts?.list ?? []

  return (
    <div className="scroll-thin flex shrink-0 items-center gap-1 overflow-x-auto border-b border-white/[0.08] px-2 py-1.5 md:hidden">
      {items.map(it => (
        <button
          key={it.id}
          type="button"
          onClick={() => onView(it.id)}
          aria-current={view === it.id ? 'page' : undefined}
          className={
            'ui-label inline-flex h-9 shrink-0 items-center gap-1.5 border px-2.5 transition-colors ' +
            (view === it.id
              ? 'border-white/20 bg-white/[0.08] text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground')
          }
        >
          {it.icon}
          <span>{it.label}</span>
        </button>
      ))}
      {list.length > 1 ? (
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          {list.map(a => {
            const u = units.find(x => x.id === a.id)
            const on = accounts?.active === a.id
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => post('/api/accounts/active', { id: a.id })}
                aria-label={'аккаунт ' + a.label}
                aria-current={on || undefined}
                className={'inline-flex h-9 items-center gap-1.5 border px-2 ' + (on ? 'border-white/20 bg-white/[0.08]' : 'border-transparent')}
              >
                <Dot tone={accountTone(u, a.session)} pulse={u?.running} />
                <span className="ui-label max-w-[70px] truncate">{a.label}</span>
              </button>
            )
          })}
        </span>
      ) : null}
    </div>
  )
}
