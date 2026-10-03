// Кирпичи новой панели. Только оформление: ни данных, ни правил работы —
// они живут в lib/ и в экранах. Стили — v2.css, всё под .v2.

import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ')

export type Tone = 'ok' | 'warn' | 'stop' | 'idle'

// Панель — первый слой: кромка, скругление 16.
export function Panel({ title, aside, children, className }: {
  title?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cx('v2-panel', className)}>
      {title != null ? (
        <header className="v2-panel-head">
          <span>{title}</span>
          {aside != null ? <span className="v2-aside">{aside}</span> : null}
        </header>
      ) : null}
      {children}
    </section>
  )
}

// Плитка — второй слой внутри панели, без кромки.
export function Tile({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('v2-tile', className)}>{children}</div>
}

export function Pill({ children, tone, className, title }: {
  children: ReactNode
  tone?: 'warn' | 'stop'
  className?: string
  title?: string
}) {
  return <span className={cx('v2-pill', tone && 'is-' + tone, className)} title={title}>{children}</span>
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'plain' | 'soft' | 'go' | 'stop'
  loading?: boolean
}

// Кнопка. «go» — главное действие (лайм со свечением); «stop» — остановка.
// Пока идёт запрос, кнопка неактивна и показывает вращение — размер тот же.
export function Btn({ tone = 'plain', loading, disabled, className, children, type = 'button', ...rest }: BtnProps) {
  return (
    <button
      type={type}
      className={cx('v2-btn', tone !== 'plain' && 'is-' + tone, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 size={14} className="v2-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  )
}

// Кнопка-иконка. Подпись обязательна: она и для чтения с экрана,
// и подсказкой при наведении или фокусе (§4.3).
export function IconBtn({ label, children, onClick, current, boxed, badge, badgeTone, tip = 'bottom', ...rest }: {
  label: string
  children: ReactNode
  onClick?: () => void
  current?: boolean
  boxed?: boolean
  badge?: number
  badgeTone?: 'warn' | 'stop'
  tip?: 'right' | 'bottom' | 'top'
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick'>) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={current ? 'page' : undefined}
      className={cx('v2-ibtn', boxed && 'is-boxed')}
      onClick={onClick}
      {...rest}
    >
      {children}
      {badge ? <span className={cx('v2-badge', badgeTone === 'stop' && 'is-stop')} aria-hidden="true">{badge}</span> : null}
      <span className={'v2-tip at-' + tip} aria-hidden="true">{label}</span>
    </button>
  )
}

export function Chip({ children, tone, dot }: { children: ReactNode; tone?: Exclude<Tone, 'idle'>; dot?: boolean }) {
  return <span className={cx('v2-chip', tone && 'is-' + tone, dot && 'has-dot')}>{children}</span>
}

// Откуда число: «инвентарь», «журнал», «карта», «выписка»… (§3.3)
export function Src({ children }: { children: ReactNode }) {
  return <span className="v2-src">{children}</span>
}

// Значение в одном из четырёх состояний (§3.3). Ноль и «нет данных» —
// разные вещи: у «нет данных» причина обязательна.
export type ValProps =
  | { state: 'known'; children: ReactNode }
  | { state: 'estimated'; children: ReactNode }
  | { state: 'stale'; children: ReactNode; when: string }
  | { state: 'none'; why: string }

export function Val(p: ValProps) {
  if (p.state === 'none') {
    return (
      <span className="v2-val is-none">
        <span className="v2-num">—</span>
        <span className="v2-why">{p.why}</span>
      </span>
    )
  }
  if (p.state === 'estimated') {
    return (
      <span className="v2-val">
        <span className="v2-num">≈ {p.children}</span>
        <Chip tone="warn">оценка</Chip>
      </span>
    )
  }
  if (p.state === 'stale') {
    return (
      <span className="v2-val is-stale">
        <span className="v2-num">{p.children}</span>
        <span className="v2-when">{p.when}</span>
      </span>
    )
  }
  return <span className="v2-val"><span className="v2-num">{p.children}</span></span>
}

export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return <span className={cx('v2-dot', tone !== 'idle' && 'is-' + tone, pulse && 'is-pulse')} aria-hidden="true" />
}

// Лампа со словом: смысл не передаётся только цветом (§4.3).
export function Lamp({ tone, word, pulse }: { tone: Tone; word: ReactNode; pulse?: boolean }) {
  return (
    <span className="v2-lamp">
      <Dot tone={tone} pulse={pulse} />
      <b>{word}</b>
    </span>
  )
}

export function Skeleton({ h = 16, w = '100%' }: { h?: number; w?: number | string }) {
  return <span className="v2-skel" style={{ display: 'block', height: h, width: w }} aria-hidden="true" />
}
