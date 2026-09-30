import { lazy, Suspense, useEffect, useRef, useState } from 'react'
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

export function Login() {
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
      </form>
    </main>
  )
}
