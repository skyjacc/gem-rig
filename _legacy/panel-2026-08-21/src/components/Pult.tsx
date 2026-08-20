import { useEffect, useRef, useState } from 'react'
import type { State } from '../lib/types.ts'
import { post } from '../lib/live.ts'

// Пульт. Один экран, который отвечает на три вопроса:
//   идёт ли работа, сколько осталось, и требует ли что-то меня.
//
// Работник крутится сам: смотрит инвентарь, пересобирает очередь, держит
// отправщик живым. Человеку остаётся купить гем и посмотреть сюда.
//
// Палитра — та же нейтральная shadcn, что и на Roadmap. Держим локально,
// чтобы не переписывать разом остальные вкладки.
const SKIN = `
.pt {
  --bg: oklch(14.5% 0 0);
  --card: oklch(17% 0 0);
  --card-hi: oklch(20% 0 0);
  --fg: oklch(98.5% 0 0);
  --muted: oklch(63% 0 0);
  --faint: oklch(45% 0 0);
  --border: oklch(26.9% 0 0);
  --ring: oklch(43.9% 0 0);
  --ok: oklch(72% 0.16 155);
  --run: oklch(70% 0.15 235);
  --warn: oklch(78% 0.15 85);
  --stop: oklch(64% 0.21 27);
  --radius: 0.625rem;
  color: var(--fg);
}
.pt-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.pt-head {
  font-size: 10px;
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--muted);
}
.pt-num { font-variant-numeric: tabular-nums; font-weight: 700; letter-spacing: -.02em; }
.pt-switch {
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card-hi);
  width: 62px; height: 32px;
  position: relative;
  cursor: pointer;
  transition: background .18s, border-color .18s;
}
.pt-switch[data-on="true"] { background: var(--ok); border-color: var(--ok); }
.pt-knob {
  position: absolute; top: 3px; left: 3px;
  width: 24px; height: 24px; border-radius: 999px;
  background: var(--fg);
  transition: transform .18s cubic-bezier(.2,.8,.2,1);
}
.pt-switch[data-on="true"] .pt-knob { transform: translateX(30px); }
.pt-bar { height: 6px; border-radius: 999px; background: var(--card-hi); overflow: hidden; }
.pt-bar > i { display: block; height: 100%; border-radius: 999px; transition: width .4s ease; }
.pt-row:hover { background: var(--card-hi); }
.pt-btn {
  border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px);
  background: var(--card-hi); color: var(--fg);
  padding: 5px 12px; font-size: 11px; cursor: pointer;
  transition: border-color .15s, color .15s;
}
.pt-btn:hover { border-color: var(--ring); }
.pt-btn[data-on="true"] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
`

const nf = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

const ago = (ts: number, now: number) => {
  if (!ts) return 'никогда'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return s + ' с назад'
  if (s < 3600) return Math.round(s / 60) + ' мин назад'
  return Math.round(s / 3600) + ' ч назад'
}

const hms = (min: number) => {
  if (!min) return '—'
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? h + ' ч ' + m + ' мин' : m + ' мин'
}

const PACE: [number, string][] = [[1000, '1 с'], [2000, '2 с'], [5000, '5 с'], [30000, '30 с']]

type Alert = { level: 'stop' | 'warn'; text: string }

// Что должен увидеть человек, не читая логов. Порядок — по срочности.
function alerts(state: State, now: number): Alert[] {
  const a: Alert[] = []
  const ap = state.autopilot
  const goal = ap.goal || 2000

  if (ap.action === 'halt') a.push({ level: 'stop', text: 'работник остановился сам: ' + ap.why })
  if (ap.failures > 0) a.push({ level: 'warn', text: 'отправщик не запустился ' + ap.failures + ' раз подряд' })
  if (state.inv.error) a.push({ level: 'stop', text: 'Steam: ' + state.inv.error })
  if (state.inv.age != null && state.inv.age > 300) {
    a.push({ level: 'warn', text: 'инвентарь не читался ' + Math.round(state.inv.age / 60) + ' мин' })
  }
  if (!state.keys.opendota) a.push({ level: 'warn', text: 'нет ключа OpenDota — новые сущности не подтянутся' })

  if (ap.enabled && state.sender.running && state.confirmed && now - state.confirmed.ts > 120_000) {
    a.push({ level: 'warn', text: 'больше двух минут без подтверждений' })
  }
  if (!ap.enabled && state.sender.running) {
    a.push({ level: 'warn', text: 'отправщик запущен вручную — работник его не ведёт' })
  }

  for (const m of state.mine) {
    if (m.gem === '—') continue
    if (!m.entityId || !m.kind || m.kind === 'unknown') {
      a.push({ level: 'warn', text: m.gem + ': сущность не опознана, в очередь не попадёт' })
      continue
    }
    if (m.supply != null && m.supply < goal) {
      a.push({ level: 'warn', text: m.gem + ': матчей всего ' + nf(m.supply) + ' — до ' + goal + ' не дойдёт' })
    }
  }
  return a
}

export function Pult({ state }: { state: State }) {
  const ap = state.autopilot
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const log = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight }, [state.sender.lines.length])

  const goal = ap.goal || 2000
  const live = ap.enabled && state.sender.running
  const warns = alerts(state, now)
  const owned = state.mine.filter(m => m.gem !== '—')

  // Товар: сколько вещей уже перевалило за цель. Одна отправка поднимает все,
  // поэтому считаем именно вещи, а не гемы.
  const ready = owned.reduce((n, m) => n + (m.max >= goal ? m.items : 0), 0)
  const total = owned.reduce((n, m) => n + m.items, 0)

  const toggle = async () => {
    setBusy(true)
    setErr(null)
    const r = await post('/api/autopilot', { on: !ap.enabled, delay: ap.delay })
    if (r?.error) setErr(String(r.error))
    setBusy(false)
  }

  return (
    <div className="pt py-5">
      <style>{SKIN}</style>

      {/* тумблер и причина */}
      <div className="pt-card mb-4 flex items-center gap-4 p-4">
        <div
          className="pt-switch shrink-0"
          data-on={ap.enabled}
          role="switch"
          aria-checked={ap.enabled}
          tabIndex={0}
          onClick={() => { if (!busy) toggle() }}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!busy) toggle() } }}
        >
          <span className="pt-knob" />
        </div>

        <div className="min-w-0">
          <div className="text-[17px] font-semibold leading-tight">
            {ap.enabled ? 'работник включён' : 'работник выключен'}
            {live && (
              <span
                className="ml-2 inline-block h-[7px] w-[7px] animate-pulse rounded-full align-middle"
                style={{ background: 'var(--ok)' }}
              />
            )}
          </div>
          <div className="truncate text-[12px]" style={{ color: 'var(--muted)' }}>
            {ap.enabled ? ap.why : 'включите — очередь соберётся сама, ни одного сообщения до этого не уйдёт'}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {PACE.map(([ms, label]) => (
            <button
              key={ms}
              className="pt-btn"
              data-on={ap.delay === ms}
              onClick={() => post('/api/autopilot', { on: ap.enabled, delay: ms })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {err && <div className="mb-4 text-[12px]" style={{ color: 'var(--stop)' }}>{err}</div>}

      {/* цифры */}
      <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="в очереди"
          value={nf(ap.queueLength)}
          note={ap.rebuiltAt ? 'собрана ' + ago(ap.rebuiltAt, now) : 'ещё не собиралась'}
        />
        <Metric
          label="до конца очереди"
          value={hms(ap.etaMinutes)}
          note={'при паузе ' + ap.delay / 1000 + ' с'}
        />
        <Metric
          label="темп"
          value={state.rate ? state.rate + ' / мин' : '—'}
          note="за последние 2 минуты"
        />
        <Metric
          label="последнее подтверждение"
          value={state.confirmed ? ago(state.confirmed.ts, now) : 'нет'}
          note={state.confirmed ? 'матч ' + state.confirmed.match_id : 'ещё ни одного'}
          tone={state.confirmed && now - state.confirmed.ts < 15_000 ? 'ok' : undefined}
        />
      </div>

      {/* товар */}
      <div className="pt-card mb-4">
        <div className="flex items-baseline gap-3 border-b px-4 py-2.5" style={{ borderColor: 'var(--border)' }}>
          <span className="pt-head">товар</span>
          <span className="ml-auto text-[11px]" style={{ color: 'var(--muted)' }}>
            {nf(ready)} из {nf(total)} вещей за {nf(goal)}
          </span>
        </div>

        {owned.length === 0 ? (
          <div className="px-4 py-6 text-[12px]" style={{ color: 'var(--muted)' }}>
            гемов в инвентаре нет. Купите — работник заметит сам в течение минуты.
          </div>
        ) : (
          <div className="py-1">
            {owned.map(m => {
              const pct = Math.min(100, (m.max / goal) * 100)
              const done = m.max >= goal
              const inQueue = ap.gems.some(g => g.gem === m.gem)
              return (
                <div key={m.gem} className="pt-row grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-2">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-[13px]">{m.gem}</span>
                    <span className="text-[11px]" style={{ color: 'var(--faint)' }}>×{m.items}</span>
                    {!inQueue && ap.enabled && (
                      <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--faint)' }}>
                        не в очереди
                      </span>
                    )}
                  </div>
                  <div className="pt-num text-[13px]">
                    <span style={{ color: done ? 'var(--ok)' : 'var(--fg)' }}>{nf(m.max)}</span>
                    <span style={{ color: 'var(--faint)' }}> / {nf(goal)}</span>
                    {m.supply != null && (
                      <span className="ml-3 text-[11px]" style={{ color: 'var(--faint)' }}>
                        потолок {nf(m.supply)}
                        {m.supplyKind === 'estimated' && ' (оценка)'}
                        {m.left != null && ' · осталось ' + nf(m.left)}
                      </span>
                    )}
                  </div>
                  <div className="pt-bar col-span-2">
                    <i style={{ width: pct + '%', background: done ? 'var(--ok)' : 'var(--run)' }} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* внимание */}
        <div className="pt-card">
          <div className="flex items-baseline gap-3 border-b px-4 py-2.5" style={{ borderColor: 'var(--border)' }}>
            <span className="pt-head">требует внимания</span>
            <span className="ml-auto text-[11px]" style={{ color: 'var(--muted)' }}>{warns.length || 'чисто'}</span>
          </div>
          {warns.length === 0 ? (
            <div className="px-4 py-6 text-[12px]" style={{ color: 'var(--muted)' }}>ничего не требует вмешательства</div>
          ) : (
            <div className="py-1">
              {warns.map((w, i) => (
                <div key={i} className="flex items-baseline gap-2.5 px-4 py-1.5 text-[12px]">
                  <span
                    className="h-[6px] w-[6px] shrink-0 translate-y-[-1px] rounded-full"
                    style={{ background: w.level === 'stop' ? 'var(--stop)' : 'var(--warn)' }}
                  />
                  <span>{w.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* решения работника */}
        <div className="pt-card">
          <div className="flex items-baseline gap-3 border-b px-4 py-2.5" style={{ borderColor: 'var(--border)' }}>
            <span className="pt-head">что делал работник</span>
            <span className="ml-auto text-[11px]" style={{ color: 'var(--muted)' }}>
              смотрел {ap.lastTick ? ago(ap.lastTick, now) : '—'}
            </span>
          </div>
          {ap.log.length === 0 ? (
            <div className="px-4 py-6 text-[12px]" style={{ color: 'var(--muted)' }}>решений ещё не было</div>
          ) : (
            <div className="max-h-[220px] overflow-auto py-1">
              {ap.log.map((l, i) => (
                <div key={l.ts + ':' + i} className="flex items-baseline gap-3 px-4 py-1 text-[12px]">
                  <span className="pt-num shrink-0 text-[11px]" style={{ color: 'var(--faint)' }}>
                    {new Date(l.ts).toLocaleTimeString('ru-RU')}
                  </span>
                  <span className="truncate">{l.why}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* сырой вывод отправщика — на случай разбора */}
      {state.sender.lines.length > 0 && (
        <details className="pt-card mt-4">
          <summary className="cursor-pointer px-4 py-2.5">
            <span className="pt-head">вывод отправщика</span>
            <span className="ml-3 text-[11px]" style={{ color: 'var(--muted)' }}>
              {state.sender.running ? 'pid ' + state.sender.pid : state.sender.exit ?? 'остановлен'}
            </span>
          </summary>
          <div
            ref={log}
            className="max-h-[220px] overflow-auto border-t px-4 py-2 text-[11px] leading-[1.5]"
            style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
          >
            {state.sender.lines.map((l, i) => <div key={i} className="whitespace-pre-wrap">{l}</div>)}
          </div>
        </details>
      )}

      <p className="mt-4 max-w-[820px] text-[12px]" style={{ color: 'var(--muted)' }}>
        Работник смотрит инвентарь каждые 20 секунд. Купленный гем попадает в очередь сам,
        нажимать ничего не нужно. Одна отправка поднимает все подходящие вещи разом —
        поэтому второй и десятый экземпляр гема стоят ноль отправок.
      </p>
    </div>
  )
}

function Metric({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'ok' }) {
  return (
    <div className="pt-card p-4">
      <div className="pt-head">{label}</div>
      <div className="pt-num mt-1.5 text-[26px] leading-none" style={{ color: tone === 'ok' ? 'var(--ok)' : 'var(--fg)' }}>
        {value}
      </div>
      {note && <div className="mt-1.5 text-[11px]" style={{ color: 'var(--faint)' }}>{note}</div>}
    </div>
  )
}
