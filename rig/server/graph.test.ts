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

// Имена сущностей бывают из нескольких слов: «Evil Geniuses», «Team Liquid»,
// «Beyond the Summit». Ключом пары раньше была склейка через пробел, а концы
// восстанавливались через split(' ') — и ребро возвращалось как «Evil»
// и «Geniuses». Узлов с такими именами нет, поэтому связь просто исчезала
// с полотна: граф молча терял ровно те пары, ради которых он и нужен.
test('многословные имена не разваливаются на слова', () => {
  const e = coEdges(new Map([
    ['Evil Geniuses', ['1', '2']],
    ['Team Liquid', ['1', '2']],
  ]))
  assert.equal(e.length, 1)
  assert.equal(e[0].a, 'Evil Geniuses')
  assert.equal(e[0].b, 'Team Liquid')
  assert.equal(e[0].shared, 2)
})

// Ключ пары обязан быть обратимым. При склейке через разделитель «A B» + «C»
// и «A» + «B C» дают одну и ту же строку, и два разных ребра сливаются
// в одно с удвоенным весом.
test('пары не слипаются, даже если склейка имён совпадает', () => {
  const e = coEdges(new Map([
    ['A B', ['1']],
    ['C', ['1']],
    ['A', ['2']],
    ['B C', ['2']],
  ]))
  assert.equal(e.length, 2)
  assert.equal(e.every(x => x.shared === 1), true)
  assert.deepEqual(
    e.map(x => x.a + ' + ' + x.b).sort(),
    ['A + B C', 'A B + C'],
  )
})
