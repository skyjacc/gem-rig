import { rub, type Finding } from '../api'
import { rarityColor } from './icons'

/**
 * Top spreads as a horizontal bar chart: the lot price and the gem value are
 * stacked on one row so the gap between them is the profit, read left to right.
 */
export function SpreadChart({
  findings,
  onPick,
}: {
  findings: Finding[]
  onPick: (f: Finding) => void
}) {
  const rows = findings.filter((f) => f.priced && f.net_spread > 0).slice(0, 8)
  if (rows.length === 0) return null

  const max = Math.max(...rows.map((f) => f.gem_value))

  return (
    <ul className="space-y-2.5">
      {rows.map((f) => {
        const color = rarityColor(f.rarity, f.name_color)
        const pricePct = (f.price / max) * 100
        const valuePct = (f.gem_value / max) * 100
        return (
          <li key={f.key}>
            <button
              onClick={() => onPick(f)}
              className="group flex w-full items-center gap-3 rounded-lg px-1 py-1 text-left transition-colors hover:bg-panel-2/60"
            >
              <span className="w-40 shrink-0 truncate text-xs" style={{ color }}>
                {f.item_name}
              </span>

              <span className="relative h-4 flex-1 overflow-hidden rounded bg-panel-3">
                <span
                  className="bar-grow absolute inset-y-0 left-0 rounded bg-accent/25"
                  style={{ width: `${valuePct}%` }}
                />
                <span
                  className="bar-grow absolute inset-y-0 left-0 rounded bg-danger/60"
                  style={{ width: `${pricePct}%` }}
                />
              </span>

              <span className="w-24 shrink-0 text-right font-mono text-xs text-accent">
                +{rub(f.net_spread)}
              </span>
            </button>
          </li>
        )
      })}
      <li className="flex items-center gap-4 pt-1 text-[11px] text-faint">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-3 rounded-sm bg-danger/60" /> цена лота
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-3 rounded-sm bg-accent/25" /> цена гема
        </span>
      </li>
    </ul>
  )
}
