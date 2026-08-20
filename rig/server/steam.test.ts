import { test } from 'node:test'
import assert from 'node:assert/strict'
import { carrierOf } from './steam.ts'

// Голый самоцвет и предмет с вставленным самоцветом — разный товар.
// Голый можно вставить куда угодно позже, у предмета счётчик неотделим.
// Путать их в списке нельзя: это разные строки на витрине и разные деньги.

test('собственное имя без героя — это голый самоцвет', () => {
  assert.equal(carrierOf('Spectator: Alliance', ''), 'gem')
})

test('Genuine тоже самоцвет', () => {
  assert.equal(carrierOf('Genuine Spectator: Evil Geniuses', ''), 'gem')
})

test('предмет с героем — предмет, даже если имя похоже', () => {
  assert.equal(carrierOf('Nether Heart', 'Pugna'), 'item')
  assert.equal(carrierOf('Inscribed Primeval Staff', "Nature's Prophet"), 'item')
})

test('имя самоцвета вместе с героем означает, что он уже вставлен', () => {
  assert.equal(carrierOf('Spectator: Alliance', 'Puck'), 'item')
})

test('пробелы в имени героя не считаются героем', () => {
  assert.equal(carrierOf('Spectator: NaVi', '   '), 'gem')
})

test('пустое и мусорное не роняет разбор', () => {
  assert.equal(carrierOf('', ''), 'item')
  assert.equal(carrierOf(undefined as any, undefined as any), 'item')
})

test('регистр не важен', () => {
  assert.equal(carrierOf('spectator: navi', ''), 'gem')
})
