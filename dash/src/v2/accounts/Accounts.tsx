// Экран «Аккаунты» (§5.5, план 2.4): карточки с четырьмя проверками,
// «второй аккаунт», настройки выбранного аккаунта, общие правила.
//
// Данные — то, что уже отдаёт сервер:
//   аккаунты, две сессии, ключ   GET /api/accounts
//   работник, инвентарь          state.autopilot.units[]
//   правила                      GET /api/settings
// В показе (VITE_DEMO) у аккаунта в снимке нет ни сессий, ни ключа — список
// берётся из demo/accounts.json, составленного руками (план 2.4, решение 6).
//
// Две сессии Steam — две строки, никогда не одно «жива / отозвана»: вход
// игры снаружи не проверить, веб-вход проверяется фактическим получением кук.

import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Link2, Minus, Pencil, Play, QrCode, Square, X } from 'lucide-react'
import {
  DEMO, icon, nf, useAction,
  type AccountRow, type Accounts, type Settings, type State, type Unit,
} from '../../lib/api.ts'
import { accountsOf, unitOf } from './data.ts'
import { Loadable } from '../States.tsx'
import { Btn, Chip, IconBtn, Src } from '../ui.tsx'
import { cells, checks, day, pauseChips, targetMinutes, WAVES, type Check as CheckT, type Tone } from './model.ts'
import { KeyDialog, UnlinkDialog, WebLinkDialog } from './dialogs.tsx'
import { ActionDialog } from '../Dialog.tsx'

export type Open =
  | { kind: 'relink'; id: string; label: string }
  | { kind: 'web'; id: string }
  | { kind: 'key'; id: string }
  | { kind: 'unkey'; id: string }
  | { kind: 'unlink'; id: string }
  | null

export function AccountsScreen({ state, accounts, accountsJson, settings, now, sel, onSel, open, setOpen, onLink, onBurn }: {
  state: State
  accounts: Accounts | null
  accountsJson: { loading: boolean; error: string | null; reload: () => void }
  settings: Settings | null
  now: number
  sel: string | null
  onSel: (id: string) => void
  open: Open
  setOpen: (o: Open) => void
  onLink: (relink: { id: string; label: string } | null) => void
  onBurn: () => void
}) {
  const accs = accountsOf(accounts)
  const list = accs?.list ?? []
  const cur = list.find(a => a.id === sel) ?? list.find(a => a.id === accs?.active) ?? list[0] ?? null
  const u = cur ? unitOf(state, accs, cur.id) : undefined

  const act = (o: Open) => {
    if (o?.kind === 'relink') onLink({ id: o.id, label: o.label })
    else setOpen(o)
  }
  const byId = (id: string) => list.find(a => a.id === id) ?? null

  return (
    <div className="v2-acc">
      <header className="v2-inv-head">
        <div>
          <h1 className="v2-h1">Аккаунты</h1>
          <p className="v2-hint">
            Матчи общие для всех аккаунтов, а сожжённые — у каждого свои: второй аккаунт крутит те же матчи
            заново, и у каждого свои темп, цель и набор гемов.
          </p>
        </div>
        <Btn tone="soft" onClick={() => onLink(null)}><Link2 size={14} aria-hidden="true" />Привязать аккаунт</Btn>
      </header>

      <Loadable what="аккаунты" loading={accountsJson.loading} error={DEMO ? null : accountsJson.error} ready={!!accs} onRetry={accountsJson.reload}>
        <div className="v2-acc-cards">
          {list.map(a => (
            <Card
              key={a.id}
              a={a}
              u={unitOf(state, accs, a.id)}
              active={accs?.active === a.id}
              single={list.length === 1}
              selected={cur?.id === a.id}
              now={now}
              onSel={() => onSel(a.id)}
              onOpen={act}
              onBurn={onBurn}
            />
          ))}
          <button type="button" className="v2-acc-add" onClick={() => onLink(null)}>
            <QrCode size={22} aria-hidden="true" />
            <b>Второй аккаунт</b>
            <span>Вход по QR из мобильного Steam — около минуты. Пароль не нужен.</span>
            <span className="v2-hint">
              Сожжённые матчи у каждого аккаунта свои: второй пройдёт те же матчи заново и поднимет свои гемы —
              ещё одна партия товара за то же время.
            </span>
          </button>
        </div>

        {cur ? <Tune key={cur.id} a={cur} u={u} state={state} active={accs?.active === cur.id} floor={settings?.pace?.floor ?? null} /> : null}
        <Rules settings={settings} />
      </Loadable>

      {open?.kind === 'web' && byId(open.id) ? <WebLinkDialog a={byId(open.id)!} accounts={accs} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'key' && byId(open.id) ? <KeyDialog a={byId(open.id)!} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'unlink' && byId(open.id) ? <UnlinkDialog a={byId(open.id)!} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'unkey' && byId(open.id) ? (
        <ActionDialog
          title="Удалить ключ площадки"
          aside={byId(open.id)!.label}
          rows={[
            { k: 'что удалится', v: 'ключ market.dota2.net этого аккаунта' },
            { k: 'что перестанет работать', v: 'закупка на этот аккаунт', tone: 'warn' },
            { k: 'вернуть', v: 'вставить ключ заново' },
          ]}
          verb="удалить ключ"
          url="/api/accounts/market-key/remove"
          body={{ id: open.id }}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  )
}

// ── карточка ──

function Card({ a, u, active, single, selected, now, onSel, onOpen, onBurn }: {
  a: AccountRow
  u: Unit | undefined
  active: boolean
  single: boolean
  selected: boolean
  now: number
  onSel: () => void
  onOpen: (o: Open) => void
  onBurn: () => void
}) {
  const run = useAction()
  const lamp: Tone = u?.running ? 'ok' : u?.fatal ? 'stop' : u?.enabled ? 'warn' : 'idle'
  const word = u?.running ? 'накручивает' : u?.fatal ? 'встал' : u?.enabled ? 'включён, ждёт' : 'стоит'

  return (
    <article className={'v2-acc-card' + (selected ? ' is-on' : '')} aria-label={'Аккаунт ' + a.label}>
      <header className="v2-acc-h">
        <button type="button" className="v2-acc-who" aria-pressed={selected} onClick={onSel} title="показать настройки и работника этого аккаунта">
          <span className="v2-ava is-lg" aria-hidden="true">
            {a.label.slice(0, 1).toUpperCase()}
            <span className={'v2-acc-lamp is-' + lamp} />
          </span>
          <span className="v2-acc-n">
            <b>{a.label}</b>
            <span className="v2-hint"><span className="v2-id">{a.steamid}</span> · с {day(a.added)}</span>
          </span>
        </button>
        <Rename a={a} />
        <span className="v2-acc-tags">
          {active ? <Chip>активный</Chip> : null}
          <Chip tone={lamp === 'idle' ? undefined : lamp} dot>{word}</Chip>
        </span>
      </header>

      <div className="v2-acc-stats">
        {cells(a, u).map(c => (
          <div key={c.k} className="v2-tile"><span>{c.k}</span><b className="v2-num">{c.v}</b></div>
        ))}
      </div>

      <ul className="v2-acc-checks">
        {checks(a, u, now).map(c => <CheckRow key={c.id} c={c} a={a} onOpen={onOpen} />)}
      </ul>

      <footer className="v2-acc-foot">
        {u?.enabled ? (
          <Btn tone="stop" loading={run.busy} onClick={() => run.run('/api/sender/stop', { id: a.id })}>
            <Square size={13} aria-hidden="true" />Остановить
          </Btn>
        ) : active ? (
          <Btn tone="go" onClick={onBurn}><Play size={14} aria-hidden="true" />Накрутить</Btn>
        ) : (
          <Btn tone="soft" loading={run.busy} onClick={() => run.run('/api/accounts/active', { id: a.id })}>сделать активным</Btn>
        )}
        <span className="v2-hint v2-acc-why">
          {run.error ? <span className="is-stop" role="alert">Не вышло: {run.error}</span>
            : !u?.enabled && !active ? 'накрутка запускается от активного аккаунта — подтверждение считает его очередь'
            : u?.why ?? ''}
        </span>
        <button
          type="button"
          className="v2-linkbtn v2-acc-unlink"
          disabled={single}
          title={single ? 'это единственный аккаунт — сервер не даст его отвязать' : undefined}
          onClick={() => onOpen({ kind: 'unlink', id: a.id })}
        >
          отвязать
        </button>
      </footer>
    </article>
  )
}

const MARK: Record<Tone, typeof Check> = { ok: Check, warn: AlertTriangle, stop: X, idle: Minus }

function CheckRow({ c, a, onOpen }: { c: CheckT; a: AccountRow; onOpen: (o: Open) => void }) {
  const act = useAction()
  const Mark = MARK[c.tone]
  const busy = act.busy
  let buttons: ReactNode = null
  if (c.id === 'game') {
    buttons = (
      <>
        <Btn tone="soft" loading={busy} onClick={() => act.run('/api/accounts/session-check', { id: a.id })} title="перечитать файл сессии — в Steam не ходит">перечитать</Btn>
        <Btn tone={c.tone === 'stop' ? 'go' : 'soft'} onClick={() => onOpen({ kind: 'relink', id: a.id, label: a.label })}>обновить по QR</Btn>
      </>
    )
  } else if (c.id === 'web') {
    const none = !a.web || a.web.state === 'missing' || a.web.state === 'expired'
    buttons = (
      <>
        <Btn tone="soft" loading={busy} disabled={none} title={none ? 'проверять нечего — сначала войдите по QR' : 'один запрос к Steam: выдаст ли он веб-куки'}
          onClick={() => act.run('/api/accounts/web-check', { id: a.id })}>проверить</Btn>
        <Btn tone={c.tone === 'stop' ? 'go' : 'soft'} onClick={() => onOpen({ kind: 'web', id: a.id })}>войти по QR</Btn>
      </>
    )
  } else if (c.id === 'market') {
    const none = !a.market || a.market.state === 'missing'
    buttons = (
      <>
        {!none ? <Btn tone="soft" loading={busy} onClick={() => act.run('/api/accounts/market-key/check', { id: a.id })}>проверить</Btn> : null}
        <Btn tone={none ? 'go' : 'soft'} onClick={() => onOpen({ kind: 'key', id: a.id })}>{none ? 'вставить ключ' : 'заменить'}</Btn>
        {!none ? <Btn tone="soft" onClick={() => onOpen({ kind: 'unkey', id: a.id })}>удалить</Btn> : null}
      </>
    )
  }
  return (
    <li className={'v2-acc-ck is-' + c.tone}>
      <span className="v2-acc-mark" aria-hidden="true"><Mark size={13} strokeWidth={2.25} /></span>
      <span className="v2-acc-ck-t">
        <b>{c.title} · {c.word}</b>
        <span className="v2-hint">{c.hint}</span>
        {act.error ? <span className="v2-hint is-stop" role="alert">Не вышло: {act.error}</span> : null}
      </span>
      {buttons ? <span className="v2-acc-ck-a">{buttons}</span> : null}
    </li>
  )
}

// Переименование — на месте: ✎ → поле, Enter сохраняет, Esc отменяет.
function Rename({ a }: { a: AccountRow }) {
  const [edit, setEdit] = useState<string | null>(null)
  const act = useAction()
  if (edit == null) {
    return <IconBtn label="переименовать" tip="bottom" onClick={() => setEdit(a.label)}><Pencil size={13} aria-hidden="true" /></IconBtn>
  }
  const save = async () => {
    const r: any = await act.run('/api/accounts/rename', { id: a.id, label: edit })
    if (!r?.error) setEdit(null)
  }
  return (
    <span className="v2-acc-rename">
      <input
        autoFocus
        value={edit}
        aria-label={'Новое имя аккаунта «' + a.label + '»'}
        onChange={e => setEdit(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); setEdit(null) } }}
      />
      <Btn tone="soft" loading={act.busy} onClick={save}>ок</Btn>
      {act.error ? <span className="v2-hint is-stop" role="alert">{act.error}</span> : null}
    </span>
  )
}

// ── настройки выбранного аккаунта ──

function Tune({ a, u, state, active, floor }: { a: AccountRow; u: Unit | undefined; state: State; active: boolean; floor: number | null }) {
  const act = useAction()
  const [target, setTarget] = useState(u?.ordered ? String(u.ordered) : u?.target ? String(u.target) : '')
  useEffect(() => { setTarget(u?.ordered ? String(u.ordered) : u?.target ? String(u.target) : '') }, [u?.ordered, u?.target])

  if (!u) {
    return (
      <section className="v2-acc-sec">
        <h2 className="v2-acc-sh">Настройки «{a.label}»</h2>
        <p className="v2-hint">У этого аккаунта ещё нет работника — он появится, когда сервер увидит сессию аккаунта.</p>
      </section>
    )
  }

  const send = (patch: Record<string, unknown>) => act.run('/api/autopilot', { id: a.id, ...patch })
  const available = u.available ?? []
  const chosen = new Set(u.only ?? available.map(g => g.gem))
  const flip = (gem: string) => {
    const next = new Set(chosen)
    next.has(gem) ? next.delete(gem) : next.add(gem)
    // Отмечены все — это и есть «все», список тогда не нужен.
    send({ only: next.size === available.length ? null : [...next] })
  }
  const pics = new Map<string, string>()
  for (const x of state.catalog) if (x.icon) pics.set(x.short, x.icon)
  for (const g of state.mine) if (g.icon) pics.set(g.gem, g.icon)
  // Гемы инвентаря без карты — только у активного: state.mine — его.
  const known = new Set(available.map(g => g.gem))
  const unmapped = active ? state.mine.filter(m => m.gem !== '—' && !known.has(m.gem)).map(m => m.gem) : []
  const t = Number(target)
  const mins = targetMinutes(t, u)

  return (
    <section className="v2-acc-sec">
      <div className="v2-acc-sh-row">
        <h2 className="v2-acc-sh">Настройки «{a.label}»</h2>
        <span className="v2-hint">действуют только на этот аккаунт, применяются сразу</span>
      </div>
      <div className="v2-panel v2-acc-set">
        <div className="v2-acc-row">
          <div className="v2-acc-k">Пауза между отправками<small>«сама» подбирает по замерам{floor != null ? '; ниже ' + nf(floor) + ' мс (пол из общих правил) нельзя' : ''}</small></div>
          <div className="v2-seg" role="group" aria-label="Пауза между отправками">
            <button type="button" aria-pressed={u.auto} onClick={() => send({ auto: true })}>сама</button>
            {pauseChips(floor).map(p => (
              <button key={p.ms} type="button" aria-pressed={!u.auto && !u.even && u.delay === p.ms} disabled={p.below}
                title={p.below ? 'ниже пола паузы из общих правил' : undefined}
                onClick={() => send({ delay: p.ms })}>{p.label}</button>
            ))}
          </div>
        </div>

        <div className="v2-acc-row">
          <div className="v2-acc-k">Цель<small>сколько отправок сделать и встать; пусто — до конца очереди</small></div>
          <div className="v2-acc-inline">
            <label className="v2-buy-field v2-acc-field">
              <input value={target} onChange={e => setTarget(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="до конца" aria-label="Цель в отправках" />
              <span>отпр.</span>
            </label>
            <Btn tone="soft" loading={act.busy} onClick={() => send({ target: target.trim() ? Number(target) : null })}>применить</Btn>
            <span className="v2-hint">
              {t > 0 && mins != null
                ? <>≈ {nf(mins)} мин при нынешней паузе <Chip tone="warn">оценка</Chip></>
                : 'в очереди ' + nf(u.queueLength) + ' — работник встанет, когда она кончится'}
              {u.target ? ' · сейчас: остановлюсь на ' + nf(u.target) : ''}
            </span>
          </div>
        </div>

        <div className="v2-acc-row">
          <div className="v2-acc-k">Разброс счётчиков<small>на сколько партий разложить, чтобы вещи вышли с разными числами</small></div>
          <div className="v2-seg" role="group" aria-label="Разброс счётчиков">
            {WAVES.map(w => (
              <button key={w} type="button" aria-pressed={(u.waves ?? 1) === w}
                onClick={() => send({ waves: w, target: target.trim() ? Number(target) : u.ordered ?? null })}>{w === 1 ? 'нет' : w}</button>
            ))}
          </div>
        </div>

        <div className="v2-acc-row">
          <div className="v2-acc-k">Какие гемы крутить<small>{u.only ? (u.only.length ? 'выбрано ' + nf(chosen.size) + ' из ' + nf(available.length) : 'ничего не выбрано — жечь нечего') : 'все, что лежат в инвентаре'}</small></div>
          <div className="v2-acc-gems">
            {available.length === 0 && unmapped.length === 0 ? <span className="v2-hint">нет гемов, по которым понятно, чьи матчи считать</span> : null}
            {available.map(g => (
              <button key={g.gem} type="button" className="v2-acc-gem" aria-pressed={chosen.has(g.gem)} onClick={() => flip(g.gem)}>
                <i style={{ backgroundImage: pics.get(g.gem) ? `url('${icon(pics.get(g.gem)!, 64)}')` : undefined }} aria-hidden="true" />
                {g.gem}<b className="v2-num">{nf(g.objects)}</b>
              </button>
            ))}
            {unmapped.map(g => (
              <span key={g} className="v2-acc-gem is-na" title="гема нет в карте tools/gem-map.json — непонятно, чьи матчи считать">
                <i aria-hidden="true" />{g}<b>нет в карте</b>
              </span>
            ))}
            {u.only ? <Btn tone="soft" onClick={() => send({ only: null })}>все</Btn> : null}
          </div>
        </div>
        {act.error ? <p className="v2-note is-stop" role="alert">Не вышло: {act.error}</p> : null}
      </div>
    </section>
  )
}

// ── общие правила ──

const RULES = [
  { path: 'goal', label: 'Цель счётчика', hint: 'с какого числа вещь считается товаром', unit: 'просм.', scale: 1 },
  { path: 'tick', label: 'Как часто проверять инвентарь', hint: 'работник заглядывает в Steam раз в', unit: 'с', scale: 1_000 },
  { path: 'pace.floor', label: 'Пол паузы', hint: 'ниже не опустится ни один аккаунт', unit: 'мс', scale: 1 },
] as const

function Rules({ settings }: { settings: Settings | null }) {
  const act = useAction()
  const [draft, setDraft] = useState<Record<string, string>>({})
  const value = (path: string) => {
    if (!settings) return null
    const [p, q] = path.split('.')
    const v = q ? (settings as any)[p]?.[q] : (settings as any)[p]
    return typeof v === 'number' ? v : null
  }
  const save = async (r: typeof RULES[number]) => {
    const raw = draft[r.path]
    if (raw === undefined) return
    const n = Number(raw.replace(/\s/g, '').replace(',', '.'))
    if (!Number.isFinite(n)) return
    const [p, q] = r.path.split('.')
    const v = n * r.scale
    const res: any = await act.run('/api/settings', q ? { [p]: { [q]: v } } : { [p]: v })
    if (!res?.error) setDraft(d => { const x = { ...d }; delete x[r.path]; return x })
  }
  return (
    <section className="v2-acc-sec">
      <div className="v2-acc-sh-row">
        <h2 className="v2-acc-sh">Общие правила</h2>
        <span className="v2-hint">на все аккаунты сразу <Src>настройки</Src></span>
      </div>
      <div className="v2-acc-rules">
        {RULES.map(r => {
          const v = value(r.path)
          const changed = draft[r.path] !== undefined
          return (
            <div key={r.path} className="v2-panel v2-acc-rule">
              <div className="v2-acc-k">{r.label}<small>{r.hint}</small></div>
              <div className="v2-acc-inline">
                <label className="v2-buy-field v2-acc-field">
                  <input
                    value={draft[r.path] ?? (v == null ? '' : String(v / r.scale))}
                    placeholder={v == null ? 'нет данных' : undefined}
                    onChange={e => setDraft(d => ({ ...d, [r.path]: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') save(r) }}
                    inputMode="decimal"
                    aria-label={r.label}
                  />
                  <span>{r.unit}</span>
                </label>
                <Btn tone={changed ? 'go' : 'soft'} className="v2-acc-save" disabled={!changed} loading={act.busy && changed} onClick={() => save(r)}>сохранить</Btn>
              </div>
            </div>
          )
        })}
      </div>
      {act.error ? <p className="v2-note is-stop" role="alert">Сервер не принял: {act.error}</p> : null}
    </section>
  )
}
