import { test, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MONEY_DDL, listOps } from './money.ts'
import { KEY_NAME, parseSteamHistory, steamExternalId, steamLimiter, steamSync, STEAM_COOL_MS } from './steammarket.ts'

// Обезличенная форма живого ответа market/myhistory?norender=1 (план 3.3,
// «Проверено вживую»). Числа и номера выдуманы; поля — как в ответе.

const ME = '76561198000000001'
const OTHER = '76561198000000002'

function page(purchases: any[], events: any[] = [], names: Record<string, string> = {}) {
  const assets: any = {}
  for (const p of purchases) {
    const a = p.asset
    assets[a.appid] ??= {}
    assets[a.appid][a.contextid] ??= {}
    assets[a.appid][a.contextid][a.id] = { market_hash_name: names[a.id] ?? (a.appid === 440 ? KEY_NAME : 'Inscribed Prison Shank'), appid: a.appid }
  }
  return {
    success: true, pagesize: 100, total_count: 999, start: 0, assets, events,
    purchases: Object.fromEntries(purchases.map(p => [p.listingid + '_' + p.purchaseid, p])),
    listings: {},
  }
}

const deal = (over: Record<string, any> = {}) => ({
  listingid: '5400000000000000001', purchaseid: '5400000000000000002', time_sold: 1_790_000_000,
  steamid_purchaser: OTHER, needs_rollback: 0, failed: 0,
  asset: { currency: 0, appid: 570, contextid: '2', id: '30001', classid: '1', instanceid: '0', amount: '1', status: 4, new_id: '1', new_contextid: '2' },
  paid_amount: 100, paid_fee: 15, currencyid: '2018', steam_fee: 5, publisher_fee: 10, publisher_fee_app: 570, publisher_fee_percent: '0.100000001490116119',
  received_amount: 100, received_currencyid: '2018', funds_returned: 0, added_tax: 0,
  ...over,
})

test('внешний номер — listingid_purchaseid', () => {
  assert.equal(steamExternalId(deal()), '5400000000000000001_5400000000000000002')
})

test('продажа в своей валюте: цена покупателя = paid_amount + paid_fee, комиссии отдельно, пришло = received', () => {
  const r = parseSteamHistory(page([deal()]), ME, 'main')
  assert.equal(r.ops.length, 1)
  const op = r.ops[0]
  assert.equal(op.type, 'продажа вещи')
  assert.equal(op.source, 'рынок Steam')
  assert.equal(op.currency, 'steam:2018')
  assert.equal(op.gross, 115)
  assert.equal(op.feeSteam, 5)
  assert.equal(op.feeGame, 10)
  assert.equal(op.net, 100)
  assert.equal(op.happenedAt, 1_790_000_000_000)
  assert.equal(op.externalId, '5400000000000000001_5400000000000000002')
  assert.equal((op.gross ?? 0) - (op.feeSteam ?? 0) - (op.feeGame ?? 0), op.net, '§16: пришло = цена покупателя минус обе комиссии')
})

test('продажа в чужой валюте: пришло — в валюте кошелька, цены покупателя и комиссий в ней нет — пусто, не 0', () => {
  const r = parseSteamHistory(page([deal({ currencyid: '2005', paid_amount: 900, paid_fee: 130, steam_fee: 45, publisher_fee: 85, received_amount: 98 })]), ME, 'main')
  const op = r.ops[0]
  assert.equal(op.currency, 'steam:2018')
  assert.equal(op.net, 98)
  assert.equal(op.gross, null)
  assert.equal(op.feeSteam, null)
  assert.equal(op.feeGame, null)
  const raw = JSON.parse(op.rawRef!)
  assert.equal(raw.paid_amount, 900, 'числа в валюте покупателя — в raw_ref')
  assert.equal(raw.currencyid, '2005')
})

test('покупка ключа: уплачено = paid_amount + paid_fee в моей валюте, net со знаком минус', () => {
  const r = parseSteamHistory(page([deal({ steamid_purchaser: ME, asset: { ...deal().asset, appid: 440, id: '70001' }, publisher_fee_app: 440, received_currencyid: '2009', received_amount: 7 })]), ME, 'main')
  assert.equal(r.ops.length, 1)
  const op = r.ops[0]
  assert.equal(op.type, 'покупка ключа')
  assert.equal(op.currency, 'steam:2018')
  assert.equal(op.gross, 115)
  assert.equal(op.feeSteam, 5)
  assert.equal(op.feeGame, 10)
  assert.equal(op.net, -115)
})

test('в raw_ref нет steamid покупателя — чужие данные не храним', () => {
  const r = parseSteamHistory(page([deal()]), ME, 'main')
  assert.ok(!r.ops[0].rawRef!.includes(OTHER))
  assert.equal(JSON.parse(r.ops[0].rawRef!).side, 'продажа')
})

test('всё остальное — пропуск с причиной, не деньги', () => {
  const r = parseSteamHistory(page([
    deal({ purchaseid: '1', steamid_purchaser: ME, asset: { ...deal().asset, appid: 440, id: '70002' } }),       // не ключ
    deal({ purchaseid: '2', failed: 1 }),
    deal({ purchaseid: '3', needs_rollback: 1 }),
    deal({ purchaseid: '4', funds_returned: 1 }),
    deal({ purchaseid: '5', paid_amount: 1.5 }),
    deal({ purchaseid: '6', received_amount: undefined }),
    deal({ purchaseid: '7', time_sold: 'вчера' }),
    deal({ purchaseid: '8', received_currencyid: '' }),
  ], [
    { listingid: '9', purchaseid: '0', event_type: 1, time_event: 1, steamid_actor: ME },
    { listingid: '9', purchaseid: '0', event_type: 2, time_event: 2, steamid_actor: ME },
  ], { '70002': 'Backpack Expander' }), ME, 'main')
  assert.equal(r.ops.length, 0)
  assert.equal(r.skipped['покупка не ключа — нет типа в §16'], 1)
  assert.equal(r.skipped['сделка не прошла (failed / needs_rollback)'], 2)
  assert.equal(r.skipped['деньги возвращены (funds_returned)'], 1)
  assert.equal(r.skipped['не разобрано: суммы не целые'], 2)
  assert.equal(r.skipped['не разобрано: time_sold'], 1)
  assert.equal(r.skipped['не разобрано: нет валюты'], 1)
  assert.equal(r.skipped['выставление или снятие лота — не движение денег'], 2)
})

test('пустая или чужая страница — ничего', () => {
  assert.deepEqual(parseSteamHistory({ success: false }, ME, 'main'), { ops: [], skipped: { 'не разобрано: страница без success': 1 } })
  assert.equal(parseSteamHistory(page([]), ME, 'main').ops.length, 0)
})

test('нет listingid или purchaseid — не разобрано, номер «undefined_undefined» не строится', () => {
  const r = parseSteamHistory(page([deal({ purchaseid: undefined }), deal({ listingid: '', purchaseid: '7' })]), ME, 'main')
  assert.equal(r.ops.length, 0)
  assert.equal(r.skipped['не разобрано: нет listingid/purchaseid'], 2)
})

test('нет steamid покупателя — не разобрано, а не «продажа»', () => {
  const r = parseSteamHistory(page([deal({ steamid_purchaser: undefined }), deal({ purchaseid: '8', steamid_purchaser: '' })]), ME, 'main')
  assert.equal(r.ops.length, 0)
  assert.equal(r.skipped['не разобрано: нет steamid покупателя'], 2)
})

// ── импорт (задача 3) ──

const COOKIE = 'steamLoginSecure=СЕКРЕТ; sessionid=S'

function fresh() {
  const db = new DatabaseSync(':memory:')
  db.exec(MONEY_DDL)
  return db
}

// Страница истории с n продажами начиная с номера from (новые сверху).
const pageOf = (from: number, n: number, total: number) => {
  const deals = Array.from({ length: n }, (_, i) => deal({ listingid: String(1000 + from + i), purchaseid: String(2000 + from + i) }))
  return { ...page(deals, deals.map(d => ({ listingid: d.listingid, purchaseid: d.purchaseid, event_type: 3, time_event: 1, steamid_actor: OTHER }))), total_count: total, start: from }
}

let calls: { url: string; cookie: string; key: string }[] = []
let cooled: { key: string; ms: number }[] = []
beforeEach(() => {
  mock.restoreAll()
  calls = []
  cooled = []
  mock.method(steamLimiter, 'run', async (key: string, send: () => unknown) => { calls.push({ url: '', cookie: '', key }); return send() })
  mock.method(steamLimiter, 'cool', (key: string, ms: number) => { cooled.push({ key, ms }) })
})

function steam(answer: (start: number, n: number) => { status: number; body: any }) {
  let n = 0
  return async (url: string, init: any) => {
    const start = Number(new URL(url).searchParams.get('start'))
    calls[calls.length - 1].url = url
    calls[calls.length - 1].cookie = init?.headers?.Cookie ?? ''
    const a = answer(start, n++)
    return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } })
  }
}

test('импорт: страницы по 100 через ограничитель аккаунта, куки — заголовком, в ответе их нет', async () => {
  const db = fresh()
  const fetcher = steam(start => ({ status: 200, body: pageOf(start, start < 200 ? 100 : 0, 250) }))
  const r = await steamSync(db, { accountId: 'main', me: ME, cookie: COOKIE, pages: 3, fetcher })
  assert.equal(calls.length, 3)
  assert.ok(calls.every(c => c.key === 'main'), 'ограничитель — на аккаунт')
  assert.ok(calls.every(c => c.cookie === COOKIE))
  assert.deepEqual(calls.map(c => new URL(c.url).searchParams.get('start')), ['0', '100', '200'])
  assert.ok(calls.every(c => new URL(c.url).searchParams.get('count') === '100' && new URL(c.url).searchParams.get('norender') === '1'))
  assert.equal(r.inserted, 200)
  assert.ok(!JSON.stringify(r).includes('СЕКРЕТ'))
  assert.ok(!JSON.stringify(listOps(db)).includes('СЕКРЕТ'))
})

test('страниц по умолчанию 3, не больше 20, не меньше 1', async () => {
  const db = fresh()
  const many = steam(start => ({ status: 200, body: pageOf(start, 100, 99999) }))
  assert.equal((await steamSync(db, { accountId: 'main', me: ME, cookie: COOKIE, fetcher: many })).pages, 3)
  calls = []
  assert.equal((await steamSync(fresh(), { accountId: 'main', me: ME, cookie: COOKIE, pages: 999, fetcher: many })).pages, 20)
  assert.equal((await steamSync(fresh(), { accountId: 'main', me: ME, cookie: COOKIE, pages: 0, fetcher: many })).pages, 1)
})

test('конец истории — стоп без лишних запросов', async () => {
  const r = await steamSync(fresh(), { accountId: 'main', me: ME, cookie: COOKIE, pages: 10, fetcher: steam(start => ({ status: 200, body: pageOf(start, start === 0 ? 100 : 30, 130) })) })
  assert.equal(calls.length, 2)
  assert.equal(r.stoppedBy, 'конец истории')
  assert.equal(r.inserted, 130)
})

test('дошли до уже записанного — стоп: повторный импорт не листает всю историю', async () => {
  const db = fresh()
  const fetcher = steam(start => ({ status: 200, body: pageOf(start, 100, 99999) }))
  await steamSync(db, { accountId: 'main', me: ME, cookie: COOKIE, pages: 2, fetcher })
  calls = []
  const r = await steamSync(db, { accountId: 'main', me: ME, cookie: COOKIE, pages: 5, fetcher })
  assert.equal(calls.length, 1)
  assert.equal(r.stoppedBy, 'дошли до записанного')
  assert.equal(r.inserted, 0)
  assert.equal(r.existing, 100)
})

test('429 — сразу стоп без повторов, пауза аккаунту, записанное раньше остаётся', async () => {
  const db = fresh()
  const r = await steamSync(db, { accountId: 'main', me: ME, cookie: COOKIE, pages: 5, fetcher: steam(start => (start === 0 ? { status: 200, body: pageOf(0, 100, 99999) } : { status: 429, body: '' })) })
  assert.equal(calls.length, 2)
  assert.equal(r.stoppedBy, '429')
  assert.equal(r.inserted, 100)
  assert.deepEqual(cooled, [{ key: 'main', ms: STEAM_COOL_MS }])
})

test('не 200 или не JSON — стоп с понятной причиной', async () => {
  const a = await steamSync(fresh(), { accountId: 'main', me: ME, cookie: COOKIE, fetcher: steam(() => ({ status: 302, body: '' })) })
  assert.match(a.stoppedBy, /ошибка/)
  assert.match(String(a.error), /302/)
  const b = await steamSync(fresh(), { accountId: 'main', me: ME, cookie: COOKIE, fetcher: steam(() => ({ status: 200, body: '<html>вход</html>' })) })
  assert.match(String(b.error), /не JSON/)
  assert.equal(b.inserted, 0)
})

test('нет своего steamid — импорт не начинается: продажу от покупки не отличить', async () => {
  const r = await steamSync(fresh(), { accountId: 'main', me: '', cookie: COOKIE, fetcher: steam(() => ({ status: 200, body: pageOf(0, 1, 1) })) })
  assert.equal(calls.length, 0)
  assert.match(String(r.error), /steamid/)
})
