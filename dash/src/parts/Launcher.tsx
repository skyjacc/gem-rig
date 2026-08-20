import { useState } from 'react'
import { Play, Square, Wand2 } from 'lucide-react'
import { nf, post, span, type State, type Unit } from '../lib/api.ts'
import { Bar, Button, Card, Dot, Field, Label, Segmented } from './ui.tsx'

// Запуск.
//
// Тумблер «включить и жечь всё» — не единственный режим. Заказ на ровно
// N отправок нужен так же часто: проверить темп, добить один гем до круглого
// числа, потратить полчаса и не больше. Работник сам встанет на цифре.
//
// Пауза по умолчанию подбирается: пока GC отвечает на каждую отправку,
// темп поднимается; появились молчания — это потолок, отходим.

const PRESET: (number | null)[] = [100, 500, 2000, null]
const MANUAL: [number, string][] = [[500, '0,5 с'], [1000, '1 с'], [2000, '2 с'], [5000, '5 с']]

export function Launcher({ state, unit }: { state: State; unit: Unit }) {
  const [target, setTarget] = useState<number | null>(unit.target)
  const [own, setOwn] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const pace = state.autopilot.pace

  const run = async (on: boolean) => {
    setErr(null)
    const t = own.trim() ? Math.max(1, Number(own.replace(/\D/g, '')) || 0) : target
    const r = await post('/api/autopilot', { id: unit.id, on, target: on ? t : undefined })
    if (r?.error) setErr(String(r.error))
  }

  const pct = unit.target ? (unit.done / unit.target) * 100 : 0

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        {unit.enabled ? (
          <Button tone="danger" onClick={() => run(false)} className="min-w-[132px]">
            <Square className="h-3.5 w-3.5" />
            <span>остановить</span>
          </Button>
        ) : (
          <Button active onClick={() => run(true)} className="min-w-[132px]">
            <Play className="h-3.5 w-3.5" />
            <span>запустить</span>
          </Button>
        )}

        <span className="mx-1 h-6 w-px bg-white/[0.08]" />

        <Label>сколько</Label>
        <Segmented
          value={own.trim() ? 'own' : String(target)}
          items={[
            ...PRESET.map(p => ({ id: String(p), label: p === null ? 'всё' : nf(p) })),
            { id: 'own', label: 'своё' },
          ]}
          onPick={id => {
            if (id === 'own') { setOwn(own || '250'); return }
            setOwn('')
            setTarget(id === 'null' ? null : Number(id))
          }}
        />
        {own.trim() ? (
          <Field value={own} onChange={v => setOwn(v.replace(/\D/g, ''))} width="w-24" inputMode="numeric" />
        ) : null}

        <span className="mx-1 h-6 w-px bg-white/[0.08]" />

        <Label>пауза</Label>
        <Segmented
          value={unit.auto ? 'auto' : String(unit.delay)}
          items={[
            { id: 'auto', label: 'сама', icon: <Wand2 className="h-3.5 w-3.5" /> },
            ...MANUAL.map(([ms, l]) => ({ id: String(ms), label: l })),
          ]}
          onPick={id => post('/api/autopilot', id === 'auto'
            ? { id: unit.id, auto: true }
            : { id: unit.id, delay: Number(id) })}
        />
        <span className="tnum font-mono text-[12px] text-muted-foreground">{nf(unit.delay)} мс</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-[12px] text-muted-foreground">
        <span className="flex items-center gap-2">
          <Dot tone={unit.running ? 'ok' : unit.enabled ? 'warn' : 'idle'} pulse={unit.running} />
          {unit.enabled ? unit.why : 'ничего не уйдёт, пока не нажать «запустить»'}
        </span>
        {pace && unit.auto ? <span>темп: {pace.why}</span> : null}
        {err ? <span style={{ color: 'var(--stop)' }}>{err}</span> : null}
      </div>

      {unit.target ? (
        <div className="mt-3">
          <div className="mb-1 flex items-baseline justify-between text-[12px]">
            <span className="text-muted-foreground">заказано {nf(unit.target)}</span>
            <span className="tnum font-mono">
              {nf(unit.done)} · осталось {nf(Math.max(0, unit.target - unit.done))} · {span(Math.round((unit.target - unit.done) * unit.delay / 60000))}
            </span>
          </div>
          <Bar pct={pct} tone={unit.done >= unit.target ? 'ok' : 'run'} />
        </div>
      ) : null}
    </Card>
  )
}
