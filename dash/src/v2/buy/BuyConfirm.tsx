// Подтверждение закупки (план 2.3, решение 9).
//
// Деньги списываются необратимо, поэтому окно ведёт себя как подтверждение
// «Накрутить» (§5.7): закрывается ТОЛЬКО кнопками — ни Esc, ни щелчок по
// фону; фокус заперт в окне и стоит на «отмене», чтобы Enter по привычке
// не запустил покупку. Готовое ActionDialog закрывается по Esc и фону —
// поэтому здесь своё.
//
// Запрос — тот же, что в старой Скупке: POST /api/market/buy
// {lines, id аккаунта разбора, currency}. Сервер сам выбирает ключ и
// перепроверяет всё (buyKey, vetLines, startPurchase); ошибка — в окне.

import { useEffect, useRef } from 'react'
import { nf, plural, useAction } from '../../lib/api.ts'
import { Btn } from '../ui.tsx'
import { money, minutes } from './Buy.tsx'
import type { Cart, Cur, Scan } from './model.ts'

export function BuyConfirm({ scan, cart, cur, tolerance, onClose }: {
  scan: Scan
  cart: Cart
  cur: Cur
  tolerance: number | undefined
  onClose: () => void
}) {
  const act = useAction()
  const box = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)

  useEffect(() => { cancel.current?.focus() }, [])

  // Esc гасим, Tab держим внутри окна.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return }
      if (e.key !== 'Tab' || !box.current) return
      const f = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled])')]
      if (!f.length) return
      const first = f[0], last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [])

  const go = async () => {
    const r: any = await act.run('/api/market/buy', {
      lines: cart.lines.map(x => ({ name: x.o.name, take: x.n, price: x.o.price })),
      // Аккаунт, по которому считался план: переключение в панели между
      // разбором и покупкой не должно увести лоты на другой (как в старой).
      id: scan.account?.id,
      currency: cur,
    })
    if (r?.error) return
    onClose()
  }

  const rows: { k: string; v: string; tone?: 'warn' }[] = [
    { k: 'аккаунт', v: scan.account?.label ?? '—' },
    { k: 'позиций · самоцветов', v: nf(cart.lines.length) + ' · ' + nf(cart.units) },
    { k: 'спишется не больше', v: money(cart.cost, cur) },
    { k: 'допуск цены', v: tolerance == null ? '— (нет в настройках)' : Math.round(tolerance * 100) + ' %' },
    { k: 'доп. время накрутки · оценка', v: cart.sends ? '+' + minutes(cart.sends) + ' · ' + nf(cart.sends) + ' ' + plural(cart.sends, 'отправка', 'отправки', 'отправок') : 'бесплатно — всё уже крутится' },
  ]
  if (scan.balance != null && cart.cost > scan.balance + 1e-9) {
    rows.push({ k: 'на счету', v: money(scan.balance, cur) + ' — меньше суммы, сервер откажет', tone: 'warn' })
  }

  return (
    <div className="v2-veil">
      <div ref={box} className="v2-dialog" role="dialog" aria-modal="true" aria-labelledby="v2-buy-title">
        <header className="v2-dialog-head">
          <h2 id="v2-buy-title">Запустить закупку</h2>
          <span className="v2-aside">market.dota2.net</span>
        </header>

        <dl className="v2-rows">
          {rows.map(r => (
            <div key={r.k} className={r.tone === 'warn' ? 'is-warn' : undefined}>
              <dt>{r.k}</dt>
              <dd className="v2-num">{r.v}</dd>
            </div>
          ))}
        </dl>

        <ul className="v2-buy-cfm">
          {cart.lines.map(x => (
            <li key={x.o.gem}>
              <span>{x.o.gem}</span>
              <span className="v2-num v2-hint">{nf(x.n)} × {money(x.o.price, cur)}</span>
              <b className="v2-num">{money(x.n * x.o.price, cur)}</b>
            </li>
          ))}
        </ul>

        <p className="v2-burn">
          Деньги списываются с баланса площадки сразу, купленный лот не вернуть. Робот перед каждым
          лотом берёт свежую цену и дороже плана не покупает; если площадка не ответила, списались ли
          деньги, — закупка встаёт целиком, повторной покупки не будет.
        </p>

        {act.error ? <p className="v2-note is-stop" role="alert">Не вышло: {act.error}</p> : null}

        <footer className="v2-dialog-foot">
          <Btn ref={cancel} tone="soft" onClick={() => { act.clear(); onClose() }} disabled={act.busy}>отмена</Btn>
          <Btn tone="go" loading={act.busy} onClick={go}>
            {act.busy ? 'запускаю…' : act.error ? 'ещё раз' : 'списать до ' + money(cart.cost, cur)}
          </Btn>
        </footer>
      </div>
    </div>
  )
}
