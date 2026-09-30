import { lazy, Suspense, useEffect, useRef, useState, type ComponentType } from 'react'
import { Eye, EyeOff } from 'lucide-react'

// Вход. Сцена — шейдерный фон Portal Field из ThreeUI (MIT), поверх — одна
// тёмная панель: название, поле токена, кнопка Liquid Metal. Выбран из шести
// вариантов (Ember Storm, Flow Field, Portal Field, Nebula, Amber Halftone,
// Cloud Field).
//
// ThreeUI грузится отдельно: основная панель за него не платит.
// На вход Steam страница не похожа — иначе выглядела бы как фишинг.

type Phase = 'idle' | 'busy' | 'ok' | 'bad'

// Каждый компонент — своим подпутём: иначе подтягивается вся библиотека
// (7 МБ), а панель открывают и издалека через Tailscale. Стили ThreeUI —
// только вместе с его компонентами, чтобы не задеть оформление панели.
const css = () => import('@designcodeio/threeui/style.css')
const load = (imp: () => Promise<any>, name: string) =>
  lazy(async () => {
    const [m] = await Promise.all([imp(), css()])
    return { default: m[name] as ComponentType<any> }
  })

const PortalFieldCollection = load(() => import('@designcodeio/threeui/components/PortalFieldCollection'), 'PortalFieldCollection')
const LiquidMetalButton = load(() => import('@designcodeio/threeui/components/LiquidMetalButton'), 'LiquidMetalButton')
export function Login() {
  const [token, setToken] = useState('')
  const [show, setShow] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { input.current?.focus() }, [])

  const submit = async () => {
    const t = token.trim()
    if (!t || phase === 'busy' || phase === 'ok') return
    setPhase('busy')
    setError(null)
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: t }),
      })
      const d = await r.json().catch(() => ({}))
      if (r.ok && d?.ok) {
        setPhase('ok')
        setTimeout(() => location.reload(), 400)
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

  return (
    <main className={'lg is-' + phase}>
      <div className="lg-scene" aria-hidden="true">
        <Suspense fallback={null}>
          <div className="lg-bg-wrap">
            <PortalFieldCollection variant="portal-field" mode="dark" className="lg-bg" />
          </div>
        </Suspense>
      </div>

      <form
        ref={form}
        className="lg-panel"
        onSubmit={e => { e.preventDefault(); void submit() }}
        aria-describedby={error ? 'lg-error' : undefined}
      >
        <h1 className="lg-title">Gemtrack</h1>

        <div className="lg-field">
          <input
            ref={input}
            type={show ? 'text' : 'password'}
            value={token}
            onChange={e => { setToken(e.target.value); if (phase === 'bad') { setPhase('idle'); setError(null) } }}
            placeholder="Токен доступа"
            aria-label="Токен доступа"
            autoComplete="current-password"
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
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>

        <div className="lg-go">
          <Suspense fallback={<button type="submit" className="lg-go-plain">Войти</button>}>
            <LiquidMetalButton
              variant="pill"
              rendering="monotone"
              embedded
              text={phase === 'busy' ? 'Проверка' : phase === 'ok' ? 'Входим' : 'Войти'}
              onClick={() => form.current?.requestSubmit()}
            />
          </Suspense>
        </div>

        <p id="lg-error" className="lg-error" role="alert">{error ?? ''}</p>
      </form>
    </main>
  )
}
