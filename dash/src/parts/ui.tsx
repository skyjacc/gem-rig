import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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

export function Card({ hover, className = '', style, children }: {
  hover?: boolean; className?: string; style?: React.CSSProperties; children: ReactNode
}) {
  return <div className={`card ${hover ? 'card-hover' : ''} ${className}`} style={style}>{children}</div>
}

export function Label({ className = '', children }: { className?: string; children: ReactNode }) {
  return <span className={`ui-label text-muted-foreground/75 ${className}`}>{children}</span>
}

// Кнопка.
//
// Четыре вида, потому что действия у панели разной цены:
//
//   обычный   переключить вид, открыть настройки — отменяется само собой
//   active    то, за чем сюда пришли
//   danger    остановить, отвязать, удалить — заметно, но не страшно
//   burn      необратимое: за ним уходят сообщения, которых не вернуть
//
// loading — не украшение. За кнопкой запрос, который может идти секунду
// и не дойти вовсе; без него человек нажимает второй раз, и уходит две
// закупки вместо одной.
export function Button({
  active,
  tone,
  loading,
  className = '',
  children,
  ...rest
}: {
  active?: boolean
  tone?: 'danger' | 'burn'
  loading?: boolean
  children: ReactNode
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const base = 'ui-label relative inline-flex h-10 shrink-0 items-center justify-center gap-1.5 border bg-background/40 px-2.5 ' +
    'backdrop-blur transition-all duration-150 active:scale-95 touch-manipulation disabled:pointer-events-none disabled:opacity-40 '
  const look = tone === 'danger'
    ? 'border-white/[0.08] text-[color:var(--stop)] hover:border-[color:var(--stop)] '
    : tone === 'burn'
      ? 'border-[color:var(--warn)]/60 text-[color:var(--warn)] hover:border-[color:var(--warn)] hover:bg-[color:var(--warn)]/10 '
      : active
        ? 'border-white/20 bg-white/[0.08] text-foreground '
        : 'border-white/[0.08] text-muted-foreground hover:border-white/20 hover:text-foreground '
  return (
    <button
      type="button"
      {...rest}
      aria-busy={loading || undefined}
      disabled={rest.disabled || loading}
      className={base + look + className}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  )
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={'inline-block h-3 w-3 shrink-0 animate-spin rounded-full border border-current border-t-transparent ' + className}
    />
  )
}

// Сообщение о том, что пошло не так, рядом с тем, что не вышло.
//
// Ошибка должна отвечать на четыре вопроса: что случилось, почему система
// в таком виде, что делать и можно ли повторить. «Error 500» не отвечает
// ни на один.
export function Note({
  tone = 'stop',
  title,
  children,
  action,
}: {
  tone?: 'stop' | 'warn' | 'ok'
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  const color = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : 'var(--stop)'
  return (
    <div className="flex flex-wrap items-start gap-3 border border-white/[0.08] px-3.5 py-2.5" role="status">
      <span className="mt-[6px] h-[6px] w-[6px] shrink-0" style={{ background: color }} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]" style={{ color }}>{title}</span>
        {children ? <span className="mt-1 block text-[12px] leading-relaxed text-muted-foreground">{children}</span> : null}
      </span>
      {action ? <span className="shrink-0">{action}</span> : null}
    </div>
  )
}

// Переключатель с бегунком: выбранное не перепрыгивает, а переезжает.
// Ширина у пунктов разная, поэтому положение меряется по самим кнопкам.
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
  const box = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState({ x: 0, w: 0, ready: false })

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => {
      const active = el.querySelector<HTMLElement>('[data-on="true"]')
      if (!active) return setThumb(t => ({ ...t, ready: false }))
      setThumb({ x: active.offsetLeft, w: active.offsetWidth, ready: true })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [value, items.length])

  return (
    <div
      ref={box}
      className={`seg inline-flex h-10 shrink-0 border border-white/[0.08] bg-background/40 backdrop-blur ${className}`}
    >
      {thumb.ready ? (
        <span className="seg-thumb" style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w }} aria-hidden="true" />
      ) : null}
      {items.map((it, i) => (
        <button
          key={it.id}
          type="button"
          data-on={value === it.id}
          onClick={() => onPick(it.id)}
          className={
            'ui-label relative z-[1] inline-flex items-center justify-center gap-1.5 px-2.5 ' +
            (i ? 'border-l border-white/[0.08] ' : '') +
            (value === it.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')
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
      className={`ui-label h-10 border border-white/[0.08] bg-background/40 px-2.5 text-foreground placeholder:text-muted-foreground/75 ${width}`}
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

// Лампа состояния.
//
// Цвет не может быть единственным носителем смысла: у восьми процентов
// мужчин зелёный и красный неразличимы, а тут ими помечено «идёт»
// и «сломалось». Поэтому у точки есть имя — его читает и диктор,
// и всплывающая подсказка.
const DOT: Record<string, string> = {
  ok: 'работает',
  warn: 'ждёт',
  stop: 'остановлено',
  idle: 'выключено',
}

export function Dot({ tone, pulse, label }: {
  tone: 'ok' | 'warn' | 'stop' | 'idle'
  pulse?: boolean
  label?: string
}) {
  const color =
    tone === 'ok' ? 'var(--ok)' :
    tone === 'warn' ? 'var(--warn)' :
    tone === 'stop' ? 'var(--stop)' : 'rgb(255 255 255 / 0.25)'
  const name = label ?? DOT[tone]
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className={`inline-block h-[6px] w-[6px] shrink-0 ${pulse ? 'animate-pulse' : ''}`}
      style={{ background: color }}
    />
  )
}

// Значок предмета.
//
// У них логотип лежит белым кругом с тонким тёмным кольцом:
// rounded-full bg-white/[0.92] ring-1 ring-black/20. Тёмный квадрат,
// который я сделал сначала, — главная причина, почему панель на них
// не походила: круглые белые пятна и есть их узнаваемая примета.
export function ItemIcon({ hash, size = 22 }: { hash: string; size?: number }) {
  return (
    <span className="chip-icon inline-flex" style={{ width: size, height: size }} aria-hidden="true">
      {hash ? (
        <img
          src={steamIcon(hash, size > 40 ? 128 : 64)}
          alt=""
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
        />
      ) : null}
    </span>
  )
}

export function Head({ title, note, right }: { title: string; note?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-3">
      <h2 className="text-[15px] font-medium text-foreground/95">{title}</h2>
      {note ? <span className="ui-label text-muted-foreground/75">{note}</span> : null}
      {right ? <div className="ml-auto flex items-center gap-2">{right}</div> : null}
    </div>
  )
}

// Шапка экрана. У них страница открывается крупной строкой в 26 пикселей
// со сжатием -0.04em и подписью в 14 под ней — именно этого у меня не было
// вовсе, и панель читалась как таблица без начала.
export function PageHead({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-10 flex flex-wrap items-end gap-4">
      <div className="min-w-0">
        <h1 className="text-balance text-[26px] font-medium leading-[1.15] tracking-[-0.04em] text-foreground/95">
          {title}
        </h1>
        {sub ? <p className="mt-2 text-sm leading-5 text-muted-foreground">{sub}</p> : null}
      </div>
      {right ? <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div> : null}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">{children}</div>
}

// Скелетон: каркас того, что придёт, вместо слова «читаю».
//
// Пульс мягкий, без бегущего блика: блик — украшение, пульс — состояние
// «живое, ждём». Анимируется только прозрачность, это дешево даже когда
// каркасов много.
export function Skeleton({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return <div aria-hidden="true" className={'skeleton ' + className} style={style} />
}

// Каркас табличного экрана: строки той же высоты, что настоящие, чтобы
// приход данных не прыгал макетом. Ширина блоков — приблизительная форма
// колонок, а не точная копия.
export function RowsSkeleton({ rows = 8, cols = [96, 64, 160, 48] }: { rows?: number; cols?: number[] }) {
  return (
    <div className="space-y-2.5 p-3.5" aria-busy="true">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4" style={{ opacity: 1 - (r % 4) * 0.15 }}>
          {cols.map((w, c) => <Skeleton key={c} className="h-[13px] shrink-0" style={{ width: w }} />)}
        </div>
      ))}
    </div>
  )
}

// Число, которое катится к новому значению, а не прыгает. На панели,
// где счётчик меняется раз в секунду, прыжок читается как помеха,
// а качение — как работа.
export function Num({ value, className = '', style }: { value: number; className?: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null)
  const from = useRef(value)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const a = from.current
    const b = value
    from.current = value
    if (a === b) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = fmt(b)
      return
    }
    const dur = Math.min(900, 220 + Math.abs(b - a) * 1.6)
    const t0 = performance.now()
    let raf = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur)
      const e = 1 - Math.pow(1 - p, 3)
      el.textContent = fmt(Math.round(a + (b - a) * e))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])

  return <span ref={ref} className={`tnum ${className}`} style={style}>{fmt(value)}</span>
}

const fmt = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
