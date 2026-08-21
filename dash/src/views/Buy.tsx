import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Minus, Plus, RefreshCw, ShoppingCart, SlidersHorizontal, Wand2 } from 'lucide-react'
import { nf, post, useJson, type State } from '../lib/api.ts'
import { Button, Card, Dot, Empty, Field, ItemIcon, Label, PageHead, Segmented } from '../parts/ui.tsx'
import { Modal } from '../parts/Modal.tsx'
import { Reveal } from '../parts/Reveal.tsx'

// Скупка.
//
// Терминал, а не витрина: цифры и скорость решения, без карточек товара.
//
// Главное отличие от обычной скупки — у нас ограничение не деньги, а время.
// Одно сообщение поднимает ВСЕ вещи одной команды разом, поэтому отправки
// считаются на команду, а не на штуку: сто самоцветов Virtus.pro стоят той же
// тысячи отправок, что и один. А копия команды, которая уже накручивается,
// не стоит вообще ничего — только полцента за сам самоцвет.
//
// Отсюда две колонки прибыли: на доллар и на отправку. Первая всегда
// огромна, вторая и есть настоящий выбор.

type Offer = {
  gem: string
  name: string
  price: number
  volume: number
  pool: number
  owned: number
  reaches: boolean
  burning: boolean
  sends: number
  revenue: number
  profit: number
}

type Cur = 'RUB' | 'USD' | 'EUR' | 'UAH'

type Scan = {
  goal: number
  sell: number
  currency: Cur
  converted: boolean   // цена пересчитана, а не взята у площадки
  rate: number
  perGem: number
  updated: number
  error: string | null
  scanned: number
  balance: number | null
  balanceCurrency: string | null
  balanceError: string | null
  offers: Offer[]
}

const SIGN: Record<Cur, string> = { RUB: '₽', USD: '$', EUR: '€', UAH: '₴' }

// Доллар знаком спереди и точкой, остальные — знаком сзади и запятой.
// Полцента должно остаться полцентом, а не округлиться в ноль.
function money(v: number, c: Cur) {
  const n = Number(v) || 0
  if (c === 'USD') return '$' + n.toFixed(Math.abs(n) < 0.01 && n !== 0 ? 3 : 2)
  const [w, f] = n.toFixed(Math.abs(n) < 1 && n !== 0 ? 3 : 2).split('.')
  return w.replace(/\B(?=(\d{3})+$)/g, ' ') + ',' + f + ' ' + SIGN[c]
}

const SPEED = 76   // отправок в минуту, замер 20 августа

// Столбцы: по любому можно отсортировать, по числовым — задать диапазон.
// Порядок тот же, что в таблице, чтобы заголовки и фильтры не разъезжались.
type SortKey = 'gem' | 'price' | 'pool' | 'volume' | 'sends' | 'take' | 'cost' | 'profit'
type RangeKey = 'price' | 'pool' | 'volume' | 'sends'

const COLUMNS: { key: SortKey; title: string; align: string }[] = [
  { key: 'gem', title: 'гем', align: '' },
  { key: 'price', title: 'цена', align: 'text-right' },
  { key: 'pool', title: 'потолок', align: 'text-right' },
  { key: 'volume', title: 'в продаже', align: 'text-right' },
  { key: 'sends', title: 'отправок', align: 'text-right' },
  { key: 'take', title: 'взять', align: 'text-center' },
  { key: 'cost', title: 'стоимость', align: 'text-right' },
  { key: 'profit', title: 'прибыль', align: 'text-right' },
]

const RANGES: { key: RangeKey; title: string }[] = [
  { key: 'price', title: 'цена' },
  { key: 'pool', title: 'потолок' },
  { key: 'volume', title: 'в продаже' },
  { key: 'sends', title: 'отправок' },
]

const EMPTY: Record<RangeKey, [string, string]> = {
  price: ['', ''], pool: ['', ''], volume: ['', ''], sends: ['', ''],
}

// Сколько диапазонов заполнено — числом на кнопке, чтобы не забыть,
// что список сужен и часть предложений не видна.
const used = (r: Record<RangeKey, [string, string]>) =>
  Object.values(r).filter(([a, b]) => a !== '' || b !== '').length

export function Buy({ state }: { state: State }) {
  const [cur, setCur] = useState<Cur>('USD')
  const { data } = useJson<Scan>('/api/market?cur=' + cur, state.ts + '|' + cur)
  const [take, setTake] = useState<Record<string, number>>({})
  const [only, setOnly] = useState<'fit' | 'free' | 'all'>('fit')
  const [q, setQ] = useState('')
  const [budget, setBudget] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; down: boolean }>({ key: 'profit', down: true })
  const [filters, setFilters] = useState(false)
  const [range, setRange] = useState<Record<RangeKey, [string, string]>>(EMPTY)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const offers = useMemo(() => {
    if (!data) return []

    // Пустая граница означает «без ограничения», а не ноль.
    const between = (v: number, r: [string, string]) => {
      const lo = r[0] === '' ? -Infinity : Number(r[0].replace(',', '.'))
      const hi = r[1] === '' ? Infinity : Number(r[1].replace(',', '.'))
      return v >= (Number.isFinite(lo) ? lo : -Infinity) && v <= (Number.isFinite(hi) ? hi : Infinity)
    }

    const rows = data.offers
      .filter(o => (only === 'all' ? true : only === 'free' ? o.burning : o.reaches))
      .filter(o => !q || o.gem.toLowerCase().includes(q.toLowerCase()))
      .filter(o => between(o.price, range.price) && between(o.pool, range.pool) &&
        between(o.volume, range.volume) && between(o.sends, range.sends))

    const val = (o: Offer): number | string => {
      const n = take[o.gem] ?? 0
      if (sort.key === 'gem') return o.gem.toLowerCase()
      if (sort.key === 'price') return o.price
      if (sort.key === 'pool') return o.pool
      if (sort.key === 'volume') return o.volume
      if (sort.key === 'sends') return o.sends
      if (sort.key === 'take') return n
      if (sort.key === 'cost') return n * o.price
      return n * (o.reaches ? data.sell : 0) - n * o.price
    }

    return [...rows].sort((a, b) => {
      const x = val(a)
      const y = val(b)
      const c = typeof x === 'string'
        ? String(x).localeCompare(String(y))
        : (x as number) - (y as number)
      return sort.down ? -c : c
    })
  }, [data, only, q, range, sort, take])

  const cart = useMemo(() => {
    if (!data) return { lines: [], units: 0, cost: 0, revenue: 0, profit: 0, sends: 0, minutes: 0 }
    const lines = data.offers
      .map(o => ({ o, n: take[o.gem] ?? 0 }))
      .filter(x => x.n > 0)
    const units = lines.reduce((n, x) => n + x.n, 0)
    const cost = lines.reduce((n, x) => n + x.n * x.o.price, 0)
    const revenue = lines.reduce((n, x) => n + (x.o.reaches ? x.n * data.sell : 0), 0)
    // Отправки — на команду, а не на штуку.
    const sends = lines.reduce((n, x) => n + (x.o.burning ? 0 : x.o.sends), 0)
    return { lines, units, cost, revenue, profit: revenue - cost, sends, minutes: Math.round(sends / SPEED) }
  }, [data, take])

  if (!data) return <Card className="p-6 text-[13px] text-muted-foreground">опрашиваю площадку…</Card>

  const bump = (gem: string, n: number, max: number) =>
    setTake(t => ({ ...t, [gem]: Math.max(0, Math.min(max, (t[gem] ?? 0) + n)) }))

  // Оптимальная закупка: сначала то, что не стоит отправок, потом дешёвое.
  const optimal = () => {
    const money = Number(budget.replace(',', '.')) || 0
    if (!money) return
    let left = money
    const next: Record<string, number> = {}
    const order = [...data.offers]
      .filter(o => o.reaches)
      .sort((a, b) => Number(b.burning) - Number(a.burning) || a.price - b.price)
    for (const o of order) {
      const can = Math.min(o.volume, Math.floor(left / o.price))
      if (can <= 0) continue
      next[o.gem] = can
      left -= can * o.price
    }
    setTake(next)
  }

  const kpi = data.offers.filter(o => o.reaches)
  const free = kpi.filter(o => o.burning)

  return (
    <div className="view-in space-y-4">
      <PageHead
        title="Скупка"
        sub="цена лота ничего не значит без запаса матчей: отправки считаются на команду, а не на штуку"
        right={
          <>
            <span className="ui-label flex h-10 items-center gap-2 border border-white/[0.08] px-2.5 text-muted-foreground">
              <Dot tone={data.error ? 'stop' : 'ok'} pulse={!data.error} />
              {data.error ? data.error : 'просмотрено ' + nf(data.scanned) + ' позиций'}
              {data.updated ? ' · ' + new Date(data.updated).toLocaleTimeString('ru-RU') : ''}
            </span>
            <Segmented
              value={cur}
              items={(['RUB', 'USD', 'EUR', 'UAH'] as Cur[]).map(c => ({ id: c, label: SIGN[c] + ' ' + c }))}
              onPick={setCur}
            />
            <Button onClick={() => fetch('/api/market?force=1&cur=' + cur)}>
              <RefreshCw className="h-3.5 w-3.5" />
              <span>обновить</span>
            </Button>
          </>
        }
      />

      <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(170px,1fr))]">
        <Kpi k="гемов подходит" v={nf(kpi.length)} note={'из ' + nf(data.offers.length) + ' найденных'} />
        <Kpi k="лотов доступно" v={nf(kpi.reduce((n, o) => n + o.volume, 0))} />
        <Kpi k="без отправок" v={nf(free.reduce((n, o) => n + o.volume, 0))} note="уже накручиваются" tone="ok" />
        <Kpi k="цена лота" v={money(kpi[0]?.price ?? 0, cur)} note={data.converted ? 'пересчёт по курсу НБУ ' + data.rate.toFixed(2) : 'минимальная'} />
        <Kpi k="продажа" v={money(data.sell, cur)} note="за готовую вещь" />
        <Kpi
          k="на счету"
          v={data.balance != null ? money(data.balance, (data.balanceCurrency as Cur) ?? cur) : '—'}
          note={data.balanceError ?? 'на market.dota2.net'}
          tone={data.balance ? 'ok' : undefined}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={only}
          items={[
            { id: 'fit' as const, label: 'дойдут до цели' },
            { id: 'free' as const, label: 'без отправок' },
            { id: 'all' as const, label: 'все' },
          ]}
          onPick={setOnly}
        />
        <Field value={q} onChange={setQ} placeholder="гем" width="w-44" />
        <Button active={filters} onClick={() => setFilters(v => !v)}>
          <SlidersHorizontal className="h-3.5 w-3.5" />
          <span>фильтры{used(range) ? " · " + used(range) : ""}</span>
        </Button>
        <span className="mx-1 h-6 w-px bg-white/[0.08]" />
        <Label>бюджет</Label>
        <Field value={budget} onChange={setBudget} placeholder="$" width="w-24" inputMode="decimal" />
        <Button onClick={optimal}>
          <Wand2 className="h-3.5 w-3.5" />
          <span>собрать лучшее</span>
        </Button>
        {cart.units ? <Button onClick={() => setTake({})}>сбросить</Button> : null}
      </div>

      <Reveal open={filters}>
        <Card className="mb-2 p-3.5">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            {RANGES.map(r => (
              <span key={r.key}>
                <Label>{r.title}</Label>
                <span className="mt-1.5 flex items-center gap-1.5">
                  <input
                    value={range[r.key][0]}
                    onChange={e => setRange(x => ({ ...x, [r.key]: [e.target.value, x[r.key][1]] }))}
                    placeholder="от"
                    inputMode="decimal"
                    className="ui-label h-9 w-20 border border-white/[0.08] bg-background/40 px-2 text-right text-foreground"
                  />
                  <span className="text-muted-foreground/40">—</span>
                  <input
                    value={range[r.key][1]}
                    onChange={e => setRange(x => ({ ...x, [r.key]: [x[r.key][0], e.target.value] }))}
                    placeholder="до"
                    inputMode="decimal"
                    className="ui-label h-9 w-20 border border-white/[0.08] bg-background/40 px-2 text-right text-foreground"
                  />
                </span>
              </span>
            ))}
            <Button onClick={() => setRange(EMPTY)}>очистить</Button>
          </div>
        </Card>
      </Reveal>

      <Card className="fade">
        <div className="scroll-thin max-h-[calc(100svh-430px)] overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-[#0f0f0f]">
              <tr className="ui-label border-b border-white/[0.06] text-left text-muted-foreground/75">
                {COLUMNS.map(c => (
                  <th key={c.key} className={"px-3.5 py-2 font-medium " + c.align}>
                    <button
                      type="button"
                      onClick={() => setSort(prev => ({ key: c.key, down: prev.key === c.key ? !prev.down : true }))}
                      className={"inline-flex items-center gap-1 " +
                        (sort.key === c.key ? "text-foreground" : "hover:text-foreground")}
                    >
                      <span>{c.title}</span>
                      {sort.key === c.key
                        ? (sort.down ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)
                        : null}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {offers.map(o => {
                const n = take[o.gem] ?? 0
                const sum = n * o.price
                const gain = n * (o.reaches ? data.sell : 0) - sum
                return (
                  <tr
                    key={o.gem}
                    className={'border-b border-white/[0.06] last:border-0 transition-colors ' +
                      (n ? 'bg-white/[0.04]' : 'hover:bg-white/[0.02]')}
                  >
                    <td className="px-3.5 py-1.5">
                      <span className="flex min-w-0 items-center gap-2">
                        <ItemIcon hash={iconFor(state, o.gem)} size={18} />
                        <span className="truncate">{o.gem}</span>
                        {o.burning ? (
                          <span className="ui-label shrink-0" style={{ color: 'var(--ok)' }}>идёт</span>
                        ) : null}
                        {o.owned ? (
                          <span className="tnum shrink-0 font-mono text-[11px] text-muted-foreground/50">есть {o.owned}</span>
                        ) : null}
                      </span>
                    </td>
                    <td className="tnum px-3.5 py-1.5 text-right font-mono">{money(o.price, cur)}</td>
                    <td
                      className="tnum px-3.5 py-1.5 text-right font-mono"
                      style={{ color: o.reaches ? undefined : 'var(--warn)' }}
                    >{nf(o.pool)}</td>
                    <td className="tnum px-3.5 py-1.5 text-right font-mono text-muted-foreground">{nf(o.volume)}</td>
                    <td className="tnum px-3.5 py-1.5 text-right font-mono">
                      {o.burning
                        ? <span style={{ color: 'var(--ok)' }}>0</span>
                        : <span className="text-muted-foreground">{nf(o.sends)}</span>}
                    </td>
                    <td className="px-3.5 py-1.5">
                      <span className="flex items-center justify-center gap-1">
                        <button type="button" onClick={() => bump(o.gem, -10, o.volume)}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] border border-white/[0.08] text-muted-foreground hover:border-white/20">
                          <Minus className="h-3 w-3" />
                        </button>
                        <input
                          value={n || ''}
                          placeholder="0"
                          inputMode="numeric"
                          onChange={e => {
                            const v = Math.max(0, Math.min(o.volume, Number(e.target.value.replace(/\D/g, '')) || 0))
                            setTake(t => ({ ...t, [o.gem]: v }))
                          }}
                          className="tnum h-6 w-14 border border-white/[0.08] bg-background/40 text-center font-mono text-[12px]"
                        />
                        <button type="button" onClick={() => bump(o.gem, 10, o.volume)}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] border border-white/[0.08] text-muted-foreground hover:border-white/20">
                          <Plus className="h-3 w-3" />
                        </button>
                      </span>
                    </td>
                    <td className="tnum px-3.5 py-1.5 text-right font-mono">{sum ? money(sum, cur) : ''}</td>
                    <td className="tnum px-3.5 py-1.5 text-right font-mono" style={{ color: gain > 0 ? 'var(--ok)' : undefined }}>
                      {gain ? money(gain, cur) : ''}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {offers.length === 0 ? <Empty>ничего не подошло</Empty> : null}
        </div>
      </Card>
      <p className="text-[12px] text-muted-foreground">
        показано {nf(offers.length)} из {nf(data.offers.length)}
      </p>

      {cart.units > 0 ? (
        <Card className="slide-up sticky bottom-0 flex flex-wrap items-center gap-x-8 gap-y-3 p-3.5"
          style={{ background: '#111111e6', backdropFilter: 'blur(16px)' }}>
          <Sum k="позиций" v={nf(cart.lines.length)} />
          <Sum k="самоцветов" v={nf(cart.units)} />
          <Sum k="стоимость" v={money(cart.cost, cur)} />
          <Sum k="отправок" v={nf(cart.sends)} note={cart.minutes ? '≈ ' + nf(cart.minutes) + ' мин' : 'ничего не надо жечь'} />
          <Sum k="выручка" v={money(cart.revenue, cur)} />
          <Sum k="прибыль" v={money(cart.profit, cur)} tone="ok" />
          <span className="ml-auto">
            <Button active onClick={() => setConfirm(true)}>
              <ShoppingCart className="h-3.5 w-3.5" />
              <span>купить {nf(cart.units)}</span>
            </Button>
          </span>
        </Card>
      ) : null}

      <Modal
        open={confirm}
        title="Подтверждение закупки"
        note={nf(cart.lines.length) + ' позиций · ' + nf(cart.units) + ' самоцветов'}
        width="w-[560px]"
        onClose={() => { setConfirm(false); setResult(null) }}
        footer={
          <>
            <Button onClick={() => { setConfirm(false); setResult(null) }}>отмена</Button>
            <Button
              active
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                const r = await post('/api/market/buy', {
                  lines: cart.lines.map(x => ({ name: x.o.name, take: x.n, price: x.o.price })),
                  currency: cur,
                  confirm: true,
                })
                setResult(r?.error ? String(r.error) : JSON.stringify(r))
                setBusy(false)
              }}
            >
              {busy ? 'покупаю…' : 'подтвердить'}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[13px]">
          <div className="scroll-thin max-h-[220px] divide-y divide-white/[0.06] overflow-auto">
            {cart.lines.map(x => (
              <div key={x.o.gem} className="flex items-baseline gap-3 py-1.5">
                <span className="min-w-0 flex-1 truncate">{x.o.gem}</span>
                <span className="tnum font-mono text-muted-foreground">{nf(x.n)} × {money(x.o.price, cur)}</span>
                <span className="tnum w-20 text-right font-mono">{money(x.n * x.o.price, cur)}</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 border-t border-white/[0.06] pt-3 text-[12px]">
            <Row k="спишется" v={money(cart.cost, cur)} />
            <Row k="отправок потом" v={nf(cart.sends) + (cart.minutes ? ' · ' + nf(cart.minutes) + ' мин' : '')} />
            <Row k="выручка" v={money(cart.revenue, cur)} />
            <Row k="прибыль" v={money(cart.profit, cur)} />
          </div>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Покупка идёт на market.dota2.net с вашего баланса. Каждый лот берётся отдельным
            запросом с потолком цены — если цена подскочила, лот просто не купится.
            Валюта покупки сверяется с валютой счёта: у площадки рубль считается сотнями,
            а доллар тысячами, и перепутать их значит переплатить вдесятеро.
          </p>
          {result ? (
            <pre className="scroll-thin max-h-[140px] overflow-auto border border-white/[0.08] p-2 text-[11px] text-muted-foreground">
              {result}
            </pre>
          ) : null}
        </div>
      </Modal>
    </div>
  )
}

const iconFor = (state: State, gem: string) =>
  state.mine.find(m => m.gem === gem)?.icon ??
  state.catalog.find(c => c.short === gem)?.icon ?? ''

function Kpi({ k, v, note, tone }: { k: string; v: string; note?: string; tone?: 'ok' }) {
  return (
    <Card hover className="p-3.5">
      <Label>{k}</Label>
      <div className="tnum mt-1.5 font-mono text-[22px] font-medium tracking-tight"
        style={{ color: tone === 'ok' ? 'var(--ok)' : undefined }}>{v}</div>
      {note ? <div className="mt-1 text-[11px] text-muted-foreground/60">{note}</div> : null}
    </Card>
  )
}

function Sum({ k, v, note, tone }: { k: string; v: string; note?: string; tone?: 'ok' }) {
  return (
    <span>
      <Label>{k}</Label>
      <span className="tnum mt-0.5 block font-mono text-[17px] font-medium"
        style={{ color: tone === 'ok' ? 'var(--ok)' : undefined }}>{v}</span>
      {note ? <span className="block text-[11px] text-muted-foreground/60">{note}</span> : null}
    </span>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <span className="flex items-baseline justify-between gap-3">
      <Label>{k}</Label>
      <span className="tnum font-mono">{v}</span>
    </span>
  )
}
