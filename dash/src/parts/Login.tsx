import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import './login.css'
import { Check, Eye, EyeOff, Gem, LoaderCircle, Lock } from 'lucide-react'

// Вход. Фон — шейдерная сцена Portal Field из ThreeUI (MIT); выбран из шести
// вариантов. Поверх — компактная тёмная карточка: знак, название, одно поле,
// одна кнопка. Панель своя, для себя — поэтому никаких пояснений и подписей.
//
// Фон и интерфейс связаны: поле в фокусе — портал ярче; «Войти» — портал
// пульсирует; вход принят — портал затягивает экран, и открывается панель.
//
// Иконки — только Lucide: один набор, один вес линии.
// На вход Steam страница не похожа — иначе выглядела бы как фишинг.

type Phase = 'idle' | 'busy' | 'ok' | 'bad'

// Сцена портала — отдельным куском: основная панель за неё не платит.
const PortalScene = lazy(() => import('./PortalScene.tsx').then(m => ({ default: m.PortalScene })))

// steam — сервер умеет вход через Steam (задан внешний адрес панели).
export function Login({ steam = false, invite = null }: { steam?: boolean; invite?: string | null }) {
  return invite ? <InviteLogin token={invite} /> : <TokenLogin steam={steam} />
}

function TokenLogin({ steam }: { steam: boolean }) {
  const [token, setToken] = useState('')
  const [show, setShow] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [focus, setFocus] = useState(false)
  const [pulse, setPulse] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { input.current?.focus() }, [])

  const submit = async () => {
    const t = token.trim()
    if (!t || phase === 'busy' || phase === 'ok') return
    setPhase('busy')
    setError(null)
    setPulse(p => p + 1)
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: t }),
      })
      const d = await r.json().catch(() => ({}))
      if (r.ok && d?.ok) {
        setPhase('ok')
        // Портал успевает затянуть экран, потом открывается панель.
        setTimeout(() => location.reload(), 900)
        return
      }
      setPhase('bad')
      setError(r.status === 401 ? 'Токен не подходит' : (d?.error ?? 'Панель ответила ' + r.status))
    } catch {
      setPhase('bad')
      setError('Нет связи с панелью')
    }
    requestAnimationFrame(() => input.current?.select())
  }

  // Вход через Steam (план 7.1): сервер заводит попытку, ставит куку этого
  // браузера и отдаёт адрес страницы Steam.
  const viaSteam = async () => {
    setError(null)
    try {
      const r = await fetch('/api/auth/steam/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'вход' }),
      })
      const d = await r.json().catch(() => ({}))
      if (d?.url) { location.href = d.url; return }
      setPhase('bad')
      setError(d?.error ?? 'Панель ответила ' + r.status)
    } catch {
      setPhase('bad')
      setError('Нет связи с панелью')
    }
  }

  const filled = token.length > 0

  return (
    <main className={'lg is-' + phase + (focus ? ' is-focus' : '')}>
      <div className="lg-scene" aria-hidden="true">
        <div className={'lg-scene-in' + (pulse ? ' pulse-' + (pulse % 2) : '')}>
          <Suspense fallback={null}>
            <PortalScene className="lg-bg" />
          </Suspense>
        </div>
      </div>

      <form
        className="lg-card"
        onSubmit={e => { e.preventDefault(); void submit() }}
        aria-describedby={error ? 'lg-error' : undefined}
      >
        <Gem className="lg-mark" size={18} strokeWidth={1.5} aria-hidden="true" />
        <h1 className="lg-title">Gemtrack</h1>

        <label className={'lg-field' + (filled ? ' filled' : '')}>
          <Lock className="lg-lock" size={15} strokeWidth={1.75} aria-hidden="true" />
          <span className="lg-float">Токен доступа</span>
          <input
            ref={input}
            type={show ? 'text' : 'password'}
            value={token}
            onChange={e => { setToken(e.target.value); if (phase === 'bad') { setPhase('idle'); setError(null) } }}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            autoComplete="current-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={phase === 'bad'}
            disabled={phase === 'ok'}
          />
          <button
            type="button"
            className="lg-eye"
            onClick={() => setShow(s => !s)}
            aria-label={show ? 'Скрыть токен' : 'Показать токен'}
          >
            {show ? <EyeOff size={16} strokeWidth={1.75} /> : <Eye size={16} strokeWidth={1.75} />}
          </button>
        </label>

        <p id="lg-error" className="lg-error" role="alert">{error ?? ''}</p>

        <button type="submit" className="lg-go" disabled={!token.trim() || phase === 'busy' || phase === 'ok'}>
          <span className="lg-go-label">
            {phase === 'busy' ? <LoaderCircle className="lg-spin" size={17} strokeWidth={2} aria-label="Проверка" />
              : phase === 'ok' ? <Check size={18} strokeWidth={2.25} aria-label="Вход принят" />
                : 'Войти'}
          </span>
        </button>
        {steam ? (
          <button type="button" className="lg-steam" onClick={() => void viaSteam()} disabled={phase === 'busy' || phase === 'ok'}>
            Войти через Steam
          </button>
        ) : null}
      </form>
    </main>
  )
}

// ── вход по приглашению (план 7.3, макет 8 «по приглашению») ──
//
// Ссылка проверяется сервером (действует ли, открыт ли вход для
// приглашённых); вход — через Steam, с подтверждением «это вы?» на странице
// возврата. Токен из адреса уходит только в эти два запроса.

type InviteInfo = { name: string; expiresAt: number; open: boolean; steamLogin: boolean }

function InviteLogin({ token }: { token: string }) {
  const [info, setInfo] = useState<InviteInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void fetch('/api/invite?token=' + encodeURIComponent(token))
      .then(async r => { const d = await r.json().catch(() => ({})); if (r.ok) setInfo(d); else setError(d?.error ?? 'панель ответила ' + r.status) })
      .catch(() => setError('нет связи с панелью'))
  }, [token])

  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/auth/steam/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'приглашение', invite: token }),
      })
      const d = await r.json().catch(() => ({}))
      if (d?.url) { location.href = d.url; return }
      setError(d?.error ?? 'панель ответила ' + r.status)
    } catch {
      setError('нет связи с панелью')
    }
    setBusy(false)
  }

  const until = info ? new Date(info.expiresAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : ''
  return (
    <main className="lg is-idle">
      <div className="lg-card lg-invite">
        <Gem className="lg-mark" size={18} strokeWidth={1.5} aria-hidden="true" />
        <h1 className="lg-title">{info ? 'Вас пригласили' : 'Gemtrack'}</h1>
        {info ? (
          <>
            <p className="lg-text">Владелец приглашает вас как <b>«{info.name}»</b>. Ссылка одноразовая, действует до {until}.</p>
            <p className="lg-text">Войдите своим Steam — этот профиль и станет вашим входом. Рабочие аккаунты добавите внутри.</p>
            <p className="lg-warn" role="note"><b>Прочитайте до входа.</b> Накрутка — автоматизация, которую соглашение Steam запрещает. Valve может закрыть рабочий аккаунт без предупреждения, с вещами и кошельком на нём. Рискуют ваши рабочие аккаунты. Панель работает на компьютере владельца: ваши сессии Steam и ключ площадки будут храниться у него.</p>
            {!info.open ? <p className="lg-error" role="status">Вход для приглашённых владелец ещё не открыл — ссылка подождёт до {until}.</p> : null}
            {!info.steamLogin ? <p className="lg-error" role="status">Вход через Steam на этой панели выключен — напишите владельцу.</p> : null}
            <button type="button" className="lg-go" disabled={busy || !info.open || !info.steamLogin} onClick={() => void go()}>
              <span className="lg-go-label">{busy ? <LoaderCircle className="lg-spin" size={17} strokeWidth={2} aria-label="Открываем Steam" /> : 'Войти через Steam'}</span>
            </button>
            <p className="lg-fine">Вход через официальную страницу Steam. Пароль панель не видит и не хранит — Steam сообщает только номер профиля.</p>
          </>
        ) : null}
        <p className="lg-error" role="alert">{error ?? ''}</p>
      </div>
    </main>
  )
}
