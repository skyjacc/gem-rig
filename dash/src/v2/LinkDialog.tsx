// Привязка аккаунта по QR (план 9, решение 2) — то же поведение, что у
// прежнего окна LinkAccount, в виде v2.
//
// Код запрашивается сразу при открытии: Valve выдаёт его с задержкой, пусть
// готовится, пока человек берёт телефон. Метку можно вписать когда угодно —
// применится после входа. Пароль не вводится: на диск ложится одна сессия.
//
// relink — обновить вход игры существующего аккаунта: тот же QR, сервер
// примет токен, только если вошли тем же Steam.

import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { post, type Accounts } from '../lib/api.ts'
import { Btn } from './ui.tsx'
import { Qr } from './Qr.tsx'
import { useTrap } from './useTrap.ts'
import { linkFlow } from './linkFlow.ts'

const defaultLabel = (a: Accounts | null) => 'аккаунт ' + ((a?.list.length ?? 0) + 1)

export function LinkDialog({ accounts, relink, onClose }: {
  accounts: Accounts | null
  relink: { id: string; label: string } | null
  onClose: () => void
}) {
  const [label, setLabel] = useState('')
  const [failed, setFailed] = useState<string | null>(null)
  const asked = useRef(false)
  const box = useRef<HTMLDivElement>(null)
  // Запуск и отмена — по очереди: отмена не обгонит запуск (linkFlow.ts).
  const [flow] = useState(() => linkFlow(post))
  const link = accounts?.link ?? null
  const waiting = !!link && !link.done
  const done = !!link?.done && !!link.steamid && !link.error

  const start = async () => {
    const r: any = await flow.start(relink ? { relink: relink.id } : { label: label.trim() || defaultLabel(accounts) })
    setFailed(r?.error ? String(r.error) : null)
  }

  // Открыли — сразу просим код. Один раз за открытие: поток состояния иначе
  // перезапускал бы вход на каждом обновлении.
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    void start()
  }, [])

  // Вошёл — применяем метку, если её вписали, и закрываемся.
  useEffect(() => {
    if (!done || !link) return
    const name = label.trim()
    if (!relink && name && name !== link.label) void post('/api/accounts/rename', { id: link.id, label: name })
    const t = setTimeout(onClose, 1200)
    return () => clearTimeout(t)
  }, [done, link?.id, link?.label, label, relink, onClose])

  const close = () => { void flow.cancel(); onClose() }
  const again = async () => { await flow.cancel(); await start() }
  useTrap(box, close)

  return (
    <div className="v2-veil">
      <div ref={box} className="v2-dialog v2-acc-dlg" role="dialog" aria-modal="true" aria-labelledby="v2-link-title">
        <header className="v2-dialog-head">
          <h2 id="v2-link-title">{relink ? 'Обновить вход игры «' + relink.label + '»' : 'Привязать аккаунт'}</h2>
          <span className="v2-aside">вход по QR из приложения Steam</span>
        </header>
        <p className="v2-text">Пароль сюда не вводится: вход подтверждается в телефоне, панель хранит только файл сессии.</p>
        <div className="v2-acc-qrbox">
          <Qr url={link?.url ?? null} ok={done} failed={!!failed || !!link?.error} />
          <ol className="v2-buy-rules">
            <li><i>1</i>Приложение Steam на телефоне</li>
            <li><i>2</i>Значок QR справа сверху</li>
            <li><i>3</i>Навести камеру на код</li>
            <li><i className={done ? 'is-ok' : undefined}>4</i>Подтвердить вход</li>
          </ol>
        </div>
        {relink ? (
          <p className="v2-hint">Войдите тем же Steam, что и раньше. Другой аккаунт сессию не заменит.</p>
        ) : (
          <label className="v2-buy-field v2-acc-keyf">
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder={defaultLabel(accounts)} aria-label="Метка аккаунта" />
          </label>
        )}
        <p className="v2-hint" role="status">
          {failed ? <span className="is-stop">Не вышло: {failed}</span>
            : link?.error ? <span className="is-stop">{link.error}</span>
            : done ? 'Вошёл: ' + link!.steamid
            : waiting && link?.url ? 'Код живёт полминуты — если протух, возьмите другой.' + (relink ? '' : ' Метку можно вписать, пока код ждёт.')
            : 'Valve выдаёт код…'}
        </p>
        <footer className="v2-dialog-foot">
          <Btn tone="soft" onClick={again}><RefreshCw size={13} aria-hidden="true" />другой код</Btn>
          <Btn tone={done ? 'go' : 'soft'} onClick={close}>{done ? 'готово' : 'закрыть'}</Btn>
        </footer>
      </div>
    </div>
  )
}
