import { useEffect, useState } from 'react'
import { CircleAlert, CircleSlash } from 'lucide-react'
import { CircleCheckIcon, ChevronDownIcon, ChevronRightIcon, ClockIcon, RefreshCWIcon } from './animated'
import { api, ago, type Run } from '../api'
import { Badge, Button, Panel } from './ui'

/**
 * Sweep history. The panel used to say "обход завершён" and stop there, which
 * answered none of the questions actually asked of it: which scan was that,
 * did it finish, what did it look at, and where did forty thousand catalogue
 * rows go if only two dozen offers came out.
 *
 * Every row here is one run. Every count opens as journal events filtered to
 * that run, so no number is a claim the operator has to take on faith.
 */

const triggerLabel: Record<string, string> = {
  schedule: 'по расписанию',
  manual: 'вручную',
  new_lot: 'появился новый лот',
  startup: 'при запуске',
}

const outcomeMeta: Record<Run['outcome'], { label: string; tone: 'good' | 'warn' | 'bad' }> = {
  ok: { label: 'завершён', tone: 'good' },
  error: { label: 'с ошибкой', tone: 'bad' },
  cancelled: { label: 'прерван', tone: 'warn' },
}

/** Why candidates did not become offers, in the operator's words. */
const excludedLabel: Record<string, string> = {
  above_price_cap: 'дороже потолка сканирования',
  loose_gem: 'это сам гем, а не носитель',
  no_instance_id: 'нет варианта или цены — строку нельзя проверить',
  no_kinetic_socket: 'Steam не показал кинетического сокета',
  gem_unpriced: 'цену гема не знает ни один рынок',
  below_min_spread: 'гем не перекрывает цену лота',
  delisted: 'лот ушёл с площадки',
  no_order_book: 'нет стакана — выход не оценить',
  steam_unknown: 'Steam не описывает этот вариант — перестали спрашивать',
}

const clock = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} с` : `${ms} мс`)

function Cell({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div title={hint}>
      <div className="text-[10px] tracking-[0.1em] text-faint uppercase">{label}</div>
      <div className="font-mono text-sm">{typeof value === 'number' ? value.toLocaleString('ru-RU') : value}</div>
    </div>
  )
}

function RunRow({ run, live, onJournal }: { run: Run; live?: boolean; onJournal: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const meta = live ? { label: 'идёт', tone: 'info' as const } : outcomeMeta[run.outcome]
  const Icon = live ? RefreshCWIcon : run.outcome === 'ok' ? CircleCheckIcon : run.outcome === 'cancelled' ? CircleSlash : CircleAlert
  const excluded = Object.entries(run.excluded ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  const dropped = excluded.reduce((sum, [, n]) => sum + n, 0)

  return (
    <li className="border-b border-line-soft/60 last:border-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex items-center gap-2 text-left"
        >
          {open ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
          <Icon size={14} className={live ? 'animate-spin text-info' : meta.tone === 'good' ? 'text-accent' : meta.tone === 'bad' ? 'text-danger' : 'text-warn'} />
          <span className="font-mono text-xs">{run.id}</span>
        </button>

        <Badge tone={meta.tone}>{meta.label}</Badge>
        <span className="text-[11px] text-faint">{triggerLabel[run.trigger] ?? run.trigger}</span>

        <span className="ml-auto flex items-center gap-4 text-xs">
          <span className="text-faint">
            <ClockIcon size={11} className="mr-1 inline-block" />
            {clock(run.started_at)}
            {!live && ` · ${secs(run.duration_ms)}`}
          </span>
          <span title="офферов в таблице после этого прохода">
            <span className="font-mono text-text">{run.findings}</span>
            <span className="ml-1 text-faint">в таблице</span>
          </span>
          <span title="из них с рассчитанным выходом и положительным итогом">
            <span className="font-mono text-accent">{run.profitable}</span>
            <span className="ml-1 text-faint">в плюс</span>
          </span>
        </span>

        <Button size="sm" tone="ghost" onClick={() => onJournal(run.id)} title="Открыть журнал только этого прохода">
          журнал прохода
        </Button>
      </div>

      {open && (
        <div className="space-y-4 border-t border-line-soft/60 bg-panel-2/30 px-5 py-4">
          {run.error && (
            <p className="rounded-lg border border-danger/35 bg-danger/8 px-3 py-2 text-xs text-danger">
              {run.error}
            </p>
          )}

          <div>
            <h4 className="mb-2 text-[10px] font-semibold tracking-[0.14em] text-faint uppercase">
              что проход посмотрел
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 lg:grid-cols-8">
              <Cell label="строк каталога" value={run.catalogue_rows} hint="сколько строк отдала площадка" />
              <Cell label="кандидатов" value={run.candidates} hint="прошли по цене и типу" />
              <Cell label="из кэша" value={run.from_cache} hint="сокеты уже были известны, Steam не спрашивали" />
              <Cell label="спросили Steam" value={run.requested} hint="варианты, отправленные на проверку сокетов" />
              <Cell label="ответов Steam" value={run.sockets_ok} hint="описаний реально получено и разобрано" />
              <Cell label="вызовов Steam" value={run.steam_calls} hint="пакетных запросов, не предметов" />
              <Cell label="стаканов" value={run.order_books} hint="имён с прочитанным стаканом ордеров" />
              <Cell
                label="не знает Steam"
                value={run.steam_unknown}
                hint="варианты, которые Steam отказался описывать трижды подряд — их перестали спрашивать. Это не очередь: сколько ни жди, они не разрешатся"
              />
            </div>
          </div>

          <div>
            <h4 className="mb-2 text-[10px] font-semibold tracking-[0.14em] text-faint uppercase">
              что вышло
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
              <Cell label="в таблице" value={run.findings} />
              <Cell label="с расчётом" value={run.priced} hint="есть цена выхода хотя бы по одному гему" />
              <Cell label="в плюс" value={run.profitable} />
              <Cell label="добавлено" value={run.added} />
              <Cell label="убрано" value={run.removed} />
            </div>
            {run.steam_unknown > 0 && (
              <p className="mt-2 text-xs text-faint">
                <span className="font-mono">{run.steam_unknown.toLocaleString('ru-RU')}</span> вариантов
                пропущено намеренно: Steam Economy API их не описывает. Повторная попытка — раз в 30 проходов,
                вдруг Valve добавит запись.
              </p>
            )}
            {run.deferred > 0 && (
              <p className="mt-2 text-xs text-warn">
                Отложено на следующий проход: <span className="font-mono">{run.deferred.toLocaleString('ru-RU')}</span>{' '}
                кандидатов. Проход не покрыл каталог целиком — упёрся в бюджет запросов к Steam.
              </p>
            )}
          </div>

          <div>
            <h4 className="mb-2 text-[10px] font-semibold tracking-[0.14em] text-faint uppercase">
              почему остальное не вышло{dropped > 0 && ` — ${dropped.toLocaleString('ru-RU')}`}
            </h4>
            {excluded.length === 0 ? (
              <p className="text-xs text-faint">Проход ничего не отбрасывал.</p>
            ) : (
              <ul className="space-y-1">
                {excluded.map(([reason, n]) => (
                  <li key={reason} className="flex items-baseline gap-3 text-xs">
                    <span className="w-16 shrink-0 text-right font-mono text-text">
                      {n.toLocaleString('ru-RU')}
                    </span>
                    <span className="text-mute">{excludedLabel[reason] ?? reason}</span>
                    <span className="font-mono text-[10px] text-faint">{reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </li>
  )
}

export function Runs({ onJournal }: { onJournal: (runID: string) => void }) {
  const [data, setData] = useState<{ runs: Run[] | null; current?: Run; queued: boolean } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const load = () =>
      api
        .runs()
        .then((d) => {
          setData(d)
          setError('')
        })
        .catch((e: Error) => setError(e.message))
    load()
    const id = window.setInterval(load, 5000)
    return () => window.clearInterval(id)
  }, [])

  const runs = data?.runs ?? []

  return (
    <Panel
      title="Проходы сканера"
      subtitle="каждый обход market.dota2.net отдельно: чем запущен, чем кончился, что отбросил"
    >
      {error && (
        <p className="mb-3 rounded-lg border border-danger/35 bg-danger/8 px-3 py-2 text-sm text-danger">
          Список проходов недоступен: {error}
        </p>
      )}

      <p className="mb-3 text-xs text-faint">
        Здесь только обход market.dota2.net. Обновление цен, обход DMarket и проверка обменов — отдельные
        процессы со своим расписанием; кнопка «Обойти сейчас» их не запускает.
        {data?.queued && ' Ещё один проход уже стоит в очереди — повторные запросы объединяются в один.'}
      </p>

      {!data && !error ? (
        <p className="text-sm text-mute">Читаем историю проходов…</p>
      ) : runs.length === 0 && !data?.current ? (
        <p className="text-sm text-mute">
          Ни один проход ещё не завершился. Первый идёт или запланирован — список заполнится после него.
        </p>
      ) : (
        <ul className="-mx-5">
          {data?.current && <RunRow run={data.current} live onJournal={onJournal} />}
          {runs.map((r) => (
            <RunRow key={r.id} run={r} onJournal={onJournal} />
          ))}
        </ul>
      )}

      {runs.length > 0 && (
        <p className="mt-3 text-xs text-faint">
          Хранятся последние {runs.length} проходов этой сессии, последний — {ago(runs[0].started_at)}.
          После перезапуска список начинается заново; события самих проходов остаются в файлах журнала.
        </p>
      )}
    </Panel>
  )
}
