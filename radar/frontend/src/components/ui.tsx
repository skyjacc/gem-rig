import { useState, type ReactNode } from 'react'

export function Panel({
  title,
  subtitle,
  action,
  children,
  className = '',
  bodyClass = 'p-5',
}: {
  title?: string
  subtitle?: string
  action?: ReactNode
  children: ReactNode
  className?: string
  bodyClass?: string
}) {
  return (
    <section
      className={`overflow-hidden rounded-2xl border border-line bg-panel/70 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-24px_rgba(0,0,0,0.9)] backdrop-blur-sm ${className}`}
    >
      {(title || action) && (
        <header className="flex items-center justify-between gap-4 border-b border-line-soft px-5 py-3.5">
          <div>
            {title && (
              <h2 className="text-[12px] font-semibold tracking-[0.14em] text-mute uppercase">
                {title}
              </h2>
            )}
            {subtitle && <p className="mt-0.5 text-xs text-faint">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  )
}

export function Stat({
  label,
  value,
  hint,
  icon,
  tone = 'default',
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  tone?: 'default' | 'good' | 'warn' | 'bad'
}) {
  const toneClass = {
    default: 'text-text',
    good: 'text-accent',
    warn: 'text-warn',
    bad: 'text-danger',
  }[tone]
  return (
    <div className="group rounded-2xl border border-line bg-panel/70 px-4 py-3.5 transition-colors hover:border-line/80 hover:bg-panel-2/60">
      <div className="flex items-center gap-2 text-[11px] font-medium tracking-[0.12em] text-faint uppercase">
        {icon && <span className={`ico ico-pop ${toneClass}`}>{icon}</span>}
        {label}
      </div>
      <div className={`mt-1.5 font-mono text-[22px] leading-none ${toneClass}`}>{value}</div>
      {hint && <div className="mt-2 text-xs leading-snug text-faint">{hint}</div>}
    </div>
  )
}

export function Badge({
  children,
  tone = 'default',
  title,
}: {
  children: ReactNode
  tone?: 'default' | 'good' | 'warn' | 'bad' | 'info' | 'violet'
  title?: string
}) {
  const toneClass = {
    default: 'border-line bg-panel-2 text-mute',
    good: 'border-accent/35 bg-accent/10 text-accent',
    warn: 'border-warn/35 bg-warn/10 text-warn',
    bad: 'border-danger/35 bg-danger/10 text-danger',
    info: 'border-info/35 bg-info/10 text-info',
    violet: 'border-violet/35 bg-violet/10 text-violet',
  }[tone]
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${toneClass}`}
    >
      {children}
    </span>
  )
}

export function Button({
  children,
  onClick,
  disabled,
  tone = 'default',
  size = 'md',
  title,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  tone?: 'default' | 'primary' | 'ghost'
  size?: 'sm' | 'md'
  title?: string
  type?: 'button' | 'submit'
}) {
  const toneClass = {
    default: 'border-line bg-panel-2 text-text hover:border-faint hover:bg-panel-3',
    primary: 'border-accent/45 bg-accent/12 text-accent hover:bg-accent/20 hover:border-accent/70',
    ghost: 'border-transparent bg-transparent text-mute hover:text-text hover:bg-panel-2',
  }[tone]
  const sizeClass = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm'
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`group inline-flex items-center gap-2 rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${toneClass} ${sizeClass}`}
    >
      {children}
    </button>
  )
}

/** A dot that pulses only while work is actually running. */
export function LiveDot({ active, tone = 'good' }: { active: boolean; tone?: 'good' | 'bad' }) {
  const color = tone === 'good' ? 'text-accent' : 'text-danger'
  return (
    <span
      className={`relative inline-block h-2 w-2 rounded-full bg-current ${color} ${
        active ? 'pulse-ring' : 'opacity-40'
      }`}
    />
  )
}

/** Thin horizontal progress track. */
export function Progress({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'info' }) {
  const bar = tone === 'accent' ? 'bg-accent/70' : 'bg-info/70'
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel-3">
      <div
        className={`h-full rounded-full transition-[width] duration-700 ease-out ${bar}`}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  )
}

/** Square item artwork with a rarity edge and a graceful empty state. */
export function ItemThumb({
  src,
  alt,
  color,
  size = 44,
}: {
  src?: string
  alt: string
  color: string
  size?: number
}) {
  const [broken, setBroken] = useState(false)
  // `color` can be a CSS variable, so alpha has to be mixed rather than
  // appended: `var(--color-line)55` is not a colour and the whole rule is
  // dropped, taking the rarity edge with it.
  const edge = `color-mix(in srgb, ${color} 33%, transparent)`
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-panel-3"
      style={{ width: size, height: size, boxShadow: `inset 0 0 0 1px ${edge}` }}
    >
      {src && !broken ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onError={() => setBroken(true)}
          className="h-full w-full object-contain"
        />
      ) : (
        <span className="text-[10px] text-faint" title={broken ? 'иконка не загрузилась' : 'иконки нет'}>
          {broken ? '⚠' : '—'}
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 h-[2px]" style={{ background: color }} />
    </span>
  )
}
