import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cents, gemName, impliedRate, money, plan, rank, units } from './market.ts'

// Цена на площадке в копейках: доллар — тысяча. Ошибка тут стоит денег,
// поэтому отдельная проверка.
test('доллары переводятся в копейки целыми', () => {
  assert.equal(cents(0.005), 5)
  assert.equal(cents(0.03), 30)
  assert.equal(cents(1), 1000)
})

test('копейки округляются вверх — иначе лот не купится', () => {
  assert.equal(cents(0.0051), 6)
})

test('мусор превращается в ноль, а не в NaN', () => {
  assert.equal(cents('' as any), 0)
  assert.equal(cents(-1), 0)
})

test('имя гема отделяется от приставок', () => {
  assert.equal(gemName('Spectator: Alliance'), 'Alliance')
  assert.equal(gemName('Genuine Spectator: NaVi'), 'NaVi')
  assert.equal(gemName('Nether Wand'), '')
})

const item = (gem: string, price: number, volume: number, pool: number, owned = 0) =>
  ({ gem, name: 'Spectator: ' + gem, price, volume, pool, owned })

test('первыми идут те, что дойдут до цели', () => {
  const r = rank([item('мало', 0.001, 50, 300), item('много', 0.005, 50, 2500)], 1000)
  assert.equal(r[0].gem, 'много')
  assert.equal(r[0].reaches, true)
  assert.equal(r[1].reaches, false)
})

test('при равных условиях дешевле — выше', () => {
  const r = rank([item('дорогой', 0.01, 50, 2000), item('дешёвый', 0.005, 50, 2000)], 1000)
  assert.equal(r[0].gem, 'дешёвый')
})

test('уже купленный помечается — его копия не стоит отправок', () => {
  const r = rank([item('свой', 0.006, 10, 2000, 5), item('чужой', 0.005, 10, 2000)], 1000)
  assert.equal(r.find(x => x.gem === 'свой')!.owned, 5)
})

test('план не превышает ни денег, ни числа лотов', () => {
  const p = plan(rank([item('a', 0.005, 3, 2000), item('b', 0.005, 100, 2000)], 1000), 0.02, 10)
  assert.ok(p.total <= 0.02 + 1e-9, 'уложились в сумму: ' + p.total)
  const a = p.lines.find(l => l.gem === 'a')
  assert.ok(!a || a.take <= 3, 'больше, чем есть в продаже, не берём')
})

test('нулевой бюджет — пустой план, а не ошибка', () => {
  const p = plan(rank([item('a', 0.005, 10, 2000)], 1000), 0, 5)
  assert.deepEqual(p.lines, [])
  assert.equal(p.total, 0)
})

test('в план не попадает то, что до цели не дойдёт', () => {
  const p = plan(rank([item('короткий', 0.001, 99, 100)], 1000), 1, 99)
  assert.deepEqual(p.lines, [])
})

// ── валюты ──
//
// Площадка отдаёт цены в рублях, долларах и евро — это её собственные числа,
// по ним и платят. Гривны у неё нет вовсе (404), поэтому цена в гривне —
// пересчёт доллара по курсу НБУ, и подавать её надо именно так.

test('курс площадки берётся по её же ценам, а не с потолка', () => {
  const usd = [{ market_hash_name: 'a', price: '0.005' }, { market_hash_name: 'b', price: '1' }]
  const rub = [{ market_hash_name: 'a', price: '0.4' }, { market_hash_name: 'b', price: '80' }]
  assert.equal(impliedRate(usd, rub), 80)
})

test('перекос одной позиции не сдвигает курс — берём середину', () => {
  const usd = [{ market_hash_name: 'a', price: '1' }, { market_hash_name: 'b', price: '1' }, { market_hash_name: 'c', price: '1' }]
  const rub = [{ market_hash_name: 'a', price: '80' }, { market_hash_name: 'b', price: '80' }, { market_hash_name: 'c', price: '9999' }]
  assert.equal(impliedRate(usd, rub), 80)
})

test('нет общих позиций — курса нет, а не единица', () => {
  assert.equal(impliedRate([{ market_hash_name: 'a', price: '1' }], [{ market_hash_name: 'b', price: '2' }]), 0)
})

test('пустые списки не роняют счёт', () => {
  assert.equal(impliedRate([], []), 0)
})

test('нули и мусор в ценах пропускаются', () => {
  const usd = [{ market_hash_name: 'a', price: '0' }, { market_hash_name: 'b', price: '2' }]
  const rub = [{ market_hash_name: 'a', price: '5' }, { market_hash_name: 'b', price: '160' }]
  assert.equal(impliedRate(usd, rub), 80)
})

test('деньги показываются по правилам своей валюты', () => {
  assert.equal(money(1234.5, 'RUB'), '1 234,50 ₽')
  assert.equal(money(0.005, 'USD'), '$0.005')
  assert.equal(money(12, 'UAH'), '12,00 ₴')
})

test('множитель мелкой единицы зависит от валюты счёта', () => {
  assert.equal(units(1, 'RUB'), 100)
  assert.equal(units(1, 'USD'), 1000)
  assert.equal(units(1, 'EUR'), 1000)
})

test('послать рублёвую цену с множителем доллара — переплата вдесятеро', () => {
  assert.notEqual(units(100, 'RUB'), units(100, 'USD'))
  assert.equal(units(100, 'USD') / units(100, 'RUB'), 10)
})
