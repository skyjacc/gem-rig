import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLimiter, type Clock } from './ratelimit.ts'

// Часы стоят на месте, сон ничего не ждёт: проверяем расписание,
// а не реальное время — тесты идут мгновенно.
const frozen = (t = 1_000): Clock => ({ now: () => t, sleep: async () => {} })

test('параллельные запросы одного ключа разводятся по 250 мс', async () => {
  const lim = createLimiter(4, frozen())
  const at = await Promise.all(Array.from({ length: 6 }, () => lim.take('k')))
  assert.deepEqual(at, [1000, 1250, 1500, 1750, 2000, 2250])
})

test('в любую секунду — не больше четырёх запросов', async () => {
  const lim = createLimiter(4, frozen())
  const at = await Promise.all(Array.from({ length: 40 }, () => lim.take('k')))
  for (const s of at) assert.ok(at.filter(x => x >= s && x < s + 1000).length <= 4)
})

test('разные ключи друг друга не ждут', async () => {
  const lim = createLimiter(4, frozen())
  const [a, b] = await Promise.all([lim.take('a'), lim.take('b')])
  assert.equal(a, 1000)
  assert.equal(b, 1000)
})

test('после паузы очередь не копится — запрос идёт сразу', async () => {
  let t = 1000
  const lim = createLimiter(4, { now: () => t, sleep: async () => {} })
  await lim.take('k')
  t = 10_000
  assert.equal(await lim.take('k'), 10_000)
})

test('«слишком часто» отодвигает следующий запрос', async () => {
  const lim = createLimiter(4, frozen())
  await lim.take('k')
  lim.cool('k', 5000)
  assert.equal(await lim.take('k'), 6000)
})

test('ждёт ровно до своего окна', async () => {
  const slept: number[] = []
  const lim = createLimiter(4, { now: () => 1000, sleep: async ms => { slept.push(ms) } })
  await Promise.all([lim.take('k'), lim.take('k'), lim.take('k')])
  assert.deepEqual(slept, [250, 500])
})
