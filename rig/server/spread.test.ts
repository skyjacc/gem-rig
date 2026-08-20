import { test } from 'node:test'
import assert from 'node:assert/strict'
import { livelyTarget, spreadPlan } from './spread.ts'

test('круглое число превращается в живое', () => {
  const v = livelyTarget(1000, 'main:BZZ')
  assert.ok(v > 1000, 'ниже заказанного не опускаемся: ' + v)
  assert.ok(v < 1400, 'и не улетаем вдвое: ' + v)
  assert.notEqual(v % 100, 0)
  assert.notEqual(v % 50, 0)
})

test('одно и то же зерно даёт одно и то же число', () => {
  assert.equal(livelyTarget(2000, 'a'), livelyTarget(2000, 'a'))
})

test('разные аккаунты останавливаются на разных числах', () => {
  assert.notEqual(livelyTarget(2000, 'main'), livelyTarget(2000, 'alt'))
})

test('уже неровное число не трогаем сильно', () => {
  const v = livelyTarget(1137, 'x')
  assert.ok(v >= 1137 && v < 1137 * 1.4)
})

test('план разброса даёт столько партий, сколько заказано', () => {
  const p = spreadPlan(1000, 3, 'BZZ')
  assert.equal(p.length, 3)
})

test('первая партия жжётся дольше всех', () => {
  const p = spreadPlan(1000, 3, 'BZZ')
  assert.equal(p[0].addAt, 0)
  assert.ok(p[0].value > p[1].value)
  assert.ok(p[1].value > p[2].value)
})

test('момент добавления — это разница с самой длинной партией', () => {
  const p = spreadPlan(1000, 3, 'BZZ')
  for (const w of p) assert.equal(w.addAt, p[0].value - w.value)
})

test('все числа разные — в этом весь смысл', () => {
  const v = spreadPlan(1000, 5, 'BZZ').map(w => w.value)
  assert.equal(new Set(v).size, v.length)
})

test('ни одно значение не круглое', () => {
  for (const w of spreadPlan(2000, 4, 'Empire')) {
    assert.notEqual(w.value % 50, 0, 'круглое: ' + w.value)
  }
})

test('одна партия — это просто живое число', () => {
  const p = spreadPlan(1000, 1, 'x')
  assert.equal(p.length, 1)
  assert.equal(p[0].addAt, 0)
  assert.equal(p[0].value, livelyTarget(1000, 'x:0'))
})

test('партий не бывает меньше одной', () => {
  assert.equal(spreadPlan(1000, 0, 'x').length, 1)
  assert.equal(spreadPlan(1000, -3, 'x').length, 1)
})

test('все партии не ниже заказанного', () => {
  for (const w of spreadPlan(1000, 6, 'z')) assert.ok(w.value >= 1000, 'ниже заказа: ' + w.value)
})

test('партии расходятся заметно, а не на восемь единиц', () => {
  const v = spreadPlan(2000, 3, 'main:2000').map(w => w.value)
  for (let i = 1; i < v.length; i++) {
    assert.ok(v[i - 1] - v[i] >= 60, 'слишком близко: ' + v.join(' '))
  }
})

test('разброс укладывается в разумную полосу', () => {
  const v = spreadPlan(1000, 4, 'x').map(w => w.value)
  assert.ok(v[0] - v[v.length - 1] < 1000 * 0.32, 'полоса разъехалась: ' + v.join(' '))
})

test('на тысяче получаются числа вроде 1023 и 1213, а не 1000', () => {
  for (const w of spreadPlan(1000, 3, 'seed')) {
    assert.ok(w.value > 1000 && w.value < 1300, w.value)
    assert.notEqual(w.value % 100, 0)
  }
})
