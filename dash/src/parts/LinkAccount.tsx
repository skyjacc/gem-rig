import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { post, type Accounts } from '../lib/api.ts'
import { Button, Field, Label } from './ui.tsx'
import { Modal } from './Modal.tsx'

// Привязка аккаунта.
//
// Живёт не внутри экрана «Аккаунты», а над всей панелью: кнопка в боковой
// колонке должна открывать окно там, где человек стоит, а не уводить его
// на другой экран и заставлять искать вторую кнопку.
//
// Вход по QR из приложения Steam. Пароль не вводится и не хранится:
// на диск ложится одна сессия, отдельным файлом на каждый аккаунт.

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
  const link = accounts?.link ?? null
  const waiting = !!link && !link.done

  // Удалось — окно закрывается само, чтобы не требовать лишнего нажатия.
  useEffect(() => {
    if (open && link?.done && link.steamid && !link.error) {
      const t = setTimeout(onClose, 1400)
      return () => clearTimeout(t)
    }
  }, [open, link?.done, link?.steamid, link?.error, onClose])

  const close = () => { post('/api/accounts/link/cancel', {}); onClose() }

  return (
    <Modal
      open={open}
      title="Привязать аккаунт"
      note="вход по QR из приложения Steam"
      onClose={close}
      footer={
        waiting ? (
          <Button onClick={close}>отменить</Button>
        ) : (
          <>
            <Button onClick={onClose}>закрыть</Button>
            <Button active onClick={() => post('/api/accounts/link', { label })}>показать QR</Button>
          </>
        )
      }
    >
      {waiting ? (
        <div className="flex flex-wrap items-start gap-5">
          <Qr url={link!.url} />
          <ol className="min-w-0 flex-1 space-y-1.5 text-[13px] leading-relaxed text-muted-foreground">
            <li><span className="text-foreground">1</span> — приложение Steam на телефоне</li>
            <li><span className="text-foreground">2</span> — значок QR справа сверху</li>
            <li><span className="text-foreground">3</span> — навести камеру на код</li>
            <li><span className="text-foreground">4</span> — подтвердить вход</li>
            {link!.steamid ? <li style={{ color: 'var(--ok)' }}>вошёл: {link!.steamid}</li> : null}
          </ol>
        </div>
      ) : (
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
      )}
    </Modal>
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
