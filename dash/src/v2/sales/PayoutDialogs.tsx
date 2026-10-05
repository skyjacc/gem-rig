// Выплаты Clover руками (план 3.2): поля выплаты, форма ввода, окна сторно
// и исправления.
//
// Аккаунт закрепляется при открытии формы и отправляется явно (решение 8):
// сменился активный — форма остаётся на своём и пишет об этом.
// «Пришло» (монета, количество, сеть) и «в долларах» — раздельно (решение
// 4): доллары выплаты в монете, включая USDT, — оценка владельца, из
// количества монеты они не подставляются.

import { useEffect, useRef, useState } from 'react'
import { useAction } from '../../lib/api.ts'
import { Btn, Chip } from '../ui.tsx'
import { useTrap } from '../useTrap.ts'
import { money, when, type PayoutRow } from './model.ts'

export type Acc = { id: string; label: string }

const ASSETS = ['USDT', 'USDC', 'LTC', 'BTC', 'ETH', 'SOL', 'USD']

export type Draft = {
  tx: string; asset: string; assetAmount: string; network: string; usd: string; at: string; keys: string; note: string
}

// datetime-local — местное время без пояса: «2026-10-05T14:30».
const local = (ts: number) => {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}

export const emptyDraft = (now = Date.now()): Draft =>
  ({ tx: '', asset: '', assetAmount: '', network: '', usd: '', at: local(now), keys: '', note: '' })

export const draftOf = (r: PayoutRow): Draft => ({
  tx: r.tx, asset: r.asset, assetAmount: r.assetAmount ?? '', network: r.network ?? '',
  usd: (r.op.net / 100).toFixed(2), at: local(r.op.happened_at), keys: r.keys == null ? '' : String(r.keys), note: r.note ?? '',
})

export const bodyOf = (d: Draft, accountId: string) => ({
  accountId,
  tx: d.tx,
  asset: d.asset,
  assetAmount: d.assetAmount,
  network: d.network,
  usd: d.usd,
  happenedAt: d.at ? new Date(d.at).getTime() : undefined,
  keys: d.keys,
  note: d.note,
})

export const short = (tx: string) => (tx.length > 18 ? tx.slice(0, 10) + '…' + tx.slice(-6) : tx)

// ── поля ──

export function PayoutFields({ d, set, txLocked = false }: { d: Draft; set: (d: Draft) => void; txLocked?: boolean }) {
  const f = (k: keyof Draft) => (e: { target: { value: string } }) => set({ ...d, [k]: e.target.value })
  const coin = d.asset && d.asset !== 'USD'
  return (
    <div className="v2-po-fields">
      <label className="v2-po-f is-wide">
        <span>Номер транзакции {txLocked ? <small>— не меняется: другой номер — другая выплата</small> : <small>— хэш перевода, если есть</small>}</span>
        <input value={d.tx} onChange={f('tx')} readOnly={txLocked} spellCheck={false} autoComplete="off" placeholder="0x… или номер выплаты с сайта" aria-label="Номер транзакции" />
      </label>
      <label className="v2-po-f">
        <span>Пришло</span>
        <select value={d.asset} onChange={f('asset')} aria-label="Чем пришла выплата">
          <option value="">— выберите —</option>
          {ASSETS.map(a => <option key={a} value={a}>{a === 'USD' ? 'USD (PayPal, банк)' : a}</option>)}
        </select>
      </label>
      {coin ? (
        <>
          <label className="v2-po-f">
            <span>Сколько {d.asset} <small>— как пришло</small></span>
            <input value={d.assetAmount} onChange={f('assetAmount')} inputMode="decimal" placeholder="необязательно" aria-label={'Количество ' + d.asset} />
          </label>
          <label className="v2-po-f">
            <span>Сеть</span>
            <input value={d.network} onChange={f('network')} placeholder="BEP20, ERC-20, TRC-20…" aria-label="Сеть" />
          </label>
        </>
      ) : null}
      <label className="v2-po-f">
        <span>{coin ? <>В долларах <Chip tone="warn">оценка</Chip></> : 'Получено $'}</span>
        <input value={d.usd} onChange={f('usd')} inputMode="decimal" placeholder="12.50" aria-label={coin ? 'Ваша оценка в долларах' : 'Получено долларов'} />
        {coin ? <small className="v2-hint">ваша оценка в $ на дату выплаты — {d.asset} не равно доллару автоматически</small> : null}
      </label>
      <label className="v2-po-f">
        <span>Когда пришло</span>
        <input type="datetime-local" value={d.at} onChange={f('at')} aria-label="Когда пришла выплата" />
      </label>
      <label className="v2-po-f">
        <span>Ключей <small>— справочно</small></span>
        <input value={d.keys} onChange={f('keys')} inputMode="numeric" placeholder="необязательно" aria-label="Ключей продано" />
      </label>
      <label className="v2-po-f is-wide">
        <span>Заметка</span>
        <input value={d.note} onChange={f('note')} placeholder="необязательно" aria-label="Заметка" />
      </label>
    </div>
  )
}

// ── форма ввода ──

export function PayoutForm({ account, accounts, onDone }: { account: string | null; accounts: Acc[]; onDone: () => void }) {
  const act = useAction()
  // Аккаунт — тот, что был активным при открытии формы (решение 8).
  const [acc, setAcc] = useState<string | null>(account)
  useEffect(() => { if (!acc && account) setAcc(account) }, [acc, account])
  const [d, setD] = useState<Draft>(() => emptyDraft())
  const [note, setNote] = useState<string | null>(null)
  const label = (id: string | null) => accounts.find(a => a.id === id)?.label ?? id ?? '—'

  const send = async () => {
    if (!acc) return
    setNote(null)
    const r: any = await act.run('/api/money/payout', bodyOf(d, acc))
    if (r?.error) return
    setNote(r?.inserted === false ? 'Эта выплата уже внесена — новой записи нет.' : 'Внесено.')
    if (r?.inserted !== false) setD(emptyDraft())
    onDone()
  }

  return (
    <div className="v2-po-form">
      <p className="v2-hint">Выплата за ключи аккаунта <b>«{label(acc)}»</b> — закреплён при открытии формы.</p>
      {acc && account && acc !== account ? (
        <p className="v2-note is-warn" role="status">Активный аккаунт сменился — выплата будет записана на «{label(acc)}», как показано. <button type="button" className="v2-linkbtn" onClick={() => setAcc(account)}>записать на «{label(account)}»</button></p>
      ) : null}
      <PayoutFields d={d} set={x => { setD(x); setNote(null); act.clear() }} />
      {act.error ? <p className="v2-note is-stop" role="alert">Не внесено: {act.error}. Введённое не потеряно.</p> : null}
      {note ? <p className="v2-note" role="status">{note}</p> : null}
      <div className="v2-po-foot">
        <Btn tone="go" loading={act.busy} disabled={!acc || !d.tx.trim() || !d.usd.trim() || !d.asset} onClick={send}>+ внести выплату</Btn>
      </div>
    </div>
  )
}

// ── сторно (решение 7) ──

export function StornoDialog({ row, accountLabel, onClose, onDone }: { row: PayoutRow; accountLabel: string; onClose: () => void; onDone: () => void }) {
  const act = useAction()
  const box = useRef<HTMLDivElement>(null)
  const [reason, setReason] = useState('')
  useTrap(box, onClose)
  const go = async () => {
    const r: any = await act.run('/api/money/storno', { id: row.op.id, reason: reason.trim() })
    if (r?.error) return
    onDone()
    onClose()
  }
  return (
    <div className="v2-veil" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={box} className="v2-dialog" role="dialog" aria-modal="true" aria-labelledby="v2-po-st-title">
        <header className="v2-dialog-head">
          <h2 id="v2-po-st-title">Сторнировать выплату</h2>
          <span className="v2-aside">Clover.tf · {accountLabel}</span>
        </header>
        <dl className="v2-po-dl">
          <dt>когда</dt><dd>{when(row.op.happened_at)}</dd>
          <dt>сумма</dt><dd className="v2-num">{money('Clover.tf', row.op.currency, row.op.net).text}{row.usdBy !== 'получено' ? ' (оценка)' : ''}</dd>
          <dt>номер</dt><dd className="v2-po-tx" title={row.tx}>{short(row.tx)}{row.version > 1 ? ' · исправление №' + row.version : ''}</dd>
        </dl>
        <p className="v2-text">Запись останется в журнале; рядом ляжет обратная — и из «реализовано» выплата уйдёт. Вернуть её можно только исправлением.</p>
        <label className="v2-po-f is-wide">
          <span>Причина <small>— обязательно</small></span>
          <input value={reason} onChange={e => setReason(e.target.value)} placeholder="например: опечатка в сумме" aria-label="Причина сторно" />
        </label>
        {act.error ? <p className="v2-note is-stop" role="alert">Не вышло: {act.error}</p> : null}
        <footer className="v2-dialog-foot">
          <Btn tone="soft" onClick={onClose}>отмена</Btn>
          <Btn tone="stop" loading={act.busy} disabled={!reason.trim()} onClick={go}>сторнировать</Btn>
        </footer>
      </div>
    </div>
  )
}

// ── исправление (решение 6) ──

export function CorrectDialog({ row, accounts, onClose, onDone }: { row: PayoutRow; accounts: Acc[]; onClose: () => void; onDone: () => void }) {
  const act = useAction()
  const box = useRef<HTMLDivElement>(null)
  const [d, setD] = useState<Draft>(() => draftOf(row))
  const [acc, setAcc] = useState(row.op.account_id ?? '')
  const [note, setNote] = useState<string | null>(null)
  useTrap(box, onClose)
  const from = row.op.account_id ?? ''
  const label = (id: string) => accounts.find(a => a.id === id)?.label ?? id
  const go = async () => {
    const r: any = await act.run('/api/money/payout/correct', { ...bodyOf(d, acc), corrects: row.op.id })
    if (r?.error) return
    onDone()
    if (r?.inserted === false) { setNote('Это исправление уже внесено — новой записи нет.'); return }
    onClose()
  }
  return (
    <div className="v2-veil" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={box} className="v2-dialog v2-po-dlg" role="dialog" aria-modal="true" aria-labelledby="v2-po-fix-title">
        <header className="v2-dialog-head">
          <h2 id="v2-po-fix-title">Исправление выплаты</h2>
          <span className="v2-aside">Clover.tf · вместо сторнированной от {when(row.op.happened_at)}</span>
        </header>
        <p className="v2-text">Новая запись того же номера — версия {row.version + 1}, со ссылкой на сторнированную. Ошибся аккаунтом — выберите верный: это перенос.</p>
        <label className="v2-po-f is-wide">
          <span>Аккаунт</span>
          <select value={acc} onChange={e => setAcc(e.target.value)} aria-label="Аккаунт выплаты">
            {accounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
            {accounts.some(a => a.id === from) ? null : <option value={from}>{from}</option>}
          </select>
          {acc !== from ? <small className="v2-hint">перенос с «{label(from)}» на «{label(acc)}»</small> : null}
        </label>
        <PayoutFields d={d} set={x => { setD(x); setNote(null); act.clear() }} txLocked />
        {act.error ? <p className="v2-note is-stop" role="alert">Не внесено: {act.error}</p> : null}
        {note ? <p className="v2-note" role="status">{note}</p> : null}
        <footer className="v2-dialog-foot">
          <Btn tone="soft" onClick={onClose}>{note ? 'закрыть' : 'отмена'}</Btn>
          {note ? null : <Btn tone="go" loading={act.busy} disabled={!acc || !d.usd.trim() || !d.asset} onClick={go}>внести исправление</Btn>}
        </footer>
      </div>
    </div>
  )
}
