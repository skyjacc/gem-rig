import { test, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { balance, buyOne, buyInfo, marketLimiter, operationHistory } from './market.ts'

// Настоящая площадка не трогается: fetch подменён, ограничитель не ждёт.
const KEY = 'SECRET-KEY-123'
let seen: { url: string; headers: Record<string, string> }[] = []

function answer(status: number, body: string) {
  seen = []
  mock.method(globalThis, 'fetch', async (url: unknown, init?: { headers?: Record<string, string> }) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} })
    return new Response(body, { status })
  })
}

beforeEach(() => {
  mock.restoreAll()
  mock.method(marketLimiter, 'run', async (_key: string, send: () => unknown) => send())
  mock.method(marketLimiter, 'cool', () => {})
})

test('ключ уходит заголовком X-API-KEY, а не в адресе', async () => {
  answer(200, '{"success":true}')
  await balance(KEY)
  assert.equal(seen.length, 1)
  assert.ok(!seen[0].url.includes(KEY), 'ключ в адресе: ' + seen[0].url)
  assert.equal(seen[0].headers['X-API-KEY'], KEY)
})

test('параметры покупки остаются в адресе, ключа там нет', async () => {
  answer(200, '{"success":true}')
  await buyOne(KEY, 'Spectator: Alliance', 0.03, 'USD', 'gt-1')
  const u = new URL(seen[0].url)
  assert.equal(u.pathname, '/api/v2/buy')
  assert.equal(u.searchParams.get('hash_name'), 'Spectator: Alliance')
  assert.equal(u.searchParams.get('custom_id'), 'gt-1')
  assert.ok(u.searchParams.get('price'))
  assert.equal(u.searchParams.get('key'), null)
})

test('каждый вызов уходит через ограничитель с этим ключом', async () => {
  answer(200, '{"success":true}')
  await balance(KEY)
  await buyOne(KEY, 'Spectator: Alliance', 0.03, 'USD', 'gt-2')
  const run = marketLimiter.run as unknown as { mock: { calls: { arguments: unknown[] }[] } }
  assert.equal(run.mock.calls.length, 2)
  assert.deepEqual(run.mock.calls.map(c => c.arguments[0]), [KEY, KEY])
})

test('запрос к площадке отправляет сам ограничитель, а не код мимо него', async () => {
  answer(200, '{"success":true}')
  mock.method(marketLimiter, 'run', async () => new Response('{"success":true,"held":true}'))
  const r: any = await balance(KEY)
  assert.equal(seen.length, 0, 'fetch вызван мимо ограничителя')
  assert.equal(r.held, true)
})

test('проверка покупки по custom_id: ключ заголовком, custom_id в адресе', async () => {
  answer(200, '{"success":false,"error":"not found"}')
  const r: any = await buyInfo(KEY, 'gt-1-1')
  const u = new URL(seen[0].url)
  assert.equal(u.pathname, '/api/v2/get-buy-info-by-custom-id')
  assert.equal(u.searchParams.get('custom_id'), 'gt-1-1')
  assert.ok(!seen[0].url.includes(KEY), 'ключ в адресе: ' + seen[0].url)
  assert.equal(seen[0].headers['X-API-KEY'], KEY)
  assert.equal(r.error, 'not found')
})

test('429 на чтении — отказ «слишком часто», не неясность, и пауза ключу 5 секунд', async () => {
  answer(429, 'Too Many Requests')
  const r: any = await balance(KEY)
  assert.equal(r.success, false)
  assert.equal(r.rateLimited, true)
  assert.equal(r.ambiguous, undefined)
  const cool = marketLimiter.cool as unknown as { mock: { calls: { arguments: unknown[] }[] } }
  assert.deepEqual(cool.mock.calls[0].arguments, [KEY, 5000])
})

test('429 на покупке — неясно: прошла ли покупка, не знаем', async () => {
  answer(429, 'Too Many Requests')
  const r: any = await buyOne(KEY, 'Spectator: Alliance', 0.03, 'USD', 'gt-3')
  assert.equal(r.success, false)
  assert.equal(r.ambiguous, true)
})

test('ключ не попадает в текст ошибки, даже если площадка его вернула', async () => {
  answer(500, 'invalid key SECRET-KEY-123')
  const r: any = await balance(KEY)
  assert.equal(r.success, false)
  assert.ok(!String(r.error).includes(KEY), 'ключ в ошибке: ' + r.error)
})

test('история операций: ключ заголовком, период — unix-секунды в адресе, через ограничитель', async () => {
  answer(200, '{"success":true,"data":[]}')
  await operationHistory(KEY, 1_790_000_000.7, 1_790_604_800)
  assert.equal(seen.length, 1)
  const u = new URL(seen[0].url)
  assert.equal(u.pathname, '/api/v2/operation-history')
  assert.equal(u.searchParams.get('date'), '1790000000')
  assert.equal(u.searchParams.get('date_end'), '1790604800')
  assert.equal(u.searchParams.get('key'), null)
  assert.ok(!seen[0].url.includes(KEY))
  assert.equal(seen[0].headers['X-API-KEY'], KEY)
  const run = marketLimiter.run as unknown as { mock: { calls: { arguments: unknown[] }[] } }
  assert.equal(run.mock.calls.length, 1)
  assert.equal(run.mock.calls[0].arguments[0], KEY)
})
