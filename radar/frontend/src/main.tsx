import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// Вход. Без куки сервер отвечает 401 на каждый /api/*. Токен лежит
// в radar-data/panel.token (или RADAR_TOKEN); при первом запуске сервер
// печатает ссылку входа в лог.
function Login() {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      })
      const d = await r.json().catch(() => ({}))
      if (r.ok && d?.ok) return location.reload()
      setError(d?.error ?? 'сервер ответил ' + r.status)
    } catch (e) {
      setError('не дошло до сервера' + (e instanceof Error ? ': ' + e.message : ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center px-4">
      <form
        className="w-full max-w-sm rounded-lg border border-white/10 p-5"
        onSubmit={e => { e.preventDefault(); if (token.trim()) void submit() }}
      >
        <h1 className="text-[15px] font-medium">Вход в радар</h1>
        <p className="mt-1.5 text-[12px] opacity-70">
          Токен — в файле <code>radar-data/panel.token</code> на машине, где запущен радар.
        </p>
        <div className="mt-4 flex gap-2">
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="токен"
            className="h-10 w-full rounded border border-white/15 bg-transparent px-2.5"
          />
          <button
            type="submit"
            disabled={busy || !token.trim()}
            className="h-10 shrink-0 rounded border border-white/15 px-3 disabled:opacity-40"
          >
            войти
          </button>
        </div>
        {error ? <p className="mt-2 text-[12px] text-red-400">{error}</p> : null}
      </form>
    </div>
  )
}

const root = document.getElementById('root')
if (root) {
  const r = createRoot(root)
  const render = (authed: boolean) =>
    r.render(
      <StrictMode>
        {authed ? <App /> : <Login />}
      </StrictMode>,
    )
  fetch('/api/auth')
    .then(res => (res.ok ? res.json() : { authed: false }))
    .then(d => render(!!d?.authed))
    // Сервер недоступен — пусть приложение само покажет, что связи нет.
    .catch(() => render(true))
}
