import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windows, WINDOW_DAYS } from './markethistory.ts'

const DAY = 86_400

test('период режется на окна не длиннее 7 суток, без дыр и наложений', () => {
  const from = 1_790_000_000
  const to = from + 30 * DAY + 123
  const w = windows(from, to)
  assert.equal(w.length, 5)
  assert.equal(w[0].from, from)
  assert.equal(w[w.length - 1].to, to)
  for (const x of w) assert.ok(x.to - x.from <= WINDOW_DAYS * DAY && x.to > x.from)
  for (let i = 1; i < w.length; i++) assert.equal(w[i].from, w[i - 1].to)
})

test('ровно 7 суток — одно окно; пустой и обратный период — ни одного', () => {
  assert.deepEqual(windows(0, 7 * DAY), [{ from: 0, to: 7 * DAY }])
  assert.deepEqual(windows(10, 10), [])
  assert.deepEqual(windows(20, 10), [])
})

test('дробные секунды отбрасываются', () => {
  assert.deepEqual(windows(1.9, 5.2), [{ from: 1, to: 5 }])
})
