import type { Confidence } from '../api'

/** How a valuation's trustworthiness is presented across the dashboard. */
export const confidenceMeta: Record<
  Confidence,
  { label: string; tone: 'good' | 'info' | 'warn' | 'bad'; hint: string }
> = {
  high: {
    label: 'надёжно',
    tone: 'good',
    hint: 'Есть реальная сделка, либо три и более рынка сходятся в цене',
  },
  medium: {
    label: 'средне',
    tone: 'info',
    hint: 'Два рынка, расхождение до трёх раз',
  },
  low: {
    label: 'слабо',
    tone: 'warn',
    hint: 'Один источник или рынки сильно расходятся — цена может быть выдумкой продавца',
  },
  none: {
    label: 'нет цены',
    tone: 'bad',
    hint: 'Ни один рынок не знает, сколько стоит этот гем',
  },
}

const SOURCE_LABELS: Record<string, string> = {
  'tm.net': 'market.dota2.net',
  'tm.net:orders': 'market.dota2.net · стаканы',
  dmarket: 'DMarket',
  steam: 'Steam',
  waxpeer: 'Waxpeer',
  lootfarm: 'LOOT.Farm',
  'lis-skins': 'Lis-Skins',
}

export function sourceLabel(name: string): string {
  return SOURCE_LABELS[name] ?? name
}

/** Marketplace badge colour for the findings table. */
export const marketTone: Record<string, 'info' | 'violet' | 'default'> = {
  'tm.net': 'info',
  dmarket: 'violet',
}

/** How each journal event kind reads to a person, and how loud it should look. */
export const kindMeta: Record<
  string,
  { label: string; tone: 'good' | 'info' | 'warn' | 'bad' | 'default' }
> = {
  'sweep.start': { label: 'обход начат', tone: 'default' },
  'sweep.done': { label: 'обход завершён', tone: 'default' },
  'finding.added': { label: 'лот появился', tone: 'good' },
  'finding.removed': { label: 'лот пропал', tone: 'warn' },
  'finding.repriced': { label: 'цена изменилась', tone: 'info' },
  'deal.priced': { label: 'расчёт готов', tone: 'good' },
  'deal.incomplete': { label: 'расчёт неполный', tone: 'warn' },
  'orderbook.fetched': { label: 'стаканы обновлены', tone: 'default' },
  'orderbook.failed': { label: 'стакан не прочитан', tone: 'bad' },
  'source.refreshed': { label: 'источник обновлён', tone: 'default' },
  'source.failed': { label: 'источник отвалился', tone: 'bad' },
  'guard.checked': { label: 'обмен проверен', tone: 'info' },
  'settings.changed': { label: 'настройки', tone: 'info' },
  'api.error': { label: 'ошибка API', tone: 'bad' },
}

/** Why something happened, in plain words. */
export const reasonMeta: Record<string, string> = {
  new_lot: 'впервые увидели лот с подтверждённым гемом',
  delisted: 'лот исчез из каталога — куплен, снят или подорожал выше потолка',
  above_price_cap: 'цена выше потолка сканирования',
  below_min_spread: 'гем перестал перекрывать цену лота',
  price_changed: 'продавец изменил цену',
  gem_unpriced: 'ни один рынок не знает цену гема',
  no_order_book: 'нет стакана для выхода',
  restored: 'поднято из сохранённого состояния',
}

export const levelTone: Record<string, string> = {
  debug: 'text-faint',
  info: 'text-mute',
  warn: 'text-warn',
  error: 'text-danger',
}

/**
 * A journal event's extra fields, ready to print.
 *
 * Go marshals an absent slice as `null`, which reached the screen as the word
 * "null" sitting next to a perfectly successful calculation and reading like a
 * failure. Empty values are dropped, and a list is joined with spaces after
 * the commas so a long `unknowns` stays legible.
 */
export function journalFields(fields?: Record<string, unknown>): [string, string][] {
  if (!fields) return []
  const out: [string, string][] = []
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === '') continue
    if (Array.isArray(v)) {
      if (v.length === 0) continue
      out.push([k, v.join(', ')])
      continue
    }
    out.push([k, typeof v === 'object' ? JSON.stringify(v) : String(v)])
  }
  return out
}
