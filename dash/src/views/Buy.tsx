import { useMemo, useState } from 'react'
import { Minus, Plus, RefreshCw, ShoppingCart, Wand2 } from 'lucide-react'
import { nf, post, useJson, type State } from '../lib/api.ts'
import { Button, Card, Dot, Empty, Field, ItemIcon, Label, PageHead, Segmented } from '../parts/ui.tsx'
import { Modal } from '../parts/Modal.tsx'

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

type Scan = {
  goal: number
  sell: number
  perGem: number
  updated: number
  error: string | null
  scanned: number
  offers: Offer[]
}

const SPEED = 76   // отправок в минуту, замер 20 августа

export function Buy({ state }: { state: State }) {
  const { data } = useJson<Scan>('/api/market', state.ts)
  const [take, setTake] = useState<Record<string, number>>({})
  const [only, setOnly] = useState<'fit' | 'free' | 'all'>('fit')
  const [q, setQ] = useState('')
  const [budget, setBudget] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const offers = useMemo(() => {
    if (!data) return []
    return data.offers
      .filter(o => (only === 'all' ? true : only === 'free' ? o.burning : o.reaches))
      .filter(o => !q || o.gem.toLowerCase().includes(q.toLowerCase()))
  }, [data, only, q])

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
            <Button onClick={() => fetch('/api/market?force=1')}>
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
        <Kpi k="цена лота" v={'$' + (kpi[0]?.price ?? 0).toFixed(3)} note="минимальная" />
        <Kpi k="продажа" v={'$' + data.sell} note="за готовую вещь" />
        <Kpi
          k="потенциал"
          v={'$' + nf(kpi.reduce((n, o) => n + o.volume, 0) * data.sell)}
          note="если взять все лоты"
          tone="ok"
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
        <span className="mx-1 h-6 w-px bg-white/[0.08]" />
        <Label>бюджет</Label>
        <Field value={budget} onChange={setBudget} placeholder="$" width="w-24" inputMode="decimal" />
        <Button onClick={optimal}>
          <Wand2 className="h-3.5 w-3.5" />
          <span>собрать лучшее</span>
        </Button>
        {cart.units ? <Button onClick={() => setTake({})}>сбросить</Button> : null}
      </div>

      <Card>
        <div className="scroll-thin max-h-[calc(100svh-430px)] overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-[#0f0f0f]">
              <tr className="ui-label border-b border-white/[0.06] text-left text-muted-foreground/75">
                <th className="px-3.5 py-2 font-medium">гем</th>
                <th className="px-3.5 py-2 text-right font-medium">цена</th>
                <th className="px-3.5 py-2 text-right font-medium">потолок</th>
                <th className="px-3.5 py-2 text-right font-medium">в продаже</th>
                <th className="px-3.5 py-2 text-right font-medium">отправок</th>
                <th className="px-3.5 py-2 text-center font-medium">взять</th>
                <th className="px-3.5 py-2 text-right font-medium">стоимость</th>
                <th className="px-3.5 py-2 text-right font-medium">прибыль</th>
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
                    <td className="tnum px-3.5 py-1.5 text-right font-mono">${o.price.toFixed(3)}</td>
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
                    <td className="tnum px-3.5 py-1.5 text-right font-mono">{sum ? '$' + sum.toFixed(2) : ''}</td>
                    <td className="tnum px-3.5 py-1.5 text-right font-mono" style={{ color: gain > 0 ? 'var(--ok)' : undefined }}>
                      {gain ? '$' + nf(gain) : ''}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {offers.length === 0 ? <Empty>ничего не подошло</Empty> : null}
        </div>
      </Card>

      {cart.units > 0 ? (
        <Card className="rise sticky bottom-0 flex flex-wrap items-center gap-x-8 gap-y-3 p-3.5"
          style={{ background: '#111111e6', backdropFilter: 'blur(16px)' }}>
          <Sum k="позиций" v={nf(cart.lines.length)} />
          <Sum k="самоцветов" v={nf(cart.units)} />
          <Sum k="стоимость" v={'$' + cart.cost.toFixed(2)} />
          <Sum k="отправок" v={nf(cart.sends)} note={cart.minutes ? '≈ ' + nf(cart.minutes) + ' мин' : 'ничего не надо жечь'} />
          <Sum k="выручка" v={'$' + nf(cart.revenue)} />
          <Sum k="прибыль" v={'$' + nf(cart.profit)} tone="ok" />
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
                <span className="tnum font-mono text-muted-foreground">{nf(x.n)} × ${x.o.price.toFixed(3)}</span>
                <span className="tnum w-16 text-right font-mono">${(x.n * x.o.price).toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 border-t border-white/[0.06] pt-3 text-[12px]">
            <Row k="спишется" v={'$' + cart.cost.toFixed(2)} />
            <Row k="отправок потом" v={nf(cart.sends) + (cart.minutes ? ' · ' + nf(cart.minutes) + ' мин' : '')} />
            <Row k="выручка при $" v={nf(cart.revenue)} />
            <Row k="прибыль" v={'$' + nf(cart.profit)} />
          </div>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Покупка идёт на market.dota2.net с вашего баланса. Каждый лот берётся отдельным
            запросом с потолком цены — если цена подскочила, лот просто не купится.
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
