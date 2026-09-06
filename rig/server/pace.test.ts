import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advise, creditRate, evenDelay, EVEN_CEIL, silenceLimit, type Sample } from './pace.ts'
import { toSamples } from './autopilot.ts'

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

test('растяжка: час на две с половиной тысячи — полторы секунды', () => {
  assert.equal(evenDelay(3600_000, 2400, 500), 1500)
})

test('растяжка: работы на час, а срок час — темп не гонится к полу', () => {
  const d = evenDelay(3600_000, 2400, 500)
  assert.ok(d > 500, 'пауза ' + d + ' не должна упираться в пол')
})

test('доля начислений: мало замеров — считаем, что начисляет всё', () => {
  assert.equal(creditRate(5, 5), 1)
})

test('доля начислений: половина пустых — половина', () => {
  assert.equal(creditRate(50, 50), 0.5)
})

test('доля начислений: ниже пятнадцати процентов не опускаемся', () => {
  assert.equal(creditRate(1, 999), 0.15)
})

// ── откуда берутся замеры ──
//
// Фильтр «судим только по текущему темпу» выше работает, но в рабочем коде
// он не отсекал ничего: панель подставляла в КАЖДУЮ запись отчёта свою
// нынешнюю паузу вместо той, на которой отправка действительно ушла.
// Замеры со вчерашних пяти секунд ложились в одну кучу с сегодняшними,
// и советчик считал чистым темп, на котором никто не работал.

test('пауза берётся из записи отчёта, а не из нынешней настройки панели', () => {
  const s = toSamples([
    { ts: 3, result: 'update', delay: 1000 },
    { ts: 2, result: 'silent', delay: 5000 },
    { ts: 1, result: 'update', delay: 5000 },
  ], 1000)
  assert.deepEqual(s.map(x => x.delay), [5000, 5000, 1000])
})

test('запись без паузы — только тогда берём нынешнюю', () => {
  const s = toSamples([{ ts: 1, result: 'update' }, { ts: 2, result: 'dup', delay: 0 }], 2500)
  assert.deepEqual(s.map(x => x.delay), [2500, 2500])
})

test('отчёт разворачивается: последним идёт самый свежий', () => {
  const s = toSamples([
    { ts: 30, result: 'update', delay: 900 },
    { ts: 10, result: 'update', delay: 4000 },
  ], 0)
  assert.equal(s[s.length - 1].delay, 900, 'advise судит по последнему — это должен быть свежий')
})

test('молчания на старой паузе не портят приговор новой', () => {
  // Сорок чистых отправок на секунде после сотни молчаний на пяти.
  const old = Array.from({ length: 100 }, (_, i) => ({ ts: i, result: 'silent', delay: 5000 }))
  const now = Array.from({ length: 40 }, (_, i) => ({ ts: 200 + i, result: 'update', delay: 1000 }))
  const s = toSamples([...now, ...old].reverse().reverse(), 1000)
  const a = advise(s, { floor: 500, ceil: 30_000, enough: 40, clean: 0.01, down: 0.8, up: 1.4 })
  assert.equal(a.atDelay, 1000, 'судим по тому темпу, на котором работаем сейчас')
  assert.equal(a.silent, 0)
  assert.equal(a.measured, 40)
})

test('мусор в отчёте не роняет разбор', () => {
  assert.deepEqual(toSamples(null as any, 1000), [])
  assert.deepEqual(toSamples([{ ts: 1 }, null] as any, 1000), [])
})
