import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { useLive } from './lib/live.ts'
import { reduceMotion } from './lib/format.ts'
import { Seam } from './components/Seam.tsx'
import { Tape } from './components/Tape.tsx'
import { Rig } from './components/Rig.tsx'
import { BundleTable, CatalogTable, MineTable } from './components/Tables.tsx'
import { Roadmap } from './components/Roadmap.tsx'
import { Pult } from './components/Pult.tsx'

const TABS = [
  { id: 'pult', label: 'Пульт' },
  { id: 'mine', label: 'Мои гемы' },
  { id: 'cat', label: 'Каталог' },
  { id: 'bund', label: 'Наборы' },
  { id: 'rig', label: 'Журнал' },
  { id: 'road', label: 'Roadmap' },
] as const
type TabId = typeof TABS[number]['id']

export default function App() {
  const { state, online } = useLive()
  const [tab, setTab] = useState<TabId>('pult')
  const [now, setNow] = useState(() => new Date())
  const body = useRef<HTMLDivElement>(null)
  const booted = useRef(false)

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 500)
    return () => clearInterval(t)
  }, [])

  // Сценарий загрузки: сначала жила, потом лента, потом содержимое.
  useEffect(() => {
    if (!state || booted.current || reduceMotion()) return
    booted.current = true
    gsap.from('[data-anim="seam"] > *', { y: 14, opacity: 0, duration: 0.55, stagger: 0.06, ease: 'power2.out' })
  }, [state])

  // Смена вкладки — короткий вход, чтобы переход читался.
  useEffect(() => {
    if (!body.current || reduceMotion()) return
    gsap.fromTo(body.current, { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: 0.28, ease: 'power2.out' })
  }, [tab])

  if (!state) {
    return (
      <div className="grid h-full place-items-center text-dust">
        <div className="text-center">
          <div className="font-display text-2xl font-extrabold text-chalk">Жила</div>
          <div className="mt-1 text-[11px] uppercase tracking-[0.28em]">подключение</div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 flex h-14 items-stretch border-b border-rule bg-ink/95 backdrop-blur">
        <div className="flex items-center gap-3 border-r border-rule px-4">
          <span className={`h-[7px] w-[7px] rounded-full ${online ? 'bg-malachite shadow-[0_0_0_0_rgba(52,211,166,.6)] animate-pulse' : 'bg-dust'}`} />
          <span>
            <span className="font-display text-[15px] font-extrabold tracking-[0.03em]">Жила</span>{' '}
            <span className="text-[10px] uppercase tracking-[0.22em] text-dust">{online ? 'в эфире' : 'переподключение'}</span>
          </span>
        </div>

        <div className="flex items-center border-r border-rule px-4 text-[15px] text-dust tnum">
          {now.toLocaleTimeString('ru-RU')}
        </div>

        <nav className="ml-auto flex">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`cursor-pointer border-l border-rule px-4 text-[11px] uppercase tracking-[0.14em] transition-colors ${
                tab === t.id ? 'bg-malachite text-ink' : 'text-dust hover:bg-raise hover:text-chalk'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {tab !== 'road' && tab !== 'pult' && <Seam state={state} />}
      {tab !== 'road' && tab !== 'pult' && <Tape state={state} />}

      <main className="px-6 pb-16">
        <div ref={body}>
          {tab === 'pult' && <Pult state={state} />}
          {tab === 'rig' && <Rig state={state} />}
          {tab === 'mine' && <MineTable state={state} />}
          {tab === 'cat' && <CatalogTable state={state} />}
          {tab === 'bund' && <BundleTable state={state} />}
          {tab === 'road' && <Roadmap />}
        </div>
      </main>
    </div>
  )
}
