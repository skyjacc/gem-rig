import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSet, pieceKey } from './itemset.ts'

// Steam кладёт набор прямо в описание предмета:
//   Used By: <герой>
//   <название набора>        цветом #9da1a9
//   <часть>                  цветом #6c7075
//   <часть>
//
// Гадать по общему куску имени нельзя: у «Nether Heart» и «Nether Lord's Cape»
// общее слово есть, а у «Nether Beetle» и «Offhand Nether Wand» — уже нет.

const D = (v: string, color?: string) => ({ value: v, color })

test('название набора и его состав', () => {
  const s = parseSet([
    D('Used By: Chen'),
    D('Wings of Obelis', '9da1a9'),
    D('Wings of Obelis Shoulders', '6c7075'),
    D('Wings of Obelis Arms', '6c7075'),
    D('Wings of Obelis Staff', '6c7075'),
  ])
  assert.equal(s.name, 'Wings of Obelis')
  assert.equal(s.pieces.length, 3)
  assert.ok(s.pieces.includes('Wings of Obelis Staff'))
})

test('«Styles:» — не название набора', () => {
  const s = parseSet([
    D('Used By: Nyx Assassin'),
    D('Styles:', '9da1a9'),
    D('Shadow Spine (Yellow)', '9da1a9'),
    D('Shadow Spine (Blue) (Locked)', 'ff4040'),
    D('Shadow Hunter', '9da1a9'),
    D('Shadow Calvaria', '6c7075'),
    D('Shadow Tracers', '6c7075'),
  ])
  assert.equal(s.name, 'Shadow Hunter')
  assert.deepEqual(s.pieces, ['Shadow Calvaria', 'Shadow Tracers'])
})

test('предмет вне набора', () => {
  const s = parseSet([D('Used By: Pugna'), D('( Not Tradable )')])
  assert.equal(s.name, '')
  assert.deepEqual(s.pieces, [])
})

test('пустое описание не роняет разбор', () => {
  assert.deepEqual(parseSet([]), { name: '', pieces: [] })
  assert.deepEqual(parseSet(undefined as any), { name: '', pieces: [] })
})

test('разметка вырезается', () => {
  const s = parseSet([
    D('<b>Wings of Obelis</b>', '9da1a9'),
    D('Wings of Obelis Arms', '6c7075'),
  ])
  assert.equal(s.name, 'Wings of Obelis')
})

test('берётся последнее название перед составом, а не первое попавшееся', () => {
  const s = parseSet([
    D('Styles:', '9da1a9'),
    D('что-то', '9da1a9'),
    D('Настоящий набор', '9da1a9'),
    D('Часть первая', '6c7075'),
  ])
  assert.equal(s.name, 'Настоящий набор')
})

// ── качественные приставки ──
//
// В инвентаре лежит «Inscribed Primeval Staff», а в составе набора Steam
// пишет «Primeval Staff». Из-за этого три набора считались неполными,
// хотя все части на месте: не хватало якобы посоха, который есть.

test('приставка качества не мешает узнать часть', () => {
  assert.equal(pieceKey('Inscribed Primeval Staff'), pieceKey('Primeval Staff'))
  assert.equal(pieceKey('Genuine Nether Wand'), pieceKey('Nether Wand'))
  assert.equal(pieceKey('Autographed Shadow Claws'), pieceKey('Shadow Claws'))
})

test('приставка снимается только в начале', () => {
  assert.notEqual(pieceKey('Staff of Inscribed Light'), pieceKey('Staff of Light'))
})

test('регистр и лишние пробелы не важны', () => {
  assert.equal(pieceKey('  inscribed   Primeval Staff '), pieceKey('Primeval Staff'))
})

test('обычное имя остаётся собой', () => {
  assert.equal(pieceKey('Nether Heart'), 'nether heart')
})
