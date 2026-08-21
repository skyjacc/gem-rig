import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { nf, post, useJson, type State } from '../lib/api.ts'
import { Button, Card, Field, Head, Label } from '../parts/ui.tsx'

// Настройки.
//
// Всё, что раньше было константой в коде и требовало правки файла.
// Значения по умолчанию не выдуманы: это замер 20 августа — 76 отправок
// в минуту при паузе в секунду, отклик GC 340 мс по медиане и 764 мс
// в худшем случае. Но замеры устаревают, поэтому крутится отсюда.
//
// У каждого поля написано, на что оно влияет и чем грозит перекос.
// Значения зажимаются на сервере: панель — не место, где можно случайно
// выставить паузу в ноль, каждая отправка необратима.

export type Settings = {
  goal: number
  tick: number
  silentLimit: number
  maxFailures: number
  invTtl: number
  treeTop: number
  pace: { floor: number; ceil: number; enough: number; clean: number; down: number; up: number }
  spread: { band: number; jitter: number }
}

type Row = {
  path: string
  label: string
  hint: string
  unit?: string
  scale?: number   // во сколько раз показанное больше хранимого
  step?: number
}

const GROUPS: { title: string; note: string; rows: Row[] }[] = [
  {
    title: 'Работа',
    note: 'что считать товаром и как часто смотреть',
    rows: [
      { path: 'goal', label: 'цель счётчика', hint: 'сколько просмотров делает вещь товаром', unit: '' },
      { path: 'tick', label: 'такт работника', hint: 'как часто смотреть инвентарь и отправщик', unit: 'с', scale: 1000 },
      { path: 'invTtl', label: 'срок инвентаря', hint: 'через сколько перечитывать инвентарь Steam', unit: 'с', scale: 1000 },
    ],
  },
  {
    title: 'Отправщик',
    note: 'когда считать его сломанным',
    rows: [
      { path: 'silentLimit', label: 'предел молчания', hint: 'сколько может молчать, прежде чем перезапустить', unit: 'с', scale: 1000 },
      { path: 'maxFailures', label: 'падений подряд', hint: 'после скольких неудачных запусков встать с причиной' },
    ],
  },
  {
    title: 'Подбор паузы',
    note: 'пока GC отвечает на каждую отправку — темп растёт; появились молчания — это потолок',
    rows: [
      { path: 'pace.floor', label: 'пол паузы', hint: 'ниже не опускаться никогда: при 300 мс GC уже не успевал отвечать', unit: 'мс' },
      { path: 'pace.ceil', label: 'потолок паузы', hint: 'выше советовать бессмысленно — дело уже не в темпе', unit: 'мс' },
      { path: 'pace.enough', label: 'нужно замеров', hint: 'меньше этого числа отправок — не выборка, а совпадение' },
      { path: 'pace.clean', label: 'допуск молчаний', hint: 'какая доля без ответа ещё считается чистой работой', unit: '%', scale: 0.01, step: 0.1 },
      { path: 'pace.down', label: 'шаг ускорения', hint: 'во сколько раз сокращать паузу, когда чисто', step: 0.05 },
      { path: 'pace.up', label: 'шаг отхода', hint: 'во сколько раз увеличивать паузу, когда молчит', step: 0.05 },
    ],
  },
  {
    title: 'Разброс',
    note: 'счётчики партий должны отличаться заметно, но оставаться в одной полосе',
    rows: [
      { path: 'spread.band', label: 'ширина полосы', hint: 'на сколько процентов от заказа расходятся партии', unit: '%', scale: 0.01, step: 1 },
      { path: 'spread.jitter', label: 'дрожание', hint: 'случайная добавка поверх ровного шага', unit: '%', scale: 0.01, step: 0.5 },
    ],
  },
  {
    title: 'Показ',
    note: 'что рисовать в дереве',
    rows: [
      { path: 'treeTop', label: 'турниров под гемом', hint: 'сколько крупнейших показывать, остальные свернуть' },
    ],
  },
]

const get = (o: any, p: string) => p.split('.').reduce((a, k) => a?.[k], o)
const put = (p: string, v: number) => {
  const [a, b] = p.split('.')
  return b ? { [a]: { [b]: v } } : { [a]: v }
}

export function Settings({ state }: { state: State }) {
  const { data } = useJson<Settings>('/api/settings', state.ts)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => { setDraft({}) }, [data?.goal])

  if (!data) return <Card className="p-6 text-[13px] text-muted-foreground">читаю настройки…</Card>

  const shown = (r: Row) => {
    if (draft[r.path] !== undefined) return draft[r.path]
    const raw = Number(get(data, r.path))
    const v = r.scale ? raw / r.scale : raw
    return String(Math.round(v * 1000) / 1000)
  }

  const apply = async (r: Row) => {
    const raw = draft[r.path]
    if (raw === undefined) return
    const n = Number(raw.replace(',', '.'))
    if (!Number.isFinite(n)) return
    await post('/api/settings', put(r.path, r.scale ? n * r.scale : n))
    setDraft(d => { const x = { ...d }; delete x[r.path]; return x })
    setSaved(r.path)
    setTimeout(() => setSaved(s => (s === r.path ? null : s)), 1400)
  }

  return (
    <div className="view-in space-y-6">
      <Head
        title="Настройки"
        note="пороги, которые раньше были зашиты в код"
        right={
          <Button onClick={() => post('/api/settings/reset', {})}>
            <RotateCcw className="h-3.5 w-3.5" />
            <span>вернуть замеренные</span>
          </Button>
        }
      />

      {GROUPS.map((g, gi) => (
        <div key={g.title}>
          <div className="mb-2">
            <h2 className="text-[15px] font-medium tracking-[-0.02em] text-foreground/95">{g.title}</h2>
            <p className="text-[12px] text-muted-foreground">{g.note}</p>
          </div>
          <Card className="rise" style={{ animationDelay: gi * 40 + 'ms' }}>
            <div className="divide-y divide-white/[0.06]">
              {g.rows.map(r => (
                <div key={r.path} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px]">{r.label}</span>
                    <span className="block text-[12px] leading-snug text-muted-foreground">{r.hint}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Field
                      value={shown(r)}
                      onChange={v => setDraft(d => ({ ...d, [r.path]: v }))}
                      width="w-24 text-right"
                      inputMode="decimal"
                      onKeyDown={e => { if (e.key === 'Enter') apply(r) }}
                    />
                    {r.unit ? <span className="ui-label w-6 text-muted-foreground/70">{r.unit}</span> : <span className="w-6" />}
                    <Button
                      disabled={draft[r.path] === undefined}
                      active={draft[r.path] !== undefined}
                      onClick={() => apply(r)}
                    >
                      {saved === r.path ? 'сохранено' : 'ок'}
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      ))}

      <div>
        <Head title="Что сейчас действует" />
        <Card className="p-4">
          <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-[12px] sm:grid-cols-3">
            <Fact k="цель" v={nf(data.goal)} />
            <Fact k="такт" v={data.tick / 1000 + ' с'} />
            <Fact k="пауза сейчас" v={nf(state.autopilot.delay) + ' мс'} />
            <Fact k="совет по темпу" v={state.autopilot.pace ? nf(state.autopilot.pace.suggest) + ' мс' : '—'} />
            <Fact k="замеров" v={nf(state.autopilot.pace?.measured ?? 0)} />
            <Fact k="без ответа" v={nf(state.autopilot.pace?.silent ?? 0)} />
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
            {state.autopilot.pace?.why ?? 'замеров ещё нет'}
          </p>
        </Card>
      </div>
    </div>
  )
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <Label>{k}</Label>
      <span className="tnum font-mono">{v}</span>
    </div>
  )
}
