import { useMemo, useState } from 'react'
import {
  createColumnHelper, flexRender, getCoreRowModel, getFilteredRowModel,
  getSortedRowModel, useReactTable, type SortingState,
} from '@tanstack/react-table'
import type { Bundle, CatalogRow, Gem, State } from '../lib/types.ts'
import { gemIcon, heroIcon, nf } from '../lib/format.ts'
import { Block, Btn, Buy, Pill } from './ui.tsx'
import { post } from '../lib/live.ts'

function Icon({ src }: { src: string }) {
  if (!src) return <span className="inline-block h-[30px] w-[30px]" />
  return <img src={src} alt="" loading="lazy" className="h-[30px] w-[30px] border border-rule bg-ink object-contain" />
}

function BuildBtn({ kind, id, name }: { kind: string | null; id: number | null; name: string }) {
  const [label, setLabel] = useState('Список')
  const [busy, setBusy] = useState(false)
  if (!kind || !id || kind === 'unknown') return null
  return (
    <Btn
      disabled={busy}
      onClick={async () => {
        setBusy(true); setLabel('собираю')
        const j = await post('/api/build', { kind, id, name, count: 0 })
        setLabel(j.error ? 'ошибка' : `${j.fresh} → ${j.file}`)
        setTimeout(() => { setBusy(false); setLabel('Список') }, 8000)
      }}
    >{label}</Btn>
  )
}

function Table({ table }: { table: any }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse tnum">
        <thead>
          {table.getHeaderGroups().map((hg: any) => (
            <tr key={hg.id}>
              {hg.headers.map((h: any) => (
                <th
                  key={h.id}
                  onClick={h.column.getToggleSortingHandler()}
                  className={`border-b border-rule px-3 py-2 text-left text-[10px] font-medium uppercase tracking-[0.14em] text-dust ${
                    h.column.getCanSort() ? 'cursor-pointer select-none hover:text-chalk' : ''
                  } ${h.column.columnDef.meta?.right ? 'text-right' : ''}`}
                >
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  {{ asc: ' ↑', desc: ' ↓' }[h.column.getIsSorted() as string] ?? ''}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row: any) => (
            <tr key={row.id} className="hover:bg-raise">
              {row.getVisibleCells().map((cell: any) => (
                <td key={cell.id} className={`border-b border-rule/50 px-3 py-1.5 ${cell.column.columnDef.meta?.right ? 'text-right' : ''}`}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
          {table.getRowModel().rows.length === 0 && (
            <tr><td className="px-3.5 py-4 text-dust" colSpan={20}>ничего не найдено</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

// ───────────────────────────── мои гемы ─────────────────────────────
const g = createColumnHelper<Gem>()

export function MineTable({ state }: { state: State }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'items', desc: true }])
  const cols = useMemo(() => [
    g.accessor('icon', { header: '', cell: c => <Icon src={gemIcon(c.getValue())} />, enableSorting: false }),
    g.accessor('gem', { header: 'Гем' }),
    g.accessor('kind', { header: 'Тип', cell: c => <Pill kind={c.getValue()} /> }),
    g.accessor('items', { header: 'Предметов', meta: { right: true } }),
    g.accessor('equipped', {
      header: 'Надето', meta: { right: true },
      cell: c => <span className={c.getValue() ? 'text-malachite' : 'text-dust'}>{c.getValue()}</span>,
    }),
    g.accessor('max', {
      header: 'Счётчик', meta: { right: true },
      cell: c => {
        const r = c.row.original
        return <span className={r.max ? 'text-malachite' : 'text-dust'}>{r.min === r.max ? r.max : `${r.min}–${r.max}`}</span>
      },
    }),
    g.accessor('supply', { header: 'Запас', meta: { right: true }, cell: c => <span className="text-dust">{nf(c.getValue())}</span> }),
    g.accessor('heroes', { header: 'Герои', cell: c => <span className="text-dust">{c.getValue()}</span> }),
    g.display({
      id: 'act', header: '', meta: { right: true },
      cell: c => <BuildBtn kind={c.row.original.kind} id={c.row.original.entityId} name={c.row.original.gem} />,
    }),
  ], [])

  const table = useReactTable({
    data: state.mine, columns: cols as any, state: { sorting }, onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(),
  })

  return (
    <div className="py-5">
      <Block title="Гемы в инвентаре" note={`${state.mine.length} групп`}>
        <Table table={table} />
      </Block>
    </div>
  )
}

// ───────────────────────────── каталог ─────────────────────────────
const c = createColumnHelper<CatalogRow>()

export function CatalogTable({ state }: { state: State }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'supply', desc: true }])
  const [filter, setFilter] = useState('')

  const cols = useMemo(() => [
    c.accessor('icon', { header: '', cell: x => <Icon src={gemIcon(x.getValue())} />, enableSorting: false }),
    c.accessor('short', { header: 'Гем' }),
    c.accessor('kind', { header: 'Тип', cell: x => <Pill kind={x.getValue()} /> }),
    c.accessor('entityName', { header: 'Сущность', cell: x => <span className="text-dust">{(x.getValue() ?? '').slice(0, 40)}</span> }),
    c.accessor('supply', { header: 'Матчей', meta: { right: true }, cell: x => nf(x.getValue()) }),
    c.accessor('price', { header: 'Цена', meta: { right: true } }),
    c.accessor('per1000', {
      header: '$/1000', meta: { right: true },
      cell: x => {
        const v = x.getValue()
        return <span className={v != null && v < 0.02 ? 'text-malachite' : 'text-dust'}>{v == null ? '—' : '$' + v.toFixed(3)}</span>
      },
    }),
    c.accessor('listings', { header: 'Лотов', meta: { right: true }, cell: x => <span className="text-dust">{x.getValue()}</span> }),
    c.accessor('ownedItems', {
      header: 'У меня', meta: { right: true },
      cell: x => <span className={x.getValue() ? 'text-malachite' : 'text-dust'}>{x.getValue() || '—'}</span>,
    }),
    c.display({ id: 'buy', header: '', meta: { right: true }, cell: x => <Buy href={x.row.original.market}>Купить</Buy> }),
    c.display({
      id: 'act', header: '', meta: { right: true },
      cell: x => <BuildBtn kind={x.row.original.kind} id={x.row.original.entityId} name={x.row.original.short} />,
    }),
  ], [])

  const table = useReactTable({
    data: state.catalog, columns: cols as any,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting, onGlobalFilterChange: setFilter,
    globalFilterFn: (row, _id, value) => {
      const r = row.original as CatalogRow
      return `${r.short} ${r.entityName ?? ''} ${r.kind ?? ''}`.toLowerCase().includes(String(value).toLowerCase())
    },
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getFilteredRowModel: getFilteredRowModel(),
  })

  return (
    <div className="py-5">
      <Block title="Все гемы на рынке" note={`${table.getRowModel().rows.length} из ${state.catalog.length}`}>
        <div className="p-3.5">
          <input
            type="search" value={filter} onChange={e => setFilter(e.target.value)}
            placeholder="имя, команда, тип"
            className="w-full max-w-[340px] border border-rule bg-ink px-3 py-2 text-chalk placeholder:text-dust focus:border-malachite focus:outline-none"
          />
        </div>
        <Table table={table} />
        <div className="border-t border-rule px-3.5 py-2.5 text-[11px] text-dust">
          «Матчей» — сколько игр есть у сущности гема. Столбец $/1000 показывает цену тысячи накрученных игр.
        </div>
      </Block>
    </div>
  )
}

// ───────────────────────────── наборы ─────────────────────────────
const b = createColumnHelper<Bundle>()

export function BundleTable({ state }: { state: State }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'partner', desc: false }])
  const cols = useMemo(() => [
    b.accessor('hero', {
      header: '', enableSorting: false,
      cell: x => x.getValue() ? <img src={heroIcon(x.getValue())} alt="" loading="lazy" className="h-5 w-5 border border-rule bg-ink" /> : null,
    }),
    b.accessor('name', { header: 'Набор' }),
    b.accessor('partner', { header: 'Гем', cell: x => <span className="text-dust">{x.getValue()}</span> }),
    b.accessor('pieces', { header: 'Частей', meta: { right: true }, cell: x => x.getValue() || '—' }),
    b.accessor('price_cents', {
      header: 'Цена', meta: { right: true },
      cell: x => (x.getValue() == null ? '—' : '$' + (x.getValue()! / 100).toFixed(2)),
    }),
    b.accessor('created', { header: 'Создан', cell: x => <span className="text-dust">{x.getValue()}</span> }),
    b.display({
      id: 'store', header: '', meta: { right: true },
      cell: x => <Buy href={`https://www.dota2.com/store/itemdetails/${x.row.original.def}`}>Магазин</Buy>,
    }),
    b.display({
      id: 'market', header: '', meta: { right: true },
      cell: x => <Buy href={`https://steamcommunity.com/market/listings/570/${encodeURIComponent(x.row.original.name)}`}>Рынок</Buy>,
    }),
  ], [])

  const table = useReactTable({
    data: state.bundles, columns: cols as any, state: { sorting }, onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(),
  })

  return (
    <div className="py-5">
      <Block title="Наборы, которые продаются уже с гемом" note="сокет занят, чисел не нужен">
        <Table table={table} />
      </Block>
    </div>
  )
}
