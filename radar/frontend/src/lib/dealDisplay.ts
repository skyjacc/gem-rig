import type { Deal, Finding, ItemDetail } from '../api.ts'

/** Only selected exits contribute to totals; unselected wallet quotes do not. */
export function dealDisplay(deal?: Deal) {
  const wallet = !!deal && [...deal.gems, ...(deal.shell ? [deal.shell] : [])]
    .some((leg) => leg.best?.payout === 'wallet')
  return {
    wallet,
    proceeds: deal?.priced ? deal.proceeds : null,
    net: deal?.priced ? deal.net : null,
    roi: deal?.priced ? deal.roi : null,
    proceedsLabel: wallet ? 'Эквивалент выручки' : 'Выручка после комиссии',
    resultLabel: wallet ? 'Результат в эквиваленте' : 'Денежный результат',
  }
}

export type DealFilters = {
  onlyProfitable: boolean
  onlyComplete: boolean
  minNet: number
  minRoi: number
}

/** Missing prices cannot satisfy completeness or any positive money threshold. */
export function dealFilterReason(deal: Deal | undefined, filters: DealFilters) {
  if (!deal?.priced) {
    return filters.onlyProfitable || filters.onlyComplete || filters.minNet > 0 || filters.minRoi > 0
      ? 'unpriced' : null
  }
  if (filters.onlyComplete && !deal.complete) return 'incomplete'
  if (filters.onlyProfitable && deal.net <= 0) return 'loss'
  if (filters.minNet > 0 && deal.net < filters.minNet) return 'threshold'
  if (filters.minRoi > 0 && deal.roi < filters.minRoi) return 'threshold'
  return null
}

/** Preserve the original venue-specific offer, even before detail loading finishes. */
export function offerMarketURL(
  finding?: Pick<Finding, 'market_url'>,
  detail?: Pick<ItemDetail, 'market_url'> | null,
): string | undefined {
  return finding?.market_url?.trim() || detail?.market_url?.trim() || undefined
}
