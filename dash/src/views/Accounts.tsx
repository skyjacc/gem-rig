import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Link2, Pencil, Play, Settings2, Square, Unlink } from 'lucide-react'
import { nf, post, span, type AccountRow, type Accounts as AccountsData, type State, type Unit } from '../lib/api.ts'
import { Bar, Button, Card, Dot, Field, Head, Label, Num, Segmented } from '../parts/ui.tsx'
import { Modal } from '../parts/Modal.tsx'

// Аккаунты.
//
// Пул матчей общий, журнал расхода — у каждого свой. Поэтому второй аккаунт
// жжёт тот же пул с нуля, а «одна сессия» ограничивает аккаунт, не машину:
// два работника идут рядом и дают вдвое больше товара за то же время.
//
// Привязка — вход по QR из приложения Steam, в окне поверх: это отдельное
// дело с началом и концом, ему не место строкой в списке. Пароль здесь
// не вводится и не хранится, на диск ложится только сессия.

const PACE: [number, string][] = [[500, '0,5 с'], [1000, '1 с'], [2000, '2 с'], [5000, '5 с'], [30000, '30 с']]
const WAVES = [1, 2, 3, 4, 5]

export function Accounts({ state, accounts }: { state: State; accounts: AccountsData | null }) {
  const [linking, setLinking] = useState(false)
  const [tuning, setTuning] = useState<string | null>(null)
  const [dropping, setDropping] = useState<string | null>(null)
  const [label, setLabel] = useState('')

  const link = accounts?.link ?? null
  const units = state.autopilot.units ?? []
  const list = accounts?.list ?? []
  const unit = (id: string) => units.find(u => u.id === id)

  // Как только привязка удалась — окно закрывается само.
  useEffect(() => {
    if (linking && link?.done && link.steamid && !link.error) {
      const t = setTimeout(() => setLinking(false), 1200)
      return () => clearTimeout(t)
    }
  }, [linking, link?.done, link?.steamid, link?.error])

  const open = (id: string) => setTuning(id)
  const tuned = tuning ? list.find(a => a.id === tuning) : null
  const dropped = dropping ? list.find(a => a.id === dropping) : null

  return (
    <div className="view-in space-y-6">
      <div>
        <Head
          title="Аккаунты"
          note={`${nf(list.length)}`}
          right={
            <Button active onClick={() => { setLabel(''); post('/api/accounts/link/cancel', {}); setLinking(true) }}>
              <Link2 className="h-3.5 w-3.5" />
              <span>привязать</span>
            </Button>
          }
        />
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {list.map(a => (
            <Row
              key={a.id}
              a={a}
              u={unit(a.id)}
              active={accounts?.active === a.id}
              onTune={() => open(a.id)}
              onDrop={() => setDropping(a.id)}
              alone={list.length === 1}
            />
          ))}
        </div>
      </div>

      <div>
        <Head title="Как это работает" />
        <Card className="p-4 text-[13px] leading-relaxed text-muted-foreground">
          Пул матчей общий на все аккаунты, журнал расхода — у каждого свой. Матч,
          израсходованный на одном, на другом остаётся свежим. Ограничение «одна сессия»
          действует на аккаунт, а не на машину, поэтому работники идут рядом.
        </Card>
      </div>

      {/* ── привязка ── */}
      <Modal
        open={linking}
        title="Привязать аккаунт"
        note="вход по QR из приложения Steam"
        onClose={() => { post('/api/accounts/link/cancel', {}); setLinking(false) }}
        footer={
          !link || link.done ? (
            <>
              <Button onClick={() => setLinking(false)}>закрыть</Button>
              <Button
                active
                disabled={!!(link && !link.done)}
                onClick={() => post('/api/accounts/link', { label })}
              >
                показать QR
              </Button>
            </>
          ) : (
            <Button onClick={() => { post('/api/accounts/link/cancel', {}); setLinking(false) }}>отменить</Button>
          )
        }
      >
        {!link || link.done ? (
          <div className="space-y-3">
            <label className="block">
              <Label>метка</Label>
              <Field value={label} onChange={setLabel} placeholder="например «второй»" width="mt-1.5 w-full" />
            </label>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Пароль не вводится и не хранится. На диск ляжет только сессия, отдельным
              файлом — это ключ от аккаунта, его нельзя никуда выкладывать.
            </p>
            {link?.error ? <p className="text-[12px]" style={{ color: 'var(--stop)' }}>{link.error}</p> : null}
            {link?.done && link.steamid && !link.error ? (
              <p className="text-[12px]" style={{ color: 'var(--ok)' }}>привязан {link.steamid}</p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-start gap-5">
            <Qr url={link.url} />
            <ol className="min-w-0 flex-1 space-y-1.5 text-[13px] leading-relaxed text-muted-foreground">
              <li><span className="text-foreground">1</span> — приложение Steam на телефоне</li>
              <li><span className="text-foreground">2</span> — значок QR справа сверху</li>
              <li><span className="text-foreground">3</span> — навести камеру на код</li>
              <li><span className="text-foreground">4</span> — подтвердить вход</li>
              {link.steamid ? (
                <li style={{ color: 'var(--ok)' }}>вошёл: {link.steamid}</li>
              ) : null}
            </ol>
          </div>
        )}
      </Modal>

      {/* ── настройки аккаунта ── */}
      <Modal
        open={!!tuned}
        title={tuned ? 'Настройки: ' + tuned.label : ''}
        note={tuned?.steamid}
        onClose={() => setTuning(null)}
        footer={<Button onClick={() => setTuning(null)}>готово</Button>}
      >
        {tuned ? <Tune a={tuned} u={unit(tuned.id)} /> : null}
      </Modal>

      {/* ── отвязка ── */}
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
  a, u, active, alone, onTune, onDrop,
}: {
  a: AccountRow
  u?: Unit
  active: boolean
  alone: boolean
  onTune: () => void
  onDrop: () => void
}) {
  const [name, setName] = useState(a.label)
  const [editing, setEditing] = useState(false)

  return (
    <Card hover className="rise p-4">
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
        <Cell k="пауза" v={u ? nf(u.delay) + ' мс' + (u.auto ? ' · сама' : '') : '—'} />
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
        {!active ? <Button onClick={() => post('/api/accounts/active', { id: a.id })}>сделать активным</Button> : null}
        {u?.enabled ? (
          <Button tone="danger" onClick={() => post('/api/autopilot', { id: a.id, on: false })}>
            <Square className="h-3.5 w-3.5" /><span>остановить</span>
          </Button>
        ) : (
          <Button disabled={!a.session} onClick={() => post('/api/autopilot', { id: a.id, on: true })}>
            <Play className="h-3.5 w-3.5" /><span>запустить</span>
          </Button>
        )}
        <Button onClick={onTune}><Settings2 className="h-3.5 w-3.5" /><span>настройки</span></Button>
        <Button onClick={() => setEditing(v => !v)}><Pencil className="h-3.5 w-3.5" /><span>метка</span></Button>
        {!alone ? (
          <Button onClick={onDrop}><Unlink className="h-3.5 w-3.5" /><span>отвязать</span></Button>
        ) : null}
      </div>

      {u?.enabled ? <p className="mt-2 text-[12px] text-muted-foreground">{u.why}</p> : null}
    </Card>
  )
}

function Cell({ k, v, tone }: { k: string; v: string; tone?: 'stop' }) {
  return (
    <span>
      <Label>{k}</Label>
      <span className="tnum mt-0.5 block font-mono text-[13px]" style={{ color: tone === 'stop' ? 'var(--stop)' : undefined }}>
        {v}
      </span>
    </span>
  )
}

// Настройки одного аккаунта: то, что у каждого своё.
function Tune({ a, u }: { a: AccountRow; u?: Unit }) {
  const [own, setOwn] = useState(u?.ordered ? String(u.ordered) : '')
  if (!u) return <p className="text-[13px] text-muted-foreground">работник ещё не создан</p>

  const send = (patch: Record<string, unknown>) => post('/api/autopilot', { id: a.id, ...patch })

  return (
    <div className="space-y-4">
      <Line k="пауза" hint="ниже пола из общих настроек опуститься нельзя">
        <Segmented
          value={u.auto ? 'auto' : String(u.delay)}
          items={[{ id: 'auto', label: 'сама' }, ...PACE.map(([ms, l]) => ({ id: String(ms), label: l }))]}
          onPick={id => send(id === 'auto' ? { auto: true } : { delay: Number(id) })}
        />
      </Line>

      <Line k="цель" hint="сколько отправок сделать и встать; пусто — до конца очереди">
        <span className="flex items-center gap-2">
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
        <div className="border-t border-white/[0.06] pt-3">
          <Label>партии</Label>
          <div className="mt-2 flex flex-wrap gap-2">
            {u.plan!.map(w => (
              <span key={w.index} className="tnum border border-white/[0.08] px-2 py-1 font-mono text-[12px]">
                {nf(w.value)}
                <span className="ml-2 text-muted-foreground">
                  {w.addAt === 0 ? 'сразу' : '+' + nf(w.addAt)}
                </span>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="border-t border-white/[0.06] pt-3 text-[12px] text-muted-foreground">
        <div className="flex justify-between"><span>сожжено этим аккаунтом</span><span className="tnum font-mono">{nf(a.burned)}</span></div>
        <div className="flex justify-between"><span>падений подряд</span><span className="tnum font-mono">{u.failures}</span></div>
        <div className="flex justify-between"><span>процесс</span><span className="tnum font-mono">{u.running ? 'pid ' + u.pid : u.exit ?? 'стоит'}</span></div>
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

function Qr({ url }: { url: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!url || !ref.current) return
    QRCode.toCanvas(ref.current, url, {
      width: 208,
      margin: 1,
      color: { dark: '#fafafa', light: '#0a0a0a' },
    }).catch(() => { })
  }, [url])

  if (!url) {
    return (
      <div className="grid h-[208px] w-[208px] shrink-0 place-items-center border border-white/[0.08] text-[12px] text-muted-foreground">
        код готовится…
      </div>
    )
  }
  return <canvas ref={ref} className="shrink-0 border border-white/[0.08]" />
}
