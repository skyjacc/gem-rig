import type { ReactNode } from 'react'
import { icon as steamIcon } from '../lib/api.ts'

// Кирпичи, снятые с osint-catalog.xyz один в один.
//
//   границы    белый 6 %, на наведении 12 %
//   поверхность белый 1 %, на наведении 2 %
//   углы       прямые
//   управление ровно 40 пикселей высотой
//   подпись    12 px / 500 / -0.012em, не капсом
//
// Ничего не додумываем: если у них нет тени — её нет и здесь.

export function Card({ hover, className = '', children }: { hover?: boolean; className?: string; children: ReactNode }) {
  return <div className={`card ${hover ? 'card-hover' : ''} ${className}`}>{children}</div>
}

export function Label({ className = '', children }: { className?: string; children: ReactNode }) {
  return <span className={`ui-label text-muted-foreground/75 ${className}`}>{children}</span>
}

export function Button({
  active,
  tone,
  className = '',
  children,
  ...rest
}: {
  active?: boolean
  tone?: 'danger'
  children: ReactNode
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const base = 'ui-label inline-flex h-10 shrink-0 items-center justify-center gap-1.5 border bg-background/40 px-3 ' +
    'backdrop-blur transition-all duration-150 active:scale-95 touch-manipulation disabled:pointer-events-none disabled:opacity-40 '
  const look = tone === 'danger'
    ? 'border-white/[0.08] text-[color:var(--stop)] hover:border-[color:var(--stop)] '
    : active
      ? 'border-white/20 bg-white/[0.08] text-foreground '
      : 'border-white/[0.08] text-muted-foreground hover:border-white/20 hover:text-foreground '
  return <button type="button" {...rest} className={base + look + className}>{children}</button>
}

export function Segmented<T extends string>({
  value,
  items,
  onPick,
  className = '',
}: {
  value: T
  items: { id: T; label: string; icon?: ReactNode }[]
  onPick: (id: T) => void
  className?: string
}) {
  return (
    <div className={`inline-flex h-10 shrink-0 border border-white/[0.08] bg-background/40 backdrop-blur ${className}`}>
      {items.map((it, i) => (
        <button
          key={it.id}
          type="button"
          onClick={() => onPick(it.id)}
          className={
            'ui-label relative inline-flex items-center justify-center gap-1.5 px-3 transition-colors ' +
            (i ? 'border-l border-white/[0.08] ' : '') +
            (value === it.id ? 'bg-white/[0.08] text-foreground' : 'text-muted-foreground hover:text-foreground')
          }
        >
          {it.icon}
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  )
}

export function Field({
  value,
  onChange,
  placeholder,
  width = 'w-full',
  ...rest
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  width?: string
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>) {
  return (
    <input
      {...rest}
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      className={`ui-label h-10 border border-white/[0.08] bg-background/40 px-3 text-foreground placeholder:text-muted-foreground/50 ${width}`}
    />
  )
}

export function Bar({ pct, tone = 'run' }: { pct: number; tone?: 'run' | 'ok' | 'faint' | 'warn' }) {
  const color =
    tone === 'ok' ? 'var(--ok)' :
    tone === 'warn' ? 'var(--warn)' :
    tone === 'faint' ? 'rgb(255 255 255 / 0.18)' : 'oklch(70.8% 0 0)'
  return (
    <div className="h-[3px] w-full bg-white/[0.06]">
      <div className="h-full transition-[width] duration-500" style={{ width: Math.min(100, Math.max(0, pct)) + '%', background: color }} />
    </div>
  )
}

export function Dot({ tone, pulse }: { tone: 'ok' | 'warn' | 'stop' | 'idle'; pulse?: boolean }) {
  const color =
    tone === 'ok' ? 'var(--ok)' :
    tone === 'warn' ? 'var(--warn)' :
    tone === 'stop' ? 'var(--stop)' : 'rgb(255 255 255 / 0.25)'
  return <span className={`inline-block h-[6px] w-[6px] shrink-0 ${pulse ? 'animate-pulse' : ''}`} style={{ background: color }} />
}

// Настоящая картинка предмета из Steam.
export function ItemIcon({ hash, size = 28 }: { hash: string; size?: number }) {
  if (!hash) {
    return <span className="shrink-0 border border-white/[0.08] bg-white/[0.03]" style={{ width: size, height: size }} />
  }
  return (
    <img
      src={steamIcon(hash, size > 40 ? 128 : 64)}
      alt=""
      referrerPolicy="no-referrer"
      className="shrink-0 border border-white/[0.06] bg-white/[0.02] object-contain"
      style={{ width: size, height: size }}
    />
  )
}

export function Head({ title, note, right }: { title: string; note?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-3">
      <h2 className="text-[15px] font-medium tracking-[-0.02em] text-foreground/95">{title}</h2>
      {note ? <span className="ui-label text-muted-foreground/75">{note}</span> : null}
      {right ? <div className="ml-auto flex items-center gap-2">{right}</div> : null}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">{children}</div>
}
