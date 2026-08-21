import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

// Окно поверх.
//
// В языке референса плавающее — единственное место с размытием и тенью,
// поэтому окно сделано тем же классом. Углы прямые, подложка глухая,
// закрывается по Escape и по щелчку мимо.

export function Modal({
  open,
  title,
  note,
  width = 'w-[520px]',
  onClose,
  children,
  footer,
}: {
  open: boolean
  title: string
  note?: string
  width?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    // Фокус внутрь: иначе Escape уходит в страницу под окном.
    box.current?.focus()
    return () => document.removeEventListener('keydown', esc)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto p-6 pt-[10vh]"
      style={{ background: 'rgba(10,10,10,0.72)', backdropFilter: 'blur(2px)' }}
      onPointerDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`floating rise max-w-full outline-none ${width}`}
        style={{ background: '#111111d1' }}
      >
        <div className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-medium tracking-[-0.02em]">{title}</span>
            {note ? <span className="block truncate text-[12px] text-muted-foreground">{note}</span> : null}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="закрыть"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-white/[0.08] text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="p-4">{children}</div>

        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-white/[0.08] px-4 py-3">{footer}</div>
        ) : null}
      </div>
    </div>
  )
}
