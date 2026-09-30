import { useState } from 'react'
import { Button, Card, Field } from './ui'

// Экран входа. Токен лежит в tools/panel.token на машине с панелью
// (или в PANEL_TOKEN); при первом запуске сервер печатает ссылку входа.
// После входа сервер ставит куку, и дальше браузер помнит её месяц.
export function Login() {
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
    } catch (e: any) {
      setError('не дошло до сервера' + (e?.message ? ': ' + e.message : ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center px-4">
      <Card className="w-full max-w-sm p-5">
        <h1 className="text-[15px] font-medium">Вход в панель</h1>
        <p className="mt-1.5 text-[12px] text-muted-foreground">
          Токен — в файле <code>tools/panel.token</code> на машине, где запущена панель.
          При первом запуске сервер печатает ссылку входа в консоль.
        </p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={e => { e.preventDefault(); if (token.trim()) void submit() }}
        >
          <Field
            value={token}
            onChange={setToken}
            placeholder="токен"
            type="password"
            autoComplete="current-password"
            autoFocus
          />
          <Button type="submit" loading={busy} disabled={busy || !token.trim()}>войти</Button>
        </form>
        {error ? <p className="mt-2 text-[12px] text-[var(--stop,#f87171)]">{error}</p> : null}
      </Card>
    </div>
  )
}
