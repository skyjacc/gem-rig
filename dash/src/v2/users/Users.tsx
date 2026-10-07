// Экран «Пользователи» (план 7.3, макет 8) — только у владельца.
//
// Кто пользуется панелью и сколько нагружает сервер. Чужие аккаунты, ключи и
// деньги здесь не видны — только счётчики. Отсюда же: приглашения, пределы,
// отключение, вход для приглашённых и допуск для приёмки (решение 16).

import { useState } from 'react'
import { ago, nf, plural } from '../../lib/api.ts'
import { Loadable } from '../States.tsx'
import { Btn, Chip, Panel } from '../ui.tsx'
import type { UserRow, UsersData } from './data.ts'
import { ConfirmDialog, InviteDialog, LimitsDialog, PermitDialog } from './dialogs.tsx'

type Open =
  | { kind: 'invite' } | { kind: 'permit' } | { kind: 'permit-off' }
  | { kind: 'limits'; u: UserRow } | { kind: 'off'; u: UserRow } | { kind: 'on'; u: UserRow }
  | { kind: 'entry'; open: boolean } | { kind: 'revoke'; id: number; name: string }
  | null

const mb = (b: number | null) => (b == null ? '—' : nf(Math.round(b / 1_048_576)) + ' МБ')
const when = (ts: number) => new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export function UsersScreen({ data, now }: { data: UsersData; now: number }) {
  const [open, setOpen] = useState<Open>(null)
  const u = data.users.data
  const reload = () => { data.users.reload(); data.invites.reload() }
  return (
    <div className="v2-us">
      <header className="v2-inv-head">
        <div>
          <h1 className="v2-h1">Пользователи</h1>
          <p className="v2-hint">Кто пользуется панелью и сколько нагружает сервер. Чужие аккаунты, ключи и деньги здесь не видны — только счётчики.</p>
        </div>
        <Btn tone="go" onClick={() => setOpen({ kind: 'invite' })}>+ пригласить</Btn>
      </header>

      <Loadable what="пользователей" loading={data.users.loading} error={data.users.error} ready={!!u} onRetry={data.users.reload}>
        {u ? (
          <>
            <div className="v2-us-load">
              <div className="v2-tile"><span>пользователей</span><b className="v2-num">{nf(u.load.users)}</b><small>{u.users.filter(x => x.disabled).length ? u.users.filter(x => x.disabled).length + ' отключено' : 'отключённых нет'}</small></div>
              <div className="v2-tile"><span>рабочих аккаунтов</span><b className="v2-num">{nf(u.load.accounts)}</b><small>у всех вместе</small></div>
              <div className="v2-tile"><span>работников запущено</span><b className="v2-num">{nf(u.load.running)}</b><small>каждый — процесс на вашем ПК, входящий в Steam</small></div>
              <div className="v2-tile"><span>база</span><b className="v2-num">{mb(u.load.dbBytes)}</b><small>общая карта матчей и журналы</small></div>
            </div>

            <Panel title="Вход в панель" aside={<Chip dot tone={u.entryOpen ? 'ok' : 'warn'}>{u.entryOpen ? 'открыт приглашённым' : 'только владелец'}</Chip>}>
              <p className="v2-text">
                {u.entryOpen
                  ? 'Приглашённые входят своим Steam; ссылки-приглашения принимаются.'
                  : 'Вход открыт только вам. Приглашения не принимаются, пока вы не откроете вход — после проверки раздельности вдвоём.'}
              </p>
              <div className="v2-login-acts">
                <Btn tone={u.entryOpen ? 'soft' : 'go'} onClick={() => setOpen({ kind: 'entry', open: !u.entryOpen })}>{u.entryOpen ? 'закрыть вход' : 'открыть вход для приглашённых…'}</Btn>
              </div>
              <h3 className="v2-sl-h3">Допуск для приёмки</h3>
              {u.permit ? (
                <p className="v2-text">Допущен Steam {u.permit.steamid} — до {when(u.permit.expiresAt)}. <button type="button" className="v2-linkbtn" onClick={() => setOpen({ kind: 'permit-off' })}>снять допуск…</button></p>
              ) : (
                <p className="v2-text">Нет. Чтобы проверить раздельность вдвоём, допустите свой тестовый Steam на 24 часа. <button type="button" className="v2-linkbtn" onClick={() => setOpen({ kind: 'permit' })}>допустить…</button></p>
              )}
            </Panel>

            <Panel title="Кто заведён">
              <ul className="v2-us-list" aria-label="Пользователи">
                {u.users.map(x => (
                  <li key={x.id} className={'v2-us-row' + (x.disabled ? ' is-off' : '')}>
                    <div className="v2-us-who">
                      <b>{x.name}</b>
                      <Chip tone={x.role === 'владелец' ? 'ok' : undefined}>{x.role}</Chip>
                      {x.disabled ? <Chip tone="stop">отключён</Chip> : !x.active ? <Chip tone="warn">не впущен</Chip> : null}
                      <span className="v2-hint v2-num">{x.steamid ?? 'Steam не привязан'}</span>
                    </div>
                    <div className="v2-us-num v2-hint">
                      <span>вход: {x.lastSeen ? ago(x.lastSeen, now) + ' назад' : 'не входил'}</span>
                      <span>{nf(x.accounts)} {plural(x.accounts, 'аккаунт', 'аккаунта', 'аккаунтов')}</span>
                      <span>{x.running ? x.running + ' крутит' : 'не крутит'}{x.buying ? ' · закупка идёт' : ''}</span>
                      <span>{x.limits ? 'пределы: ' + x.limits.accounts + ' / ' + x.limits.senders : 'без пределов'}</span>
                    </div>
                    <div className="v2-us-acts">
                      {x.role === 'владелец' ? <span className="v2-hint">это вы</span> : (
                        <>
                          <button type="button" className="v2-linkbtn" onClick={() => setOpen({ kind: 'limits', u: x })}>пределы…</button>
                          <button type="button" className="v2-linkbtn" onClick={() => setOpen({ kind: x.disabled ? 'on' : 'off', u: x })}>{x.disabled ? 'включить…' : 'отключить…'}</button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          </>
        ) : null}
      </Loadable>

      <Panel title="Приглашения" aside="ссылка показывается один раз">
        {data.invites.data?.length ? (
          <ul className="v2-us-list" aria-label="Приглашения">
            {data.invites.data.map(v => (
              <li key={v.id} className="v2-us-row">
                <div className="v2-us-who"><b>{v.name}</b><Chip tone={v.state === 'ждёт' ? 'ok' : undefined}>{v.state}</Chip></div>
                <div className="v2-us-num v2-hint">
                  <span>создано {when(v.createdAt)}</span>
                  <span>{v.state === 'ждёт' ? 'действует до ' + when(v.expiresAt) : '—'}</span>
                  <span>пределы: {v.limits.accounts} / {v.limits.senders}</span>
                </div>
                <div className="v2-us-acts">
                  {v.state === 'ждёт' ? <button type="button" className="v2-linkbtn" onClick={() => setOpen({ kind: 'revoke', id: v.id, name: v.name })}>отозвать…</button> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="v2-hint">Приглашений нет.</p>}
      </Panel>

      {open?.kind === 'invite' ? <InviteDialog onClose={() => setOpen(null)} onDone={reload} /> : null}
      {open?.kind === 'permit' ? <PermitDialog onClose={() => setOpen(null)} onDone={reload} /> : null}
      {open?.kind === 'limits' ? <LimitsDialog user={open.u} onClose={() => setOpen(null)} onDone={reload} /> : null}
      {open?.kind === 'off' ? (
        <ConfirmDialog title={'Отключить «' + open.u.name + '»'} tone="stop" verb="отключить" url="/api/users/disable" body={{ id: open.u.id }} onClose={() => setOpen(null)} onDone={reload}
          text={<>Сразу: его сессии и открытые окна закрываются, работники и закупка встают, привязки по QR отменяются. Данные остаются. Уже отправленная на площадку покупка доводится и учитывается.</>} />
      ) : null}
      {open?.kind === 'on' ? (
        <ConfirmDialog title={'Включить «' + open.u.name + '»'} verb="включить" url="/api/users/enable" body={{ id: open.u.id }} onClose={() => setOpen(null)} onDone={reload}
          text={<>Сможет снова войти своим Steam (если вход для приглашённых открыт). Работники сами не запускаются.</>} />
      ) : null}
      {open?.kind === 'entry' ? (
        <ConfirmDialog title={open.open ? 'Открыть вход для приглашённых' : 'Закрыть вход'} tone={open.open ? 'go' : 'stop'} verb={open.open ? 'открыть вход' : 'закрыть вход'}
          url="/api/users/entry" body={{ open: open.open }} onClose={() => setOpen(null)} onDone={reload}
          text={open.open
            ? <>Приглашённые смогут входить своим Steam, ссылки начнут приниматься. Открывайте только после проверки раздельности вдвоём (допуск для приёмки).</>
            : <>Все, кроме вас, теряют доступ: их сессии гаснут, работники и закупки встают. Данные остаются; откроете вход — смогут войти снова.</>} />
      ) : null}
      {open?.kind === 'permit-off' ? (
        <ConfirmDialog title="Снять допуск для приёмки" tone="stop" verb="снять допуск" url="/api/users/permit/revoke" body={{}} onClose={() => setOpen(null)} onDone={reload}
          text={<>Сессии допущенного Steam гаснут, его работа встаёт.</>} />
      ) : null}
      {open?.kind === 'revoke' ? (
        <ConfirmDialog title={'Отозвать приглашение «' + open.name + '»'} tone="stop" verb="отозвать" url="/api/users/invite/revoke" body={{ id: open.id }} onClose={() => setOpen(null)} onDone={reload}
          text={<>Ссылка перестанет действовать. Если по ней уже вошли — это не отзыв, а отключение пользователя.</>} />
      ) : null}
    </div>
  )
}

export function UsersSide() {
  return (
    <>
      <Panel title="Как это устроено">
        <div className="v2-us-why v2-text">
          <p><b>Пользователь</b> — человек: входит своим Steam. Это только пропуск — инвентаря и кошелька панель через вход не получает.</p>
          <p><b>Своё у каждого:</b> рабочие аккаунты, ключи площадки, закупки, продажи и выплаты, настройки накрутки.</p>
          <p><b>Общее:</b> карта матчей и открытые данные, общие ограничения сервера — их меняете только вы.</p>
        </div>
      </Panel>
      <Panel title="Общий ПК — сказать другу до приглашения">
        <ul className="v2-us-why v2-text">
          <li>Всё работает на вашем компьютере: выключен, спит или без сети — работа друга стоит.</li>
          <li>Один внешний адрес: входы и чтения Steam всех пользователей идут с одного IP и делят общий запас запросов к Steam.</li>
          <li>Сессии Steam и ключ площадки друга лежат на вашем ПК. Панель их не показывает, но технически владелец ПК может до них добраться — это доверие, а не защита.</li>
          <li>Накрутку соглашение Steam запрещает: рискуют рабочие аккаунты, вещи и кошелёк на них.</li>
        </ul>
      </Panel>
    </>
  )
}
