import { useMemo, useState } from 'react'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BadgeAlertIcon,
  ExternalLinkIcon,
  SearchIcon,
  SparklesIcon,
} from './animated'
import { ago, rub, type Deal, type Exit, type Finding } from '../api'
import { GemMark, HammerMark, rarityColor } from './icons'
import { Badge, ItemThumb, Panel } from './ui'
import { confidenceMeta, marketTone, sourceLabel } from './meta'
import { dealDisplay, dealFilterReason, proofState } from '../lib/dealDisplay'

type SortKey = 'net' | 'roi' | 'buy' | 'found_at'

/** Rows without a plan cannot be ranked on money, so they sort last. */
const dealOf = (f: Finding): Deal | undefined => f.deal

function sortValue(f: Finding, key: SortKey): number {
  const d = dealOf(f)
  switch (key) {
    case 'net':
      return d ? d.net : Number.NEGATIVE_INFINITY
    case 'roi':
      return d ? d.roi : Number.NEGATIVE_INFINITY
    case 'buy':
      return f.price
    case 'found_at':
      return Date.parse(f.found_at) || 0
  }
}

/** Where the exit price comes from, in one glance. */
function ExitBasis({ exit }: { exit?: Exit }) {
  if (!exit) return <Badge tone="bad">нет выхода</Badge>
  if (exit.speed === 'instant') {
    return (
      <Badge tone="good" title={`Заявок в стакане: ${exit.orders ?? 0}`}>
        ордер{exit.orders ? ` · ${exit.orders}` : ''}
      </Badge>
    )
  }
  return (
    <Badge tone="warn" title="Цена из объявления — покупателя ещё нужно дождаться">
      объявление
    </Badge>
  )
}

function Money({ value, sign = false }: { value: number; sign?: boolean }) {
  const tone = value > 0 ? 'text-accent' : value < 0 ? 'text-danger' : 'text-mute'
  return (
    <span className={`font-mono whitespace-nowrap ${sign ? tone : ''}`}>
      {sign && value > 0 ? '+' : ''}
      {rub(value)}
    </span>
  )
}

export type OfferFilters = {
  query: string
  minNet: number
  minRoi: number
  maxBudget: number
  market: string
  onlyProfitable: boolean
  onlyComplete: boolean
}

export const defaultFilters: OfferFilters = {
  query: '',
  minNet: 0,
  minRoi: 0,
  maxBudget: 0,
  market: 'all',
  onlyProfitable: true,
  onlyComplete: false,
}

function NumberField({
  label,
  value,
  onChange,
  suffix,
  width = 'w-20',
}: {
  label: string
  value: number
  onChange: (v: number) => void
  suffix?: string
  width?: string
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-mute">
      {label}
      <span className="flex items-center gap-1 rounded-lg border border-line bg-panel-2 px-2 py-1 focus-within:border-accent/50">
        <input
          value={value || ''}
          placeholder="0"
          inputMode="numeric"
          onChange={(e) => onChange(Number(e.target.value.replace(/[^\d]/g, '')) || 0)}
          className={`${width} bg-transparent font-mono text-xs text-text outline-none placeholder:text-faint`}
        />
        {suffix && <span className="text-faint">{suffix}</span>}
      </span>
    </label>
  )
}

export function Offers({
  findings,
  freshKeys,
  onOpen,
  filters,
  setFilters,
}: {
  findings: Finding[]
  freshKeys: Set<string>
  onOpen: (f: Finding, siblings?: Finding[]) => void
  filters: OfferFilters
  setFilters: (f: OfferFilters) => void
}) {
  const [sort, setSort] = useState<SortKey>('net')
  const [desc, setDesc] = useState(true)

  const markets = useMemo(
    () => Array.from(new Set(findings.map((f) => f.source).filter(Boolean))).sort(),
    [findings],
  )

  const { rows, hiddenLoss, awaiting } = useMemo(() => {
    const needle = filters.query.trim().toLowerCase()
    let hiddenLoss = 0
    let awaiting = 0

    const kept = findings.filter((f) => {
      const d = dealOf(f)
      if (!d || !d.priced) awaiting += 1
      if (filters.market !== 'all' && f.source !== filters.market) return false
      if (filters.maxBudget > 0 && f.price > filters.maxBudget) return false
      if (needle) {
        const hay = [f.item_name, f.hero_name, ...f.gems].join(' ').toLowerCase()
        if (!hay.includes(needle)) return false
      }
      const reason = dealFilterReason(d, filters)
      if (reason === 'loss') hiddenLoss += 1
      return reason === null
    })

    kept.sort((a, b) => {
      if (sort === 'net' || sort === 'roi') {
        const aPriced = !!a.deal?.priced
        const bPriced = !!b.deal?.priced
        if (aPriced !== bPriced) return aPriced ? -1 : 1
        if (!aPriced) return 0
      }
      const av = sortValue(a, sort)
      const bv = sortValue(b, sort)
      return desc ? bv - av : av - bv
    })
    return { rows: kept, hiddenLoss, awaiting }
  }, [findings, filters, sort, desc])

  const hasWallet = rows.some((f) => f.deal?.priced && dealDisplay(f.deal).wallet)

  const toggleSort = (key: SortKey) => {
    if (key === sort) setDesc((d) => !d)
    else {
      setSort(key)
      setDesc(true)
    }
  }

  const Arrow = ({ active }: { active: boolean }) =>
    !active ? null : desc ? (
      <ArrowDownIcon size={12} className="inline-block text-accent" />
    ) : (
      <ArrowUpIcon size={12} className="inline-block text-accent" />
    )

  const th = (key: SortKey, label: string) => (
    <th className="px-3 py-2.5 text-right font-medium">
      <button
        onClick={() => toggleSort(key)}
        className="inline-flex items-center gap-1 tracking-[0.1em] uppercase transition-colors hover:text-text"
      >
        {label} <Arrow active={sort === key} />
      </button>
    </th>
  )

  return (
    <Panel
      title={`Выгодные офферы — ${rows.length}`}
      subtitle={hasWallet
        ? 'итог и ROI — оценка в эквиваленте; кошелёк Steam не выводится в деньги'
        : 'основание цены выхода указано в строке: ордер или объявление'}
      bodyClass="p-0"
      action={
        <label className="group flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 focus-within:border-accent/50">
          <SearchIcon size={15} className="text-faint" />
          <input
            value={filters.query}
            onChange={(e) => setFilters({ ...filters, query: e.target.value })}
            placeholder="предмет, гем, герой"
            className="w-44 bg-transparent text-sm outline-none placeholder:text-faint"
          />
        </label>
      }
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line-soft px-5 py-3">
        <NumberField
          label="прибыль от"
          value={filters.minNet}
          suffix="₽"
          onChange={(v) => setFilters({ ...filters, minNet: v })}
        />
        <NumberField
          label="ROI от"
          value={filters.minRoi}
          suffix="%"
          width="w-14"
          onChange={(v) => setFilters({ ...filters, minRoi: v })}
        />
        <NumberField
          label="бюджет до"
          value={filters.maxBudget}
          suffix="₽"
          onChange={(v) => setFilters({ ...filters, maxBudget: v })}
        />

        {markets.length > 1 && (
          <div className="flex items-center gap-1 rounded-lg border border-line bg-panel-2 p-0.5">
            {['all', ...markets].map((m) => (
              <button
                key={m}
                onClick={() => setFilters({ ...filters, market: m })}
                className={`rounded px-2 py-1 text-xs transition-colors ${
                  filters.market === m ? 'bg-panel-3 text-text' : 'text-mute hover:text-text'
                }`}
              >
                {m === 'all' ? 'все площадки' : sourceLabel(m)}
              </button>
            ))}
          </div>
        )}

        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-mute select-none">
          <input
            type="checkbox"
            checked={filters.onlyProfitable}
            onChange={(e) => setFilters({ ...filters, onlyProfitable: e.target.checked })}
            className="accent-accent"
          />
          только прибыльные
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-mute select-none">
          <input
            type="checkbox"
            checked={filters.onlyComplete}
            onChange={(e) => setFilters({ ...filters, onlyComplete: e.target.checked })}
            className="accent-accent"
          />
          только полный расчёт
        </label>

        <span className="ml-auto text-xs text-faint">
          {hiddenLoss > 0 && `скрыто убыточных: ${hiddenLoss}`}
          {hiddenLoss > 0 && awaiting > 0 && ' · '}
          {awaiting > 0 && `ждут расчёта: ${awaiting}`}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="px-5 py-12 text-center">
          <HammerMark size={26} className="mx-auto mb-3 text-faint" />
          <p className="text-sm text-mute">
            {findings.length === 0
              ? 'Радар обходит каталог. Оффер появится, когда найдётся предмет с гемом, который можно продать дороже покупки.'
              : 'Под эти фильтры ничего не подходит. Ослабь порог прибыли или сними «только прибыльные».'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-sm">
            <thead>
              <tr className="border-b border-line-soft text-[11px] tracking-[0.1em] text-faint uppercase">
                <th className="px-5 py-2.5 text-left font-medium">Предмет и гем</th>
                <th className="px-3 py-2.5 text-left font-medium">Где купить</th>
                {th('buy', 'Покупка')}
                <th className="px-3 py-2.5 text-left font-medium">Продать</th>
                <th className="px-3 py-2.5 text-right font-medium">Выход</th>
                <th className="px-3 py-2.5 text-right font-medium">Расходы</th>
                {th('net', hasWallet ? 'Итог / эквивалент' : 'Денежный итог')}
                {th('roi', hasWallet ? 'ROI / экв.' : 'ROI')}
                <th className="px-5 py-2.5 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => {
                const d = dealOf(f)
                const color = rarityColor(f.rarity, f.name_color)
                const gemExit = d?.gems.find((g) => g.best)?.best
                const display = dealDisplay(d)
                const conf = confidenceMeta[f.confidence]
                const proof = proofState(f)

                return (
                  <tr
                    key={f.key}
                    tabIndex={0}
                    role="button"
                    aria-label={`${f.item_name} — открыть расчёт`}
                    onClick={() => onOpen(f, rows)}
                    // The whole deal breakdown was mouse-only: the sole tab
                    // stop in a row was the «Открыть оффер» link, which leaves
                    // the app. The guard keeps Enter on that link from doing
                    // both things at once — it stops click propagation but not
                    // keydown.
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onOpen(f, rows)
                      }
                    }}
                    className={`cursor-pointer border-b border-line-soft/60 align-middle transition-colors last:border-0 hover:bg-panel-2/50 ${
                      freshKeys.has(f.key) ? 'row-fresh' : ''
                    }`}
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <ItemThumb src={f.icon_url} alt={f.item_name} color={color} size={38} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-medium" style={{ color }}>
                              {f.item_name}
                            </span>
                            {freshKeys.has(f.key) && (
                              <SparklesIcon size={13} className="shrink-0 text-accent" />
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1">
                            {f.gems.map((g) => (
                              <span
                                key={g}
                                className="inline-flex items-center gap-1 text-[11px] text-accent"
                              >
                                <GemMark size={10} />
                                {g}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="px-3 py-3">
                      <div className="flex flex-col items-start gap-1">
                        <Badge tone={marketTone[f.source] ?? 'default'}>
                          {sourceLabel(f.source)}
                        </Badge>
                        {/* Whether the marketplace confirms the lot it is
                            selling actually holds the gem Steam describes. */}
                        <Badge tone={proof.tone} title={proof.hint}>
                          {proof.label}
                        </Badge>
                        <span className="text-[11px] text-faint">{ago(f.found_at)}</span>
                      </div>
                    </td>

                    <td className="px-3 py-3 text-right">
                      <Money value={f.price} />
                      {f.lock_days > 0 && (
                        <div className="mt-0.5 text-[11px] text-warn">lock {f.lock_days}д</div>
                      )}
                    </td>

                    <td className="px-3 py-3">
                      {gemExit ? (
                        <div className="flex flex-col items-start gap-1">
                          <Badge tone={marketTone[gemExit.venue] ?? 'default'}>
                            {sourceLabel(gemExit.venue)}
                          </Badge>
                          <ExitBasis exit={gemExit} />
                        </div>
                      ) : (
                        <span className="text-xs text-faint">—</span>
                      )}
                    </td>

                    <td className="px-3 py-3 text-right">
                      {d?.priced ? (
                        <>
                          <Money value={display.proceeds!} />
                          <div className="mt-0.5 text-[11px] text-faint">
                            {display.wallet ? 'эквивалент · есть кошелёк' : 'деньги после комиссии'}
                          </div>
                        </>
                      ) : (
                        <span className="text-xs text-faint">считается…</span>
                      )}
                    </td>

                    <td className="px-3 py-3 text-right">
                      {d ? (
                        <>
                          <Money value={d.extraction_cost} />
                          <div className="mt-0.5 text-[11px] text-faint">
                            молоток ×{d.gems.length}
                          </div>
                        </>
                      ) : (
                        <span className="text-xs text-faint">—</span>
                      )}
                    </td>

                    <td className="px-3 py-3 text-right">
                      {d && !d.priced ? (
                        <span className="text-xs text-faint">ждёт стакан</span>
                      ) : d ? (
                        <div className="flex flex-col items-end gap-1">
                          <span className="text-[15px]">
                            <Money value={d.net} sign />
                          </span>
                          {display.wallet && <span className="text-[11px] text-faint">оценка в эквиваленте</span>}
                          {d.optimistic ? (
                            <Badge tone="warn" title={(d.unknowns ?? []).join('; ')}>
                              <BadgeAlertIcon size={11} /> по объявлению
                            </Badge>
                          ) : (
                            !d.complete && (
                              <Badge tone="warn" title={(d.unknowns ?? []).join('; ')}>
                                <BadgeAlertIcon size={11} /> неполный
                              </Badge>
                            )
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-faint">ждёт стакан</span>
                      )}
                    </td>

                    <td className="px-3 py-3 text-right">
                      <div className="flex flex-col items-end gap-1">
                        {d?.priced ? (
                          <Badge tone={d.roi >= 50 ? 'good' : d.roi > 0 ? 'info' : 'bad'}>
                            {Math.round(d.roi)}%
                          </Badge>
                        ) : (
                          <span className="text-xs text-faint">—</span>
                        )}
                        <Badge tone={conf.tone} title={conf.hint}>
                          {conf.label}
                        </Badge>
                      </div>
                    </td>

                    <td className="px-5 py-3 text-right">
                      <a
                        href={f.market_url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="group inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-xs font-medium whitespace-nowrap text-accent transition-colors hover:bg-accent/20"
                      >
                        Открыть оффер <ExternalLinkIcon size={13} />
                      </a>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
