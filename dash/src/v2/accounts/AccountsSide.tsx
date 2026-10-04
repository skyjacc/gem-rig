// Правая колонка Аккаунтов (§5.5, план 2.4, решение 7): работник выбранного
// аккаунта, журнал его решений и «если что-то сломалось».

import { ago, clock, nf, type Accounts, type State } from '../../lib/api.ts'
import { Btn, Chip, Panel } from '../ui.tsx'
import { accountsOf, unitOf } from './data.ts'
import { troubles } from './model.ts'

export function AccountsSide({ state, accounts, sel, now, onRelink, onWeb }: {
  state: State
  accounts: Accounts | null
  sel: string | null
  now: number
  onRelink: (a: { id: string; label: string }) => void
  onWeb: (id: string) => void
}) {
  const accs = accountsOf(accounts)
  const list = accs?.list ?? []
  const a = list.find(x => x.id === sel) ?? list.find(x => x.id === accs?.active) ?? list[0]
  if (!a) return <Panel title="Работник"><p className="v2-text">Аккаунтов нет.</p></Panel>
  const u = unitOf(state, accs, a.id)
  const bad = troubles(a, u, now)
  const word = u?.running ? 'идёт' : u?.fatal ? 'встал' : u?.enabled ? 'ждёт' : 'стоит'
  const tone = u?.running ? 'ok' : u?.fatal ? 'stop' : u?.enabled ? 'warn' : undefined

  return (
    <>
      <Panel title={'Работник «' + a.label + '»'} aside={<Chip tone={tone} dot>{word}</Chip>}>
        {u ? (
          <>
            <div className="v2-acc-facts">
              <div className="v2-tile"><span>процесс</span><b>{u.running ? 'pid ' + (u.pid ?? '—') : u.exit ?? 'не запущен'}</b></div>
              <div className="v2-tile"><span>падений подряд</span><b className={'v2-num' + (u.failures ? ' is-stop' : '')}>{nf(u.failures)}</b></div>
              <div className="v2-tile"><span>выбило сессией</span><b className={'v2-num' + (u.displaced ? ' is-stop' : '')}>{nf(u.displaced ?? 0)}</b></div>
              <div className="v2-tile"><span>в очереди</span><b className="v2-num">{nf(u.queueLength)}</b></div>
            </div>
            <p className="v2-text v2-acc-last"><b>Последнее решение:</b> {u.why || '—'}</p>
          </>
        ) : (
          <p className="v2-text">У этого аккаунта ещё нет работника.</p>
        )}
      </Panel>

      <Panel title="Журнал решений" aside="что и почему">
        {u?.log?.length ? (
          <ol className="v2-acc-log">
            {[...u.log].sort((x, y) => y.ts - x.ts).slice(0, 30).map((e, i) => (
              <li key={e.ts + ':' + i}>
                <span className="v2-num v2-hint" title={new Date(e.ts).toLocaleString('ru-RU')}>{now - e.ts < 86_400_000 ? clock(e.ts) : ago(e.ts, now) + ' назад'}</span>
                <span><b>{e.action}</b> · {e.why}</span>
              </li>
            ))}
          </ol>
        ) : <p className="v2-hint">решений пока не было</p>}
      </Panel>

      <Panel title="Если что-то сломалось">
        {bad.length ? bad.map(t => (
          <div key={t.title} className="v2-note is-stop v2-acc-trouble">
            <p><b>{t.title}</b> — {t.text}</p>
            {t.fix === 'relink' ? <Btn tone="soft" onClick={() => onRelink({ id: a.id, label: a.label })}>обновить вход игры по QR</Btn> : null}
            {t.fix === 'web' ? <Btn tone="soft" onClick={() => onWeb(a.id)}>войти по QR</Btn> : null}
          </div>
        )) : <p className="v2-hint">Сейчас поломок не видно.</p>}
        <p className="v2-hint v2-acc-help">
          <b>Вход игры отвергнут</b> (сменили пароль, «выйти на всех устройствах») — работник встанет и скажет. Лечится «обновить по QR», без отвязки.
          {' '}<b>Выбило сессией</b> — с аккаунта зашли в Steam где-то ещё; два раза подряд — и работник встаёт.
          {' '}<b>Отвязать</b> можно, только когда аккаунтов больше одного.
        </p>
      </Panel>
    </>
  )
}
