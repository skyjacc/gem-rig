import { useState } from 'react'
import { ChevronDown, ChevronRight, Gem as GemIcon, LayoutGrid, Rows3, Shirt } from 'lucide-react'
import { nf, type Gem, type State } from '../lib/api.ts'
import { Bar, Card, Empty, Field, ItemIcon, Num, PageHead, Segmented } from '../parts/ui.tsx'

// Мои гемы.
//
// Главное различие, которого не видно в общей куче: чем несётся счётчик.
//
//   голый самоцвет   продаётся как самоцвет, его ещё можно вставить
//                    в любой подходящий предмет — хоть в дорогой
//   на предмете      продаётся как предмет, счётчик от него неотделим
//
// Это разный товар и разные деньги, поэтому строки помечены, а фильтр
// показывает одно или другое.
//
// Второе: продаётся не «гем», а конкретная вещь. Под строкой «BZZ ×29 · 12»
// лежат двадцать девять предметов, и у каждого счётчик свой. Строка
// раскрывается; отдельный вид показывает все вещи разом.

type Only = 'all' | 'gem' | 'item'

export function Gems({ state }: { state: State }) {
  const [q, setQ] = useState('')
  const [only, setOnly] = useState<Only>('all')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [layout, setLayout] = useState<'rows' | 'grid'>('rows')
  const goal = state.autopilot.goal || 2000

  const hit = (m: Gem) =>
    m.gem.toLowerCase().includes(q.toLowerCase()) ||
    (m.heroes ?? '').toLowerCase().includes(q.toLowerCase())

  const keep = (c: 'gem' | 'item') => only === 'all' || only === c

  const rows = state.mine
    .filter(m => m.gem !== '—' && hit(m))
    .map(m => ({ ...m, rows: (m.rows ?? []).filter(r => keep(r.carrier)) }))
    .filter(m => m.rows.length)

  const items = rows.reduce((n, m) => n + m.rows.length, 0)
  const bare = state.mine.reduce((n, m) => n + (m.bare ?? 0), 0)

  const toggle = (g: string) => setOpen(s => {
    const n = new Set(s)
    n.has(g) ? n.delete(g) : n.add(g)
    return n
  })

  const controls = (
    <>
      <Segmented
        value={only}
        items={[
          { id: 'all' as const, label: 'всё' },
          { id: 'gem' as const, label: 'самоцветы ' + nf(bare), icon: <GemIcon className="h-3.5 w-3.5" /> },
          { id: 'item' as const, label: 'на предметах', icon: <Shirt className="h-3.5 w-3.5" /> },
        ]}
        onPick={setOnly}
      />
      <Segmented
        value={layout}
        items={[
          { id: 'rows' as const, label: 'по гемам', icon: <Rows3 className="h-3.5 w-3.5" /> },
          { id: 'grid' as const, label: 'все вещи', icon: <LayoutGrid className="h-3.5 w-3.5" /> },
        ]}
        onPick={setLayout}
      />
      <Field value={q} onChange={setQ} placeholder="поиск" width="w-48" />
    </>
  )

  if (layout === 'grid') {
    const all = rows.flatMap(m => m.rows.map(r => ({ ...r, gem: m.gem })))
    return (
      <div className="view-in">
        <PageHead title="Мои гемы" sub={`${nf(all.length)} вещей — продаётся вещь, а не гем`} right={controls} />
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">
          {all.map((r, i) => (
            <Card key={r.assetid} hover className="rise flex flex-col gap-2 p-3.5" style={{ animationDelay: Math.min(i, 30) * 12 + 'ms' }}>
              <div className="flex items-center gap-2">
                <ItemIcon hash={r.icon} size={22} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{r.gem}</span>
                  <span className="block truncate text-[11px] text-muted-foreground/60">
                    {r.carrier === 'gem' ? 'самоцвет' : r.name}
                  </span>
                </span>
              </div>
              <Num
                value={r.value}
                className="font-mono text-xl font-medium tracking-tight"
                style={{ color: r.value >= goal ? 'var(--ok)' : undefined }}
              />
              <Bar pct={(r.value / goal) * 100} tone={r.value >= goal ? 'ok' : 'run'} />
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground/70">
                <Carrier c={r.carrier} />
                {r.equipped ? <span>надет</span> : null}
              </div>
            </Card>
          ))}
        </div>
        {all.length === 0 ? <Card><Empty>ничего не нашлось</Empty></Card> : null}
      </div>
    )
  }

  return (
    <div className="view-in">
      <PageHead title="Мои гемы" sub={`${nf(rows.length)} видов · ${nf(items)} вещей · голый самоцвет и предмет со вставленным — разный товар`} right={controls} />
      <Card>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="ui-label border-b border-white/[0.06] text-left text-muted-foreground/75">
              <th className="px-4 py-2 font-medium">гем</th>
              <th className="px-4 py-2 font-medium">носитель</th>
              <th className="px-4 py-2 font-medium">надето</th>
              <th className="px-4 py-2 font-medium">счётчик</th>
              <th className="px-4 py-2 font-medium">разброс</th>
              <th className="px-4 py-2 font-medium">потолок</th>
              <th className="px-4 py-2 font-medium">осталось</th>
              <th className="w-[170px] px-4 py-2 font-medium">до {nf(goal)}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(m => (
              <GemRows key={m.gem} gem={m} goal={goal} open={open.has(m.gem)} onToggle={() => toggle(m.gem)} />
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <Empty>ничего не нашлось</Empty> : null}
      </Card>
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        Голый самоцвет продаётся как самоцвет и его ещё можно вставить в любой подходящий
        предмет. У предмета со вставленным счётчик неотделим — продаётся предмет.
        Счётчик растёт одинаково у обоих: проверено 20 августа, голый Alliance поднялся
        с 2 до 3 вместе с надетыми.
      </p>
    </div>
  )
}

function Carrier({ c }: { c: 'gem' | 'item' }) {
  const gem = c === 'gem'
  return (
    <span
      className="inline-flex items-center gap-1.5 border px-1.5 py-0.5 text-[11px]"
      style={gem
        ? { borderColor: 'rgb(255 255 255 / 0.22)', color: 'var(--foreground)' }
        : { borderColor: 'rgb(255 255 255 / 0.08)' }}
    >
      {gem ? <GemIcon className="h-3 w-3" /> : <Shirt className="h-3 w-3" />}
      <span>{gem ? 'самоцвет' : 'на предмете'}</span>
    </span>
  )
}

function GemRows({ gem, goal, open, onToggle }: { gem: Gem; goal: number; open: boolean; onToggle: () => void }) {
  const items = gem.rows ?? []
  const bare = items.filter(r => r.carrier === 'gem').length
  const socketed = items.length - bare
  const max = items.length ? Math.max(...items.map(r => r.value)) : gem.max
  const min = items.length ? Math.min(...items.map(r => r.value)) : (gem.min ?? 0)
  // Всё, что в строке, считается по показанным вещам: при фильтре «самоцветы»
  // герой и «надето» от предметов уже не относятся к делу.
  const equipped = items.filter(r => r.equipped).length
  const heroes = [...new Set(items.map(r => r.hero).filter(Boolean))].join(', ')
  const done = max >= goal
  const capped = gem.supply != null && gem.supply < goal

  return (
    <>
      <tr
        className="cursor-pointer border-b border-white/[0.06] transition-colors last:border-0 hover:bg-white/[0.03]"
        onClick={onToggle}
      >
        <td className="px-4 py-2.5">
          <span className="flex min-w-0 items-center gap-2">
            {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            <ItemIcon hash={gem.icon} size={22} />
            <span className="min-w-0">
              <span className="block truncate font-medium">{gem.gem}</span>
              <span className="block truncate text-[11px] text-muted-foreground/60">
                {heroes || (bare ? 'ни во что не вставлен' : '—')}
              </span>
            </span>
          </span>
        </td>
        <td className="px-4 py-2.5">
          <span className="flex flex-wrap items-center gap-1.5">
            {bare ? <Carrier c="gem" /> : null}
            {bare && socketed ? <span className="tnum font-mono text-[11px] text-muted-foreground/60">{bare}</span> : null}
            {socketed ? <Carrier c="item" /> : null}
            {socketed ? <span className="tnum font-mono text-[11px] text-muted-foreground/60">{socketed}</span> : null}
          </span>
        </td>
        <td className="tnum px-4 py-2.5 font-mono text-muted-foreground">{equipped || '—'}</td>
        <td className="px-4 py-2.5">
          <Num value={max} className="font-mono" style={{ color: done ? 'var(--ok)' : undefined }} />
        </td>
        <td className="tnum px-4 py-2.5 font-mono text-muted-foreground">
          {min === max ? 'все одинаковые' : `${nf(min)}…${nf(max)}`}
        </td>
        <td className="tnum px-4 py-2.5 font-mono" style={{ color: capped ? 'var(--warn)' : undefined }}>
          {gem.supply != null ? nf(gem.supply) : '—'}
          {gem.supplyKind === 'estimated' ? <span className="text-muted-foreground/60"> оц.</span> : null}
        </td>
        <td className="tnum px-4 py-2.5 font-mono text-muted-foreground">{gem.left != null ? nf(gem.left) : '—'}</td>
        <td className="px-4 py-2.5"><Bar pct={(max / goal) * 100} tone={done ? 'ok' : capped ? 'warn' : 'run'} /></td>
      </tr>

      {open ? items.map((r, i) => (
        <tr
          key={r.assetid}
          className="rise border-b border-white/[0.06] bg-white/[0.01] last:border-0"
          style={{ animationDelay: Math.min(i, 24) * 10 + 'ms' }}
        >
          <td className="py-1.5 pl-14 pr-4">
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-[3px] w-[3px] shrink-0 bg-white/25" />
              <span className="min-w-0">
                <span className="block truncate text-[12px]">
                  {r.carrier === 'gem' ? <span className="text-muted-foreground">самоцвет, никуда не вставлен</span> : r.name}
                </span>
                <span className="tnum block truncate font-mono text-[10px] text-muted-foreground/45">{r.assetid}</span>
              </span>
            </span>
          </td>
          <td className="px-4 py-1.5"><Carrier c={r.carrier} /></td>
          <td className="px-4 py-1.5 text-[12px] text-muted-foreground">{r.equipped ? 'надет' : '—'}</td>
          <td className="px-4 py-1.5">
            <Num value={r.value} className="font-mono text-[13px]" style={{ color: r.value >= goal ? 'var(--ok)' : undefined }} />
          </td>
          <td className="px-4 py-1.5 text-[12px] text-muted-foreground/60">
            {r.value === max ? '' : '−' + nf(max - r.value)}
          </td>
          <td className="px-4 py-1.5" />
          <td className="px-4 py-1.5" />
          <td className="px-4 py-1.5"><Bar pct={(r.value / goal) * 100} tone={r.value >= goal ? 'ok' : 'faint'} /></td>
        </tr>
      )) : null}
    </>
  )
}
