import test from 'node:test'
import assert from 'node:assert/strict'
import { dealDisplay, dealFilterReason, offerMarketURL } from '../src/lib/dealDisplay.ts'

const cash = { venue: 'market', payout: 'cash', net: 180, weighted: 180 }
const wallet = { venue: 'steam', payout: 'wallet', net: 300, weighted: 150 }
const deal = (overrides = {}) => ({
  buy_price: 100, extraction_cost: 10, invested: 110,
  gems: [{ name: 'gem', exits: [cash, wallet], best: cash }],
  proceeds: 180, net: 70, roi: 63.6,
  priced: true, complete: true, optimistic: false, ...overrides,
})
const filters = { onlyProfitable: false, onlyComplete: false, minNet: 0, minRoi: 0 }

test('original DMarket offer wins over generic detail market URL, including while loading', () => {
  const finding = { market_url: 'https://dmarket.com/offer/123' }
  const detail = { market_url: 'https://market.dota2.net/item/456' }
  assert.equal(offerMarketURL(finding, detail), finding.market_url)
  assert.equal(offerMarketURL(finding, null), finding.market_url)
  assert.equal(offerMarketURL(undefined, detail), detail.market_url)
  assert.equal(offerMarketURL({ market_url: ' ' }, detail), detail.market_url)
  assert.equal(offerMarketURL(undefined, null), undefined)
  assert.equal(offerMarketURL({ market_url: '' }, { market_url: '' }), undefined)
})

test('unpriced and missing deals require every price-dependent filter to be off', () => {
  for (const candidate of [undefined, deal({ priced: false, complete: true, net: 999, roi: 999 })]) {
    for (const onlyProfitable of [false, true]) {
      for (const onlyComplete of [false, true]) {
        for (const minNet of [0, 1]) {
          for (const minRoi of [0, 1]) {
            const input = { onlyProfitable, onlyComplete, minNet, minRoi }
            assert.equal(dealFilterReason(candidate, input),
              onlyProfitable || onlyComplete || minNet || minRoi ? 'unpriced' : null)
          }
        }
      }
    }
  }
})

test('priced deals respect completeness, profitability and inclusive thresholds', () => {
  assert.equal(dealFilterReason(deal({ complete: false }), { ...filters, onlyComplete: true }), 'incomplete')
  assert.equal(dealFilterReason(deal({ net: 0 }), { ...filters, onlyProfitable: true }), 'loss')
  assert.equal(dealFilterReason(deal({ net: -1 }), filters), null)
  assert.equal(dealFilterReason(deal(), { ...filters, minNet: 70, minRoi: 63.6 }), null)
  assert.equal(dealFilterReason(deal(), { ...filters, minNet: 71 }), 'threshold')
  assert.equal(dealFilterReason(deal(), { ...filters, minRoi: 64 }), 'threshold')
})

test('unpriced results are unavailable, not a fabricated loss or zero proceeds', () => {
  for (const candidate of [undefined, deal({ priced: false, proceeds: 0, net: -110, roi: -100 })]) {
    const display = dealDisplay(candidate)
    assert.equal(display.proceeds, null)
    assert.equal(display.net, null)
    assert.equal(display.roi, null)
  }
  const zero = dealDisplay(deal({ proceeds: 110, net: 0, roi: 0 }))
  assert.equal(zero.net, 0)
  assert.equal(zero.roi, 0)
})

test('cash totals ignore unselected Steam wallet quotes', () => {
  const display = dealDisplay(deal())
  assert.equal(display.wallet, false)
  assert.equal(display.resultLabel, 'Денежный результат')
  assert.equal(display.proceeds, 180)
})

test('wallet totals use actual selected payout types, including shell and zero weighting', () => {
  for (const candidate of [
    deal({ gems: [{ name: 'gem', best: wallet }], proceeds: 150 }),
    deal({ shell: { name: 'shell', best: { ...wallet, weighted: 0 } } }),
    deal({ gems: [{ name: 'gem', best: { ...wallet, venue: 'another-venue' } }] }),
  ]) {
    const display = dealDisplay(candidate)
    assert.equal(display.wallet, true)
    assert.equal(display.proceedsLabel, 'Эквивалент выручки')
    assert.equal(display.resultLabel, 'Результат в эквиваленте')
    assert.equal(display.proceeds, candidate.proceeds)
  }
  assert.equal(dealDisplay(deal({ gems: [{ best: { ...cash, venue: 'steam' } }] })).wallet, false)
})
