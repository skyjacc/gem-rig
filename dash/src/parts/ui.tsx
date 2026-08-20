import type { ReactNode } from 'react'

// Кирпичи, снятые с osint-catalog.xyz один в один.
//
// Их правила простые и держатся на всём сайте:
//   границы   белый в 6 сотых, на наведении 12
//   поверхность  белый в одну сотую, на наведении две
//   углы      прямые
//   высота управления  ровно 40 пикселей
//   подпись   не капсом, 12 пикселей, вес 500
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
  className = '',
  children,
  ...rest
}: { active?: boolean; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={
        'ui-label inline-flex h-10 shrink-0 items-center gap-1.5 border bg-background/40 px-3 backdrop-blur ' +
        'transition-all duration-150 active:scale-95 touch-manipulation disabled:opacity-40 ' +
        (active
          ? 'border-white/20 bg-white/[0.08] text-foreground '
          : 'border-white/[0.08] text-muted-foreground hover:border-white/20 hover:text-foreground ') +
        className
      }
    >
      {children}
    </button>
  )
}

// Сегменты: одна рамка на всю группу, разделители внутри слева.
export function Segmented<T extends string>({
  value,
  items,
  onPick,
}: {
  value: T
  items: { id: T; label: string; icon?: ReactNode }[]
  onPick: (id: T) => void
}) {
  return (
    <div className="inline-flex h-10 shrink-0 border border-white/[0.08] bg-background/40 backdrop-blur">
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

// Полоса заполнения. У референса такой нет — он ничего не измеряет.
// Держим в его логике: прямая, в один цвет, без блеска.
export function Bar({ pct, tone = 'run' }: { pct: number; tone?: 'run' | 'ok' | 'faint' }) {
  const color = tone === 'ok' ? 'var(--ok)' : tone === 'faint' ? 'rgb(255 255 255 / 0.18)' : 'oklch(70.8% 0 0)'
  return (
    <div className="h-[3px] w-full bg-white/[0.06]">
      <div className="h-full transition-[width] duration-500" style={{ width: Math.min(100, Math.max(0, pct)) + '%', background: color }} />
    </div>
  )
}

export function Dot({ tone }: { tone: 'ok' | 'warn' | 'stop' | 'idle' }) {
  const color = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'stop' ? 'var(--stop)' : 'rgb(255 255 255 / 0.25)'
  return <span className="inline-block h-[6px] w-[6px] shrink-0" style={{ background: color }} />
}
