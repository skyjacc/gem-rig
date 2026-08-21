import { useState } from 'react'
import { Play, Shuffle, Square, Wand2 } from 'lucide-react'
import { nf, post, span, type State, type Unit } from '../lib/api.ts'
import { Bar, Button, Card, Dot, Field, Label, Num, Segmented } from './ui.tsx'

// Запуск.
//
// Три вещи, которых не было в тумблере.
//
// Цель. Заказ на ровно N отправок нужен так же часто, как «жечь всё»:
// проверить темп, добить гем до нужного числа, потратить полчаса.
//
// Живое число. Круглые 1000 и 2000 естественная игра почти не даёт, и на
// витрине они читаются ровно как то, чем являются. Заказ превращается
// в 1147: не ниже заказанного, но и не круглое.
//
// Разброс. Одно сообщение поднимает ВСЕ подходящие вещи разом, поэтому
// двадцать девять предметов идут в ногу и приходят к одному числу.
// Разные числа получаются только партиями: счётчик вещи равен числу
// отправок ПОСЛЕ её появления. Работник считает моменты и говорит,
// когда добавлять следующую партию.

const PRESET: (number | null)[] = [100, 500, 2000, null]
const MANUAL: [number, string][] = [[500, '0,5 с'], [1000, '1 с'], [2000, '2 с'], [5000, '5 с']]
const WAVES = [1, 2, 3, 4, 5]

export function Launcher({ state, unit }: { state: State; unit: Unit }) {
  const [target, setTarget] = useState<number | null>(unit.ordered ?? unit.target)
  const [own, setOwn] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const pace = state.autopilot.pace
  const plan = unit.plan ?? []
  const waves = unit.waves ?? 1

  const run = async (on: boolean) => {
    setErr(null)
    const t = own.trim() ? Math.max(1, Number(own.replace(/\D/g, '')) || 0) : target
    const r = await post('/api/autopilot', { id: unit.id, on, target: on ? t : undefined })
    if (r?.error) setErr(String(r.error))
  }

  return (
    <Card className="rise p-3.5">
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

        <Label>разброс</Label>
        <Segmented
          value={String(waves)}
          items={WAVES.map(w => ({ id: String(w), label: w === 1 ? 'нет' : w + ' партии' }))}
          onPick={id => post('/api/autopilot', { id: unit.id, waves: Number(id), target: own.trim() ? Number(own) : target })}
        />

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
            <span className="text-muted-foreground">
              остановлюсь на <span className="tnum font-mono text-foreground">{nf(unit.target)}</span>
              {unit.ordered && unit.ordered !== unit.target ? ` — заказ ${nf(unit.ordered)}, круглое не берём` : ''}
            </span>
            <span className="tnum font-mono">
              <Num value={unit.done} /> · осталось {nf(Math.max(0, unit.target - unit.done))} ·{' '}
              {span(Math.round((unit.target - unit.done) * unit.delay / 60000))}
            </span>
          </div>
          <Bar pct={(unit.done / unit.target) * 100} tone={unit.done >= unit.target ? 'ok' : 'run'} />
        </div>
      ) : null}

      {plan.length > 1 ? (
        <div className="mt-3 border-t border-white/[0.06] pt-3">
          <div className="mb-2 flex items-center gap-2">
            <Shuffle className="h-3.5 w-3.5 text-muted-foreground" />
            <Label>партии — чтобы счётчики вышли разными</Label>
          </div>
          <div className="flex flex-wrap gap-2">
            {plan.map(w => {
              const passed = unit.done >= w.addAt
              const nextUp = unit.nextWave?.index === w.index
              return (
                <span
                  key={w.index}
                  className={'flex items-center gap-2 border px-3 py-2 text-[12px] ' +
                    (nextUp ? 'border-white/25 bg-white/[0.06]' : 'border-white/[0.08]')}
                >
                  <Dot tone={passed ? 'ok' : nextUp ? 'warn' : 'idle'} pulse={nextUp && unit.running} />
                  <span className="tnum font-mono">{nf(w.value)}</span>
                  <span className="text-muted-foreground">
                    {w.addAt === 0 ? 'уже в инвентаре' : passed ? 'добавлена' : 'добавить на ' + nf(w.addAt)}
                  </span>
                </span>
              )
            })}
          </div>
          {unit.nextWave ? (
            <div className="mt-2 text-[12px]" style={{ color: unit.done >= unit.nextWave.addAt ? 'var(--warn)' : undefined }}>
              {unit.done >= unit.nextWave.addAt
                ? 'пора добавить следующую партию — она догонит до ' + nf(unit.nextWave.value)
                : 'следующая партия через ' + nf(unit.nextWave.addAt - unit.done) + ' отправок'}
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}
