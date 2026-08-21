import { useState } from 'react'
import { nf, post, useJson, type Settings, type State, type Unit } from '../lib/api.ts'
import { Button, Field, ItemIcon, Label, Segmented } from './ui.tsx'
import { Modal } from './Modal.tsx'

// Настройка накрутки — всё в одном окне.
//
// Раньше это лежало в трёх местах: полоса запуска на главном экране,
// карточка аккаунта и отдельный экран порогов. Человек настраивает раз
// и надолго, поэтому нет смысла держать это на виду; но когда он приходит
// настраивать — всё должно быть рядом, а не в трёх вкладках.
//
// Два уровня: «этот аккаунт» — то, что меняют часто; «общие правила» —
// пороги, которые крутят раз в месяц.
//
// Панель у правого края, а не окно посередине: содержимое разной высоты,
// две вкладки и длинный список порогов. Посередине это прыгало при каждом
// переключении.

const PACE: [number, string][] = [[500, '0,5 с'], [1000, '1 с'], [2000, '2 с'], [5000, '5 с'], [30000, '30 с']]
const TARGET: (number | null)[] = [100, 500, 2000, null]
const WAVES = [1, 2, 3, 4, 5]

export function Tune({
  open,
  onClose,
  state,
  unit,
}: {
  open: boolean
  onClose: () => void
  state: State
  unit: Unit
}) {
  const [tab, setTab] = useState<'run' | 'rules'>('run')

  return (
    <Modal
      open={open}
      title="Настройка"
      note={unit.label}
      variant="side"
      onClose={onClose}
      footer={<Button onClick={onClose}>готово</Button>}
    >
      <Segmented
        value={tab}
        items={[{ id: 'run' as const, label: 'этот аккаунт' }, { id: 'rules' as const, label: 'общие правила' }]}
        onPick={setTab}
        className="mb-4"
      />
      {tab === 'run' ? <Run state={state} unit={unit} /> : <Rules state={state} />}
    </Modal>
  )
}

function Run({ state, unit }: { state: State; unit: Unit }) {
  const [own, setOwn] = useState(unit.ordered ? String(unit.ordered) : '')
  const send = (patch: Record<string, unknown>) => post('/api/autopilot', { id: unit.id, ...patch })

  const available = unit.available ?? []
  const only = unit.only ?? null
  const chosen = new Set(only ?? available.map(g => g.gem))
  const icons = new Map(state.mine.filter(m => m.gem !== '—').map(m => [m.gem, m.icon]))

  const flip = (gem: string) => {
    const next = new Set(chosen)
    next.has(gem) ? next.delete(gem) : next.add(gem)
    const list = [...next]
    send({ only: list.length === available.length ? [] : list })
  }

  return (
    <div className="space-y-4">
      <Line k="сколько отправок" hint="и встать; «всё» — до конца очереди">
        <span className="flex flex-wrap items-center gap-2">
          <Segmented
            value={own.trim() ? 'own' : String(unit.ordered)}
            items={[
              ...TARGET.map(t => ({ id: String(t), label: t === null ? 'всё' : nf(t) })),
              { id: 'own', label: 'своё' },
            ]}
            onPick={id => {
              if (id === 'own') { setOwn(own || '250'); return }
              setOwn('')
              send({ target: id === 'null' ? null : Number(id) })
            }}
          />
          {own.trim() ? (
            <>
              <Field value={own} onChange={v => setOwn(v.replace(/\D/g, ''))} width="w-24" inputMode="numeric" />
              <Button onClick={() => send({ target: Number(own) })}>применить</Button>
            </>
          ) : null}
        </span>
        {unit.target ? (
          <p className="text-[12px] text-muted-foreground">
            остановлюсь на <span className="tnum font-mono text-foreground">{nf(unit.target)}</span>
            {unit.ordered && unit.ordered !== unit.target
              ? ' — заказ ' + nf(unit.ordered) + ', круглые числа выдают накрутку'
              : ''}
          </p>
        ) : null}
      </Line>

      <Line k="разброс" hint="партиями, чтобы счётчики вышли разными, а не одинаковыми">
        <Segmented
          value={String(unit.waves ?? 1)}
          items={WAVES.map(w => ({ id: String(w), label: w === 1 ? 'нет' : String(w) }))}
          onPick={id => send({ waves: Number(id), target: unit.ordered ?? null })}
        />
        {(unit.plan ?? []).length > 1 ? (
          <div className="flex flex-wrap gap-1.5">
            {unit.plan!.map(w => (
              <span key={w.index} className="tnum border border-white/[0.08] px-2 py-1 font-mono text-[12px]">
                {nf(w.value)}
                <span className="ml-2 text-muted-foreground">{w.addAt === 0 ? 'сразу' : '+' + nf(w.addAt)}</span>
              </span>
            ))}
          </div>
        ) : null}
      </Line>

      <Line k="пауза" hint="на «сама» темп растёт, пока Valve отвечает на каждую отправку">
        <span className="flex flex-wrap items-center gap-2">
          <Segmented
            value={unit.auto ? 'auto' : String(unit.delay)}
            items={[{ id: 'auto', label: 'сама' }, ...PACE.map(([ms, l]) => ({ id: String(ms), label: l }))]}
            onPick={id => send(id === 'auto' ? { auto: true } : { delay: Number(id) })}
          />
          <span className="tnum font-mono text-[12px] text-muted-foreground">{nf(unit.delay)} мс</span>
        </span>
        {state.autopilot.pace && unit.auto ? (
          <p className="text-[12px] text-muted-foreground">{state.autopilot.pace.why}</p>
        ) : null}
      </Line>

      <Line
        k="какие гемы накручивать"
        hint={only ? 'выбрано ' + only.length + ' из ' + available.length : 'все, что лежат в инвентаре'}
      >
        {available.length === 0 ? (
          <span className="text-[12px] text-muted-foreground">нет гемов, по которым понятно, чьи матчи считать</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {available.map(g => {
              const on = chosen.has(g.gem)
              return (
                <button
                  key={g.gem}
                  type="button"
                  onClick={() => flip(g.gem)}
                  className={
                    'ui-label inline-flex h-8 items-center gap-2 border px-2 transition-colors ' +
                    (on
                      ? 'border-white/20 bg-white/[0.08] text-foreground'
                      : 'border-white/[0.08] text-muted-foreground hover:border-white/20')
                  }
                >
                  <span className={on ? '' : 'opacity-40'}>
                    <ItemIcon hash={icons.get(g.gem) ?? ''} size={16} />
                  </span>
                  <span>{g.gem}</span>
                  <span className="tnum font-mono text-[11px] text-muted-foreground/60">{g.objects}</span>
                </button>
              )
            })}
            {only ? <Button onClick={() => send({ only: [] })}>все</Button> : null}
          </div>
        )}
      </Line>
    </div>
  )
}

// Общие пороги. Крутят редко, поэтому лежат вторым слоем.
const RULES: { path: string; label: string; hint: string; unit?: string; scale?: number }[] = [
  { path: 'goal', label: 'цель счётчика', hint: 'сколько просмотров делает вещь товаром' },
  { path: 'tick', label: 'как часто проверять', hint: 'через сколько заглядывать в инвентарь', unit: 'с', scale: 1000 },
  { path: 'invTtl', label: 'когда перечитывать Steam', hint: 'через сколько запрашивать инвентарь заново', unit: 'с', scale: 1000 },
  { path: 'silentLimit', label: 'сколько ждать молча', hint: 'после этого отправка перезапускается', unit: 'с', scale: 1000 },
  { path: 'startLimit', label: 'сколько ждать первой отправки', hint: 'у отправщика своя лестница отходов при обрывах связи', unit: 'с', scale: 1000 },
  { path: 'maxFailures', label: 'сколько сбоев терпеть', hint: 'после этого остановиться и сказать почему' },
  { path: 'pace.floor', label: 'пол паузы', hint: 'ниже не опускаться никогда', unit: 'мс' },
  { path: 'pace.ceil', label: 'потолок паузы', hint: 'выше не подниматься', unit: 'мс' },
  { path: 'pace.enough', label: 'сколько отправок для замера', hint: 'по меньшему числу судить о темпе нельзя' },
  { path: 'pace.clean', label: 'сколько тишины терпеть', hint: 'доля отправок без ответа, которая ещё нормальна', unit: '%', scale: 0.01 },
  { path: 'spread.band', label: 'насколько разные числа', hint: 'на сколько процентов расходятся партии', unit: '%', scale: 0.01 },
  { path: 'treeTop', label: 'турниров в дереве', hint: 'сколько самых больших показывать под гемом' },
  { path: 'priceTolerance', label: 'допуск по цене', hint: 'на сколько цена может вырасти между планом и покупкой; ноль — только по своей или дешевле', unit: '%', scale: 0.01 },
]

const get = (o: any, p: string) => p.split('.').reduce((a, k) => a?.[k], o)

function Rules({ state }: { state: State }) {
  const { data } = useJson<Settings>('/api/settings', state.ts)
  const [draft, setDraft] = useState<Record<string, string>>({})
  if (!data) return <p className="text-[13px] text-muted-foreground">читаю…</p>

  const apply = async (r: typeof RULES[number]) => {
    const raw = draft[r.path]
    if (raw === undefined) return
    const n = Number(raw.replace(',', '.'))
    if (!Number.isFinite(n)) return
    const [a, b] = r.path.split('.')
    const v = r.scale ? n * r.scale : n
    await post('/api/settings', b ? { [a]: { [b]: v } } : { [a]: v })
    setDraft(d => { const x = { ...d }; delete x[r.path]; return x })
  }

  return (
    <div>
      <div className="divide-y divide-white/[0.06]">
        {RULES.map(r => {
          const raw = Number(get(data, r.path))
          const shown = draft[r.path] ?? String(Math.round((r.scale ? raw / r.scale : raw) * 1000) / 1000)
          return (
            <div key={r.path} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px]">{r.label}</span>
                <span className="block text-[12px] leading-snug text-muted-foreground">{r.hint}</span>
              </span>
              <Field
                value={shown}
                onChange={v => setDraft(d => ({ ...d, [r.path]: v }))}
                width="w-20 text-right"
                inputMode="decimal"
                onKeyDown={e => { if (e.key === 'Enter') apply(r) }}
              />
              <span className="ui-label w-5 shrink-0 text-muted-foreground/70">{r.unit ?? ''}</span>
              <Button disabled={draft[r.path] === undefined} active={draft[r.path] !== undefined} onClick={() => apply(r)}>
                ок
              </Button>
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-3">
        <span className="text-[12px] text-muted-foreground">
          значения по умолчанию — замер 20 августа: 76 отправок в минуту при паузе в секунду
        </span>
        <Button onClick={() => post('/api/settings/reset', {})}>сбросить</Button>
      </div>
    </div>
  )
}

function Line({ k, hint, children }: { k: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 border-b border-white/[0.06] pb-4 last:border-0 last:pb-0">
      <div>
        <Label>{k}</Label>
        {hint ? <div className="text-[11px] text-muted-foreground/60">{hint}</div> : null}
      </div>
      {children}
    </div>
  )
}
