// Окно «Настроить» (§5.7, план 9, решение 1) — замена прежнего parts/Tune.tsx.
//
// Боковое окно справа, две вкладки:
//   «этот аккаунт»   — работник на пульте (активный аккаунт); применяется
//                      сразу, POST /api/autopilot — как прежде;
//   «общие правила» — 20 полей прежнего RULES с теми же подписями, единицами
//                      и масштабами; правка копится, «Сохранить» — одним
//                      POST /api/settings. Сервер сливает правку с текущими
//                      правилами и зажимает в свои пределы — принятое
//                      показывается, поправленное называется словами.
// Сброс всех правил к умолчаниям — только через подтверждение.
//
// Закрывается по Esc и по фону (§5.7: необратимого здесь нет); несохранённая
// правка правил при закрытии пропадает — об этом сказано у кнопки.

import { useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { icon, nf, useAction, type Settings, type State, type Unit } from '../lib/api.ts'
import { Btn, IconBtn } from './ui.tsx'
import { ActionDialog } from './Dialog.tsx'
import { useTrap } from './useTrap.ts'
import { afterSave, get, GROUPS, patchOf, SHARED, shown, type Rule } from './tuneModel.ts'

export type TuneTab = 'run' | 'rules'

// Значения кнопок — те же, что в прежнем окне (перенос, не новые числа).
// Круглые цели — именами: grep целей по src/v2 должен быть пуст (§3.2).
const PACE: [number, string][] = [[500, '0,5 с'], [1_000, '1 с'], [2_000, '2 с'], [5_000, '5 с'], [30_000, '30 с']]
const TARGETS: (number | null)[] = [100, 500, 2_000, null]
const CAPS = [0, 500, 1_000, 1_500, 2_000]
const WAVES = [1, 2, 3, 4, 5]
const HOUR = 3_600_000

const secs = (ms: number) =>
  ms >= 60_000 ? Math.round(ms / 60_000) + ' мин' : (ms / 1_000).toFixed(ms >= 10_000 ? 0 : 1).replace('.', ',') + ' с'

// Срок — кнопкой: ночью проще ткнуть «до утра», чем вспоминать число.
function untilFrom(id: string): number {
  const now = Date.now()
  if (id === '2ч') return now + 2 * HOUR
  if (id === '8ч') return now + 8 * HOUR
  if (id === 'утро') {
    const d = new Date()
    d.setHours(10, 0, 0, 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  return 0
}
function untilLabel(until: number) {
  if (!until) return 'нет'
  const d = new Date(until)
  if (d.getHours() === 10 && d.getMinutes() === 0) return 'утро'
  return (until - Date.now()) / HOUR > 5 ? '8ч' : '2ч'
}
function left(until: number) {
  const ms = until - Date.now()
  if (ms <= 0) return 'срок вышел'
  const h = Math.floor(ms / HOUR)
  const m = Math.round((ms % HOUR) / 60_000)
  return h ? h + ' ч ' + m + ' мин' : m + ' мин'
}

export function TuneSheet({ tab, onTab, onClose, state, settings, onSaved, owner = true }: {
  tab: TuneTab
  onTab: (t: TuneTab) => void
  onClose: () => void
  state: State
  settings: Settings | null
  onSaved: () => void
  // Владелец меняет и общие ограничения сервера; пользователь — только свои (план 7.3).
  owner?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  useTrap(box, onClose, !confirmReset)
  const unit = state.autopilot
  return (
    <div className="v2-veil v2-sheet-veil" onMouseDown={e => { if (e.target === e.currentTarget && !confirmReset) onClose() }}>
      <div ref={box} className="v2-sheet" role="dialog" aria-modal="true" aria-labelledby="v2-tune-title">
        <header className="v2-sheet-head">
          <div>
            <h2 id="v2-tune-title">Настройка</h2>
            <span className="v2-hint">{tab === 'run' ? unit.label : 'на все аккаунты сразу'}</span>
          </div>
          <IconBtn label="закрыть" tip="bottom-end" onClick={onClose}><X size={16} aria-hidden="true" /></IconBtn>
        </header>
        <div className="v2-seg v2-sheet-tabs" role="tablist" aria-label="Что настраивать">
          <button type="button" role="tab" aria-selected={tab === 'run'} aria-pressed={tab === 'run'} onClick={() => onTab('run')}>этот аккаунт</button>
          <button type="button" role="tab" aria-selected={tab === 'rules'} aria-pressed={tab === 'rules'} onClick={() => onTab('rules')}>общие правила</button>
        </div>
        <div className="v2-sheet-body" role="tabpanel">
          {tab === 'run' ? <Run state={state} unit={unit} floor={settings?.pace?.floor ?? null} />
            : <Rules settings={settings} onSaved={onSaved} onReset={() => setConfirmReset(true)} owner={owner} />}
        </div>
      </div>
      {confirmReset ? (
        <ActionDialog
          title="Сбросить все правила"
          aside="к значениям по умолчанию"
          rows={[
            { k: 'что изменится', v: 'все 20 общих правил вернутся к умолчаниям', tone: 'warn' },
            { k: 'что не изменится', v: 'настройки работников аккаунтов, ключи, сессии' },
            { k: 'вернуть', v: 'ввести значения заново' },
          ]}
          verb="сбросить правила"
          url="/api/settings/reset"
          body={{}}
          onClose={() => { setConfirmReset(false); onSaved() }}
        />
      ) : null}
    </div>
  )
}

function Line({ k, hint, children }: { k: string; hint?: string; children: ReactNode }) {
  return (
    <div className="v2-tune-line">
      <div className="v2-acc-k">{k}{hint ? <small>{hint}</small> : null}</div>
      {children}
    </div>
  )
}

function Seg<T extends string>({ label, value, items, onPick }: { label: string; value: T; items: { id: T; label: string; disabled?: boolean; title?: string }[]; onPick: (id: T) => void }) {
  return (
    <div className="v2-seg v2-tune-seg" role="group" aria-label={label}>
      {items.map(i => (
        <button key={i.id} type="button" aria-pressed={value === i.id} disabled={i.disabled} title={i.title} onClick={() => onPick(i.id)}>{i.label}</button>
      ))}
    </div>
  )
}

// ── этот аккаунт ──

function Run({ state, unit, floor }: { state: State; unit: Unit; floor: number | null }) {
  const act = useAction()
  // «Ввожу своё» — отдельно от текста: стёртое до конца число не должно
  // возвращать прежний набор прямо под руками.
  const [own, setOwn] = useState<string | null>(null)
  const send = (patch: Record<string, unknown>) => act.run('/api/autopilot', { id: unit.id, ...patch })
  const available = unit.available ?? []
  const only = unit.only ?? null
  const chosen = new Set(only ?? available.map(g => g.gem))
  const icons = new Map(state.mine.filter(m => m.gem !== '—').map(m => [m.gem, m.icon]))
  const flip = (gem: string) => {
    const next = new Set(chosen)
    next.has(gem) ? next.delete(gem) : next.add(gem)
    send({ only: next.size === available.length ? null : [...next] })
  }

  return (
    <div className="v2-tune">
      <Line k="Сколько отправок" hint="и встать; «всё» — до конца очереди">
        <div className="v2-acc-inline">
          <Seg
            label="Сколько отправок"
            value={own === null ? String(unit.ordered ?? null) : 'own'}
            items={[...TARGETS.map(t => ({ id: String(t), label: t === null ? 'всё' : nf(t) })), { id: 'own', label: 'своё' }]}
            onPick={id => {
              if (id === 'own') { setOwn(String(unit.ordered ?? 250)); return }
              setOwn(null)
              send({ target: id === 'null' ? null : Number(id) })
            }}
          />
          {own !== null ? (
            <>
              <label className="v2-buy-field v2-acc-field"><input value={own} onChange={e => setOwn(e.target.value.replace(/\D/g, ''))} inputMode="numeric" aria-label="Своё число отправок" /></label>
              <Btn tone="soft" disabled={!own} onClick={() => send({ target: Number(own) })}>применить</Btn>
            </>
          ) : null}
        </div>
        {unit.target ? (
          <p className="v2-hint">остановлюсь на <b className="v2-num">{nf(unit.target)}</b>{unit.ordered && unit.ordered !== unit.target ? ' — заказ ' + nf(unit.ordered) + ', круглые числа выдают накрутку' : ''}</p>
        ) : null}
      </Line>

      <Line k="Работать до" hint="ночной прогон удобнее задавать сроком: сколько успеется, столько и хорошо">
        <Seg
          label="Работать до"
          value={untilLabel(unit.until ?? 0)}
          items={[{ id: 'нет', label: 'без срока' }, { id: '2ч', label: '2 ч' }, { id: '8ч', label: '8 ч' }, { id: 'утро', label: 'до 10 утра' }]}
          onPick={id => send({ until: untilFrom(id) })}
        />
        {unit.until ? (
          <p className="v2-hint">встану в <b className="v2-num">{new Date(unit.until).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</b> · осталось {left(unit.until)}</p>
        ) : null}
      </Line>

      <Line k="Докуда вести каждый гем" hint="дойдя до потолка, гем выходит из работы, а его матчи остаются целыми">
        <Seg label="Докуда вести каждый гем" value={String(unit.cap ?? 0)} items={CAPS.map(c => ({ id: String(c), label: c === 0 ? 'весь запас' : nf(c) }))} onPick={id => send({ cap: Number(id) })} />
        {(unit.caps ?? []).length ? (
          <div className="v2-tune-chips">
            {unit.caps!.map(c => <span key={c.gem} className={(unit.capped ?? []).includes(c.gem) ? 'is-ok' : undefined}>{c.gem} <b className="v2-num">{nf(c.cap)}</b></span>)}
          </div>
        ) : null}
        {(unit.capped ?? []).length ? <p className="v2-hint">дошли: {unit.capped!.join(', ')}</p> : null}
        <p className="v2-hint">у каждого гема потолок свой и некруглый — счётчики выходят разными сами собой</p>
      </Line>

      <Line k="Разброс" hint="партиями, чтобы счётчики вышли разными, а не одинаковыми">
        <Seg label="Разброс" value={String(unit.waves ?? 1)} items={WAVES.map(w => ({ id: String(w), label: w === 1 ? 'нет' : String(w) }))} onPick={id => send({ waves: Number(id), target: unit.ordered ?? null })} />
        {(unit.plan ?? []).length > 1 ? (
          <div className="v2-tune-chips">
            {unit.plan!.map(w => <span key={w.index}><b className="v2-num">{nf(w.value)}</b> {w.addAt === 0 ? 'сразу' : '+' + nf(w.addAt)}</span>)}
          </div>
        ) : null}
      </Line>

      <Line k="Пауза" hint="«к сроку» делит работу на оставшееся время; «сама» гонит, пока Valve отвечает">
        <div className="v2-acc-inline">
          <Seg
            label="Пауза"
            value={unit.even && unit.until ? 'even' : unit.auto ? 'auto' : String(unit.delay)}
            items={[
              { id: 'even', label: 'к сроку' },
              { id: 'auto', label: 'сама' },
              ...PACE.map(([ms, l]) => ({ id: String(ms), label: l, disabled: floor != null && ms < floor, title: floor != null && ms < floor ? 'ниже пола паузы из общих правил' : undefined })),
            ]}
            onPick={id => send(id === 'even' ? { even: true } : id === 'auto' ? { even: false, auto: true } : { even: false, delay: Number(id) })}
          />
          <span className="v2-hint v2-num">{nf(unit.delay)} мс</span>
        </div>
        <p className="v2-hint">ниже пола из общих правил не опустится никогда · выбранное здесь отменяет подбор на ходу · «к сроку» и «сама» не работают вместе</p>
        {unit.even && !unit.until ? <p className="v2-note is-warn">Делить не на что — задайте срок выше.</p> : null}
        {unit.even && unit.until ? (
          <p className="v2-hint">осталось <b className="v2-num">{nf(unit.sendsLeft ?? 0)}</b> отправок на {left(unit.until)} — по одной в <b className="v2-num">{secs(unit.delay)}</b></p>
        ) : state.autopilot.pace && unit.auto ? <p className="v2-hint">{state.autopilot.pace.why}</p> : null}
      </Line>

      <Line k="Какие гемы накручивать" hint={only ? (only.length ? 'выбрано ' + only.length + ' из ' + available.length : 'ничего не выбрано — жечь нечего') : 'все, что лежат в инвентаре'}>
        {available.length === 0 ? <p className="v2-hint">нет гемов, по которым понятно, чьи матчи считать</p> : (
          <div className="v2-acc-gems">
            {available.map(g => (
              <button key={g.gem} type="button" className="v2-acc-gem" aria-pressed={chosen.has(g.gem)} onClick={() => flip(g.gem)}>
                <i style={{ backgroundImage: icons.get(g.gem) ? `url('${icon(icons.get(g.gem)!, 64)}')` : undefined }} aria-hidden="true" />
                {g.gem}<b className="v2-num">{nf(g.objects)}</b>
              </button>
            ))}
            {only ? <Btn tone="soft" onClick={() => send({ only: null })}>все</Btn> : null}
          </div>
        )}
      </Line>
      {act.error ? <p className="v2-note is-stop" role="alert">Не вышло: {act.error}</p> : null}
    </div>
  )
}

// ── общие правила ──

function Rules({ settings, onSaved, onReset, owner }: { settings: Settings | null; onSaved: () => void; onReset: () => void; owner: boolean }) {
  const act = useAction()
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [more, setMore] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const all = GROUPS.flatMap(g => g.rules)
  const changed = Object.keys(draft).filter(k => {
    const r = all.find(x => x.path === k)
    return r && settings && draft[k] !== shown(r, Number(get(settings, k)))
  })
  if (!settings) return <p className="v2-hint">Правила загружаются…</p>

  const save = async () => {
    const sent = Object.fromEntries(changed.map(k => [k, draft[k]]))
    const { patch, bad } = patchOf(sent, all)
    if (bad.length) { setNote('Не число: ' + bad.join(', ')); return }
    const res: any = await act.run('/api/settings', patch)
    if (res?.error) return
    // Сервер зажимает в свои пределы — называем поправленное словами.
    const fixed = changed.map(k => {
      const r = all.find(x => x.path === k)!
      const accepted = get(res, k)
      return typeof accepted === 'number' && shown(r, accepted) !== String(Number(sent[k].replace(',', '.'))) ? r.label + ': ' + sent[k] + ' → ' + shown(r, accepted) : null
    }).filter(Boolean)
    setNote(fixed.length ? 'Сохранено; сервер поправил по своим пределам — ' + fixed.join('; ') : 'Сохранено.')
    setDraft(d => afterSave(d, sent))
    onSaved()
  }

  const row = (r: Rule) => {
    const v = draft[r.path] ?? shown(r, Number(get(settings, r.path)))
    const isChanged = changed.includes(r.path)
    const shared = !owner && SHARED.includes(r.path)
    return (
      <div key={r.path} className={'v2-tune-rule' + (isChanged ? ' is-changed' : '')}>
        <div className="v2-acc-k">{r.label}<small>{shared ? 'общее ограничение сервера — меняет владелец' : !owner && r.path === 'pace.floor' ? r.hint + '; не ниже общего пола сервера' : r.hint}</small></div>
        <label className="v2-buy-field v2-tune-field">
          <input value={v} placeholder="нет данных" readOnly={shared} onChange={e => { setDraft(d => ({ ...d, [r.path]: e.target.value })); setNote(null) }} inputMode="decimal" aria-label={r.label} />
          <span>{r.unit ?? ''}</span>
        </label>
      </div>
    )
  }

  return (
    <div className="v2-tune">
      {GROUPS.map(g => g.more && !more ? null : (
        <section key={g.title} className="v2-tune-group" aria-label={g.title}>
          <h3>{g.title}</h3>
          {g.rules.map(row)}
        </section>
      ))}
      <button type="button" className="v2-linkbtn" aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'скрыть остальное' : 'показать все'}</button>
      {note ? <p className={'v2-note ' + (note.startsWith('Не число') ? 'is-stop' : '')} role="status">{note}</p> : null}
      {act.error ? <p className="v2-note is-stop" role="alert">Сервер не принял: {act.error}. Правка не потеряна.</p> : null}
      <div className="v2-tune-foot">
        <span className="v2-hint">{changed.length ? 'изменено ' + changed.length + ' · несохранённое пропадёт при закрытии' : 'изменений нет'}</span>
        <Btn tone="soft" disabled={!changed.length} onClick={() => { setDraft({}); setNote(null) }}>сбросить правки</Btn>
        <Btn tone="go" className="v2-acc-save" disabled={!changed.length} loading={act.busy} onClick={save}>Сохранить</Btn>
      </div>
      <p className="v2-hint v2-tune-defaults">
        Значения по умолчанию — замер 20 августа: 76 отправок в минуту при паузе в секунду, отклик GC 340 мс по медиане.{' '}
        <button type="button" className="v2-linkbtn" onClick={onReset}>сбросить все правила к умолчаниям…</button>
      </p>
    </div>
  )
}
