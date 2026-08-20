import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Link2, Play, Square, Unlink } from 'lucide-react'
import { ago, nf, post, type Accounts as AccountsData, type State } from '../lib/api.ts'
import { Button, Card, Dot, Field, Head, Label } from '../parts/ui.tsx'

// Аккаунты.
//
// Пул матчей общий, журнал расхода — у каждого свой. Поэтому второй аккаунт
// жжёт тот же пул с нуля, а «одна сессия» ограничивает аккаунт, не машину:
// два работника идут рядом и дают вдвое больше товара за то же время.
//
// Привязка — вход по QR из приложения Steam. Пароль здесь не вводится
// и не хранится: сохраняется только сессия, в отдельном файле.

export function Accounts({ state, accounts, now }: { state: State; accounts: AccountsData | null; now: number }) {
  const [label, setLabel] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const link = accounts?.link ?? null
  const units = state.autopilot.units ?? []

  return (
    <div className="space-y-6">
      <div>
        <Head title="Аккаунты" note={`${nf(accounts?.list.length ?? 0)}`} />
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {(accounts?.list ?? []).map(a => {
            const u = units.find(x => x.id === a.id)
            const on = accounts?.active === a.id
            return (
              <Card key={a.id} hover className="p-4">
                <div className="flex items-center gap-2.5">
                  <Dot tone={u?.running ? 'ok' : u?.enabled ? 'warn' : a.session ? 'idle' : 'stop'} pulse={u?.running} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{a.label}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">{a.steamid}</span>
                  </span>
                  {on ? <span className="ui-label shrink-0 border border-white/[0.08] px-2 py-1 text-muted-foreground">активный</span> : null}
                </div>

                <div className="mt-3 grid grid-cols-3 gap-3 text-[12px]">
                  <span><Label>сожжено</Label><span className="tnum mt-0.5 block font-mono text-[13px]">{nf(a.burned)}</span></span>
                  <span><Label>в очереди</Label><span className="tnum mt-0.5 block font-mono text-[13px]">{nf(u?.queueLength ?? 0)}</span></span>
                  <span><Label>сессия</Label><span className="mt-0.5 block text-[13px]">{a.session ? 'есть' : 'нет'}</span></span>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {!on ? (
                    <Button onClick={() => post('/api/accounts/active', { id: a.id })}>сделать активным</Button>
                  ) : null}
                  {u?.enabled ? (
                    <Button tone="danger" onClick={() => post('/api/autopilot', { id: a.id, on: false })}>
                      <Square className="h-3.5 w-3.5" /><span>остановить</span>
                    </Button>
                  ) : (
                    <Button disabled={!a.session} onClick={() => post('/api/autopilot', { id: a.id, on: true })}>
                      <Play className="h-3.5 w-3.5" /><span>запустить</span>
                    </Button>
                  )}
                  {(accounts?.list.length ?? 0) > 1 ? (
                    confirm === a.id ? (
                      <>
                        <Button tone="danger" onClick={async () => { await post('/api/accounts/unlink', { id: a.id }); setConfirm(null) }}>
                          удалить сессию
                        </Button>
                        <Button onClick={() => setConfirm(null)}>отмена</Button>
                      </>
                    ) : (
                      <Button onClick={() => setConfirm(a.id)}>
                        <Unlink className="h-3.5 w-3.5" /><span>отвязать</span>
                      </Button>
                    )
                  ) : null}
                </div>

                {confirm === a.id ? (
                  <p className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--warn)' }}>
                    Сессия будет удалена — вернуть аккаунт можно только новым QR. Журнал расхода
                    останется: эти матчи на нём действительно израсходованы.
                  </p>
                ) : null}

                {u?.enabled ? (
                  <p className="mt-2 text-[12px] text-muted-foreground">{u.why}</p>
                ) : null}
              </Card>
            )
          })}
        </div>
      </div>

      <div>
        <Head title="Привязать" />
        <Card className="p-4">
          {!link || link.done ? (
            <div className="flex flex-wrap items-center gap-2">
              <Field value={label} onChange={setLabel} placeholder="метка, например «второй»" width="w-64" />
              <Button active onClick={() => post('/api/accounts/link', { label })}>
                <Link2 className="h-3.5 w-3.5" /><span>показать QR</span>
              </Button>
              {link?.error ? <span className="text-[12px]" style={{ color: 'var(--stop)' }}>{link.error}</span> : null}
              {link?.done && link.steamid && !link.error ? (
                <span className="text-[12px]" style={{ color: 'var(--ok)' }}>привязан {link.steamid}</span>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-wrap items-start gap-6">
              <Qr url={link.url} />
              <div className="min-w-0 flex-1 space-y-2 text-[13px] leading-relaxed">
                <div className="text-[15px] font-medium">Приложение Steam на телефоне</div>
                <ol className="space-y-1 text-muted-foreground">
                  <li>1 — значок QR справа сверху</li>
                  <li>2 — навести камеру на код</li>
                  <li>3 — подтвердить вход</li>
                </ol>
                <p className="text-[12px] text-muted-foreground">
                  Пароль не вводится и не сохраняется. На диск ляжет только сессия,
                  в отдельном файле — это ключ от аккаунта.
                </p>
                <Button onClick={() => post('/api/accounts/link/cancel', {})}>отменить</Button>
              </div>
            </div>
          )}
        </Card>
      </div>

      <div>
        <Head title="Как это работает" />
        <Card className="p-4 text-[13px] leading-relaxed text-muted-foreground">
          Пул матчей общий на все аккаунты, журнал расхода — у каждого свой. Матч,
          израсходованный на одном, на другом остаётся свежим. Ограничение «одна сессия»
          действует на аккаунт, а не на машину, поэтому работники идут рядом.
          {' '}Сейчас в очереди у активного: {nf(state.autopilot.queueLength)} матчей,
          последний такт {state.autopilot.lastTick ? ago(state.autopilot.lastTick, now) + ' назад' : '—'}.
        </Card>
      </div>
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
      <div className="grid h-[208px] w-[208px] place-items-center border border-white/[0.08] text-[12px] text-muted-foreground">
        код готовится…
      </div>
    )
  }
  return <canvas ref={ref} className="border border-white/[0.08]" />
}
