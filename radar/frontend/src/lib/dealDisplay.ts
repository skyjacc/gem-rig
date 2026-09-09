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

/**
 * Whether a lot may be presented as something to buy.
 *
 * Steam describes a variant; the marketplace describes the lot it is selling.
 * A seller can hammer the gem out and leave the emptied item listed under the
 * gemmed variant's id — Steam keeps reporting the gem, truthfully, about a
 * variant the seller no longer owns. Only agreement between the two is proof,
 * and an unanswered check is not agreement.
 */
export function proofState(f: Pick<Finding, 'proof'>): {
  ok: boolean
  label: string
  tone: 'good' | 'warn' | 'bad'
  hint: string
} {
  const p = f.proof
  if (!p || !p.checked) {
    return {
      ok: false,
      label: 'не сверен',
      tone: 'warn',
      hint: 'Площадку ещё не спрашивали, что она продаёт под этим вариантом.',
    }
  }
  if (p.error) {
    return {
      ok: false,
      label: 'сверка не прошла',
      tone: 'warn',
      hint: `Площадка не ответила: ${p.error}. Это не подтверждение и не опровержение.`,
    }
  }
  if (!p.agree) {
    return {
      ok: false,
      label: 'лот не подтверждён',
      tone: 'bad',
      hint:
        p.note ??
        `Steam описывает ${(p.steam_gems ?? []).join(', ') || '—'}, площадка — ${
          (p.market_gems ?? []).join(', ') || 'ничего'
        }.`,
    }
  }
  return {
    ok: true,
    label: 'лот подтверждён',
    tone: 'good',
    hint:
      p.note ||
      'Steam и площадка называют один и тот же кинетик в этом лоте.',
  }
}

/**
 * Whether the seller is charging for the gem at all.
 *
 * A listing can be perfectly honest about its variant and still be a trap: the
 * seller hammered the gem out, sells it separately, and leaves the emptied
 * shell under the gemmed variant's id. Metadata cannot see that. The price can
 * — an empty shell is priced like the other empty shells.
 *
 * Measured live: a Diffusal Lance claiming a 557 RUB gem cost 35 kopeks more
 * than its empty siblings. Honest listings in the same sweep carried premiums
 * of 24, 37 and 79 per cent of the gem's value.
 */
export function premiumState(f: Pick<Finding, 'premium' | 'gem_value'>): {
  ok: boolean
  label: string
  tone: 'good' | 'warn' | 'bad'
  hint: string
} | null {
  const p = f.premium
  if (!p || !p.measured) return null
  const pct = Math.round(p.share * 100)
  if (p.share < 0.1) {
    return {
      ok: false,
      label: 'гем не заложен в цену',
      tone: 'bad',
      hint:
        `Лот дороже самого дешёвого другого варианта всего на ${p.amount.toFixed(2)} ₽ ` +
        `— ${pct}% от стоимости гема. Продавец, у которого гем есть, закладывает его в цену. ` +
        `Либо гема в лоте нет, либо это редкая ошибка продавца: проверяй до покупки.`,
    }
  }
  return {
    ok: true,
    label: `+${p.amount.toFixed(0)} ₽ за гем`,
    tone: 'good',
    hint:
      `Лот дороже пустого варианта на ${p.amount.toFixed(2)} ₽ — ${pct}% стоимости гема. ` +
      `Продавец гем в цену заложил, значит он у него есть.`,
  }
}
