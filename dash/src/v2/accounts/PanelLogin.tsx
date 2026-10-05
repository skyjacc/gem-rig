// Вход в панель (план 7.1): как вы вошли, Steam владельца, выход везде.
//
// Пользователь панели — человек, рабочий аккаунт — Steam, который крутит
// гемы (§12.2). Здесь — первое: чем вы входите в саму панель. Привязать
// свой Steam владелец может, только войдя токеном или Steam владельца —
// завершит привязку та же сессия в том же браузере (решение 2а).

import { DEMO, post, useAction, useJson } from '../../lib/api.ts'
import { Btn, Chip, Panel } from '../ui.tsx'

type Auth = {
  authed: boolean
  user: { name: string; role: string; via: 'steam' | 'токен'; steamBound: boolean } | null
  steamLogin: boolean
}

export function PanelLogin() {
  const auth = useJson<Auth>(DEMO ? null : '/api/auth', 0)
  const bind = useAction()
  const out = useAction()
  if (DEMO) {
    return (
      <Panel title="Вход в панель">
        <p className="v2-hint">В показе вход не нужен. В панели здесь — как вы вошли, привязка своего Steam и «выйти на всех устройствах».</p>
      </Panel>
    )
  }
  const u = auth.data?.user
  if (!u) return null

  const startBind = async () => {
    const r: any = await bind.run('/api/auth/steam/start', { purpose: 'привязка владельца' })
    if (r?.url) location.href = r.url
  }
  const logoutAll = async () => {
    const r: any = await out.run('/api/auth/logout-all', {})
    if (!r?.error) location.reload()
  }

  return (
    <Panel title="Вход в панель" aside={<Chip dot tone={u.via === 'steam' ? 'ok' : 'warn'}>{u.via === 'steam' ? 'через Steam' : 'по токену · 12 ч'}</Chip>}>
      {u.role === 'владелец' ? (
        u.steamBound ? (
          <p className="v2-text">Steam владельца привязан — входите кнопкой «Войти через Steam». Вход по токену остаётся запасным: сессия на 12 часов.</p>
        ) : (
          <>
            <p className="v2-text">Свой Steam для входа ещё не привязан. Привязка откроет страницу Steam и вернёт сюда; завершит её только этот браузер.</p>
            {auth.data?.steamLogin
              ? <Btn tone="soft" loading={bind.busy} onClick={startBind}>привязать свой Steam</Btn>
              : <p className="v2-hint">Вход через Steam выключен: на сервере не задан внешний адрес панели (PANEL_URL).</p>}
            {bind.error ? <p className="v2-note is-stop" role="alert">Не вышло: {bind.error}</p> : null}
          </>
        )
      ) : null}
      <p className="v2-hint">Вход в панель открыт только владельцу — пока не готово разделение данных между пользователями.</p>
      <div className="v2-login-acts">
        <Btn tone="soft" loading={out.busy} onClick={logoutAll}>выйти на всех устройствах</Btn>
        <Btn tone="soft" onClick={() => { void post('/api/logout', {}).then(() => location.reload()) }}>выйти</Btn>
      </div>
      {out.error ? <p className="v2-note is-stop" role="alert">Не вышло: {out.error}</p> : null}
    </Panel>
  )
}
