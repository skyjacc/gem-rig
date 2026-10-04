// Холст Обзора, режим «дерево» (§5.1, макет 1-obzor.html):
// аккаунт слева → столбец гемов → веер вещей выбранного гема справа.
//
// Раскладка — фиксированная сетка макета; холст вписывается в видимую
// область сам, зум только масштабирует (transform на самом полотне, не на
// наведении — §3.1 не нарушается). Статус гема — gemStatus() из lib/worker.ts,
// те же условия, что в тревогах. Цель — только из настроек.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { icon, nf, plural, type Accounts, type State } from '../../lib/api.ts'
import { gemStatus, type GemStatus } from '../../lib/worker.ts'
import { Chip, IconBtn } from '../ui.tsx'

type Gem = State['mine'][number]

// Сетка макета.
const W = 960
const AX = 20, AW = 220                      // аккаунт
const GX = 340, GW = 236, GH = 66, GAP = 82  // гемы
const IX = 730, IH = 40, IGAP = 48           // вещи
const TOP = 34
const gy = (i: number) => TOP + i * GAP

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const mx = (x1 + x2) / 2
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
}

const things = (n: number) => nf(n) + ' ' + plural(n, 'вещь', 'вещи', 'вещей')

// Порядок столбца: в работе → прочие нормальные → не дойдёт → нет в карте;
// внутри группы — по лучшему счётчику вниз.
export function orderGems(mine: Gem[], goal: number | null, picked: Set<string>) {
  const rank = (m: Gem) => {
    const s = gemStatus(m, goal)
    return s === 'map' ? 3 : s === 'reach' ? 2 : picked.has(m.gem) ? 0 : 1
  }
  return mine.filter(m => m.gem !== '—').sort((a, b) => rank(a) - rank(b) || b.max - a.max || a.gem.localeCompare(b.gem))
}

// Какой гем показан: выбранный, а если не выбран или пропал — первый в столбце.
// Одна функция и для холста, и для инспектора — чтобы они не разошлись.
export function currentGem(state: State, goal: number | null, sel: string | null) {
  const gems = orderGems(state.mine, goal, new Set(state.autopilot.picked ?? []))
  return gems.find(g => g.gem === sel) ?? gems[0] ?? null
}

// Уважает ли человек «уменьшить движение»: SVG-импульсы CSS не гасит,
// поэтому их просто не рисуем. Им же пользуется конвейер Скупки.
export function useCalm() {
  const q = '(prefers-reduced-motion: reduce)'
  const [calm, setCalm] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const m = matchMedia(q)
    const on = () => setCalm(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return calm
}

const SESSION: Record<string, { word: string; tone: 'ok' | 'warn' | 'stop' }> = {
  ok: { word: 'сессия жива', tone: 'ok' },
  revoked: { word: 'сессия отозвана', tone: 'stop' },
  error: { word: 'сессию не проверить', tone: 'warn' },
  missing: { word: 'сессии нет', tone: 'stop' },
}

export function Canvas({ state, accounts, goal, sel, onSel }: {
  state: State
  accounts: Accounts | null
  goal: number | null
  sel: string | null
  onSel: (gem: string) => void
}) {
  const ap = state.autopilot
  const picked = new Set(ap.picked ?? [])
  const gems = orderGems(state.mine, goal, picked)
  const H = Math.max(620, gy(gems.length) + 8)
  const calm = useCalm()

  const stage = useRef<HTMLDivElement>(null)
  const [fitK, setFitK] = useState(1)
  const [zoom, setZoom] = useState(1)

  // Вписать полотно в видимую область: сверху легенда, снизу пульт.
  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const fit = () => {
      const r = el.getBoundingClientRect()
      if (!r.width) return
      const k = Math.min(1.15, (r.width - 48) / W, (r.height - 48) / H)
      if (k > 0.2) setFitK(k)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [H])

  const current = currentGem(state, goal, sel)
  const si = current ? gems.indexOf(current) : -1
  const acc = accounts?.list.find(a => a.id === accounts.active)
  const session = SESSION[acc?.sessionState?.state ?? ''] ?? { word: 'сессия не проверена', tone: 'warn' as const }
  const items = gems.reduce((n, m) => n + m.items, 0)

  const AH = 148
  const AY = Math.max(16, Math.min(H - AH - 16, (gems.length ? gy(Math.floor((gems.length - 1) / 2)) + GH / 2 : H / 2) - AH / 2))
  const ay = AY + AH / 2

  const tone = (s: GemStatus) => (s === 'map' ? 'stop' : s === 'reach' ? 'warn' : 'ok')
  const live = (m: Gem) => ap.running && picked.has(m.gem) && gemStatus(m, goal) === 'ok'

  // Стрелки ↑/↓ переводят выбор между гемами (§4.3).
  const btns = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (i: number) => (e: React.KeyboardEvent) => {
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const j = Math.max(0, Math.min(gems.length - 1, i + d))
    onSel(gems[j].gem)
    btns.current[j]?.focus()
  }

  // Веер вещей выбранного гема.
  const fan = (() => {
    if (!current) return null
    const rows = [...current.rows].sort((a, b) => b.value - a.value || Number(b.equipped) - Number(a.equipped))
    const shown = rows.slice(0, current.items > 5 ? 4 : 5)
    const extra = current.items - shown.length
    const count = shown.length + (extra > 0 ? 1 : 0)
    const cy = gy(si) + GH / 2
    const top = Math.max(16, Math.min(H - count * IGAP - 8, cy - (count * IGAP - 8) / 2))
    return { shown, extra, cy, top }
  })()

  const k = fitK * zoom

  return (
    <div className="v2-ov-stage" ref={stage}>
      <div className="v2-ov-board" style={{ width: W, height: H, transform: `translate(-50%, -50%) scale(${k})` }}>
        <svg className="v2-ov-wires" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          {gems.map((m, i) => {
            const s = gemStatus(m, goal)
            const d = curve(AX + AW, ay, GX, gy(i) + GH / 2)
            const on = live(m)
            return (
              <g key={m.gem}>
                {on ? <path className="v2-edge is-live is-glow" d={d} /> : null}
                <path className={'v2-edge' + (on ? ' is-live' : s === 'reach' ? ' is-warn' : s === 'map' ? ' is-stop' : '')} d={d} />
                {on && !calm ? (
                  <circle r="3" className="v2-pulse">
                    <animateMotion dur={1.6 + i * 0.25 + 's'} repeatCount="indefinite" path={d} />
                  </circle>
                ) : null}
              </g>
            )
          })}
          {fan ? (
            <>
              {fan.shown.map((_, k2) => (
                <path key={k2} className="v2-edge is-item is-sel" d={curve(GX + GW, fan.cy, IX, fan.top + k2 * IGAP + IH / 2)} />
              ))}
              {fan.extra > 0 ? <path className="v2-edge is-item" d={curve(GX + GW, fan.cy, IX, fan.top + fan.shown.length * IGAP + IH / 2)} /> : null}
            </>
          ) : null}
        </svg>

        <div className="v2-node v2-node-acct" style={{ left: AX, top: AY, width: AW, height: AH }}>
          <div className="v2-acct-row">
            <span className="v2-ava is-lg" aria-hidden="true">{(ap.label || '?').slice(0, 1).toUpperCase()}</span>
            <div className="v2-acct-name">
              <b>{ap.label}</b>
              <span className="v2-id">{ap.steamid}</span>
            </div>
          </div>
          <div className="v2-acct-chips">
            <Chip tone={ap.running ? 'ok' : undefined} dot>{ap.running ? 'накручивает' : ap.enabled ? 'включён' : 'выключен'}</Chip>
            <Chip tone={session.tone} dot>{session.word}</Chip>
          </div>
          <div className="v2-acct-stats">
            <span><i>вещей</i><b className="v2-num">{nf(items)}</b></span>
            <span><i>гемов</i><b className="v2-num">{nf(gems.length)}</b></span>
            <span><i>сожжено</i><b className="v2-num">{nf(ap.burned)}</b></span>
          </div>
        </div>

        {gems.map((m, i) => {
          const s = gemStatus(m, goal)
          const on = current?.gem === m.gem
          const pct = goal ? Math.min(100, (m.max / goal) * 100) : 0
          return (
            <button
              key={m.gem}
              ref={el => { btns.current[i] = el }}
              type="button"
              className={'v2-node v2-node-gem' + (on ? ' is-on' : '')}
              style={{ left: GX, top: gy(i), width: GW, height: GH }}
              aria-pressed={on}
              onClick={() => onSel(m.gem)}
              onKeyDown={onKey(i)}
            >
              <span className="v2-gem-ico" style={{ backgroundImage: m.icon ? `url('${icon(m.icon, 96)}')` : undefined }} aria-hidden="true" />
              <span className="v2-gem-meta">
                <span className="v2-gem-nm">
                  <span className="v2-gem-name">{m.gem}</span>
                  <span className="v2-gem-cnt v2-num">
                    <b>{nf(m.max)}</b>{goal ? ' / ' + nf(goal) : ' · цель не задана'}
                  </span>
                </span>
                <span className="v2-gem-hr">
                  {s === 'ok'
                    ? (m.heroes || '—') + ' · ' + things(m.items)
                    : <Chip tone={tone(s)} dot>{s === 'reach' ? 'не дойдёт' : 'нет в карте'}</Chip>}
                </span>
                {goal ? <span className="v2-gem-bar" aria-hidden="true"><i style={{ width: Math.max(pct, m.max ? 1.5 : 0) + '%' }} /></span> : null}
              </span>
            </button>
          )
        })}

        {fan && current ? (
          <>
            <span className="v2-elabel" style={{ left: (GX + GW + IX) / 2, top: fan.cy }}>{things(current.items)} · +1 за матч</span>
            {fan.shown.map((r, k2) => (
              <div key={r.assetid} className="v2-node v2-node-item" style={{ left: IX, top: fan.top + k2 * IGAP, height: IH }}>
                <span className="v2-item-ico" style={{ backgroundImage: current.icon ? `url('${icon(current.icon, 64)}')` : undefined }} aria-hidden="true" />
                <span className="v2-item-n" title={r.name}>{r.name}</span>
                {r.equipped ? <span className="v2-item-eq">надето</span> : null}
                <span className="v2-item-v v2-num">{nf(r.value)}</span>
              </div>
            ))}
            {fan.extra > 0 ? (
              <div className="v2-node v2-node-item is-more" style={{ left: IX, top: fan.top + fan.shown.length * IGAP, height: IH }}>
                ещё {nf(fan.extra)} — в инвентаре
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="v2-ov-legend" aria-label="Обозначения">
        <span><i className="is-live" />в работе</span>
        <span><i className="is-warn" />не дойдёт до цели</span>
        <span><i className="is-stop" />нет в карте</span>
      </div>

      <div className="v2-ov-zoom">
        <IconBtn label="Приблизить" tip="left" onClick={() => setZoom(z => Math.min(2.5, z * 1.2))}><Plus size={15} /></IconBtn>
        <IconBtn label="Отдалить" tip="left" onClick={() => setZoom(z => Math.max(0.4, z / 1.2))}><Minus size={15} /></IconBtn>
        <IconBtn label="Вписать" tip="left" onClick={() => setZoom(1)}><Maximize size={15} /></IconBtn>
      </div>
    </div>
  )
}
