import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './v2/base.css'
import AppV2 from './v2/AppV2.tsx'
import { Login } from './parts/Login.tsx'
import { DEMO } from './lib/api.ts'

const root = createRoot(document.getElementById('root')!)

// Панель одна — новая (план 9). Старые закладки с ?ui=v2 открываются как
// обычно: параметр больше ничего не переключает.

// Сначала спрашиваем, вошли ли мы. Без куки входа сервер отвечает 401 на
// каждый /api/*, и панель показала бы вместо данных стену ошибок.
// Показ работает без сервера — ему вход не нужен.
async function boot() {
  let authed = DEMO
  let steam = false
  if (!DEMO) {
    try {
      const r = await fetch('/api/auth')
      const d = r.ok ? await r.json() : null
      authed = !!d?.authed
      steam = !!d?.steamLogin
    } catch {
      authed = true // сервер недоступен — пусть панель сама покажет, что связи нет
    }
  }
  root.render(
    <StrictMode>
      {authed ? <AppV2 /> : <Login steam={steam} />}
    </StrictMode>,
  )
}

void boot()
