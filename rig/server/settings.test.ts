import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, merge } from './settings.ts'

test('пустая правка ничего не меняет', () => {
  assert.deepEqual(merge(DEFAULTS, {}), DEFAULTS)
})

test('меняется только то, что прислали', () => {
  const s = merge(DEFAULTS, { goal: 1500 })
  assert.equal(s.goal, 1500)
  assert.equal(s.tick, DEFAULTS.tick)
})

test('вложенное правится по полю, а не целиком', () => {
  const s = merge(DEFAULTS, { pace: { floor: 800 } })
  assert.equal(s.pace.floor, 800)
  assert.equal(s.pace.ceil, DEFAULTS.pace.ceil, 'остальное на месте')
})

// Отправщик не принимает из файла значение ниже пятисот вовсе
// (tools/gcwatch/lib.js, effectiveDelay) и молча остаётся на прежнем темпе.
// Пол ниже пятисот означал бы, что панель показывает паузу, которой нет.
test('пол паузы не опускается ниже того, что примет отправщик', () => {
  assert.equal(merge(DEFAULTS, { pace: { floor: 300 } }).pace.floor, 500)
  assert.equal(merge(DEFAULTS, { pace: { floor: 499 } }).pace.floor, 500)
  assert.equal(merge(DEFAULTS, { pace: { floor: 500 } }).pace.floor, 500)
})

test('мусор отбрасывается, а не роняет настройки', () => {
  const s = merge(DEFAULTS, { goal: 'много', tick: null, pace: 'быстро' } as any)
  assert.deepEqual(s, DEFAULTS)
})

test('значения зажимаются в разумные пределы', () => {
  assert.equal(merge(DEFAULTS, { goal: 0 }).goal, 1)
  assert.equal(merge(DEFAULTS, { goal: 999_999 }).goal, 100_000)
  assert.equal(merge(DEFAULTS, { pace: { floor: 10 } }).pace.floor, 500)
  assert.equal(merge(DEFAULTS, { tick: 1 }).tick, 5_000)
})

test('пауза не может быть ниже пола', () => {
  const s = merge(DEFAULTS, { pace: { floor: 900, ceil: 500 } })
  assert.ok(s.pace.ceil >= s.pace.floor, 'потолок ниже пола — бессмыслица')
})

test('доля молчаний — это доля, а не проценты', () => {
  assert.equal(merge(DEFAULTS, { pace: { clean: 50 } }).pace.clean, 1)
  assert.equal(merge(DEFAULTS, { pace: { clean: -1 } }).pace.clean, 0)
})

test('неизвестные поля не попадают в настройки', () => {
  const s = merge(DEFAULTS, { чтоНибудь: 1 } as any)
  assert.equal((s as any).чтоНибудь, undefined)
})

test('исходные настройки не портятся правкой', () => {
  const before = JSON.stringify(DEFAULTS)
  merge(DEFAULTS, { goal: 5, pace: { floor: 999 } })
  assert.equal(JSON.stringify(DEFAULTS), before)
})
