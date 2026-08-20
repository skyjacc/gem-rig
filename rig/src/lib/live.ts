import { useEffect, useRef, useState } from 'react'
import type { State } from './types.ts'

// Одно соединение на страницу. Сервер толкает состояние сам, опроса нет.
export function useLive() {
  const [state, setState] = useState<State | null>(null)
  const [online, setOnline] = useState(false)
  const es = useRef<EventSource | null>(null)

  useEffect(() => {
    const src = new EventSource('/api/stream')
    es.current = src
    src.onopen = () => setOnline(true)
    src.onerror = () => setOnline(false)
    src.onmessage = e => {
      try { setState(JSON.parse(e.data)) } catch { /* следующий кадр */ }
    }
    return () => src.close()
  }, [])

  return { state, online }
}

export async function post(url: string, body: unknown) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json()
}
