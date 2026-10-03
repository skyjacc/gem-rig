import { useState, useEffect } from 'react'
import { nf, post, useJson, type Settings, type State, type Unit } from '../lib/api.ts'
import { Button, Field, ItemIcon, Label, Note, Segmented } from './ui.tsx'
import { Modal } from './Modal.tsx'
import { Reveal } from './Reveal.tsx'

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
// Пауза в человеческом виде: миллисекунды читаются плохо, секунды хорошо.
const secs = (ms: number) =>
  ms >= 60_000 ? Math.round(ms / 60_000) + ' мин' : (ms / 1000).toFixed(ms >= 10_000 ? 0 : 1).replace('.', ',') + ' с'

const CAP = [0, 500, 1000, 1500, 2000]
const WAVES = [1, 2, 3, 4, 5]

// Срок задаётся кнопкой, а не вводом времени: ночью проще ткнуть «до утра»,
// чем вспоминать, какое сегодня число.
function untilFrom(id: string): number {
  const now = Date.now()
  if (id === '2ч') return now + 2 * 3600_000
  if (id === '8ч') return now + 8 * 3600_000
  if (id === 'утро') {
    const d = new Date()
    d.setHours(10, 0, 0, 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  return 0
}

function untilLabel(until: number) {
  if (!until) return 'нет'
  const d = new Date(until)
  if (d.getHours() === 10 && d.getMinutes() === 0) return 'утро'
  return (until - Date.now()) / 3600_000 > 5 ? '8ч' : '2ч'
}

function left(until: number) {
  const ms = until - Date.now()
  if (ms <= 0) return 'срок вышел'
  const h = Math.floor(ms / 3600_000)
  const m = Math.round((ms % 3600_000) / 60_000)
  return h ? h + ' ч ' + m + ' мин' : m + ' мин'
}

export function Tune({
  open,
  onClose,
  state,
  unit,
  initial,
}: {
  open: boolean
  onClose: () => void
  state: State
  unit: Unit
  // С какой вкладки открыть. Без него — как раньше: вкладка остаётся той,
  // на которой окно закрыли.
  initial?: 'run' | 'rules'
}) {
  const [tab, setTab] = useState<'run' | 'rules'>(initial ?? 'run')
  useEffect(() => { if (open && initial) setTab(initial) }, [open, initial])

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
  // Признак «ввожу своё» отдельно от самого текста. Раньше режим держался
  // на непустоте поля, и стёртое до конца число возвращало прежний набор
  // прямо под руками — стереть, чтобы набрать заново, было нельзя.
  const [own, setOwn] = useState<string | null>(null)
  const send = (patch: Record<string, unknown>) => post('/api/autopilot', { id: unit.id, ...patch })

  const available = unit.available ?? []
  const only = unit.only ?? null
  const chosen = new Set(only ?? available.map(g => g.gem))
  const icons = new Map(state.mine.filter(m => m.gem !== '—').map(m => [m.gem, m.icon]))

  const flip = (gem: string) => {
    const next = new Set(chosen)
    next.has(gem) ? next.delete(gem) : next.add(gem)
    const list = [...next]
    send({ only: list.length === available.length ? null : list })
  }

  return (
    <div className="space-y-4">
      <Line k="сколько отправок" hint="и встать; «всё» — до конца очереди">
        <span className="flex flex-wrap items-center gap-2">
          <Segmented
            value={own === null ? String(unit.ordered) : 'own'}
            items={[
              ...TARGET.map(t => ({ id: String(t), label: t === null ? 'всё' : nf(t) })),
              { id: 'own', label: 'своё' },
            ]}
            onPick={id => {
              if (id === 'own') { setOwn(String(unit.ordered ?? 250)); return }
              setOwn(null)
              send({ target: id === 'null' ? null : Number(id) })
            }}
          />
          {own !== null ? (
            <>
              <Field value={own} onChange={v => setOwn(v.replace(/\D/g, ''))} width="w-24" inputMode="numeric" />
              <Button disabled={!own} onClick={() => send({ target: Number(own) })}>применить</Button>
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

      <Line k="работать до" hint="ночной прогон удобнее задавать сроком: сколько успеется, столько и хорошо">
        <span className="flex flex-wrap items-center gap-2">
          <Segmented
            value={untilLabel(unit.until ?? 0)}
            items={[
              { id: 'нет', label: 'без срока' },
              { id: '2ч', label: '2 ч' },
              { id: '8ч', label: '8 ч' },
              { id: 'утро', label: 'до 10 утра' },
            ]}
            onPick={id => send({ until: untilFrom(id) })}
          />
          {unit.until ? (
            <span className="text-[12px] text-muted-foreground">
              встану в{' '}
              <span className="tnum font-mono text-foreground">
                {new Date(unit.until).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}
              </span>
              {' · осталось '}{left(unit.until)}
            </span>
          ) : null}
        </span>
      </Line>

      <Line
        k="докуда вести каждый гем"
        hint="дойдя до потолка, гем выходит из работы, а его матчи остаются целыми"
      >
        <span className="flex flex-wrap items-center gap-2">
          <Segmented
            value={String(unit.cap ?? 0)}
            items={CAP.map(c => ({ id: String(c), label: c === 0 ? 'весь запас' : nf(c) }))}
            onPick={id => send({ cap: Number(id) })}
          />
          {(unit.capped ?? []).length ? (
            <span className="text-[12px]" style={{ color: 'var(--ok)' }}>
              дошли: {unit.capped!.join(', ')}
            </span>
          ) : null}
        </span>
        {(unit.caps ?? []).length ? (
          <div className="flex flex-wrap gap-1.5">
            {unit.caps!.map(c => (
              <span
                key={c.gem}
                className="tnum border border-white/[0.08] px-2 py-1 font-mono text-[12px]"
                style={(unit.capped ?? []).includes(c.gem) ? { color: 'var(--ok)' } : undefined}
              >
                <span className="mr-2 font-sans text-muted-foreground">{c.gem}</span>
                {nf(c.cap)}
              </span>
            ))}
          </div>
        ) : null}
        <p className="text-[12px] text-muted-foreground">
          у каждого гема потолок свой и некруглый — счётчики выходят разными сами собой
        </p>
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

      <Line
        k="пауза"
        hint="«к сроку» делит работу на оставшееся время; «сама» гонит, пока Valve отвечает"
      >
        <span className="flex flex-wrap items-center gap-2">
          <Segmented
            value={unit.even && unit.until ? 'even' : unit.auto ? 'auto' : String(unit.delay)}
            items={[
              { id: 'even', label: 'к сроку' },
              { id: 'auto', label: 'сама' },
              ...PACE.map(([ms, l]) => ({ id: String(ms), label: l })),
            ]}
            onPick={id => send(
              id === 'even' ? { even: true }
                : id === 'auto' ? { even: false, auto: true }
                  : { even: false, delay: Number(id) },
            )}
          />
          <span className="tnum font-mono text-[12px] text-muted-foreground">{nf(unit.delay)} мс</span>
        </span>
        {/* У паузы один хозяин за раз, и порядок старшинства такой:
            пол из общих правил → выбор здесь → подбор на ходу.
            Раньше «сама» и «к сроку» могли быть включены одновременно
            и переписывали друг друга каждый такт. */}
        <p className="text-[11px] leading-snug text-muted-foreground/75">
          ниже пола из общих правил не опустится никогда · выбранное здесь отменяет
          подбор на ходу · «к сроку» и «сама» не работают вместе
        </p>
        {unit.even && !unit.until ? (
          <p className="text-[12px]" style={{ color: 'var(--warn)' }}>
            делить не на что — задайте срок выше
          </p>
        ) : null}
        {unit.even && unit.until ? (
          <p className="text-[12px] text-muted-foreground">
            осталось <span className="tnum font-mono text-foreground">{nf(unit.sendsLeft ?? 0)}</span> отправок
            {' на '}{left(unit.until)} — по одной в{' '}
            <span className="tnum font-mono text-foreground">{secs(unit.delay)}</span>
          </p>
        ) : state.autopilot.pace && unit.auto ? (
          <p className="text-[12px] text-muted-foreground">{state.autopilot.pace.why}</p>
        ) : null}
      </Line>

      <Line
        k="какие гемы накручивать"
        hint={only ? (only.length ? 'выбрано ' + only.length + ' из ' + available.length : 'ничего не выбрано — жечь нечего') : 'все, что лежат в инвентаре'}
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
                  <span className="tnum font-mono text-[11px] text-muted-foreground/75">{g.objects}</span>
                </button>
              )
            })}
            {only ? <Button onClick={() => send({ only: null })}>все</Button> : null}
          </div>
        )}
      </Line>
    </div>
  )
}

// Общие пороги.
//
// Делятся надвое, и это не про экономию места. Показывать «долю молчаний,
// ниже которой темп считается чистым» рядом с ценой продажи — значит
// утверждать, что это одинаково понятные вещи. Первое трогают, когда знают
// последствия; второе меняют, потому что цена на рынке изменилась.
type Rule = { path: string; label: string; hint: string; unit?: string; scale?: number }

const BASIC: Rule[] = [
  { path: 'goal', label: 'цель счётчика', hint: 'сколько просмотров делает вещь товаром' },
  { path: 'sellPrice', label: 'цена готовой вещи', hint: 'за сколько уходит вещь со счётчиком — от этого числа считается вся выгода в скупке', unit: '$' },
  { path: 'perGem', label: 'сколько брать одного гема', hint: 'потолок на позицию в «собрать лучшее»: двадцать шестая копия продаётся не лучше двадцать пятой' },
  { path: 'priceTolerance', label: 'допуск по цене', hint: 'на сколько цена может вырасти между планом и покупкой; ноль — только по своей или дешевле', unit: '%', scale: 0.01 },
  { path: 'purchaseCap', label: 'потолок закупки', hint: 'больше этой суммы за один запуск не потратится, в валюте счёта площадки; пока ноль — закупка не начнётся' },
  { path: 'tick', label: 'как часто проверять', hint: 'через сколько заглядывать в инвентарь и состояние отправщика', unit: 'с', scale: 1000 },
  { path: 'invTtl', label: 'когда перечитывать Steam', hint: 'через сколько запрашивать инвентарь заново', unit: 'с', scale: 1000 },
]

const DEEP: Rule[] = [
  { path: 'silentLimit', label: 'сколько ждать молча', hint: 'после этого отправщик перезапускается; на растяжке предел растёт вместе с паузой', unit: 'с', scale: 1000 },
  { path: 'startLimit', label: 'сколько ждать первой отправки', hint: 'у отправщика своя лестница отходов при обрывах связи — 15, 30, 60, 120 секунд', unit: 'с', scale: 1000 },
  { path: 'maxFailures', label: 'сколько падений терпеть', hint: 'после этого встать и сказать почему' },
  { path: 'invStale', label: 'когда счётчикам больше не верить', hint: 'при работе с потолком: старее этого — работник останавливается, чтобы не жечь вслепую', unit: 'мин', scale: 60000 },
  { path: 'pace.floor', label: 'пол паузы', hint: 'ниже не опускаться никогда; отправщик значение меньше 500 мс не принимает вовсе', unit: 'мс' },
  { path: 'pace.ceil', label: 'потолок паузы', hint: 'выше не подниматься', unit: 'мс' },
  { path: 'pace.enough', label: 'сколько отправок для замера', hint: 'по меньшему числу судить о темпе нельзя' },
  { path: 'pace.clean', label: 'сколько тишины терпеть', hint: 'доля отправок без ответа, которая ещё считается нормой', unit: '%', scale: 0.01 },
  { path: 'pace.down', label: 'шаг ускорения', hint: 'на сколько умножается пауза, когда GC отвечает на каждую отправку' },
  { path: 'pace.up', label: 'шаг отхода', hint: 'на сколько умножается пауза, когда появились молчания' },
  { path: 'spread.band', label: 'насколько разные числа', hint: 'на сколько процентов расходятся партии разброса', unit: '%', scale: 0.01 },
  { path: 'spread.jitter', label: 'дрожание', hint: 'случайная добавка поверх ровного шага, чтобы партии не легли по линейке', unit: '%', scale: 0.01 },
  { path: 'treeTop', label: 'турниров в дереве', hint: 'сколько самых больших показывать под гемом' },
]

const get = (o: any, p: string) => p.split('.').reduce((a, k) => a?.[k], o)

function Rules({ state }: { state: State }) {
  const { data, loading, error, reload } = useJson<Settings>('/api/settings', state.ts)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [deep, setDeep] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  if (error) {
    return (
      <Note title="настройки не прочитались" action={<Button onClick={reload} loading={loading}>ещё раз</Button>}>
        {error}
      </Note>
    )
  }
  if (!data) return <p className="text-[13px] text-muted-foreground">читаю…</p>

  const apply = async (r: Rule) => {
    const raw = draft[r.path]
    if (raw === undefined) return
    const n = Number(raw.replace(',', '.'))
    if (!Number.isFinite(n)) { setFailed(r.label + ': это не число'); return }
    const [a, b] = r.path.split('.')
    const v = r.scale ? n * r.scale : n
    const res: any = await post('/api/settings', b ? { [a]: { [b]: v } } : { [a]: v })
    setFailed(res?.error ? r.label + ': ' + res.error : null)
    setDraft(d => { const x = { ...d }; delete x[r.path]; return x })
  }

  // Пороги зажимаются на сервере: панель — не место, где можно случайно
  // выставить паузу в ноль. Поэтому введённое число может отличаться от
  // сохранённого, и поле после «ок» показывает то, что приняли, а не то,
  // что набрали.
  const row = (r: Rule) => {
    const raw = Number(get(data, r.path))
    const shown = draft[r.path] ?? String(Math.round((r.scale ? raw / r.scale : raw) * 1000) / 1000)
    return (
      <div key={r.path} className="flex flex-wrap items-center gap-3 py-2.5">
        <span className="min-w-[180px] flex-1">
          <span className="block text-[13px]">{r.label}</span>
          <span className="block text-[12px] leading-snug text-muted-foreground">{r.hint}</span>
        </span>
        <Field
          value={shown}
          onChange={v => setDraft(d => ({ ...d, [r.path]: v }))}
          width="w-20 text-right"
          inputMode="decimal"
          aria-label={r.label}
          onKeyDown={e => { if (e.key === 'Enter') apply(r) }}
        />
        <span className="ui-label w-6 shrink-0 text-muted-foreground/70">{r.unit ?? ''}</span>
        <Button disabled={draft[r.path] === undefined} active={draft[r.path] !== undefined} onClick={() => apply(r)}>
          ок
        </Button>
      </div>
    )
  }

  return (
    <div>
      {failed ? <div className="mb-3"><Note title="не принято">{failed}</Note></div> : null}

      <div className="divide-y divide-white/[0.06]">{BASIC.map(row)}</div>

      <button
        type="button"
        onClick={() => setDeep(!deep)}
        aria-expanded={deep}
        className="ui-label mt-3 flex w-full items-center gap-2 border-t border-white/[0.06] pt-3 text-left text-muted-foreground transition-colors hover:text-foreground"
      >
        <span>{deep ? 'скрыть' : 'показать'} пороги работника и темпа</span>
        <span className="ml-auto text-muted-foreground/75">{DEEP.length}</span>
      </button>
      <Reveal open={deep}>
        <div className="divide-y divide-white/[0.06] pt-1">{DEEP.map(row)}</div>
      </Reveal>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-3">
        <span className="max-w-[380px] text-[12px] leading-relaxed text-muted-foreground">
          значения по умолчанию — замер 20 августа: 76 отправок в минуту при паузе
          в секунду, отклик GC 340 мс по медиане
        </span>
        <Button onClick={() => post('/api/settings/reset', {})}>сбросить всё</Button>
      </div>
    </div>
  )
}

function Line({ k, hint, children }: { k: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 border-b border-white/[0.06] pb-4 last:border-0 last:pb-0">
      <div>
        <Label>{k}</Label>
        {hint ? <div className="text-[11px] text-muted-foreground/75">{hint}</div> : null}
      </div>
      {children}
    </div>
  )
}
