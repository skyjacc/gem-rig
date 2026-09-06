import { RefreshCWIcon } from './animated'
import { ago, type Status } from '../api'
import { SpreadChart } from './SpreadChart'
import { Coverage } from './Coverage'
import { Button, Panel, Progress } from './ui'
import type { Finding } from '../api'

/**
 * Everything that explains how the offers were produced. Kept off the main
 * screen so it never competes with the offers themselves, but one click away
 * when a number needs to be questioned.
 */
export function Diagnostics({
  status,
  findings,
  onScan,
  onPick,
  scanPending = false,
}: {
  status: Status | null
  findings: Finding[]
  onScan: () => void
  scanPending?: boolean
  onPick: (f: Finding) => void
}) {
  const scanner = status?.scanner
  const progress =
    scanner?.running && scanner.phase_total > 0
      ? Math.min(100, Math.round((scanner.phase_done / scanner.phase_total) * 100))
      : 0

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <Panel
          title="Обход каталога market.dota2.net"
          subtitle={
            scanner?.last_sweep_duration
              ? `последний проход ${scanner.last_sweep_duration}, ${ago(scanner.last_sweep)}`
              : 'первый проход ещё идёт'
          }
          action={
            <Button tone="primary" size="sm" onClick={onScan} disabled={scanPending || Boolean(scanner?.running)}>
              <RefreshCWIcon size={15} className={scanner?.running ? 'animate-spin' : ''} />
              {scanPending ? 'Отправляется…' : scanner?.running ? 'Идёт обход TM' : 'Обойти market.dota2.net'}
            </Button>
          }
        >
          {scanner?.running && <Progress value={progress} />}
          <p className="mt-2 text-xs text-faint">
            {scanner?.running ? `${scanner.phase_detail || scanner.phase}: ${scanner.phase_done} / ${scanner.phase_total}. Это прогресс этапа, не покрытие рынка.` : 'Ожидание следующего обхода. Проверка DMarket и обновление цен выполняются отдельно.'}
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
            {[
              ['Успешно разрешено', scanner?.current_resolved?.toLocaleString('ru-RU') ?? '—'],
              ['Вариантов', (scanner?.catalogue_size ?? 0).toLocaleString('ru-RU')],
              ['Вариантов осталось', (scanner?.pending_resolve ?? 0).toLocaleString('ru-RU')],
              ['Попыток Steam за сессию', (scanner?.steam_calls ?? 0).toLocaleString('ru-RU')],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt className="text-[11px] tracking-[0.1em] text-faint uppercase">{label}</dt>
                <dd className="font-mono text-text">{value}</dd>
              </div>
            ))}
          </dl>
          {scanner?.last_error && (
            <p className="mt-4 rounded-lg border border-warn/30 bg-warn/8 px-3 py-2 text-sm text-warn">
              {scanner.last_error}
            </p>
          )}
        </Panel>

        <Panel title="Курс" subtitle="берётся из самого Steam, без сторонних валютных API">
          <div className="font-mono text-2xl text-accent">
            1 $ = {(status?.fx_rate ?? 0).toFixed(2)} ₽
          </div>
          <p className="mt-2 text-xs text-mute">{status?.fx_source || '—'}</p>
          <p className="mt-3 text-xs text-faint">
            Один и тот же гем запрашивается у Steam в долларах и в рублях, отношение и есть курс.
            Это оценочный коэффициент Steam, не банковский курс и не гарантированный курс вывода.
          </p>
        </Panel>
      </div>

      <Coverage />

      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <Panel
          title="DMarket"
          subtitle={
            status?.dmarket?.enabled
              ? `сокеты приходят разобранными, запросов к Steam не нужно${
                  status.dmarket.balance_usd ? ` · баланс $${status.dmarket.balance_usd}` : ''
                }`
              : 'ключи не найдены — положи dmarket.key и dmarket.pub в tools/'
          }
        >
          {status?.dmarket?.enabled ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
              {[
                ['Офферов просмотрено', status.dmarket.offers_seen],
                ['С кинетиком', status.dmarket.with_gems],
                ['В таблице', status.dmarket.findings],
                ['Обход, мс', status.dmarket.last_sweep_ms],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <dt className="text-[11px] tracking-[0.1em] text-faint uppercase">{label}</dt>
                  <dd className="font-mono text-text">{Number(value).toLocaleString('ru-RU')}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-mute">
              Вторая площадка с точным вариантом предмета и историей реальных сделок.
            </p>
          )}
          {status?.dmarket?.last_error && (
            <p className="mt-3 rounded-lg border border-warn/30 bg-warn/8 px-3 py-2 text-sm text-warn">
              {status.dmarket.last_error}
            </p>
          )}
        </Panel>

        <Panel title="Разница объявлений" subtitle="справочно: цена лота против цены гема">
          {findings.some((f) => f.priced && f.net_spread > 0) ? (
            <SpreadChart findings={findings} onPick={onPick} />
          ) : (
            <p className="text-sm text-mute">Появится, как только найдётся прибыльный лот.</p>
          )}
        </Panel>
      </div>
    </div>
  )
}
