import { useState } from 'react'
import { ChevronDown, ChevronRight, LayoutGrid, Rows3 } from 'lucide-react'
import { nf, type Gem, type State } from '../lib/api.ts'
import { Bar, Card, Empty, Field, Head, ItemIcon, Num, Segmented } from '../parts/ui.tsx'

// Мои гемы.
//
// Продаётся не «гем», а конкретная вещь со своим счётчиком. Группа
// удобна для обзора и врёт в деталях: под строкой «BZZ ×29 · 12» лежат
// двадцать девять предметов со счётчиками от нуля до двенадцати, и
// стоят они по-разному.
//
// Поэтому два уровня: свёрнуто — по гемам, раскрыто — каждая вещь.

export function Gems({ state }: { state: State }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [layout, setLayout] = useState<'rows' | 'grid'>('rows')
  const goal = state.autopilot.goal || 2000

  const rows = state.mine.filter(m => m.gem !== '—' && (
    m.gem.toLowerCase().includes(q.toLowerCase()) ||
    (m.heroes ?? '').toLowerCase().includes(q.toLowerCase())
  ))
  const items = rows.reduce((n, m) => n + m.items, 0)
  const toggle = (g: string) => setOpen(s => {
    const n = new Set(s)
    n.has(g) ? n.delete(g) : n.add(g)
    return n
  })

  if (layout === 'grid') {
    const all = rows.flatMap(m => (m.rows ?? []).map(r => ({ ...r, gem: m.gem })))
    return (
      <div className="view-in">
        <Head
          title="Мои гемы"
          note={`${nf(all.length)} вещей`}
          right={
            <>
              <Segmented
                value={layout}
                items={[
                  { id: 'rows' as const, label: 'по гемам', icon: <Rows3 className="h-3.5 w-3.5" /> },
                  { id: 'grid' as const, label: 'все вещи', icon: <LayoutGrid className="h-3.5 w-3.5" /> },
                ]}
                onPick={setLayout}
              />
              <Field value={q} onChange={setQ} placeholder="поиск" width="w-56" />
            </>
          }
        />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-6">
          {all.map((r, i) => (
            <Card key={r.assetid} hover className="rise flex flex-col gap-2 p-3" style={{ animationDelay: Math.min(i, 30) * 12 + 'ms' }}>
              <div className="flex items-center gap-2">
                <ItemIcon hash={r.icon} size={26} />
                <span className="min-w-0 flex-1 truncate text-[13px]">{r.gem}</span>
              </div>
              <Num
                value={r.value}
                className="font-mono text-xl font-medium tracking-tight"
                style={{ color: r.value >= goal ? 'var(--ok)' : undefined }}
              />
              <Bar pct={(r.value / goal) * 100} tone={r.value >= goal ? 'ok' : 'run'} />
              <div className="flex items-center justify-between text-[11px] text-muted-foreground/70">
                <span className="truncate">{r.hero || '—'}</span>
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
      <Head
        title="Мои гемы"
        note={`${nf(rows.length)} видов · ${nf(items)} вещей`}
        right={
          <>
            <Segmented
              value={layout}
              items={[
                { id: 'rows' as const, label: 'по гемам', icon: <Rows3 className="h-3.5 w-3.5" /> },
                { id: 'grid' as const, label: 'все вещи', icon: <LayoutGrid className="h-3.5 w-3.5" /> },
              ]}
              onPick={setLayout}
            />
            <Field value={q} onChange={setQ} placeholder="поиск" width="w-56" />
          </>
        }
      />
      <Card>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="ui-label border-b border-white/[0.06] text-left text-muted-foreground/75">
              <th className="px-4 py-2 font-medium">гем</th>
              <th className="px-4 py-2 font-medium">вещей</th>
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
    </div>
  )
}

function GemRows({ gem, goal, open, onToggle }: { gem: Gem; goal: number; open: boolean; onToggle: () => void }) {
  const done = gem.max >= goal
  const capped = gem.supply != null && gem.supply < goal
  const spread = gem.min !== gem.max
  const items = gem.rows ?? []

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
            <ItemIcon hash={gem.icon} size={24} />
            <span className="min-w-0">
              <span className="block truncate font-medium">{gem.gem}</span>
              {gem.heroes ? <span className="block truncate text-[11px] text-muted-foreground/60">{gem.heroes}</span> : null}
            </span>
          </span>
        </td>
        <td className="tnum px-4 py-2.5 font-mono">{gem.items}</td>
        <td className="tnum px-4 py-2.5 font-mono text-muted-foreground">{gem.equipped || '—'}</td>
        <td className="px-4 py-2.5">
          <Num value={gem.max} className="font-mono" style={{ color: done ? 'var(--ok)' : undefined }} />
        </td>
        <td className="tnum px-4 py-2.5 font-mono text-muted-foreground">
          {spread ? `${nf(gem.min ?? 0)}…${nf(gem.max)}` : 'все одинаковые'}
        </td>
        <td className="tnum px-4 py-2.5 font-mono" style={{ color: capped ? 'var(--warn)' : undefined }}>
          {gem.supply != null ? nf(gem.supply) : '—'}
          {gem.supplyKind === 'estimated' ? <span className="text-muted-foreground/60"> оц.</span> : null}
        </td>
        <td className="tnum px-4 py-2.5 font-mono text-muted-foreground">{gem.left != null ? nf(gem.left) : '—'}</td>
        <td className="px-4 py-2.5"><Bar pct={(gem.max / goal) * 100} tone={done ? 'ok' : capped ? 'warn' : 'run'} /></td>
      </tr>

      {open ? items.map((r, i) => (
        <tr key={r.assetid} className="rise border-b border-white/[0.06] bg-white/[0.01] last:border-0" style={{ animationDelay: Math.min(i, 24) * 10 + 'ms' }}>
          <td className="py-1.5 pl-14 pr-4">
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-[3px] w-[3px] shrink-0 bg-white/25" />
              <span className="tnum truncate font-mono text-[11px] text-muted-foreground/60">{r.assetid}</span>
            </span>
          </td>
          <td className="px-4 py-1.5 text-[12px] text-muted-foreground">{r.hero || '—'}</td>
          <td className="px-4 py-1.5 text-[12px] text-muted-foreground">{r.equipped ? 'надет' : '—'}</td>
          <td className="px-4 py-1.5">
            <Num value={r.value} className="font-mono text-[13px]" style={{ color: r.value >= goal ? 'var(--ok)' : undefined }} />
          </td>
          <td className="px-4 py-1.5 text-[12px] text-muted-foreground/60">
            {r.value === gem.max ? '' : '−' + nf(gem.max - r.value)}
          </td>
          <td className="px-4 py-1.5" />
          <td className="px-4 py-1.5" />
          <td className="px-4 py-1.5"><Bar pct={(r.value / goal) * 100} tone={r.value >= goal ? 'ok' : 'faint'} /></td>
        </tr>
      )) : null}
    </>
  )
}
