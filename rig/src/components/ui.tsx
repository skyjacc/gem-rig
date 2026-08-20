import { useEffect, useRef, type ReactNode } from 'react'
import gsap from 'gsap'
import { KIND_CLASS, KIND_LABEL, reduceMotion } from '../lib/format.ts'

export function Block({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="border border-rule bg-seam">
      <header className="flex items-center gap-4 border-b border-rule px-3.5 py-2.5">
        <h3 className="m-0 text-[10px] font-medium uppercase tracking-[0.22em] text-dust">{title}</h3>
        {note ? <span className="ml-auto text-[11px] text-dust">{note}</span> : null}
      </header>
      {children}
    </section>
  )
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border border-rule bg-seam">
      <h3 className="m-0 border-b border-rule px-3.5 py-2.5 text-[10px] font-medium uppercase tracking-[0.22em] text-dust">
        {title}
      </h3>
      <div className="p-3.5">{children}</div>
    </div>
  )
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-rule/50 py-1.5 last:border-0">
      <span className="text-dust">{label}</span>
      <span className="tnum">{children}</span>
    </div>
  )
}

export function Pill({ kind }: { kind: string | null }) {
  if (!kind) return <span className="inline-block border border-rule px-1.5 text-[10px] uppercase tracking-wide text-dust">—</span>
  return (
    <span className={`inline-block border px-1.5 text-[10px] uppercase tracking-wide ${KIND_CLASS[kind] ?? 'border-rule text-dust'}`}>
      {KIND_LABEL[kind] ?? kind}
    </span>
  )
}

export function Btn({ on, children, ...rest }: { on?: boolean; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`cursor-pointer border px-2.5 py-1 text-[11px] transition-colors ${
        on ? 'border-malachite bg-malachite text-ink' : 'border-rule bg-raise text-chalk hover:border-malachite hover:text-malachite'
      } disabled:opacity-50`}
    >
      {children}
    </button>
  )
}

export function Buy({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener" className="inline-block border border-rule px-2 py-1 text-[11px] text-malachite hover:bg-raise">
      {children}
    </a>
  )
}

// Число, которое докатывается до нового значения, а не прыгает.
export function Odometer({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const prev = useRef(value)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (reduceMotion()) { el.textContent = fmt(value); prev.current = value; return }
    const obj = { v: prev.current }
    const tw = gsap.to(obj, {
      v: value,
      duration: Math.min(1.1, 0.25 + Math.abs(value - prev.current) / 900),
      ease: 'power2.out',
      onUpdate: () => { el.textContent = fmt(Math.round(obj.v)) },
      onComplete: () => { prev.current = value },
    })
    return () => { tw.kill() }
  }, [value])

  return <span ref={ref} className={`tnum ${className ?? ''}`}>{fmt(value)}</span>
}

const fmt = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
