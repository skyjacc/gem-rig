import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { RefreshCw } from 'lucide-react'
import { post, type Accounts } from '../lib/api.ts'
import { Button, Field, Label } from './ui.tsx'
import { Modal } from './Modal.tsx'

// Привязка аккаунта.
//
// Код запрашивается сразу при открытии окна, а не после ввода имени.
// Имя — дело секундное, а код Valve выдаёт с задержкой и он протухает:
// пусть он готовится, пока человек берёт телефон. Метку можно вписать
// когда угодно, хоть после входа — она применится сама.
//
// Живёт над всей панелью: кнопка в боковой колонке открывает окно там,
// где человек стоит, а не уводит его на другой экран.
//
// Пароль не вводится и не хранится: на диск ложится одна сессия.

export function LinkAccount({
  open,
  onClose,
  accounts,
}: {
  open: boolean
  onClose: () => void
  accounts: Accounts | null
}) {
  const [label, setLabel] = useState('')
  const asked = useRef(false)
  const link = accounts?.link ?? null
  const waiting = !!link && !link.done

  // Открыли — сразу просим код. Один раз за открытие, иначе поток состояния
  // будет перезапускать вход на каждом обновлении.
  useEffect(() => {
    if (!open) { asked.current = false; return }
    if (asked.current) return
    asked.current = true
    post('/api/accounts/link', { label: label.trim() || defaultLabel(accounts) })
  }, [open, accounts, label])

  // Вошёл — применяем метку, если её вписали, и закрываемся.
  useEffect(() => {
    if (!open || !link?.done || !link.steamid || link.error) return
    const name = label.trim()
    if (name && name !== link.label) post('/api/accounts/rename', { id: link.id, label: name })
    const t = setTimeout(onClose, 1200)
    return () => clearTimeout(t)
  }, [open, link?.done, link?.steamid, link?.error, link?.id, link?.label, label, onClose])

  const close = () => { post('/api/accounts/link/cancel', {}); onClose() }
  const again = () => {
    post('/api/accounts/link/cancel', {})
      .then(() => post('/api/accounts/link', { label: label.trim() || defaultLabel(accounts) }))
  }

  const done = link?.done && link.steamid && !link.error

  return (
    <Modal
      open={open}
      title="Привязать аккаунт"
      note="вход по QR из приложения Steam"
      onClose={close}
      footer={
        <>
          <Button onClick={again}>
            <RefreshCw className="h-3.5 w-3.5" />
            <span>другой код</span>
          </Button>
          <Button onClick={close}>закрыть</Button>
        </>
      }
    >
      <div className="flex flex-wrap items-start gap-5">
        <Qr url={link?.url ?? null} done={!!done} />

        <div className="min-w-0 flex-1 space-y-3">
          <ol className="space-y-1.5 text-[13px] leading-relaxed text-muted-foreground">
            <li><span className="text-foreground">1</span> — приложение Steam на телефоне</li>
            <li><span className="text-foreground">2</span> — значок QR справа сверху</li>
            <li><span className="text-foreground">3</span> — навести камеру на код</li>
            <li><span className="text-foreground">4</span> — подтвердить вход</li>
          </ol>

          <label className="block">
            <Label>метка</Label>
            <Field
              value={label}
              onChange={setLabel}
              placeholder={defaultLabel(accounts)}
              width="mt-1.5 w-full"
            />
            <span className="mt-1 block text-[11px] text-muted-foreground/60">
              можно вписать пока код ждёт — применится после входа
            </span>
          </label>

          {link?.error ? (
            <p className="text-[12px]" style={{ color: 'var(--stop)' }}>{link.error}</p>
          ) : null}
          {done ? (
            <p className="text-[12px]" style={{ color: 'var(--ok)' }}>вошёл: {link!.steamid}</p>
          ) : waiting && link?.url ? (
            <p className="text-[12px] text-muted-foreground">код живёт около минуты — если протух, возьмите другой</p>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}

const defaultLabel = (a: Accounts | null) => 'аккаунт ' + ((a?.list.length ?? 0) + 1)

function Qr({ url, done }: { url: string | null; done: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!url || !ref.current) return
    QRCode.toCanvas(ref.current, url, {
      width: 208,
      margin: 1,
      color: { dark: '#fafafa', light: '#0a0a0a' },
    }).catch(() => { })
  }, [url])

  if (done) {
    return (
      <div
        className="grid h-[208px] w-[208px] shrink-0 place-items-center border text-[13px]"
        style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}
      >
        готово
      </div>
    )
  }

  if (!url) {
    return (
      <div className="grid h-[208px] w-[208px] shrink-0 place-items-center border border-white/[0.08]">
        <span className="ui-label animate-pulse text-muted-foreground">Valve выдаёт код…</span>
      </div>
    )
  }

  return <canvas ref={ref} className="shrink-0 border border-white/[0.08]" />
}
