import { useEffect, useRef, useState, type ReactNode } from 'react'

// Раскрытие по высоте.
//
// Две попытки до этого не выжили, и обе поучительны.
//
// Сетка из 0fr в 1fr — короткий приём, но внутри раскрытия своя прокрутка,
// а в контейнере без заданной высоты доля схлопывалась в один пиксель.
//
// Замер по таймеру раскрывался, но не закрывался: снятое ограничение
// и возврат к нулю попадали в один тик, и промежуточного значения,
// от которого шёл бы переход, просто не было.
//
// Теперь высота содержимого наблюдается, а обёртка всегда знает своё
// число: открыто — столько же, закрыто — ноль. Ни таймеров, ни угадывания.

export function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState(0)

  useEffect(() => {
    const el = inner.current
    if (!el) return
    const measure = () => setFull(el.scrollHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [children])

  return (
    <div
      style={{
        height: open ? full : 0,
        overflow: 'hidden',
        transition: 'height var(--t-mid) var(--ease)',
      }}
      aria-hidden={!open}
    >
      <div ref={inner}>{children}</div>
    </div>
  )
}
