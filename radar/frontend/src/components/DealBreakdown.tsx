import { BadgeAlertIcon, WalletIcon } from './animated'
import { rub, type Deal, type Exit, type Leg } from '../api'
import { HammerMark, RoubleMark } from './icons'
import { Badge } from './ui'
import { sourceLabel } from './meta'
import { dealDisplay } from '../lib/dealDisplay'

function ExitLine({ exit, chosen }: { exit: Exit; chosen: boolean }) {
  return (
    <li
      className={`flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
        chosen ? 'border-accent/35 bg-accent/[0.07]' : 'border-line bg-panel-2/50'
      }`}
    >
      <span className="font-medium">{sourceLabel(exit.venue)}</span>
      {exit.speed === 'instant' ? (
        <Badge tone="good" title={`Заявок: ${exit.orders ?? 0}`}>
          в ордер{exit.orders ? ` · ${exit.orders}` : ''}
        </Badge>
      ) : (
        <Badge tone="warn">объявление</Badge>
      )}
      {exit.payout === 'wallet' && (
        <Badge tone="violet" title="Деньги нельзя вывести, только тратить внутри площадки">
          <WalletIcon size={11} /> кошелёк
        </Badge>
      )}
      <span className="ml-auto text-faint">
        {rub(exit.gross)} − {exit.fee_percent}%
      </span>
      <span className="text-right font-mono text-text">
        {rub(exit.net)}{exit.payout === 'wallet' && ' в кошелёк'}
      </span>
      {exit.payout === 'wallet' && (
        <span className="basis-full text-right text-[11px] text-faint">
          {chosen ? 'В расчёт' : 'Эквивалент выхода'}: {rub(exit.weighted)} · не выводится в деньги
        </span>
      )}
      {exit.note && <span className="basis-full text-[11px] text-warn">{exit.note}</span>}
    </li>
  )
}

function LegBlock({ leg, label }: { leg: Leg; label: string }) {
  const exits = leg.exits ?? []
  // A leg routinely carries two exits from the same venue — the order book and
  // the listing — so matching on venue alone highlighted both as "the chosen
  // one", including the listed price the ranking had deliberately refused.
  // The backend re-encodes `best`, so identity comparison is out.
  const isChosen = (e: Exit) =>
    !!leg.best &&
    leg.best.venue === e.venue &&
    leg.best.speed === e.speed &&
    leg.best.payout === e.payout &&
    leg.best.gross === e.gross
  return (
    <div className="rounded-xl border border-line bg-panel-2/40 px-3.5 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{leg.name}</span>
        <span className="text-[11px] tracking-[0.1em] text-faint uppercase">{label}</span>
      </div>
      {exits.length === 0 ? (
        <p className="text-xs text-warn">
          Ни одна площадка не готова это купить. В расчёт не попадает.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {exits.map((e, i) => (
            <ExitLine key={`${e.venue}-${e.speed}-${i}`} exit={e} chosen={isChosen(e)} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** The full buy-extract-sell arithmetic, laid out so it can be checked by hand. */
export function DealBreakdown({ deal }: { deal: Deal }) {
  const display = dealDisplay(deal)
  const rows: [string, number | null, string?][] = [
    ['Покупка лота', -deal.buy_price],
    ['Извлечение гемов', -deal.extraction_cost, `молоток × ${deal.gems.length}`],
    [display.proceedsLabel, display.proceeds],
  ]

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-line bg-panel-2/50 p-4">
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([label, value, hint]) => (
              <tr key={label} className="border-b border-line-soft/60 last:border-0">
                <td className="py-2 text-mute">
                  {label}
                  {hint && <span className="ml-2 text-[11px] text-faint">{hint}</span>}
                </td>
                <td
                  className={`py-2 text-right font-mono ${value === null ? 'text-faint' : value < 0 ? 'text-danger' : 'text-accent'}`}
                >
                  {value !== null && value > 0 ? '+' : ''}
                  {value === null ? 'недоступна' : rub(value)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-line">
              <td className="pt-3 font-medium">
                {display.resultLabel}
                <span className="ml-2 text-[11px] text-faint">
                  с вложенных {rub(deal.invested)}
                </span>
              </td>
              <td
                className={`pt-3 text-right font-mono text-lg ${
                  display.net === null ? 'text-faint' : display.net > 0 ? 'text-accent' : 'text-danger'
                }`}
              >
                {display.net === null ? (
                  <span className="text-sm">Результат и ROI недоступны</span>
                ) : (
                  <>
                    {display.net > 0 ? '+' : ''}{rub(display.net)}
                    <span className="ml-2 text-sm">{Math.round(display.roi!)}%</span>
                  </>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {display.wallet && (
        <p className="text-xs text-faint">
          Выручка, результат и ROI — оценка с учётом веса кошелька, не сумма доступных к выводу денег.
        </p>
      )}

      {(!deal.priced || !deal.complete) && (
        <div className="flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/8 px-4 py-3 text-sm text-warn">
          <BadgeAlertIcon size={17} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Расчёт неполный — это не прогноз прибыли</div>
            <ul className="mt-1 list-inside list-disc text-xs">
              {(deal.unknowns ?? []).map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-[0.14em] text-faint uppercase">
          <RoubleMark size={12} /> Куда продавать
        </h3>
        <div className="space-y-2">
          {deal.gems.map((g) => (
            <LegBlock key={g.name} leg={g} label="гем" />
          ))}
          {deal.shell && <LegBlock leg={deal.shell} label="остаток носителя" />}
        </div>
      </div>

      <p className="flex items-start gap-2 text-xs text-faint">
        <HammerMark size={13} className="mt-0.5 shrink-0" />
        Молоток берётся по цене игрового магазина: $0.99 за 15 извлечений. На маркете тот же
        молоток стоит дороже — это меняет итог по мелким сделкам.
      </p>
    </section>
  )
}
