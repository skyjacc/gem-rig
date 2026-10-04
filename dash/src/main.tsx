import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import AppV2 from './v2/AppV2.tsx'
import { Login } from './parts/Login.tsx'
import { DEMO } from './lib/api.ts'

const root = createRoot(document.getElementById('root')!)

// Новая панель — по /?ui=v2, пока идёт переезд. Вход общий.
const V2 = new URLSearchParams(location.search).get('ui') === 'v2'

// Сначала спрашиваем, вошли ли мы. Без куки входа сервер отвечает 401 на
// каждый /api/*, и панель показала бы вместо данных стену ошибок.
// Показ работает без сервера — ему вход не нужен.
async function boot() {
  let authed = DEMO
  if (!DEMO) {
    try {
      const r = await fetch('/api/auth')
      authed = r.ok && !!(await r.json())?.authed
    } catch {
      authed = true // сервер недоступен — пусть панель сама покажет, что связи нет
    }
  }
  root.render(
    <StrictMode>
      {authed ? (V2 ? <AppV2 /> : <App />) : <Login />}
    </StrictMode>,
  )
}

void boot()
