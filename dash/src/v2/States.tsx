// Служебные состояния (§5.7): запуск панели, сервер не отвечает, первый
// запуск без аккаунтов и «источник не ответил». Тексты — из макета
// 7-okna-i-sostoyaniya.html.

import { useEffect, useState, type ReactNode } from 'react'
import { Gem, WifiOff } from 'lucide-react'
import { Btn, Skeleton } from './ui.tsx'

// Запуск: снимка ещё нет, связь есть.
export function Booting() {
  return (
    <div className="v2-center" role="status">
      <span className="v2-gemlogo is-breathe" aria-hidden="true"><Gem size={22} strokeWidth={1.6} /></span>
      <h2>Gemtrack</h2>
      <p>соединяюсь с сервером…</p>
    </div>
  )
}

// Сервер не отвечает. Панель — только окно в сервер; сама она ничего
// не умеет. Поток переподключается сам (EventSource), кнопка — на случай,
// если человек не хочет ждать.
export function NoServer({ since }: { since: string }) {
  return (
    <div className="v2-center" role="alert">
      <span className="v2-ring is-stop" aria-hidden="true"><WifiOff size={20} strokeWidth={2} /></span>
      <h2>Сервер не отвечает</h2>
      <p>Панель — только окно в сервер. Запустите его на домашнем ПК:</p>
      <code className="v2-cmd">cd rig &amp;&amp; npm run server</code>
      <Btn tone="soft" onClick={() => location.reload()}>Проверить ещё раз</Btn>
      <p className="v2-hint">переподключаюсь сама · без связи {since}</p>
    </div>
  )
}

// Первый запуск: аккаунтов нет — показывать нечего.
export function FirstRun({ onLink }: { onLink: () => void }) {
  return (
    <div className="v2-center">
      <span className="v2-gemlogo" aria-hidden="true"><Gem size={22} strokeWidth={1.6} /></span>
      <h2>Привяжите первый аккаунт Steam</h2>
      <p>Панель смотрит инвентарь и отправляет матчи от имени аккаунта. Без него показывать нечего.</p>
      <ol className="v2-steps">
        <li>Вход по QR из мобильного Steam — без пароля</li>
        <li>Панель прочитает инвентарь и найдёт гемы</li>
        <li>Соберёт очередь матчей — дальше «Накрутить»</li>
      </ol>
      <Btn tone="go" onClick={onLink}>Привязать аккаунт</Btn>
    </div>
  )
}

// Данные из отдельного запроса. Скелетон — не дольше 8 секунд (§5.7);
// дальше — что не пришло и почему, с «Ещё раз». Ноль и «нет данных» —
// разные вещи: пока данных нет, детям не показываем ничего.
const PATIENCE = 8_000

export function Loadable({ what, loading, error, ready, onRetry, children, lines = 3 }: {
  what: string            // что грузим — «цены площадки», «очередь»
  loading: boolean
  error: string | null
  ready: boolean          // данные есть
  onRetry: () => void
  children: ReactNode
  lines?: number
}) {
  const [late, setLate] = useState(false)

  useEffect(() => {
    if (!loading || ready) { setLate(false); return }
    const t = setTimeout(() => setLate(true), PATIENCE)
    return () => clearTimeout(t)
  }, [loading, ready])

  if (ready) return <>{children}</>

  // Не грузится и не пришло — это «нет данных», а не вечный скелетон.
  if (!loading && !error) {
    return (
      <div className="v2-unavail" role="status">
        <span className="v2-num">—</span>
        <span>{what}: данных нет</span>
        <Btn tone="soft" onClick={onRetry}>Ещё раз</Btn>
      </div>
    )
  }

  if (error || late) {
    return (
      <div className="v2-unavail" role="status">
        <span className="v2-num">—</span>
        <span>
          {what}: {error ? 'источник ответил ошибкой — ' + error : 'источник не ответил за 8 секунд'}
        </span>
        <Btn tone="soft" onClick={() => { setLate(false); onRetry() }}>Ещё раз</Btn>
      </div>
    )
  }

  return (
    <div className="v2-loading" aria-busy="true" aria-label={'загружаю ' + what}>
      <span className="v2-hint">загружаю {what}…</span>
      {Array.from({ length: lines }, (_, i) => <Skeleton key={i} h={12} w={i === lines - 1 ? '60%' : '100%'} />)}
    </div>
  )
}
