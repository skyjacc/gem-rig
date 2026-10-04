// Окна экрана «Аккаунты» (план 2.4, решение 8): веб-вход по QR, ключ
// площадки, отвязка. Игровая привязка — прежнее окно LinkAccount.

import { useEffect, useRef, useState, type RefObject } from 'react'
import QRCode from 'qrcode'
import { nf, useAction, type AccountRow, type Accounts } from '../../lib/api.ts'
import { Btn } from '../ui.tsx'
import { keyCheck } from './model.ts'

// Tab держится внутри окна; Esc — то, что окно разрешает (или ничего).
function useTrap(box: RefObject<HTMLDivElement | null>, onEsc: (() => void) | null) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onEsc?.(); return }
      if (e.key !== 'Tab' || !box.current) return
      const f = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')]
      if (!f.length) return
      const first = f[0], last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [box, onEsc])
}

// ── веб-вход по QR ──
//
// Сервер запускает weblogin.js во временный файл и принимает токен, только
// если вошли тем же Steam (план 2.4, решение 2Б). Игра и работник не
// трогаются. Окно просит код один раз за открытие; отмена гасит вход и
// убирает временный файл на сервере.

export function WebLinkDialog({ a, accounts, onClose }: { a: AccountRow; accounts: Accounts | null; onClose: () => void }) {
  const start = useAction()
  const box = useRef<HTMLDivElement>(null)
  const asked = useRef(false)
  const w = accounts?.webLink?.id === a.id ? accounts.webLink : null
  const waiting = !!w && !w.done
  const ok = !!w && w.done && !w.error

  const ask = () => { void start.run('/api/accounts/web-link', { id: a.id }) }
  useEffect(() => { if (!asked.current) { asked.current = true; ask() } }, [])

  const close = async () => {
    if (waiting) await start.run('/api/accounts/web-link/cancel', {})
    onClose()
  }
  useTrap(box, close)

  return (
    <div className="v2-veil">
      <div ref={box} className="v2-dialog v2-acc-dlg" role="dialog" aria-modal="true" aria-labelledby="v2-web-title">
        <header className="v2-dialog-head">
          <h2 id="v2-web-title">Веб-вход «{a.label}»</h2>
          <span className="v2-aside">только чтение сайта Steam</span>
        </header>
        <p className="v2-text">
          Отдельный вход для истории рынка Steam и продаж. Игру и накрутку он не трогает и не выбивает.
          Пароль не вводится; если войти другим Steam, сервер вход не примет и прежний оставит.
        </p>
        <div className="v2-acc-qrbox">
          <Qr url={w?.url ?? null} ok={ok} failed={!!start.error || !!w?.error} />
          <ol className="v2-buy-rules">
            <li><i>1</i>Откройте мобильное приложение Steam</li>
            <li><i>2</i>Значок QR — наведите камеру на код</li>
            <li><i className={ok ? 'is-ok' : undefined}>3</i>Подтвердите вход в телефоне</li>
          </ol>
        </div>
        <p className="v2-hint" role="status">
          {start.error ? <span className="is-stop">Не вышло: {start.error}</span>
            : ok ? 'Готово: веб-вход принят. Проверьте его кнопкой «проверить» в карточке.'
            : w?.error ? <span className="is-stop">{w.error}</span>
            : w?.seen ? 'Телефон увидел код — подтвердите вход.'
            : waiting ? 'Ждём подтверждения в телефоне…'
            : 'Steam выдаёт код…'}
        </p>
        <footer className="v2-dialog-foot">
          {!waiting && !ok ? <Btn tone="soft" loading={start.busy} onClick={ask}>новый код</Btn> : null}
          <Btn tone={ok ? 'go' : 'soft'} onClick={close}>{ok ? 'готово' : 'отмена'}</Btn>
        </footer>
      </div>
    </div>
  )
}

function Qr({ url, ok, failed }: { url: string | null; ok: boolean; failed: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!url || !ref.current) return
    QRCode.toCanvas(ref.current, url, { width: 168, margin: 1, color: { dark: '#ecebe8', light: '#1b1b1e' } }).catch(() => { })
  }, [url])
  if (ok) return <div className="v2-acc-qr is-ok">готово</div>
  if (failed) return <div className="v2-acc-qr"><span className="v2-hint">кода нет</span></div>
  if (!url) return <div className="v2-acc-qr"><span className="v2-hint">код готовится…</span></div>
  return <canvas ref={ref} className="v2-acc-qr" aria-label="QR-код для входа" />
}

// ── ключ площадки ──
//
// Ключ вводится в скрытое поле и уходит только телом запроса. Сервер его
// сразу проверяет у площадки (setKey); в ответ — статус, самого ключа
// панель не видит и не показывает.

export function KeyDialog({ a, onClose }: { a: AccountRow; onClose: () => void }) {
  const act = useAction()
  const box = useRef<HTMLDivElement>(null)
  const [key, setKey] = useState('')
  const [after, setAfter] = useState<AccountRow['market'] | null>(null)
  useTrap(box, onClose)

  const save = async () => {
    const r: any = await act.run('/api/accounts/market-key', { id: a.id, key: key.trim() })
    setKey('')
    if (!r?.error) setAfter(r?.state ? r : a.market)
  }
  const c = after ? keyCheck(after, Date.now()) : null

  return (
    <div className="v2-veil" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={box} className="v2-dialog" role="dialog" aria-modal="true" aria-labelledby="v2-key-title">
        <header className="v2-dialog-head">
          <h2 id="v2-key-title">Ключ market.dota2.net</h2>
          <span className="v2-aside">{a.label}</span>
        </header>
        <p className="v2-text">
          Ключ API из профиля площадки. Сервер хранит его у себя и сразу спросит площадку, к какому Steam он
          привязан: лоты придут только туда. Панель ключ обратно не получает.
        </p>
        {c ? (
          <p className={'v2-note ' + (c.tone === 'ok' ? '' : c.tone === 'stop' ? 'is-stop' : 'is-warn')} role="status">{c.title} · {c.word} — {c.hint}</p>
        ) : (
          <label className="v2-buy-field v2-acc-keyf">
            <input
              type="password"
              autoComplete="off"
              autoFocus
              value={key}
              onChange={e => setKey(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && key.trim()) save() }}
              placeholder="вставьте ключ"
              aria-label="Ключ market.dota2.net"
            />
          </label>
        )}
        {act.error ? <p className="v2-note is-stop" role="alert">Не вышло: {act.error}</p> : null}
        <footer className="v2-dialog-foot">
          <Btn tone="soft" onClick={onClose}>{c ? 'закрыть' : 'отмена'}</Btn>
          {c ? null : <Btn tone="go" loading={act.busy} disabled={!key.trim()} onClick={save}>сохранить и проверить</Btn>}
        </footer>
      </div>
    </div>
  )
}

// ── отвязка ──
//
// Необратимо (вернуть — только новым QR), поэтому как подтверждение
// «Накрутить»: закрывается только кнопками, подтверждение — вводом имени.

export function UnlinkDialog({ a, onClose }: { a: AccountRow; onClose: () => void }) {
  const act = useAction()
  const box = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const [typed, setTyped] = useState('')
  useTrap(box, null)
  useEffect(() => { cancel.current?.focus() }, [])

  const go = async () => {
    const r: any = await act.run('/api/accounts/unlink', { id: a.id })
    if (!r?.error) onClose()
  }

  return (
    <div className="v2-veil">
      <div ref={box} className="v2-dialog" role="dialog" aria-modal="true" aria-labelledby="v2-unlink-title">
        <header className="v2-dialog-head">
          <h2 id="v2-unlink-title">Отвязать «{a.label}»?</h2>
          <span className="v2-aside v2-id">{a.steamid}</span>
        </header>
        <p className="v2-text">
          Панель остановит работника этого аккаунта, удалит обе сессии (вход игры и веб-вход) и строку аккаунта.
          Вернуть можно только новым входом по QR. Журнал сожжённых матчей ({nf(a.burned)}) останется: если аккаунт
          привяжут заново, очередь будет помнить, что эти матчи уже израсходованы.
        </p>
        <label className="v2-buy-field v2-acc-keyf">
          <input value={typed} onChange={e => setTyped(e.target.value)} placeholder={'напишите «' + a.label + '», чтобы подтвердить'} aria-label="Имя аккаунта для подтверждения" />
        </label>
        {act.error ? <p className="v2-note is-stop" role="alert">Не вышло: {act.error}</p> : null}
        <footer className="v2-dialog-foot">
          <Btn ref={cancel} tone="soft" onClick={() => { act.clear(); onClose() }} disabled={act.busy}>отмена</Btn>
          <Btn tone="stop" loading={act.busy} disabled={typed.trim() !== a.label} onClick={go}>отвязать</Btn>
        </footer>
      </div>
    </div>
  )
}
