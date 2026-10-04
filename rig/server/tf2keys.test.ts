import { test, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { steamLimiter, STEAM_COOL_MS } from './steammarket.ts'
import {
  estimateRelease, keyState, lastSnapshot, parseInventoryPage, parseTradableAfter, saveSnapshot, summarize, syncKeys, TF2_DDL,
} from './tf2keys.ts'

// Обезличенная форма живого ответа /inventory/<steamid>/440/2?l=english
// (план 3.4, «Проверено вживую»): строка времени — в descriptions[].value,
// с переводом строки в начале; owner_descriptions в ответе нет.

const KEY = 'Mann Co. Supply Crate Key'
const T = (iso: string) => Date.parse(iso)

// ── строка времени ──

test('строка Steam → UTC; перевод строки и пробелы по краям не мешают', () => {
  assert.equal(parseTradableAfter('Tradable After: Sunday, October 4, 2026 (7:00:00) GMT'), T('2026-10-04T07:00:00Z'))
  assert.equal(parseTradableAfter('\nTradable After: Tuesday, October 6, 2026 (7:00:00) GMT'), T('2026-10-06T07:00:00Z'))
  assert.equal(parseTradableAfter('Tradable After: Saturday, October 10, 2026 (17:05:09) GMT  '), T('2026-10-10T17:05:09Z'))
})

test('другой формат, пустая строка, несуществующая дата, неверный день недели — null, не угадываем', () => {
  for (const s of [
    '', null, undefined, 'Tradable After: 2026-10-06 07:00', 'Tradable After: Tuesday, October 6, 2026 (7:00:00) UTC',
    'Tradable After: Monday, February 30, 2026 (7:00:00) GMT', 'Tradable After: Monday, October 6, 2026 (7:00:00) GMT',
    'Tradable After: Tuesday, October 6, 2026 (25:00:00) GMT', 'Торгуется после: вторник',
  ]) assert.equal(parseTradableAfter(s as any), null, String(s))
})

// ── страница инвентаря ──

const desc = (classid: string, tradable: 0 | 1, after: string | null, name = KEY) => ({
  appid: 440, classid, instanceid: '0', tradable, market_hash_name: name,
  descriptions: [
    { value: 'Used to open locked supply crates.' }, { value: ' ' }, { value: 'This is a limited use item. Uses: 1' },
    ...(after ? [{ value: '\n' + after, color: 'd83636', name: 'trade_hold' }] : []),
  ],
})
const asset = (assetid: string, classid: string) => ({ appid: 440, contextid: '2', assetid, classid, instanceid: '0', amount: '1' })

const invPage = (over: Record<string, unknown> = {}) => ({
  success: 1, total_inventory_count: 4, rwgrsn: -2,
  assets: [asset('101', 'c1'), asset('102', 'c1'), asset('103', 'c2'), asset('104', 'c3')],
  descriptions: [
    desc('c1', 0, 'Tradable After: Tuesday, October 6, 2026 (7:00:00) GMT'),
    desc('c2', 1, null),
    desc('c3', 1, null, 'Backpack Expander'),
  ],
  ...over,
})

test('страница: ключи с временем и без, прочие предметы — счётчиком', () => {
  const r = parseInventoryPage(invPage())
  assert.ok('keys' in r)
  assert.deepEqual(r.keys.map(k => [k.assetid, k.tradable, k.tradableAfter]), [
    ['101', 0, T('2026-10-06T07:00:00Z')], ['102', 0, T('2026-10-06T07:00:00Z')], ['103', 1, null],
  ])
  assert.equal(r.keys[0].tradableAfterRaw, 'Tradable After: Tuesday, October 6, 2026 (7:00:00) GMT')
  assert.equal(r.others, 1)
  assert.equal(r.more, false)
  assert.equal(r.total, 4)
})

test('страница с продолжением и без success', () => {
  const r = parseInventoryPage(invPage({ more_items: 1, last_assetid: '104' }))
  assert.ok('keys' in r)
  assert.equal(r.more, true)
  assert.equal(r.last, '104')
  assert.ok('error' in parseInventoryPage({ success: false }))
  assert.ok('error' in parseInventoryPage(null))
})

// ── состояние ключа и итог ──

const NOW = T('2026-10-05T12:00:00Z')
const k = (tradable: 0 | 1, after: string | null) => ({ assetid: 'a', tradable, tradableAfter: after ? T(after) : null, tradableAfterRaw: null })

test('состояние ключа — все шесть сочетаний, противоречие видно', () => {
  assert.equal(keyState(k(1, null), NOW), 'можно передать')
  assert.equal(keyState(k(1, '2026-10-06T07:00:00Z'), NOW), 'расходится')
  assert.equal(keyState(k(1, '2026-10-04T07:00:00Z'), NOW), 'можно передать')
  assert.equal(keyState(k(0, '2026-10-06T07:00:00Z'), NOW), 'на удержании')
  assert.equal(keyState(k(0, '2026-10-04T07:00:00Z'), NOW), 'расходится')
  assert.equal(keyState(k(0, null), NOW), 'на удержании, время неизвестно')
})

test('итог: каждый ключ ровно в одной группе, освобождения сгруппированы по одинаковому времени', () => {
  const keys = [
    k(0, '2026-10-06T07:00:00Z'), k(0, '2026-10-06T07:00:00Z'), k(0, '2026-10-08T07:00:00Z'),
    k(1, null), k(0, null), k(0, '2026-10-04T07:00:00Z'),
  ]
  const s = summarize(keys, NOW)
  assert.equal(s.onHand, 6)
  assert.equal(s.tradableNow, 1)
  assert.equal(s.held, 4)
  assert.equal(s.unknownTime, 1)
  assert.equal(s.conflict, 1)
  assert.equal(s.tradableNow + s.held + s.conflict, s.onHand)
  assert.deepEqual(s.releases, [{ at: T('2026-10-06T07:00:00Z'), keys: 2 }, { at: T('2026-10-08T07:00:00Z'), keys: 1 }])
  assert.deepEqual(s.nextRelease, { at: T('2026-10-06T07:00:00Z'), keys: 2 })
})

test('оценка «покупка + 7 суток» — с меткой оценка, отдельно от снимка', () => {
  assert.deepEqual(estimateRelease(T('2026-10-01T10:00:00Z')), { at: T('2026-10-08T10:00:00Z'), label: 'оценка' })
})

// ── снимок ──

function fresh() {
  const db = new DatabaseSync(':memory:')
  db.exec(TF2_DDL)
  return db
}

test('снимок пишется одной транзакцией; последний — по наибольшему id; правка и удаление запрещены', () => {
  const db = fresh()
  const a = saveSnapshot(db, 'main', 1000, [k(0, '2026-10-06T07:00:00Z'), { ...k(1, null), assetid: 'b' }])
  const b = saveSnapshot(db, 'main', 1000, [k(1, null)])   // то же время — «последний» всё равно второй
  assert.ok(b > a)
  const last = lastSnapshot(db, 'main')!
  assert.equal(last.id, b)
  assert.equal(last.keys.length, 1)
  assert.equal(lastSnapshot(db, 'other'), null)
  for (const sql of ['update tf2_snapshots set keys = 0', 'delete from tf2_snapshots', 'update tf2_keys set tradable = 1', 'delete from tf2_keys']) {
    assert.throws(() => db.prepare(sql).run(), /не меняется|запрещено/, sql)
  }
})

test('снимок: дубль assetid в одном снимке — откат целиком', () => {
  const db = fresh()
  assert.throws(() => saveSnapshot(db, 'main', 1, [k(1, null), k(0, null)]))
  assert.equal(lastSnapshot(db, 'main'), null)
  assert.equal((db.prepare('select count(*) c from tf2_keys').get() as any).c, 0)
})

// ── чтение ──

let calls: { url: string; key: string; cookie: string | undefined }[] = []
let cooled: { key: string; ms: number }[] = []
beforeEach(() => {
  mock.restoreAll()
  calls = []
  cooled = []
  mock.method(steamLimiter, 'run', async (key: string, send: () => unknown) => { calls.push({ url: '', key, cookie: undefined }); return send() })
  mock.method(steamLimiter, 'cool', (key: string, ms: number) => { cooled.push({ key, ms }) })
})

const steam = (answer: (n: number, url: string) => { status: number; body: any }) => {
  let n = 0
  return async (url: string, init: any) => {
    calls[calls.length - 1].url = url
    calls[calls.length - 1].cookie = init?.headers?.Cookie
    const a = answer(n++, url)
    return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status })
  }
}

test('чтение: одна страница — снимок сохранён; запрос без кук, через ограничитель аккаунта, l=english', async () => {
  const db = fresh()
  const r = await syncKeys(db, { accountId: 'main', steamid: '76561198000000001', fetcher: steam(() => ({ status: 200, body: invPage() })), now: NOW })
  assert.ok('snapshotId' in r)
  assert.equal(r.summary.onHand, 3)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].key, 'main')
  assert.equal(calls[0].cookie, undefined, 'время ключей видно без кук — сессию не тратим')
  const u = new URL(calls[0].url)
  assert.equal(u.pathname, '/inventory/76561198000000001/440/2')
  assert.equal(u.searchParams.get('l'), 'english')
})

test('чтение: продолжение — следующая страница с start_assetid; ключи складываются', async () => {
  const db = fresh()
  const r = await syncKeys(db, { accountId: 'main', steamid: '1', now: NOW, fetcher: steam(n => ({
    status: 200, body: n === 0 ? invPage({ more_items: 1, last_assetid: '104' }) : invPage({ assets: [asset('201', 'c1')] }),
  })) })
  assert.equal(calls.length, 2)
  assert.equal(new URL(calls[1].url).searchParams.get('start_assetid'), '104')
  assert.ok('snapshotId' in r)
  assert.equal(r.summary.onHand, 4)
})

test('неполный инвентарь не сохраняется: продолжение после лимита, ошибка страницы, 429', async () => {
  for (const [label, fetcher, pages] of [
    ['лимит', steam(() => ({ status: 200, body: invPage({ more_items: 1, last_assetid: '9' }) })), 2],
    ['ошибка', steam(n => (n === 0 ? { status: 200, body: invPage({ more_items: 1, last_assetid: '9' }) } : { status: 500, body: '' })), 5],
    ['не JSON', steam(() => ({ status: 200, body: '<html>' })), 5],
    ['429', steam(() => ({ status: 429, body: '' })), 5],
  ] as const) {
    const db = fresh()
    calls = []
    const r = await syncKeys(db, { accountId: 'main', steamid: '1', fetcher, maxPages: pages, now: NOW })
    assert.ok('error' in r, label)
    assert.match(r.error, /неполный|429/, label)
    assert.equal(lastSnapshot(db, 'main'), null, label + ': снимок не сохранён')
  }
  assert.deepEqual(cooled, [{ key: 'main', ms: STEAM_COOL_MS }])
})

test('нет steamid — без запроса', async () => {
  const r = await syncKeys(fresh(), { accountId: 'main', steamid: '', fetcher: steam(() => ({ status: 200, body: invPage() })) })
  assert.ok('error' in r)
  assert.equal(calls.length, 0)
})
