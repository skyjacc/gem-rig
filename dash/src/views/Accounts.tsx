import { useState } from 'react'
import { ChevronDown, ChevronRight, Link2, Pencil, Play, Square, Unlink } from 'lucide-react'
import {
  nf, post, span, useJson,
  type AccountRow, type Accounts as AccountsData, type Settings, type State, type Unit,
} from '../lib/api.ts'
import { Bar, Button, Card, Dot, Field, Head, ItemIcon, Label, Num, PageHead, Segmented } from '../parts/ui.tsx'
import { Modal } from '../parts/Modal.tsx'

// Аккаунты.
//
// Матчи общие для всех аккаунтов, а израсходованные — у каждого свои.
// Отсюда два следствия, ради которых экран и существует:
//
//   второй аккаунт жжёт те же матчи заново — вдвое больше товара за то же время
//   каждый настраивается отдельно: свой темп, своя цель, свой набор гемов
//
// Настройки раскрываются прямо в карточке, а не прячутся за окном: их крутят
// по ходу работы, и лишнее нажатие тут ничего не экономит. В окне остаётся
// только то, у чего есть начало и конец: привязка и отвязка.

const PACE: [number, string][] = [[500, '0,5 с'], [1000, '1 с'], [2000, '2 с'], [5000, '5 с'], [30000, '30 с']]
const WAVES = [1, 2, 3, 4, 5]

export function Accounts({
  state,
  accounts,
  onLink,
}: {
  state: State
  accounts: AccountsData | null
  onLink: () => void
}) {
  const [dropping, setDropping] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())

  const units = state.autopilot.units ?? []
  const list = accounts?.list ?? []
  const unit = (id: string) => units.find(u => u.id === id)
  const dropped = dropping ? list.find(a => a.id === dropping) : null
  const icons = new Map(state.mine.filter(m => m.gem !== '—').map(m => [m.gem, m.icon]))

  const toggle = (id: string) => setOpen(s => {
    const n = new Set(s)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })

  return (
    <div className="view-in space-y-6">
      <PageHead
        title="Аккаунты"
        sub="матчи общие для всех аккаунтов, а израсходованные — у каждого свои: второй аккаунт жжёт те же матчи заново"
        right={
          <Button active onClick={onLink}>
            <Link2 className="h-3.5 w-3.5" />
            <span>привязать</span>
          </Button>
        }
      />

      <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(420px,1fr))]">
        {list.map(a => (
          <Row
            key={a.id}
            a={a}
            u={unit(a.id)}
            icons={icons}
            active={accounts?.active === a.id}
            alone={list.length === 1}
            open={open.has(a.id)}
            onToggle={() => toggle(a.id)}
            onDrop={() => setDropping(a.id)}
          />
        ))}
      </div>

      <Common state={state} />

      <Modal
        open={!!dropped}
        title="Отвязать аккаунт"
        note={dropped?.label}
        width="w-[460px]"
        onClose={() => setDropping(null)}
        footer={
          <>
            <Button onClick={() => setDropping(null)}>отмена</Button>
            <Button
              tone="danger"
              onClick={async () => { await post('/api/accounts/unlink', { id: dropped!.id }); setDropping(null) }}
            >
              удалить сессию
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Сессия будет удалена — вернуть аккаунт можно только новым QR.
          {' '}Журнал расхода останется: {nf(dropped?.burned ?? 0)} матчей на нём
          действительно израсходованы, и если аккаунт привяжут заново, очередь
          должна об этом помнить.
        </p>
      </Modal>
    </div>
  )
}

function Row({
  a, u, icons, active, alone, open, onToggle, onDrop,
}: {
  a: AccountRow
  u?: Unit
  icons: Map<string, string>
  active: boolean
  alone: boolean
  open: boolean
  onToggle: () => void
  onDrop: () => void
}) {
  const [name, setName] = useState(a.label)
  const [editing, setEditing] = useState(false)

  return (
    <Card hover className="rise p-3.5">
      <div className="flex items-center gap-2.5">
        <Dot tone={u?.running ? 'ok' : u?.enabled ? 'warn' : a.session ? 'idle' : 'stop'} pulse={u?.running} />
        <span className="min-w-0 flex-1">
          {editing ? (
            <span className="flex items-center gap-2">
              <Field value={name} onChange={setName} width="w-44" />
              <Button
                active
                onClick={async () => { await post('/api/accounts/rename', { id: a.id, label: name }); setEditing(false) }}
              >
                сохранить
              </Button>
            </span>
          ) : (
            <>
              <span className="block truncate text-[15px] font-medium">{a.label}</span>
              <span className="block truncate font-mono text-[11px] text-muted-foreground">{a.steamid}</span>
            </>
          )}
        </span>
        {active ? (
          <span className="ui-label shrink-0 border border-white/[0.08] px-2 py-1 text-muted-foreground">активный</span>
        ) : null}
      </div>

      <div className="mt-3 grid grid-cols-4 gap-3">
        <Cell k="сожжено" v={nf(a.burned)} />
        <Cell k="в очереди" v={nf(u?.queueLength ?? 0)} />
        <Cell k="пауза" v={u ? nf(u.delay) + (u.auto ? ' сама' : ' мс') : '—'} />
        <Cell k="сессия" v={a.session ? 'есть' : 'нет'} tone={a.session ? undefined : 'stop'} />
      </div>

      {u?.target ? (
        <div className="mt-3">
          <div className="mb-1 flex items-baseline justify-between text-[12px] text-muted-foreground">
            <span>цель {nf(u.target)}</span>
            <span className="tnum font-mono"><Num value={u.done} /> · {span(u.etaMinutes)}</span>
          </div>
          <Bar pct={(u.done / u.target) * 100} tone={u.done >= u.target ? 'ok' : 'run'} />
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {u?.enabled ? (
          <Button tone="danger" onClick={() => post('/api/autopilot', { id: a.id, on: false })}>
            <Square className="h-3.5 w-3.5" /><span>остановить</span>
          </Button>
        ) : (
          <Button disabled={!a.session} onClick={() => post('/api/autopilot', { id: a.id, on: true })}>
            <Play className="h-3.5 w-3.5" /><span>запустить</span>
          </Button>
        )}
        {!active ? <Button onClick={() => post('/api/accounts/active', { id: a.id })}>сделать активным</Button> : null}
        <Button active={open} onClick={onToggle}>
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span>настройки</span>
        </Button>
        <Button onClick={() => setEditing(v => !v)}><Pencil className="h-3.5 w-3.5" /><span>метка</span></Button>
        {!alone ? <Button onClick={onDrop}><Unlink className="h-3.5 w-3.5" /><span>отвязать</span></Button> : null}
      </div>

      {u?.enabled && !open ? <p className="mt-2 text-[12px] text-muted-foreground">{u.why}</p> : null}

      {open && u ? <Tune a={a} u={u} icons={icons} /> : null}
    </Card>
  )
}

function Cell({ k, v, tone }: { k: string; v: string; tone?: 'stop' }) {
  return (
    <span className="min-w-0">
      <Label>{k}</Label>
      <span
        className="tnum mt-0.5 block truncate font-mono text-[13px]"
        style={{ color: tone === 'stop' ? 'var(--stop)' : undefined }}
      >
        {v}
      </span>
    </span>
  )
}

// Настройки одного аккаунта: то, что у каждого своё.
function Tune({ a, u, icons }: { a: AccountRow; u: Unit; icons: Map<string, string> }) {
  const [own, setOwn] = useState(u.ordered ? String(u.ordered) : '')
  const send = (patch: Record<string, unknown>) => post('/api/autopilot', { id: a.id, ...patch })

  const available = u.available ?? []
  const only = u.only ?? null
  const chosen = new Set(only ?? available.map(g => g.gem))

  const flip = (gem: string) => {
    const next = new Set(chosen)
    next.has(gem) ? next.delete(gem) : next.add(gem)
    // Отмечены все — это и есть «все», список тогда не нужен.
    const list = [...next]
    send({ only: list.length === available.length ? [] : list })
  }

  return (
    <div className="mt-3 space-y-4 border-t border-white/[0.06] pt-3">
      <Line k="пауза" hint="ниже пола из общих правил опуститься нельзя">
        <Segmented
          value={u.auto ? 'auto' : String(u.delay)}
          items={[{ id: 'auto', label: 'сама' }, ...PACE.map(([ms, l]) => ({ id: String(ms), label: l }))]}
          onPick={id => send(id === 'auto' ? { auto: true } : { delay: Number(id) })}
        />
      </Line>

      <Line k="цель" hint="сколько отправок сделать и встать; пусто — до конца очереди">
        <span className="flex flex-wrap items-center gap-2">
          <Field
            value={own}
            onChange={v => setOwn(v.replace(/\D/g, ''))}
            placeholder="всё"
            width="w-28"
            inputMode="numeric"
          />
          <Button onClick={() => send({ target: own.trim() ? Number(own) : null })}>применить</Button>
          {u.target ? (
            <span className="text-[12px] text-muted-foreground">
              остановлюсь на <span className="tnum font-mono text-foreground">{nf(u.target)}</span>
              {u.ordered && u.ordered !== u.target ? ' — заказ ' + nf(u.ordered) + ', круглое не берём' : ''}
            </span>
          ) : null}
        </span>
      </Line>

      <Line k="разброс" hint="на сколько партий разложить, чтобы счётчики вышли разными">
        <Segmented
          value={String(u.waves ?? 1)}
          items={WAVES.map(w => ({ id: String(w), label: w === 1 ? 'нет' : String(w) }))}
          onPick={id => send({ waves: Number(id), target: own.trim() ? Number(own) : u.ordered ?? null })}
        />
      </Line>

      {(u.plan ?? []).length > 1 ? (
        <div className="flex flex-wrap gap-1.5">
          {u.plan!.map(w => (
            <span key={w.index} className="tnum border border-white/[0.08] px-2 py-1 font-mono text-[12px]">
              {nf(w.value)}
              <span className="ml-2 text-muted-foreground">{w.addAt === 0 ? 'сразу' : '+' + nf(w.addAt)}</span>
            </span>
          ))}
        </div>
      ) : null}

      <Line
        k="какие гемы жечь"
        hint={only ? 'выбрано ' + only.length + ' из ' + available.length : 'все, что лежат в инвентаре'}
      >
        {available.length === 0 ? (
          <span className="text-[12px] text-muted-foreground">нет гемов, по которым понятно, чьи матчи считать</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {available.map(g => {
              const on = chosen.has(g.gem)
              return (
                <button
                  key={g.gem}
                  type="button"
                  onClick={() => flip(g.gem)}
                  className={
                    'ui-label inline-flex h-8 items-center gap-2 border px-2 transition-colors ' +
                    (on
                      ? 'border-white/20 bg-white/[0.08] text-foreground'
                      : 'border-white/[0.08] text-muted-foreground hover:border-white/20')
                  }
                >
                  <span className={on ? '' : 'opacity-40'}>
                    <ItemIcon hash={icons.get(g.gem) ?? ''} size={16} />
                  </span>
                  <span>{g.gem}</span>
                  <span className="tnum font-mono text-[11px] text-muted-foreground/60">{g.objects}</span>
                </button>
              )
            })}
            {only ? <Button onClick={() => send({ only: [] })}>все</Button> : null}
          </div>
        )}
      </Line>

      <div className="grid grid-cols-3 gap-3 border-t border-white/[0.06] pt-3">
        <Cell k="падений подряд" v={String(u.failures)} tone={u.failures ? 'stop' : undefined} />
        <Cell k="процесс" v={u.running ? 'pid ' + u.pid : u.exit ?? 'стоит'} />
        <Cell k="последнее решение" v={u.why} />
      </div>
    </div>
  )
}

function Line({ k, hint, children }: { k: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div>
        <Label>{k}</Label>
        {hint ? <div className="text-[11px] text-muted-foreground/60">{hint}</div> : null}
      </div>
      {children}
    </div>
  )
}

// Общие правила — то, что действует на все аккаунты сразу. Три поля,
// которые крутят чаще прочих; остальное на своём экране.
function Common({ state }: { state: State }) {
  const { data } = useJson<Settings>('/api/settings', state.ts)
  const [draft, setDraft] = useState<Record<string, string>>({})
  if (!data) return null

  const rows = [
    { path: 'goal', label: 'цель счётчика', hint: 'сколько просмотров делает вещь товаром', value: data.goal, unit: '', scale: 1 },
    { path: 'tick', label: 'как часто проверять', hint: 'через сколько заглядывать в инвентарь', value: data.tick, unit: 'с', scale: 1000 },
    { path: 'pace.floor', label: 'пол паузы', hint: 'ниже не опускаться никогда', value: data.pace.floor, unit: 'мс', scale: 1 },
  ]

  const apply = async (r: typeof rows[number]) => {
    const raw = draft[r.path]
    if (raw === undefined) return
    const n = Number(raw.replace(',', '.'))
    if (!Number.isFinite(n)) return
    const [a, b] = r.path.split('.')
    const v = n * r.scale
    await post('/api/settings', b ? { [a]: { [b]: v } } : { [a]: v })
    setDraft(d => { const x = { ...d }; delete x[r.path]; return x })
  }

  return (
    <div>
      <Head title="Общие правила" note="действуют на все аккаунты" />
      <Card>
        <div className="divide-y divide-white/[0.06]">
          {rows.map(r => (
            <div key={r.path} className="flex flex-wrap items-center gap-3 px-3.5 py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px]">{r.label}</span>
                <span className="block text-[12px] leading-snug text-muted-foreground">{r.hint}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <Field
                  value={draft[r.path] ?? String(r.value / r.scale)}
                  onChange={v => setDraft(d => ({ ...d, [r.path]: v }))}
                  width="w-24 text-right"
                  inputMode="decimal"
                  onKeyDown={e => { if (e.key === 'Enter') apply(r) }}
                />
                <span className="ui-label w-6 text-muted-foreground/70">{r.unit}</span>
                <Button disabled={draft[r.path] === undefined} active={draft[r.path] !== undefined} onClick={() => apply(r)}>
                  ок
                </Button>
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
