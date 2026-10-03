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

// Часы, которые идут только во сне, и сон, который кончается не сразу:
// между бронью окна и отправкой успевает прийти чужой ответ 429.
function sleepy(start = 1000) {
  let t = start
  const clock: Clock = {
    now: () => t,
    sleep: ms => {
      const until = t + ms
      return new Promise(resolve => setImmediate(() => { t = Math.max(t, until); resolve() }))
    },
  }
  return { clock, now: () => t }
}

test('429 останавливает и те запросы, что уже ждут своего окна', async () => {
  const { clock, now } = sleepy()
  const lim = createLimiter(4, clock)
  const sent: number[] = []
  await lim.run('k', () => sent.push(now()))           // A ушёл в 1000
  const b = lim.run('k', () => sent.push(now()))       // B забронировал 1250 и спит
  const c = lim.run('k', () => sent.push(now()))       // C забронировал 1500 и спит
  lim.cool('k', 5000)                                  // A получил 429: тишина до 6000
  await Promise.all([b, c])
  // Контракт — тишина и частота, а не точное расписание: порядок ждущих
  // после паузы ограничитель не обещает.
  assert.equal(sent.length, 3)
  assert.equal(sent[0], 1000)
  for (const s of sent.slice(1)) assert.ok(s >= 6000, 'ушёл во время паузы: ' + s)
  const after = sent.slice(1).sort((x, y) => x - y)
  assert.ok(after[1] - after[0] >= 250, 'после паузы чаще четырёх в секунду: ' + after)
})

test('run отправляет сразу после проверки и отдаёт ответ отправки', async () => {
  const lim = createLimiter(4, frozen())
  assert.equal(await lim.run('k', () => 'ответ'), 'ответ')
})

test('ждёт ровно до своего окна', async () => {
  const slept: number[] = []
  const lim = createLimiter(4, { now: () => 1000, sleep: async ms => { slept.push(ms) } })
  await Promise.all([lim.take('k'), lim.take('k'), lim.take('k')])
  assert.deepEqual(slept, [250, 500])
})
