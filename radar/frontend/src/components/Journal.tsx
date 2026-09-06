import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDownIcon, ChevronRightIcon, DownloadIcon, SearchIcon, XIcon } from './animated'
import { api, type JournalEvent } from '../api'
import { Badge, Panel } from './ui'
import { journalFields, kindMeta, levelTone, reasonMeta } from './meta'

function time(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function Row({ e }: { e: JournalEvent }) {
  const [open, setOpen] = useState(false)
  const meta = kindMeta[e.kind] ?? { label: e.kind, tone: 'default' as const }
  const fields = journalFields(e.fields)

  return (
    <>
      <tr
        onClick={() => fields.length > 0 && setOpen((v) => !v)}
        className={`border-b border-line-soft/50 last:border-0 ${
          fields.length > 0 ? 'cursor-pointer hover:bg-panel-2/50' : ''
        }`}
      >
        <td className="py-1.5 pr-3 pl-4 font-mono text-[11px] whitespace-nowrap text-faint">
          {fields.length > 0 ? (
            open ? (
              <ChevronDownIcon size={12} className="mr-1 inline-block" />
            ) : (
              <ChevronRightIcon size={12} className="mr-1 inline-block" />
            )
          ) : (
            <span className="mr-1 inline-block w-[11px]" />
          )}
          {time(e.at)}
        </td>
        <td className="py-1.5 pr-3">
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </td>
        <td className="max-w-[220px] truncate py-1.5 pr-3 text-xs">{e.subject || '—'}</td>
        <td className={`py-1.5 pr-4 text-xs ${levelTone[e.level] ?? 'text-mute'}`}>
          {e.message}
          {e.reason && reasonMeta[e.reason] && (
            <span className="ml-2 text-faint">· {reasonMeta[e.reason]}</span>
          )}
        </td>
      </tr>
      {open && fields.length > 0 && (
        <tr className="border-b border-line-soft/50 bg-panel-2/30">
          <td colSpan={4} className="px-4 py-2">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[11px] sm:grid-cols-3">
              {fields.map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <dt className="text-faint">{k}</dt>
                  <dd className="truncate text-text">{v}</dd>
                </div>
              ))}
            </dl>
          </td>
        </tr>
      )}
    </>
  )
}

export function Journal({
  events,
  total,
  run,
  onClearRun,
  extraAction,
}: {
  events: JournalEvent[]
  total: number
  /** When set, only this sweep's events are shown. */
  run?: string
  onClearRun?: () => void
  /** Rendered beside the export button; used for the diagnostic bundle. */
  extraAction?: ReactNode
}) {
  const [kind, setKind] = useState('all')
  const [query, setQuery] = useState('')
  const [showDebug, setShowDebug] = useState(false)

  const groups = useMemo(() => {
    const set = new Set(events.map((e) => e.kind.split('.')[0]))
    return Array.from(set).sort()
  }, [events])

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return events.filter((e) => {
      if (run && e.run !== run) return false
      if (!showDebug && e.level === 'debug') return false
      if (kind !== 'all' && !e.kind.startsWith(kind)) return false
      if (needle && !`${e.subject} ${e.message} ${e.kind}`.toLowerCase().includes(needle)) {
        return false
      }
      return true
    })
  }, [events, kind, query, showDebug, run])

  // A run filter that shows nothing is ambiguous on its own: the sweep may be
  // older than the buffer rather than uneventful. Say which.
  const runEmpty = Boolean(run) && rows.length === 0

  return (
    <Panel
      title={`Журнал — ${rows.length}`}
      subtitle={
        run
          ? `только проход ${run} · всего записей в памяти ${total}`
          : `что произошло, с чем и почему · всего записей ${total}`
      }
      bodyClass="p-0"
      action={
        <div className="flex flex-wrap items-center gap-2">
          {extraAction}
          {run && onClearRun && (
            <button
              onClick={onClearRun}
              className="inline-flex items-center gap-1.5 rounded-lg border border-info/40 bg-info/10 px-2.5 py-1.5 text-sm text-info transition-colors hover:bg-info/20"
              title="Снять фильтр по проходу и показать весь журнал"
            >
              проход {run} <XIcon size={13} />
            </button>
          )}
          <a
            href={api.journalExportURL(kind === 'all' ? '' : kind)}
            download
            className="group inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-mute transition-colors hover:border-faint hover:text-text"
            title="Выгрузить весь журнал одним файлом NDJSON — по событию на строку"
          >
            <DownloadIcon size={15} /> Выгрузить
          </a>
          <label className="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 focus-within:border-accent/50">
            <SearchIcon size={15} className="text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="предмет, источник, текст"
              className="w-48 bg-transparent text-sm outline-none placeholder:text-faint"
            />
          </label>
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-line bg-panel-2 p-0.5">
          {['all', ...groups].map((g) => (
            <button
              key={g}
              onClick={() => setKind(g)}
              className={`rounded px-2 py-1 text-xs transition-colors ${
                kind === g ? 'bg-panel-3 text-text' : 'text-mute hover:text-text'
              }`}
            >
              {g === 'all' ? 'всё' : g}
            </button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-mute select-none">
          <input
            type="checkbox"
            checked={showDebug}
            onChange={(e) => setShowDebug(e.target.checked)}
            className="accent-accent"
          />
          подробные записи
        </label>
        <span className="ml-auto text-[11px] text-faint">
          клик по строке — все поля события · журнал также пишется на диск в
          <span className="ml-1 font-mono">radar-data/journal/</span>
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-mute">
          {runEmpty
            ? `За проходом ${run} записей в памяти нет. Буфер держит последние ${total} событий — проход мог из него вытесниться. Он целиком есть в дневном файле журнала: выгрузи NDJSON и отфильтруй по полю run.`
            : events.length === 0
              ? 'Пока пусто. Записи появятся с первым обходом каталога.'
              : 'Под эти фильтры ничего не подходит. Сбрось поиск, вид события или включи отладочные.'}
        </p>
      ) : (
        <div className="max-h-[560px] overflow-y-auto">
          <table className="w-full text-sm">
            <tbody>
              {rows.map((e) => (
                <Row key={e.id} e={e} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
