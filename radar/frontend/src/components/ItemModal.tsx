import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  BoxesIcon,
  CartIcon,
  ChartLineIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  ExternalLinkIcon,
  GaugeIcon,
  XIcon,
} from './animated'
import { api, rub, type Finding, type GemPoint, type ItemDetail, type JournalEvent } from '../api'
import { DealBreakdown } from './DealBreakdown'
import { GemBreakdown } from './Sources'
import { LineChart, type Series } from './Chart'
import { GemMark, SocketIcon, rarityColor, socketColor } from './icons'
import { confidenceMeta, journalFields, kindMeta, levelTone, reasonMeta } from './meta'
import { Badge, Button, ItemThumb } from './ui'
import { dealDisplay, offerMarketURL } from '../lib/dealDisplay'

const socketLabel: Record<string, string> = {
  kinetic: 'Кинетический',
  spectator: 'Зрительский',
  prismatic: 'Призматический',
  ethereal: 'Эфирный',
  empty: 'Пустой',
  other: 'Прочий',
}

const ACCENT = 'var(--color-accent)'
const INFO = 'var(--color-info)'
const VIOLET = 'var(--color-violet)'

const TABS = [
  { id: 'deal', label: 'Расчёт', Icon: GaugeIcon },
  { id: 'sockets', label: 'Сокеты', Icon: BoxesIcon },
  { id: 'prices', label: 'Цены', Icon: CartIcon },
  { id: 'history', label: 'История', Icon: ChartLineIcon },
  { id: 'log', label: 'Журнал', Icon: ClockIcon },
] as const

type TabId = (typeof TABS)[number]['id']

export type ModalTarget = {
  classid: string
  instanceid: string
  name: string
  rarity?: string
  nameColor?: string
  /** The finding this popup was opened from, when there is one. */
  finding?: Finding
  /** The list the popup was opened from, in the order the operator sees it. */
  siblings?: Finding[]
}

const stamp = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
}

const clock = (ms: number) =>
  new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

/**
 * The money line, repeated above every tab so it never scrolls away: whatever
 * the operator is reading, the number that decides the purchase stays in view.
 */
function Summary({ finding }: { finding?: Finding }) {
  const deal = finding?.deal
  const display = dealDisplay(deal)
  if (!deal || !deal.priced) {
    return (
      <div className="flex flex-wrap items-center gap-3 border-b border-line-soft bg-panel-2/40 px-5 py-3 text-sm">
        <span className="text-mute">
          Цена лота <span className="font-mono text-text">{finding ? rub(deal?.buy_price ?? finding.price) : '—'}</span>
        </span>
        {deal && (
          <span className="text-mute">
            Извлечение <span className="font-mono text-text">{rub(deal.extraction_cost)}</span>
            {' · '}Вложить <span className="font-mono text-text">{rub(deal.invested)}</span>
          </span>
        )}
        <Badge tone="warn">расчёт недоступен</Badge>
        <span className="text-xs text-faint">
          Недостаточно данных для расчёта выручки, результата и ROI.
        </span>
      </div>
    )
  }

  const good = deal.net > 0
  const conf = confidenceMeta[finding?.confidence ?? 'none']

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line-soft bg-panel-2/40 px-5 py-3">
      <div>
        <div className="text-[10px] tracking-[0.14em] text-faint uppercase">вложить</div>
        <div className="font-mono text-sm text-danger">{rub(deal.invested)}</div>
      </div>
      <ChevronRightIcon size={14} className="mt-3 text-faint" />
      <div>
        <div className="text-[10px] tracking-[0.14em] text-faint uppercase">{display.proceedsLabel}</div>
        <div className="font-mono text-sm text-text">{rub(deal.proceeds)}</div>
      </div>
      <ChevronRightIcon size={14} className="mt-3 text-faint" />
      <div>
        <div className="text-[10px] tracking-[0.14em] text-faint uppercase">{display.resultLabel}</div>
        <div className={`font-mono text-xl leading-tight ${good ? 'text-accent' : 'text-danger'}`}>
          {good ? '+' : ''}
          {rub(deal.net)}
          <span className="ml-1.5 text-sm">{Math.round(deal.roi)}%</span>
        </div>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {display.wallet && <Badge tone="violet" title="Итог и ROI учитывают вес кошелька; это не выводимые деньги">есть кошелёк</Badge>}
        <Badge tone={conf.tone} title={conf.hint}>
          {conf.label}
        </Badge>
        {deal.optimistic && (
          <Badge tone="warn" title="Часть выручки опирается на чужое объявление, а не на живой ордер">
            по объявлению
          </Badge>
        )}
        {!deal.complete && <Badge tone="warn">неполный</Badge>}
      </div>
    </div>
  )
}

/** How one gem's price moved, from the radar's own recorded observations. */
function GemHistory({ gem }: { gem: string }) {
  const [points, setPoints] = useState<GemPoint[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setPoints(null)
    setError('')
    api
      .gemHistory(gem)
      .then((d) => alive && setPoints(d.points ?? []))
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [gem])

  const series: Series[] = useMemo(() => {
    const pts = points ?? []
    const at = (p: GemPoint) => Date.parse(p.at)
    const out: Series[] = [
      { name: 'медиана', color: ACCENT, area: true, points: pts.map((p) => ({ x: at(p), y: p.median })) },
      { name: 'максимум', color: VIOLET, dashed: true, points: pts.map((p) => ({ x: at(p), y: p.high })) },
    ]
    const orders = pts.filter((p) => typeof p.order === 'number' && p.order > 0)
    if (orders.length > 0) {
      out.push({
        name: 'верхний ордер',
        color: INFO,
        points: orders.map((p) => ({ x: at(p), y: p.order as number })),
      })
    }
    return out
  }, [points])

  const last = points && points.length > 0 ? points[points.length - 1] : null
  const first = points && points.length > 0 ? points[0] : null
  const drift = first && last && first.median > 0 ? ((last.median - first.median) / first.median) * 100 : null

  return (
    <div className="rounded-xl border border-line bg-panel-2/40 px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <GemMark size={14} />
        <span className="text-sm font-medium">{gem}</span>
        {drift !== null && Math.abs(drift) >= 1 && (
          <Badge tone={drift > 0 ? 'good' : 'warn'}>
            {drift > 0 ? '+' : ''}
            {Math.round(drift)}% за период
          </Badge>
        )}
        <span className="ml-auto text-[11px] text-faint">
          {points ? `${points.length} точек` : 'загрузка…'}
        </span>
      </div>
      {error ? (
        <p className="text-sm text-warn">История недоступна: {error}</p>
      ) : (
        <LineChart
          series={series}
          height={120}
          format={(v) => rub(v)}
          formatX={clock}
          empty="Нужно минимум две записи цены. Радар пишет новую точку только когда цена сдвинулась — пустой график значит, что цена стоит."
        />
      )}
    </div>
  )
}

/** Every event the radar recorded about this exact lot, newest first. */
function ItemLog({ subject }: { subject: string }) {
  const [events, setEvents] = useState<JournalEvent[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setEvents(null)
    setError('')
    api
      .journalFor(subject)
      .then((d) => alive && setEvents(d.events ?? []))
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [subject])

  if (error) return <p className="text-sm text-warn">Журнал недоступен: {error}</p>
  if (!events)
    return (
      <p className="flex items-center gap-2 text-sm text-mute">
        <Loader2 size={14} className="animate-spin" /> Поднимаем историю лота…
      </p>
    )
  if (events.length === 0)
    return (
      <p className="text-sm text-mute">
        По этому лоту записей нет. Такое бывает, если он поднят из сохранённого состояния до того,
        как журнал начали писать.
      </p>
    )

  return (
    <ol className="relative space-y-3 border-l border-line pl-4">
      {events.map((e) => {
        const meta = kindMeta[e.kind] ?? { label: e.kind, tone: 'default' as const }
        const fields = journalFields(e.fields)
        return (
          <li key={e.id} className="relative">
            <span
              className="absolute top-1.5 -left-[21px] h-2 w-2 rounded-full ring-3 ring-panel"
              style={{
                background:
                  meta.tone === 'good'
                    ? 'var(--color-accent)'
                    : meta.tone === 'bad'
                      ? 'var(--color-danger)'
                      : meta.tone === 'warn'
                        ? 'var(--color-warn)'
                        : 'var(--color-info)',
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={meta.tone}>{meta.label}</Badge>
              <span className="font-mono text-[11px] text-faint">{stamp(e.at)}</span>
            </div>
            <p className={`mt-1 text-sm ${levelTone[e.level] ?? 'text-mute'}`}>{e.message}</p>
            {e.reason && (
              <p className="text-[11px] text-faint">{reasonMeta[e.reason] ?? e.reason}</p>
            )}
            {fields.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-faint">
                {fields.map(([k, v]) => (
                  <span key={k}>
                    {k}=<span className="text-mute">{v}</span>
                  </span>
                ))}
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

export function ItemModal({
  target,
  onClose,
  onToast,
  onNavigate,
}: {
  target: ModalTarget
  onClose: () => void
  onToast: (text: string, tone?: 'good' | 'bad') => void
  onNavigate?: (f: Finding) => void
}) {
  const [detail, setDetail] = useState<ItemDetail | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<TabId>('deal')

  const siblings = target.siblings ?? []
  const index = siblings.findIndex((f) => f.classid === target.classid && f.instanceid === target.instanceid)
  const step = useCallback(
    (delta: number) => {
      if (!onNavigate || index < 0) return
      const next = siblings[index + delta]
      if (next) onNavigate(next)
    },
    [index, onNavigate, siblings],
  )

  const dialogRef = useRef<HTMLDivElement>(null)
  // The handler reads these through refs so the effect below can depend on
  // nothing. `onClose` and `onNavigate` are inline arrows in App, recreated on
  // every poll and every SSE event, and the dialog stays open across dozens of
  // those: with them in the dep array the effect tore down and re-ran, calling
  // dialogRef.focus() and yanking the caret out of whatever the user was on,
  // while `opener` was re-captured as an element inside the dialog — so focus
  // restore on close pointed at something that no longer existed.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const stepRef = useRef(step)
  stepRef.current = step

  useEffect(() => {
    // Keyboard focus has to live inside the dialog while it is open, and go back
    // where it came from when it closes. Without this, Tab walks the offers table
    // behind the overlay: the user is typing into rows they cannot see, and after
    // Esc the focus ring is gone entirely and the keyboard has no anchor.
    const opener = document.activeElement as HTMLElement | null
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null || el === document.activeElement)

    dialogRef.current?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (e.key === 'Tab') {
        const items = focusable()
        if (items.length === 0) return
        const first = items[0]
        const last = items[items.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (e.shiftKey && (active === first || active === dialogRef.current)) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && active === last) {
          e.preventDefault()
          first.focus()
        }
        return
      }
      // Arrows step between offers, but only when the user is not inside a
      // control that owns them: a text field, a select, or the tab strip.
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
      if (e.key === 'ArrowLeft') stepRef.current(-1)
      else if (e.key === 'ArrowRight') stepRef.current(1)
    }

    window.addEventListener('keydown', onKey)
    // Freeze the page behind the dialog, otherwise opening it from a row far
    // down the table leaves the dialog scrolled out of view.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
      opener?.focus?.()
    }
    // Deliberately empty: this runs once per open dialog. Everything mutable
    // it needs is read through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let alive = true
    setDetail(null)
    setError('')
    api
      .item(target.classid, target.instanceid)
      .then((d) => alive && setDetail(d))
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [target.classid, target.instanceid])

  const edge = rarityColor(target.rarity ?? '', target.nameColor ?? '')
  const kinetics = detail?.sockets?.filter((s) => s.kind === 'kinetic' && s.name !== 'Empty Socket')
  const finding = target.finding
  // Prefer what the deal actually priced; fall back to the names the scanner
  // recorded, so the history tab still works for an unpriced lot.
  const gemNames = finding?.deal?.gems.map((g) => g.name) ?? finding?.gems ?? []

  const marketURL = offerMarketURL(finding, detail)
  const inspectURL = detail?.inspect_url?.trim() || undefined

  const copyLink = async () => {
    if (!marketURL) return
    try {
      await navigator.clipboard.writeText(marketURL)
      onToast('Ссылка на лот скопирована')
    } catch {
      onToast('Буфер обмена недоступен', 'bad')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/80 p-4 backdrop-blur-sm sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={target.name}
        className="rise-in my-auto w-full max-w-3xl overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_40px_120px_-30px_rgba(0,0,0,1)]"
      >
        <header
          className="flex items-start gap-4 border-b border-line-soft p-5"
          style={{ background: `linear-gradient(90deg, color-mix(in srgb, ${edge} 9%, transparent), transparent 70%)` }}
        >
          <span
            className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-panel-3"
            style={{ boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${edge} 40%, transparent)` }}
          >
            {!detail && !error && !finding?.icon_url ? (
              <Loader2 size={18} className="animate-spin text-faint" />
            ) : (
              <ItemThumb src={detail?.icon_url || finding?.icon_url} alt={target.name} color={edge} size={80} />
            )}
          </span>

          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold" style={{ color: edge }}>
              {detail?.name ?? target.name}
            </h2>
            <p className="text-sm text-mute">
              {detail?.type || ' '}
              {finding?.hero_name ? ` · ${finding.hero_name}` : ''}
            </p>
            <p className="mt-1 font-mono text-[11px] text-faint">
              {target.classid}_{target.instanceid}
              {finding?.lock_days ? ` · обмен закрыт ${finding.lock_days} дн.` : ''}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {index >= 0 && siblings.length > 1 && (
              <>
                <Button
                  tone="ghost"
                  size="sm"
                  onClick={() => step(-1)}
                  disabled={index === 0}
                  title="Предыдущий оффер (←)"
                >
                  <ChevronLeftIcon size={16} />
                </Button>
                <span className="font-mono text-[11px] whitespace-nowrap text-faint">
                  {index + 1}/{siblings.length}
                </span>
                <Button
                  tone="ghost"
                  size="sm"
                  onClick={() => step(1)}
                  disabled={index === siblings.length - 1}
                  title="Следующий оффер (→)"
                >
                  <ChevronRightIcon size={16} />
                </Button>
              </>
            )}
            <Button tone="ghost" onClick={onClose} title="Закрыть (Esc)">
              <XIcon size={17} />
            </Button>
          </div>
        </header>

        <Summary finding={finding} />

        <nav className="flex gap-1 overflow-x-auto border-b border-line-soft px-3 pt-2">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              aria-current={tab === id}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors ${
                tab === id
                  ? 'border-accent text-text'
                  : 'border-transparent text-faint hover:text-mute'
              }`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </nav>

        <div className="max-h-[58vh] overflow-y-auto">
          {error && (
            <div className="m-5 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
              Steam не ответил про этот предмет: {error}. Сокеты и стакан ниже недоступны;
              расчёт сделки от этого запроса не зависит и показан как есть.
            </div>
          )}

          {/* The body is no longer gated on `detail`. The deal arithmetic, the
              gem history and this lot's journal all come from data the popup
              already holds, and hiding them because one Steam call failed
              removed exactly the numbers the operator opened the popup for. */}
          <div key={tab} className="pane-in space-y-5 p-5">
              {tab === 'deal' &&
                (finding?.deal ? (
                  <DealBreakdown deal={finding.deal} />
                ) : (
                  <p className="text-sm text-mute">
                    Расчёта нет: попап открыт не из таблицы офферов, либо у лота ещё нет плана
                    продажи.
                  </p>
                ))}

              {tab === 'sockets' && !detail && !error && (
                <p className="flex items-center gap-2 text-sm text-mute">
                  <Loader2 size={16} className="animate-spin" /> Спрашиваем Steam о сокетах…
                </p>
              )}

              {tab === 'sockets' && detail && (
                <section>
                  {detail.sockets && detail.sockets.length > 0 ? (
                    <ul className="grid gap-2 sm:grid-cols-2">
                      {detail.sockets.map((s, i) => {
                        const isEmpty = s.kind === 'empty' || s.name === 'Empty Socket'
                        return (
                          <li
                            key={`${s.name}-${i}`}
                            className="flex items-center gap-3 rounded-xl border px-3 py-2"
                            style={{
                              borderColor: isEmpty ? undefined : `color-mix(in srgb, ${socketColor(s.kind)} 27%, transparent)`,
                              background: isEmpty ? undefined : `color-mix(in srgb, ${socketColor(s.kind)} 6%, transparent)`,
                            }}
                          >
                            <SocketIcon kind={s.kind} iconURL={s.icon_url} size={22} />
                            <div className="min-w-0">
                              <div
                                className={`truncate text-sm ${isEmpty ? 'text-mute' : 'font-medium text-text'}`}
                              >
                                {s.name || '—'}
                              </div>
                              <div className="text-[11px]" style={{ color: socketColor(s.kind) }}>
                                {socketLabel[s.kind] ?? s.kind}
                                {s.subtitle ? ` · ${s.subtitle}` : ''}
                              </div>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  ) : (
                    <p className="text-sm text-mute">В ответе Steam сокеты не распознаны.</p>
                  )}

                  {kinetics && kinetics.length > 0 ? (
                    <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-accent">
                      <GemMark size={15} />
                      Кинетик подтверждён Steam:
                      {kinetics.map((k) => (
                        <Badge key={k.name} tone="good">
                          {k.name}
                        </Badge>
                      ))}
                    </p>
                  ) : (
                    <p className="mt-3 text-sm text-warn">
                      Кинетический сокет не подтверждён в разобранном ответе Steam.
                      Это не доказывает, что гем извлечён: проверьте оригинальный блок Steam и техническую проверку.
                    </p>
                  )}

                  {detail.valve_html && (
                    <details className="group mt-4 rounded-xl border border-line bg-panel-2/50">
                      <summary className="cursor-pointer list-none px-4 py-2.5 text-sm text-mute select-none hover:text-text">
                        Оригинальный блок Steam
                      </summary>
                      <div
                        className="valve-html overflow-x-auto border-t border-line-soft px-4 py-3"
                        // Markup comes from Valve's own economy API, which is the
                        // authority this whole tool exists to check against.
                        dangerouslySetInnerHTML={{ __html: detail.valve_html }}
                      />
                    </details>
                  )}
                </section>
              )}

              {tab === 'prices' && !detail && !error && (
                <p className="flex items-center gap-2 text-sm text-mute">
                  <Loader2 size={16} className="animate-spin" /> Читаем предложения и стакан…
                </p>
              )}

              {tab === 'prices' && detail && (
                <>
                  {finding?.gem_prices && finding.gem_prices.length > 0 && (
                    <section>
                      <h3 className="mb-2 text-[11px] font-semibold tracking-[0.14em] text-faint uppercase">
                        Сколько стоит гем — по каждому рынку
                      </h3>
                      <div className="space-y-2">
                        {finding.gem_prices.map((g) => (
                          <GemBreakdown key={g.name} price={g} />
                        ))}
                      </div>
                    </section>
                  )}

                  <section className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <h3 className="mb-2 text-[11px] font-semibold tracking-[0.14em] text-faint uppercase">
                        Продают на market.dota2.net
                      </h3>
                      {detail.offers_error ? (
                        <p className="text-sm text-warn">Маркет не ответил: {detail.offers_error}</p>
                      ) : detail.offers && detail.offers.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {detail.offers.slice(0, 10).map((o, i) => (
                            <span
                              key={i}
                              className={`rounded-lg border px-2.5 py-1 font-mono text-xs ${
                                i === 0
                                  ? 'border-accent/40 bg-accent/10 text-accent'
                                  : 'border-line bg-panel-2 text-mute'
                              }`}
                            >
                              {rub(o.price)}
                              {o.count > 1 && <span className="text-faint"> ×{o.count}</span>}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-mute">Сейчас предложений нет.</p>
                      )}
                    </div>

                    <div>
                      <h3 className="mb-2 text-[11px] font-semibold tracking-[0.14em] text-faint uppercase">
                        Ордера market.dota2.net
                      </h3>
                      {detail.offers_error ? (
                        // One market call fills both sides, so a failure empties the
                        // buy orders too. Saying "нет ордеров" here would report an
                        // absent bid — the opposite conclusion from "we could not ask".
                        <p className="text-sm text-warn">
                          Стакан не прочитан: {detail.offers_error}. Это не значит, что спроса нет.
                        </p>
                      ) : detail.buy_orders && detail.buy_orders.length > 0 ? (
                        <>
                          <div className="flex flex-wrap gap-2">
                            {detail.buy_orders.slice(0, 8).map((o, i) => (
                              <span
                                key={i}
                                className={`rounded-lg border px-2.5 py-1 font-mono text-xs ${
                                  i === 0
                                    ? 'border-info/40 bg-info/10 text-info'
                                    : 'border-line bg-panel-2 text-mute'
                                }`}
                              >
                                {rub(o.price)}
                                {o.count > 1 && <span className="text-faint"> ×{o.count}</span>}
                              </span>
                            ))}
                          </div>
                          <p className="mt-2 text-[11px] text-faint">
                            Верхний ордер — цена, по которой вещь уходит сразу.
                          </p>
                        </>
                      ) : (
                        <p className="text-sm text-mute">
                          Маркет ответил, встречных ордеров нет — выкупить мгновенно некому.
                        </p>
                      )}
                    </div>
                  </section>
                </>
              )}

              {tab === 'history' &&
                (gemNames.length > 0 ? (
                  <div className="space-y-3">
                    {gemNames.map((g) => (
                      <GemHistory key={g} gem={g} />
                    ))}
                    <p className="text-xs text-faint">
                      Ряды берутся из <span className="font-mono">radar-data/history.json</span> —
                      это записи самого радара, а не выгрузка площадки. Точка пишется только при
                      изменении цены, поэтому редкий график означает стабильный гем.
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-mute">Гемы у лота не определены — историю строить не по чему.</p>
                ))}

              {tab === 'log' && <ItemLog subject={finding?.item_name ?? target.name} />}
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line-soft bg-panel-2/40 px-5 py-3">
          <Button onClick={copyLink} size="sm" disabled={!marketURL}>
            <CopyIcon size={15} /> Копировать ссылку
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={inspectURL}
              aria-disabled={!inspectURL}
              tabIndex={inspectURL ? undefined : -1}
              target="_blank"
              rel="noreferrer"
              className="group inline-flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-sm text-mute transition-colors hover:border-faint hover:text-text aria-disabled:pointer-events-none aria-disabled:opacity-40"
            >
              <ExternalLinkIcon size={15} /> Техническая проверка Steam
            </a>
            <a
              href={marketURL}
              aria-disabled={!marketURL}
              tabIndex={marketURL ? undefined : -1}
              target="_blank"
              rel="noreferrer"
              className="group inline-flex items-center gap-2 rounded-lg border border-accent/45 bg-accent/12 px-3 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-accent/20 aria-disabled:pointer-events-none aria-disabled:opacity-40"
            >
              <CartIcon size={15} /> Открыть лот
            </a>
          </div>
        </footer>
      </div>
    </div>
  )
}
