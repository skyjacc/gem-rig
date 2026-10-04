// Правая колонка Скупки (§5.3, план 2.3, задача 3): «Закупка на», «Бюджет»,
// «Корзина» и запуск.
//
// С8: кнопка «Запустить закупку» активна, только если launchBlock() вернул
// null — ключ проверен (state = ok), валюта = валюте счёта, потолок задан и
// корзина в него влезает, корзина не пуста, закупка не идёт. Иначе под
// кнопкой первая причина словами. Это подсказка заранее, не защита: сервер
// на запуске проверяет всё сам (buyKey, vetLines, startPurchase).

import { useState } from 'react'
import { X } from 'lucide-react'
import { ago, DEMO, icon, nf, plural, useAction, type State } from '../../lib/api.ts'
import { Btn, Chip, Panel, Src } from '../ui.tsx'
import { money, minutes, type Buy } from './Buy.tsx'
import { BuyConfirm } from './BuyConfirm.tsx'
import { cashFor, collect, shortOfMoney, type Scan } from './model.ts'

// Сколько сервер верит прошлой проверке ключа (marketkeys.ts, TTL = 10 мин);
// старше — buyKey на запуске спросит площадку заново.
const KEY_TTL = 10 * 60_000

const KEY: Record<string,{ word: string; tone?: 'ok' | 'warn' | 'stop' }> = {
  ok: { word: 'ключ этого аккаунта', tone: 'ok' },
  unchecked: { word: 'ключ не проверен', tone: 'warn' },
  missing: { word: 'нет ключа', tone: 'stop' },
  mismatch: { word: 'ключ другого Steam', tone: 'stop' },
  invalid: { word: 'ключ отвергнут', tone: 'stop' },
}

export function BuySide({ state, buy, now, onRules }: {
  state: State
  buy: Buy
  now: number
  onRules: () => void
}) {
  const { scan } = buy
  const [confirm, setConfirm] = useState(false)
  return (
    <>
      <Account scan={scan} buy={buy} now={now} />
      <Budget scan={scan} buy={buy} onRules={onRules} />
      <Cart state={state} buy={buy} onLaunch={() => setConfirm(true)} />
      {confirm && scan ? (
        <BuyConfirm scan={scan} cart={buy.cart} cur={buy.cur} tolerance={buy.settings?.priceTolerance} onClose={() => setConfirm(false)} />
      ) : null}
    </>
  )
}

function Account({ scan, buy, now }: { scan: Scan | null; buy: Buy; now: number }) {
  const check = useAction()
  if (!scan) {
    return (
      <Panel title="Закупка на">
        <p className="v2-text">Разбора площадки нет — не видно, на какой аккаунт и с каким ключом пойдёт закупка.</p>
      </Panel>
    )
  }
  const k = scan.key
  const st = k ? KEY[k.state] : { word: 'статус ключа неизвестен', tone: 'warn' as const }
  const who = scan.account?.label ?? '—'
  const recheck = async () => {
    const r: any = await check.run('/api/accounts/market-key/check', { id: scan.account?.id })
    if (!r?.error) buy.market.reload()
  }
  return (
    <Panel title="Закупка на">
      <div className="v2-buy-acct">
        <span className="v2-ava is-lg" aria-hidden="true">{who.slice(0, 1).toUpperCase()}</span>
        <span className="v2-buy-acct-n">
          <b>{who}</b>
          <span className="v2-hint">лоты придут в Steam этого аккаунта; ключ площадки у каждого аккаунта свой</span>
          <Chip tone={st.tone} dot>{st.word}</Chip>
        </span>
      </div>

      {k?.state === 'ok' ? (
        <p className="v2-hint v2-buy-keyline">
          площадка назвала Steam этого аккаунта · проверено {ago(k.checkedAt, now)} назад
          {now - k.checkedAt > KEY_TTL ? ' · при запуске сервер проверит ещё раз' : ''}
        </p>
      ) : (
        <div className={'v2-note ' + (k?.state === 'unchecked' || !k ? 'is-warn' : 'is-stop')}>
          {k?.state === 'missing' ? (
            <p>Без ключа закупка не запустится — сервер ответит «нет ключа площадки». Ключ задаётся на экране аккаунтов: сейчас — в старой панели, в новой — этап 2.4.</p>
          ) : k?.state === 'mismatch' ? (
            <p>Площадка привязала этот ключ к другому Steam ({k.marketSteamid ?? '—'}) — лоты ушли бы не на «{who}». Замените ключ на экране аккаунтов.</p>
          ) : k?.state === 'invalid' ? (
            <p>Площадка отвергла ключ{k.error ? ': ' + k.error : ''}.</p>
          ) : (
            <p>Ключ есть, но не проверен{k?.error ? ' (' + k.error + ')' : ''}. Проверка спрашивает у площадки, чей это Steam, — запуск откроется, только если ключ этого аккаунта.</p>
          )}
          {k?.state !== 'missing' ? (
            <Btn tone="soft" loading={check.busy} onClick={recheck}>{k?.state === 'unchecked' || !k ? 'проверить ключ' : 'проверить ещё раз'}</Btn>
          ) : null}
          {check.error ? <p role="alert">Не вышло: {check.error}</p> : null}
        </div>
      )}

      <div className="v2-buy-bal">
        <span>на счету <Src>площадка</Src></span>
        {scan.balance != null
          ? <b className="v2-num">{money(scan.balance, scan.balanceCurrency ?? buy.cur)}</b>
          : <b className="v2-kpi-none">— {scan.balanceError ?? 'нет данных'}</b>}
      </div>
    </Panel>
  )
}

function Budget({ scan, buy, onRules }: { scan: Scan | null; buy: Buy; onRules: () => void }) {
  const [none, setNone] = useState(false)
  const cap = buy.cap
  const c = scan?.balanceCurrency ?? buy.cur
  const pick = () => {
    if (!scan) return
    const next = collect(scan, cashFor(buy.budget, cap, scan.balance))
    setNone(!next)
    if (next) buy.setTake(next)
  }
  return (
    <Panel title="Бюджет" aside="он же потолок суммы">
      <div className="v2-buy-budget">
        <label className="v2-buy-field">
          <span aria-hidden="true">{c === 'USD' ? '$' : c}</span>
          <input
            value={buy.budget}
            onChange={e => { buy.setBudget(e.target.value); setNone(false) }}
            inputMode="decimal"
            placeholder={cap != null && cap > 0 ? 'до ' + cap : 'весь баланс'}
            aria-label="Бюджет закупки"
          />
        </label>
        <Btn tone="soft" disabled={!scan || buy.running} onClick={pick}>собрать план</Btn>
      </div>
      {none ? <p className="v2-hint" role="status">Собирать не на что: бюджет не задан, а баланс площадки неизвестен или ноль.</p> : null}

      <ol className="v2-buy-rules">
        <li><i className="is-ok">1</i>сначала копии гемов, что уже в работе — им не нужно новых отправок</li>
        <li><i>2</i>потом те, у кого больше общих матчей с моими</li>
        <li><i>3</i>дальше — по цене тысячи просмотров; не больше {nf(scan?.perGem ?? 0)} лотов одного гема</li>
      </ol>

      <div className="v2-buy-bal">
        <span>потолок закупки · из настроек</span>
        {cap != null && cap > 0 ? <b className="v2-num">{money(cap, c)}</b> : <b className="v2-kpi-none">— не задан</b>}
      </div>
      <p className="v2-hint">
        Больше потолка за один запуск не спишется — сервер проверяет сам. Пустой бюджет — меньшее из потолка и баланса.{' '}
        <button type="button" className="v2-linkbtn" onClick={onRules}>изменить потолок</button>
      </p>
    </Panel>
  )
}

function Cart({ state, buy, onLaunch }: { state: State; buy: Buy; onLaunch: () => void }) {
  const { scan, cart, block, running } = buy
  const c = scan?.currency ?? buy.cur
  const pics = new Map<string, string>()
  for (const x of state.catalog) if (x.icon) pics.set(x.short, x.icon)
  for (const g of state.mine) if (g.icon) pics.set(g.gem, g.icon)
  const tol = buy.settings?.priceTolerance
  const short = shortOfMoney(scan, cart)

  return (
    <Panel title="Корзина" aside={cart.lines.length ? nf(cart.lines.length) + ' поз. · ' + nf(cart.units) + ' шт.' : undefined}>
      {cart.lines.length ? (
        <ul className="v2-buy-lines">
          {cart.lines.map(x => (
            <li key={x.o.gem}>
              <span className="v2-item-ico" style={{ backgroundImage: pics.get(x.o.gem) ? `url('${icon(pics.get(x.o.gem)!, 64)}')` : undefined }} aria-hidden="true" />
              <span className="v2-buy-lines-n">
                <b>{x.o.gem}</b>
                <span className="v2-hint v2-num">{nf(x.n)} × {money(x.o.price, c)}</span>
              </span>
              <b className="v2-num">{money(x.n * x.o.price, c)}</b>
              <button type="button" className="v2-buy-x" aria-label={'убрать ' + x.o.gem + ' из корзины'} disabled={running}
                onClick={() => buy.setTake(t => ({ ...t, [x.o.gem]: 0 }))}>
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="v2-buy-empty">пусто · «+» в строке плана или «собрать план» по бюджету</p>
      )}

      <div className="v2-buy-facts">
        <div className="v2-tile"><span>спишется не больше</span><b className="v2-num">{money(cart.cost, c)}</b></div>
        <div className="v2-tile"><span>самоцветов</span><b className="v2-num">{nf(cart.units)}</b>{cart.free ? <small>{nf(cart.free)} без отправок</small> : null}</div>
        <div className="v2-tile">
          <span>доп. время <Chip tone="warn">оценка</Chip></span>
          <b className="v2-num">{cart.sends ? '+' + minutes(cart.sends) : cart.units ? 'бесплатно' : '—'}</b>
          {cart.sends ? <small className="v2-num">{nf(cart.sends)} {plural(cart.sends, 'отправка', 'отправки', 'отправок')}</small> : cart.units ? <small>всё уже крутится</small> : null}
        </div>
        <div className="v2-tile">
          <span>допуск цены · из настроек</span>
          <b className="v2-num">{tol == null ? '—' : Math.round(tol * 100) + ' %'}</b>
          <small>{tol == null ? 'нет в настройках' : 'дороже плана не берёт'}</small>
        </div>
      </div>

      {cart.units && !running ? (
        <button type="button" className="v2-linkbtn v2-buy-reset" onClick={() => buy.setTake({})}>очистить корзину</button>
      ) : null}

      {short && !block ? (
        <p className="v2-note is-warn">На счету {money(scan!.balance!, c)} — меньше корзины. Баланс в разборе живёт до 30 с; окончательно его сверит сервер, и при нехватке он откажет.</p>
      ) : null}

      <Btn tone="go" className="v2-buy-go" disabled={!!block} onClick={onLaunch}>
        {running ? 'Робот работает…' : 'Запустить закупку' + (cart.units ? ' · до ' + money(cart.cost, c) : '')}
      </Btn>
      {block ? <p className="v2-hint v2-buy-why" role="status">{block}</p> : null}
      {DEMO ? <p className="v2-hint">В показе запуск ничего не отправляет.</p> : null}
    </Panel>
  )
}
