// Окна экрана «Пользователи» (план 7.3): подтверждение действия, приглашение,
// пределы, допуск для приёмки. Все — на useTrap: фокус внутрь, Tab не
// уходит, Esc закрывает, фокус возвращается на кнопку открытия.

import { useRef, useState, type ReactNode } from 'react'
import { useAction } from '../../lib/api.ts'
import { Btn } from '../ui.tsx'
import { useTrap } from '../useTrap.ts'
import type { Limits, UserRow } from './data.ts'

function Shell({ title, aside, children, foot, onClose }: { title: string; aside?: string; children: ReactNode; foot: ReactNode; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useTrap(box, onClose)
  return (
    <div className="v2-veil" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={box} className="v2-dialog v2-us-dlg" role="dialog" aria-modal="true" aria-labelledby="v2-us-title">
        <header className="v2-dialog-head">
          <h2 id="v2-us-title">{title}</h2>
          {aside ? <span className="v2-aside">{aside}</span> : null}
        </header>
        {children}
        <footer className="v2-dialog-foot">{foot}</footer>
      </div>
    </div>
  )
}

// Подтверждение действия: что произойдёт — словами, кнопка — глаголом.
export function ConfirmDialog({ title, text, verb, tone = 'go', url, body, onClose, onDone }: {
  title: string; text: ReactNode; verb: string; tone?: 'go' | 'stop'; url: string; body: unknown; onClose: () => void; onDone: () => void
}) {
  const act = useAction()
  const go = async () => {
    const r: any = await act.run(url, body)
    if (r?.error) return
    onDone()
    onClose()
  }
  return (
    <Shell title={title} onClose={onClose} foot={<>
      <Btn tone="soft" onClick={onClose} disabled={act.busy}>отмена</Btn>
      <Btn tone={tone} loading={act.busy} onClick={go}>{verb}</Btn>
    </>}>
      <div className="v2-text">{text}</div>
      {act.error ? <p className="v2-note is-stop" role="alert">Не вышло: {act.error}</p> : null}
    </Shell>
  )
}

const DAYS: [number, string][] = [[1, '1 день'], [7, '7 дней'], [30, '30 дней']]

function LimitFields({ v, set, disabled }: { v: Limits; set: (l: Limits) => void; disabled?: boolean }) {
  const num = (x: string) => Math.max(0, Math.min(50, Math.trunc(Number(x.replace(/\D/g, '')) || 0)))
  return (
    <fieldset className="v2-us-lim" disabled={disabled}>
      <label className="v2-po-f"><span>рабочих аккаунтов</span><input value={String(v.accounts)} inputMode="numeric" onChange={e => set({ ...v, accounts: num(e.target.value) })} aria-label="Предел рабочих аккаунтов" /></label>
      <label className="v2-po-f"><span>работников разом</span><input value={String(v.senders)} inputMode="numeric" onChange={e => set({ ...v, senders: num(e.target.value) })} aria-label="Предел работников разом" /></label>
    </fieldset>
  )
}

// Приглашение: ссылка одноразовая и показывается один раз — в базе только
// её хэш, повторно её не достать.
export function InviteDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const act = useAction()
  const [name, setName] = useState('')
  const [days, setDays] = useState(7)
  const [lim, setLim] = useState<Limits>({ accounts: 3, senders: 1 })
  const [made, setMade] = useState<{ link: string; panelUrl: boolean } | null>(null)
  const [copied, setCopied] = useState(false)
  const make = async () => {
    const r: any = await act.run('/api/users/invite', { name: name.trim(), days, limits: lim })
    if (r?.error) return
    setMade({ link: r.link, panelUrl: !!r.panelUrl })
    onDone()
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(made!.link); setCopied(true) } catch { setCopied(false) }
  }
  return (
    <Shell title="Пригласить пользователя" onClose={onClose} foot={made
      ? <Btn tone="go" onClick={onClose}>готово</Btn>
      : <>
        <Btn tone="soft" onClick={onClose} disabled={act.busy}>отмена</Btn>
        <Btn tone="go" loading={act.busy} disabled={!name.trim()} onClick={make}>создать ссылку</Btn>
      </>}>
      <p className="v2-text">Ссылка одноразовая: первый, кто войдёт по ней через Steam, станет этим пользователем. Дальше он входит своим Steam без ссылки.</p>
      {made ? (
        <>
          <p className="v2-note" role="status">Ссылка создана. Скопируйте её сейчас — повторно её не показать: панель хранит только отпечаток.</p>
          <div className="v2-us-link"><code>{made.link}</code><Btn tone="soft" onClick={copy}>{copied ? 'скопировано' : 'копировать'}</Btn></div>
          {made.panelUrl ? null : <p className="v2-hint">Внешний адрес панели не задан (PANEL_URL) — допишите его перед ссылкой.</p>}
        </>
      ) : (
        <fieldset className="v2-us-form" disabled={act.busy}>
          <label className="v2-po-f is-wide"><span>Как подписать</span><input value={name} onChange={e => setName(e.target.value)} placeholder="имя для списка" aria-label="Имя для списка" /></label>
          <div className="v2-po-f is-wide"><span>Ссылка действует</span>
            <div className="v2-seg" role="group" aria-label="Срок ссылки">
              {DAYS.map(([d, l]) => <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>{l}</button>)}
            </div>
          </div>
          <div className="v2-po-f is-wide"><span>Пределы</span><LimitFields v={lim} set={setLim} /></div>
        </fieldset>
      )}
      {act.error ? <p className="v2-note is-stop" role="alert">Не вышло: {act.error}</p> : null}
    </Shell>
  )
}

export function LimitsDialog({ user, onClose, onDone }: { user: UserRow; onClose: () => void; onDone: () => void }) {
  const act = useAction()
  const [lim, setLim] = useState<Limits>(user.limits ?? { accounts: 3, senders: 1 })
  const save = async () => {
    const r: any = await act.run('/api/users/limits', { id: user.id, ...lim })
    if (r?.error) return
    onDone()
    onClose()
  }
  return (
    <Shell title={'Пределы «' + user.name + '»'} onClose={onClose} foot={<>
      <Btn tone="soft" onClick={onClose} disabled={act.busy}>отмена</Btn>
      <Btn tone="go" loading={act.busy} onClick={save}>сохранить</Btn>
    </>}>
      <p className="v2-text">Каждый работник — процесс на вашем ПК, входящий в Steam. Сверх предела новая привязка и запуск работника получат отказ; уже работающее не останавливается.</p>
      <LimitFields v={lim} set={setLim} disabled={act.busy} />
      {act.error ? <p className="v2-note is-stop" role="alert">Не вышло: {act.error}</p> : null}
    </Shell>
  )
}

export function PermitDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const act = useAction()
  const [sid, setSid] = useState('')
  const ok = /^\d{17}$/.test(sid.trim())
  const go = async () => {
    const r: any = await act.run('/api/users/permit', { steamid: sid.trim() })
    if (r?.error) return
    onDone()
    onClose()
  }
  return (
    <Shell title="Допуск для приёмки" aside="один Steam · 24 часа" onClose={onClose} foot={<>
      <Btn tone="soft" onClick={onClose} disabled={act.busy}>отмена</Btn>
      <Btn tone="go" loading={act.busy} disabled={!ok} onClick={go}>допустить на 24 часа</Btn>
    </>}>
      <p className="v2-text">Ваш второй, тестовый Steam сможет войти, пока общий вход закрыт, — чтобы проверить раздельность вдвоём. Приглашения при этом не принимаются, другие Steam не входят. Через 24 часа или по «снять» его сессии гаснут, а работа встаёт.</p>
      <label className="v2-po-f is-wide"><span>steamid тестового Steam — 17 цифр</span><input value={sid} onChange={e => setSid(e.target.value)} inputMode="numeric" disabled={act.busy} aria-label="steamid тестового Steam" /></label>
      {act.error ? <p className="v2-note is-stop" role="alert">Не вышло: {act.error}</p> : null}
    </Shell>
  )
}
