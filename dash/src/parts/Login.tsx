import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Eye, EyeOff } from 'lucide-react'

// Вход в панель. Одна задача — ввести токен.
//
// Самоцвет над названием — не украшение, а индикатор: пока токен
// проверяется, прорисовываются грани; принят — камень загорается;
// не принят — вздрагивает. Остальное экрана намеренно тихое.

type Phase = 'idle' | 'busy' | 'ok' | 'bad'

export function Login() {
  const [token, setToken] = useState('')
  const [show, setShow] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
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
        setTimeout(() => location.reload(), 650)
        return
      }
      setPhase('bad')
      setError(r.status === 401 ? 'Токен не подходит' : (d?.error ?? 'Панель ответила ' + r.status))
    } catch {
      setPhase('bad')
      setError('Нет связи с панелью')
    }
    input.current?.select()
  }

  return (
    <main className="login">
      <form
        className="login-box"
        onSubmit={e => { e.preventDefault(); void submit() }}
        aria-describedby={error ? 'login-error' : 'login-hint'}
      >
        <Gem phase={phase} />
        <h1 className="login-title">Gemtrack</h1>

        <div className={'login-field' + (phase === 'bad' ? ' is-bad' : '')}>
          <input
            ref={input}
            type={show ? 'text' : 'password'}
            value={token}
            onChange={e => { setToken(e.target.value); if (phase === 'bad') { setPhase('idle'); setError(null) } }}
            placeholder="Токен доступа"
            autoComplete="current-password"
            spellCheck={false}
            aria-label="Токен доступа"
            aria-invalid={phase === 'bad'}
            disabled={phase === 'ok'}
          />
          <button
            type="button"
            className="login-icon"
            onClick={() => setShow(s => !s)}
            aria-label={show ? 'Скрыть токен' : 'Показать токен'}
            tabIndex={-1}
          >
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
          <button
            type="submit"
            className="login-go"
            disabled={!token.trim() || phase === 'busy' || phase === 'ok'}
            aria-label="Войти"
          >
            <ArrowRight size={16} />
          </button>
        </div>

        <p id={error ? 'login-error' : 'login-hint'} className={'login-note' + (error ? ' is-bad' : '')} role={error ? 'alert' : undefined}>
          {error ?? 'tools/panel.token на домашнем ПК'}
        </p>
      </form>
    </main>
  )
}

// Гранёный камень: корона и павильон, как у настоящей огранки.
function Gem({ phase }: { phase: Phase }) {
  return (
    <svg className={'login-gem is-' + phase} viewBox="0 0 64 56" aria-hidden="true">
      <g fill="none" strokeLinejoin="round" strokeLinecap="round">
        <path className="gem-outline" d="M14 4 H50 L62 20 L32 53 L2 20 Z" />
        <path className="gem-facet" d="M2 20 H62 M14 4 L22 20 L32 4 L42 20 L50 4 M22 20 L32 53 L42 20" />
      </g>
    </svg>
  )
}
