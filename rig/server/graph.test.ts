import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coEdges } from './graph.ts'

const sets = new Map<string, string[]>([
  ['A', ['1', '2', '3']],
  ['B', ['2', '3', '4']],
  ['C', ['9']],
])

test('ребро — это число общих матчей', () => {
  const ab = coEdges(sets).find(x => x.a === 'A' && x.b === 'B')!
  assert.equal(ab.shared, 2)
})

test('без общих матчей ребра нет — иначе граф превращается в кашу', () => {
  assert.equal(coEdges(sets).find(x => x.a === 'C' || x.b === 'C'), undefined)
})

test('каждая пара считается один раз', () => {
  assert.equal(coEdges(sets).length, 1)
})

test('сущность не соединяется сама с собой', () => {
  assert.equal(coEdges(new Map([['A', ['1', '1', '2']]])).length, 0)
})

test('повторы внутри набора не раздувают пересечение', () => {
  const e = coEdges(new Map([['A', ['1', '1', '2']], ['B', ['1', '1']]]))
  assert.equal(e[0].shared, 1)
})

test('рёбра идут от самого жирного пересечения', () => {
  const e = coEdges(new Map([
    ['A', ['1', '2', '3']],
    ['B', ['1']],
    ['C', ['1', '2', '3']],
  ]))
  assert.equal(e[0].shared, 3)
  assert.deepEqual([e[0].a, e[0].b].sort(), ['A', 'C'])
})

test('пустой вход не роняет', () => {
  assert.deepEqual(coEdges(new Map()), [])
})
