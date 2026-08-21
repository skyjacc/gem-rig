import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

// Окно поверх, двух видов.
//
//   center  короткое и решительное: подтвердить, ввести код. Помещается
//           целиком, высота не меняется, поэтому центр уместен.
//   side    настройки: содержимое разной высоты, вкладки, прокрутка.
//           Посередине такое прыгает при каждом переключении — панель
//           у правого края стоит на месте и не зависит от длины списка.
//
// Закрывается по Escape и щелчком мимо. Щелчок засчитывается, только если
// нажатие и отпускание произошли на подложке: иначе окно закрывается,
// когда просто тянешь выделение изнутри наружу.
//
// Рисуется порталом в body, и это не украшательство. Экран появляется
// с анимацией, у которой есть transform; такой предок становится точкой
// отсчёта для position: fixed, и окно вставало не по экрану, а по области
// содержимого — со сдвигом на ширину боковой колонки.

export function Modal({
  open,
  title,
  note,
  width = 'w-[520px]',
  variant = 'center',
  onClose,
  children,
  footer,
}: {
  open: boolean
  title: string
  note?: string
  width?: string
  variant?: 'center' | 'side'
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const downOnBackdrop = useRef(false)

  useEffect(() => {
    if (!open) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    box.current?.focus()
    return () => document.removeEventListener('keydown', esc)
  }, [open, onClose])

  if (!open) return null

  const side = variant === 'side'

  return createPortal(
    <div
      className={
        'fade fixed inset-0 z-50 flex ' +
        (side ? 'justify-end' : 'items-start justify-center overflow-auto p-6 pt-[10vh]')
      }
      style={{ background: 'rgba(10,10,10,0.72)', backdropFilter: 'blur(2px)' }}
      onPointerDown={e => { downOnBackdrop.current = e.target === e.currentTarget }}
      onPointerUp={e => { if (downOnBackdrop.current && e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={
          'floating max-w-full outline-none ' +
          (side
            ? 'slide-right flex h-svh flex-col border-l border-white/[0.08] ' + (width === 'w-[520px]' ? 'w-[560px]' : width)
            : 'pop ' + width)
        }
        style={{ background: '#111111e6' }}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.08] px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-medium tracking-[-0.02em]">{title}</span>
            {note ? <span className="block truncate text-[12px] text-muted-foreground">{note}</span> : null}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="закрыть"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border border-white/[0.08] text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className={side ? 'scroll-thin min-h-0 flex-1 overflow-auto p-4' : 'p-4'}>{children}</div>

        {footer ? (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-white/[0.08] px-4 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
