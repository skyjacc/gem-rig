import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advise, evenDelay, EVEN_CEIL, silenceLimit, type Sample } from './pace.ts'

const ok = (n: number, delay: number): Sample[] =>
  Array.from({ length: n }, (_, i) => ({ delay, ts: i * delay, result: 'update' as const }))

test('без замеров советуем секунду — известный безопасный темп', () => {
  const a = advise([])
  assert.equal(a.suggest, 1000)
  assert.match(a.why, /нет замеров/i)
})

test('чистая работа на секунде — можно пробовать быстрее', () => {
  const a = advise(ok(200, 1000))
  assert.ok(a.suggest < 1000, 'ускоряемся: ' + a.suggest)
  assert.ok(a.suggest >= 500, 'но не в пропасть: ' + a.suggest)
})

test('молчание GC на этом темпе — замедляемся', () => {
  const bad = ok(60, 700).map((s, i) => (i % 4 === 0 ? { ...s, result: 'silent' as const } : s))
  const a = advise(bad)
  assert.ok(a.suggest > 700, 'нашли потолок и отходим: ' + a.suggest)
  assert.match(a.why, /без ответа/i)
})

test('дубли темпом не считаются — это про матч, а не про скорость', () => {
  const dups = ok(200, 1000).map((s, i) => (i % 2 ? { ...s, result: 'dup' as const } : s))
  const a = advise(dups)
  assert.ok(a.suggest < 1000, 'dup не повод тормозить')
})

test('мало замеров — не двигаемся', () => {
  const a = advise(ok(5, 1000))
  assert.equal(a.suggest, 1000)
  assert.match(a.why, /мало/i)
})

test('ниже безопасного порога не опускаемся никогда', () => {
  let s = advise(ok(400, 400)).suggest
  for (let i = 0; i < 10; i++) s = advise(ok(400, s)).suggest
  assert.ok(s >= 300, 'нижний предел держится: ' + s)
})

test('замеры на другом темпе не мешают судить о текущем', () => {
  const mixed = [...ok(100, 30000).map(s => ({ ...s, result: 'silent' as const })), ...ok(200, 1000)]
  const a = advise(mixed)
  assert.ok(a.suggest < 1000, 'старая порка на 30 с не должна тормозить сегодняшнюю секунду')
})

test('растяжка: восемь часов на тысячу отправок — пауза под тридцать секунд', () => {
  assert.equal(evenDelay(8 * 3600_000, 1000, 300), 28_800)
})

test('растяжка: работы больше, чем времени — упираемся в пол', () => {
  assert.equal(evenDelay(60_000, 10_000, 300), 300)
})

test('растяжка: срок вышел — идём на полу, а не делим на ноль', () => {
  assert.equal(evenDelay(0, 500, 300), 300)
  assert.equal(evenDelay(-5000, 500, 300), 300)
})

test('растяжка: работы почти нет — пауза упирается в потолок, а не в часы', () => {
  assert.equal(evenDelay(8 * 3600_000, 1, 300), EVEN_CEIL)
})

test('молчание судится по паузе: на растяжке предел растёт вместе с ней', () => {
  assert.equal(silenceLimit(60_000, 300), 60_000)
  assert.equal(silenceLimit(60_000, 30_000), 110_000)
})
