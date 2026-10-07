import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ScrollText, ShieldAlert, Table2 } from 'lucide-react'
import {
  ActivityIcon,
  ChartLineIcon,
  SettingsIcon,
  VolumeIcon,
} from './components/animated'
import {
  ago,
  api,
  rub,
  subscribe,
  type Finding,
  type JournalEvent,
  type Status,
  type TradeAlert,
} from './api'
import { Charts } from './components/Charts'
import { Diagnostics } from './components/Diagnostics'
import { Guard } from './components/Guard'
import { Journal } from './components/Journal'
import { Runs } from './components/Runs'
import { DiagnosticBundle } from './components/DiagnosticBundle'
import { installDiagnostics, recordAction } from './lib/diagnostics'
import { ItemModal, type ModalTarget } from './components/ItemModal'
import { Offers, defaultFilters, type OfferFilters } from './components/Offers'
import { SettingsPage } from './components/Settings'
import { Toasts, type Toast } from './components/Toasts'
import { RadarSweep } from './components/icons'
import { Button, LiveDot } from './components/ui'
import { proofState } from './lib/dealDisplay'

type Tab = 'offers' | 'guard' | 'charts' | 'sources' | 'journal' | 'settings'

const tabs: { id: Tab; label: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { id: 'offers', label: 'Офферы', icon: Table2 },
  { id: 'guard', label: 'Обмены', icon: ShieldAlert },
  { id: 'charts', label: 'Графики', icon: ChartLineIcon },
  { id: 'sources', label: 'Источники', icon: ActivityIcon },
  { id: 'journal', label: 'Журнал', icon: ScrollText },
  { id: 'settings', label: 'Настройки', icon: SettingsIcon },
]

const SOUND_KEY = 'radar.sound'

/** What the sweep is doing, in words rather than a spinner. */
const phaseLabel: Record<string, string> = {
  idle: 'ожидание',
  catalogue: 'качаю каталог',
  sockets: 'проверяю сокеты у Valve',
  orders: 'читаю стаканы ордеров',
  pricing: 'считаю сделки',
}

/** Short chirp when a profitable offer lands, so the tab can sit in the background. */
function useChime(enabled: boolean) {
  const ctxRef = useRef<AudioContext | null>(null)
  return useCallback(() => {
    if (!enabled) return
    try {
      ctxRef.current ??= new AudioContext()
      const ctx = ctxRef.current
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(880, ctx.currentTime)
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12)
      gain.gain.setValueAtTime(0.0001, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35)
      osc.connect(gain).connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.36)
    } catch {
      /* audio is a nicety, never a failure */
    }
  }, [enabled])
}

function readSoundPref(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off'
  } catch {
    return true
  }
}

/** One compact figure in the header strip. */
function HeaderStat({
  label,
  value,
  tone = 'text-text',
  title,
}: {
  label: string
  value: string
  tone?: string
  title?: string
}) {
  return (
    <div title={title} className="flex flex-col">
      <span className="text-[10px] tracking-[0.12em] text-faint uppercase">{label}</span>
      <span className={`font-mono text-sm ${tone}`}>{value}</span>
    </div>
  )
}

export default function App() {
  const [tab, setTab] = useState<Tab>('offers')
  const [status, setStatus] = useState<Status | null>(null)
  const [findings, setFindings] = useState<Finding[]>([])
  const [alerts, setAlerts] = useState<TradeAlert[]>([])
  const [guardMeta, setGuardMeta] = useState({ lastRun: '', error: '' })
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [modal, setModal] = useState<ModalTarget | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [sound, setSound] = useState(readSoundPref)
  const [filters, setFilters] = useState<OfferFilters>(defaultFilters)
  const [events, setEvents] = useState<JournalEvent[]>([])
  const [eventTotal, setEventTotal] = useState(0)
  const [scanPending, setScanPending] = useState(false)
  const [runFilter, setRunFilter] = useState('')

  // Global error capture has to be live before anything renders, so a crash in
  // the first paint still lands in the diagnostic bundle.
  useEffect(() => {
    installDiagnostics()
    recordAction('панель открыта')
  }, [])
  const scanPendingRef = useRef(false)
  const chime = useChime(sound)

  const toast = useCallback((text: string, tone: 'good' | 'bad' = 'good') => {
    const id = Date.now() + Math.random()
    setToasts((prev) => [...prev.slice(-3), { id, text, tone }])
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000)
  }, [])

  const dismissToast = useCallback(
    (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)),
    [],
  )

  useEffect(() => {
    try {
      localStorage.setItem(SOUND_KEY, sound ? 'on' : 'off')
    } catch {
      /* private mode: the preference simply does not persist */
    }
  }, [sound])

  const refresh = useCallback(async () => {
    try {
      const [s, f, t, j] = await Promise.all([
        api.status(),
        api.findings(),
        api.trades(),
        api.journal(),
      ])
      setStatus(s)
      setEvents(j.events ?? [])
      setEventTotal(j.total ?? 0)
      setFindings(f.results ?? [])
      setAlerts(t.alerts ?? [])
      setGuardMeta({ lastRun: t.last_run, error: t.error })
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 15000)
    return () => window.clearInterval(id)
  }, [refresh])

  useEffect(() => {
    return subscribe((e) => {
      if (e.type === 'finding') {
        const finding = e.data
        setFindings((prev) => [finding, ...prev.filter((f) => f.key !== finding.key)])
        setFresh((prev) => new Set(prev).add(finding.key))
        window.setTimeout(
          () =>
            setFresh((prev) => {
              const next = new Set(prev)
              next.delete(finding.key)
              return next
            }),
          5000,
        )
        // A background alert must not make an unverified estimate sound spendable.
        const deal = finding.deal
        const isActionable =
          deal?.priced &&
          deal.net > 0 &&
          deal.complete &&
          !deal.optimistic &&
          proofState(finding).ok
        if (isActionable && deal) {
          chime()
          toast(
            `${finding.item_name} — вложить ${rub(deal.invested)}, результат +${rub(deal.net)}`,
          )
        } else if (deal?.net && deal.net > 0) {
          toast(`${finding.item_name} — новая оценка требует проверки`)
        }
      } else if (e.type === 'trade_alert') {
        void refresh()
        if (e.data.severity === 'critical') {
          chime()
          toast('Входящий обмен не совпадает с покупкой', 'bad')
        }
      } else if (e.type === 'stats') {
        setStatus((prev) => (prev ? { ...prev, scanner: e.data } : prev))
      } else if (e.type === 'dmarket_stats') {
        setStatus((prev) => (prev ? { ...prev, dmarket: e.data } : prev))
      } else if (e.type === 'journal') {
        // Newest first, bounded so a long session cannot grow without limit.
        setEvents((prev) => [e.data, ...prev.filter((x) => x.id !== e.data.id)].slice(0, 500))
        setEventTotal((n) => n + 1)
      }
    })
  }, [chime, refresh, toast])

  const criticalCount = useMemo(
    () => alerts.filter((a) => a.severity === 'critical').length,
    [alerts],
  )

  const profitable = useMemo(() => findings.filter((f) => f.deal?.priced && f.deal.net > 0), [findings])
  const bestNet = useMemo(
    () => profitable.reduce((max, f) => Math.max(max, f.deal?.net ?? 0), 0),
    [profitable],
  )

  const scanner = status?.scanner
  const progress =
    scanner && scanner.phase_total > 0
      ? Math.min(100, Math.round((scanner.phase_done / scanner.phase_total) * 100))
      : null

  const openItem = useCallback((f: Finding, siblings?: Finding[]) => {
    setModal({
      classid: f.classid,
      instanceid: f.instanceid,
      name: f.item_name,
      rarity: f.rarity,
      nameColor: f.name_color,
      finding: f,
      siblings,
    })
  }, [])

  // Sweeps keep running while the dialog is open. Re-point it at the current
  // copy of the finding so the numbers inside move with the table behind it.
  const liveModal = useMemo(() => {
    if (!modal) return null
    const fresh = findings.find(
      (f) => modal.finding
        ? f.source === modal.finding.source && f.key === modal.finding.key
        : f.classid === modal.classid && f.instanceid === modal.instanceid,
    )
    return fresh ? { ...modal, finding: fresh } : modal
  }, [modal, findings])

  const scanNow = useCallback(() => {
    if (scanPendingRef.current) return
    scanPendingRef.current = true
    setScanPending(true)
    void api.scanNow()
      .then(() => {
        toast('Запрошен обход market.dota2.net. Повторные запросы объединяются.')
        return refresh()
      })
      .catch((e: Error) => toast(e.message, 'bad'))
      .finally(() => {
        scanPendingRef.current = false
        setScanPending(false)
      })
  }, [refresh, toast])

  return (
    <div className="mx-auto flex min-h-full max-w-[1480px] flex-col gap-4 px-5 py-5 sm:px-6">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border border-line bg-panel/70 px-5 py-3">
        <div className="flex items-center gap-3">
          <span className={scanner?.running ? 'text-accent' : 'text-faint'}>
            <RadarSweep size={26} />
          </span>
          <div>
            <h1 className="text-[15px] leading-tight font-semibold tracking-tight">Kinetic Radar</h1>
            <p className="flex items-center gap-1.5 text-[11px] text-faint">
              <LiveDot active={Boolean(scanner?.running)} />
              {scanner?.running ? (
                <>
                  <span className="text-accent">{phaseLabel[scanner.phase] ?? 'обход'}</span>
                  {scanner.phase_detail && <span>· {scanner.phase_detail}</span>}
                </>
              ) : (
                <>
                  обход {ago(scanner?.last_sweep ?? '')}
                  {scanner?.sweeps_done ? ` · всего ${scanner.sweeps_done}` : ''}
                  {scanner && (scanner.last_added > 0 || scanner.last_removed > 0)
                    ? ` · +${scanner.last_added} / −${scanner.last_removed}`
                    : ''}
                </>
              )}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <HeaderStat
            label="Прибыльных"
            value={String(profitable.length)}
            tone={profitable.length > 0 ? 'text-accent' : 'text-mute'}
          />
          <HeaderStat
            label="Лучший результат"
            value={bestNet > 0 ? rub(bestNet) : '—'}
            tone={bestNet > 0 ? 'text-accent' : 'text-mute'}
          />
          <HeaderStat
            label="Баланс"
            // A balance that failed to read is not a balance of zero. The poll
            // keeps the last good value and only records the error beside it,
            // so an unread wallet used to render as «0 ₽» in the ordinary tone
            // — indistinguishable from an empty one.
            value={
              !status ? '—' : status.balance_error ? 'не прочитан' : rub(status.balance)
            }
            tone={
              !status?.market_key_ok || status?.balance_error ? 'text-danger' : 'text-text'
            }
            title={
              !status?.market_key_ok
                ? 'нет market.key'
                : status.balance_error
                  ? `Баланс не прочитан: ${status.balance_error}`
                  : `Прочитан ${ago(status.balance_at)}`
            }
          />
          <HeaderStat
            label={scanner?.running ? 'Текущий этап' : 'В каталоге'}
            value={scanner?.running ? (progress === null ? '…' : `${progress}%`) : String(scanner?.catalogue_size ?? '—')}
            title={scanner?.running
              ? `${phaseLabel[scanner.phase] ?? scanner.phase}: ${scanner.phase_done} из ${scanner.phase_total}. Прогресс этапа, не покрытие всего рынка.`
              : 'Строки текущего каталога market.dota2.net, не число проверенных офферов всех площадок'}
          />
          <HeaderStat
            label="Запросов TM"
            value={`${status?.requests_last_second ?? 0}/сек`}
            tone={(status?.requests_last_second ?? 0) > 4 ? 'text-danger' : 'text-mute'}
            title="предел радара 4/сек, предел маркета 5"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button
            tone="ghost"
            size="sm"
            onClick={() => setSound((s) => !s)}
            title={sound ? 'Выключить звук находок' : 'Включить звук находок'}
          >
            <VolumeIcon size={16} className={sound ? '' : 'opacity-40'} />
          </Button>
          <nav aria-label="Разделы радара" className="flex flex-wrap items-center gap-1 rounded-xl border border-line bg-panel-2/60 p-1">
            {tabs.map((t) => {
              const Icon = t.icon
              const active = tab === t.id
              return (
                <button
                  key={t.id}
                  onClick={() => {
                    recordAction(`вкладка: ${t.id}`)
                    setTab(t.id)
                  }}
                  aria-current={active ? 'page' : undefined}
                  className={`group inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? 'bg-panel-3 text-text shadow-[0_1px_0_0_rgba(255,255,255,0.05)_inset]'
                      : 'text-mute hover:bg-panel-2 hover:text-text'
                  }`}
                >
                  <Icon size={16} />
                  {t.label}
                  {t.id === 'guard' && criticalCount > 0 && (
                    <span className="rounded bg-danger px-1.5 text-[11px] font-semibold text-ink">
                      {criticalCount}
                    </span>
                  )}
                </button>
              )
            })}
          </nav>
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Сервер недоступен: {error}
        </div>
      )}

      {criticalCount > 0 && tab !== 'guard' && (
        <button
          onClick={() => setTab('guard')}
          className="group flex items-center gap-3 rounded-xl border border-danger/50 bg-danger/12 px-4 py-3 text-left text-sm text-danger transition-colors hover:bg-danger/18"
        >
          <ShieldAlert size={18} className="ico ico-shake" />
          Входящий обмен не совпадает с покупкой — не принимай его. Открыть проверку.
        </button>
      )}

      {tab === 'offers' && (
        <Offers
          findings={findings}
          freshKeys={fresh}
          onOpen={openItem}
          filters={filters}
          setFilters={setFilters}
        />
      )}

      {tab === 'guard' && (
        <Guard alerts={alerts} lastRun={guardMeta.lastRun} error={guardMeta.error} />
      )}

      {tab === 'charts' && <Charts findings={findings} />}

      {tab === 'sources' && (
        <div className="space-y-5">
          <Runs
            onJournal={(id) => {
              setRunFilter(id)
              setTab('journal')
            }}
          />
          <Diagnostics
            status={status}
            findings={findings}
            onScan={scanNow}
            scanPending={scanPending}
            onPick={openItem}
          />
        </div>
      )}

      {tab === 'journal' && (
        <Journal
          events={events}
          total={eventTotal}
          run={runFilter || undefined}
          onClearRun={() => setRunFilter('')}
          extraAction={
            <DiagnosticBundle
              ui={{ tab, filters, openItem: modal ? `${modal.classid}_${modal.instanceid}` : null }}
              onToast={toast}
            />
          }
        />
      )}

      {tab === 'settings' && <SettingsPage onToast={toast} />}

      {liveModal && (
        <ItemModal
          target={liveModal}
          onClose={() => setModal(null)}
          onToast={toast}
          onNavigate={(f) => openItem(f, liveModal.siblings)}
        />
      )}
      <Toasts items={toasts} onDismiss={dismissToast} />
    </div>
  )
}
