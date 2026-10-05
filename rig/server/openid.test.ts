import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authUrl, checkResponse, NS, returnTo, STEAM_OP, verifySignature } from './openid.ts'

// Вход через Steam OpenID 2.0 (план 7, решение 2б). Ответы Steam
// подменены; steamid — выдуманный.

const PANEL = 'https://panel.example.ts.net'
const STATE = 's'.repeat(43)
const SID = '76561190000000042'
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0)
const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

const good = (over: Record<string, string | undefined> = {}) => {
  const q: Record<string, string> = {
    'openid.ns': NS,
    'openid.mode': 'id_res',
    'openid.op_endpoint': STEAM_OP,
    'openid.claimed_id': 'https://steamcommunity.com/openid/id/' + SID,
    'openid.identity': 'https://steamcommunity.com/openid/id/' + SID,
    'openid.return_to': returnTo(PANEL, STATE),
    'openid.response_nonce': stamp(NOW - 30_000) + 'abcDEF',
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'c2lnbmF0dXJl',
  }
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete q[k]
    else q[k] = v
  }
  return q
}

const ok = (q: Record<string, string>) => checkResponse(q, returnTo(PANEL, STATE), NOW)
const refused = (q: Record<string, string>, re: RegExp) => {
  const r = ok(q)
  assert.ok('error' in r, 'ожидался отказ')
  assert.match((r as any).error, re)
}

test('адрес входа: Steam, режим checkid_setup, выбор личности за Steam, наш return_to и realm', () => {
  const u = new URL(authUrl(PANEL, STATE))
  assert.equal(u.origin + u.pathname, STEAM_OP)
  assert.equal(u.searchParams.get('openid.ns'), NS)
  assert.equal(u.searchParams.get('openid.mode'), 'checkid_setup')
  assert.equal(u.searchParams.get('openid.claimed_id'), 'http://specs.openid.net/auth/2.0/identifier_select')
  assert.equal(u.searchParams.get('openid.identity'), 'http://specs.openid.net/auth/2.0/identifier_select')
  assert.equal(u.searchParams.get('openid.return_to'), PANEL + '/api/auth/steam/return?state=' + STATE)
  assert.equal(u.searchParams.get('openid.realm'), PANEL)
})

test('верный ответ — steamid и nonce', () => {
  const r = ok(good())
  assert.deepEqual(r, { steamid: SID, nonce: stamp(NOW - 30_000) + 'abcDEF', nonceAt: NOW - 30_000 })
})

test('1. openid.ns — только OpenID 2.0', () => {
  refused(good({ 'openid.ns': 'http://openid.net/signon/1.1' }), /ns/)
  refused(good({ 'openid.ns': undefined }), /ns/)
})

test('2. режим — только id_res; cancel — «вход отменён»', () => {
  refused(good({ 'openid.mode': 'cancel' }), /вход отменён/)
  refused(good({ 'openid.mode': 'setup_needed' }), /режим/)
  refused(good({ 'openid.mode': undefined }), /режим/)
})

test('3. op_endpoint — ровно Steam', () => {
  refused(good({ 'openid.op_endpoint': 'https://evil.example/openid/login' }), /op_endpoint/)
  refused(good({ 'openid.op_endpoint': 'http://steamcommunity.com/openid/login' }), /op_endpoint/)
})

test('4. return_to — ровно наш адрес этой попытки', () => {
  refused(good({ 'openid.return_to': returnTo(PANEL, 'x'.repeat(43)) }), /return_to/)
  refused(good({ 'openid.return_to': returnTo('https://evil.example', STATE) }), /return_to/)
  refused(good({ 'openid.return_to': returnTo(PANEL, STATE) + '&extra=1' }), /return_to/)
})

test('5. claimed_id — профиль Steam из 17 цифр; identity совпадает', () => {
  refused(good({ 'openid.claimed_id': 'https://steamcommunity.com/openid/id/123', 'openid.identity': 'https://steamcommunity.com/openid/id/123' }), /claimed_id/)
  refused(good({ 'openid.claimed_id': 'https://evil.example/openid/id/' + SID, 'openid.identity': 'https://evil.example/openid/id/' + SID }), /claimed_id/)
  refused(good({ 'openid.identity': 'https://steamcommunity.com/openid/id/76561190000000043' }), /identity/)
})

test('6. обязательные поля подписаны', () => {
  for (const f of ['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle']) {
    const signed = 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle'.split(',').filter(x => x !== f).join(',')
    refused(good({ 'openid.signed': signed }), new RegExp('не подписано: ' + f))
  }
  refused(good({ 'openid.sig': undefined }), /подпис/)
})

test('7. nonce: не старше 5 минут, не больше минуты в будущем, формат', () => {
  refused(good({ 'openid.response_nonce': stamp(NOW - 5 * 60_000 - 1_000) + 'x' }), /устарел/)
  refused(good({ 'openid.response_nonce': stamp(NOW + 61_000) + 'x' }), /будущ/)
  assert.ok(!('error' in ok(good({ 'openid.response_nonce': stamp(NOW + 50_000) + 'x' }))), 'минута расхождения часов допустима')
  refused(good({ 'openid.response_nonce': 'вчера' }), /nonce/)
  refused(good({ 'openid.response_nonce': undefined }), /nonce/)
})

// ── 8. подпись ──

const kv = (s: string) => async () => ({ ok: true, text: async () => s })

test('8. подпись: is_valid:true и ns 2.0 — да; is_valid:false, без ns, ошибка — нет', async () => {
  assert.deepEqual(await verifySignature(good(), kv('ns:' + NS + '\nis_valid:true\n')), { ok: true })
  assert.match((await verifySignature(good(), kv('ns:' + NS + '\nis_valid:false\n')) as any).error, /подпись Steam не подтверждена/)
  assert.match((await verifySignature(good(), kv('is_valid:true\n')) as any).error, /подпись Steam не подтверждена/)
  assert.match((await verifySignature(good(), async () => ({ ok: false, text: async () => '' })) as any).error, /Steam не ответил/)
  assert.match((await verifySignature(good(), async () => { throw new Error('сеть') }) as any).error, /Steam не ответил/)
})

test('8. запрос подписи — на зафиксированный адрес Steam, все openid.* и режим check_authentication', async () => {
  let url = ''
  let body = ''
  const fetchFn = async (u: string, init: any) => { url = u; body = String(init.body); return { ok: true, text: async () => 'ns:' + NS + '\nis_valid:true\n' } }
  // Даже если в ответе подменён op_endpoint, подпись проверяется у Steam.
  await verifySignature(good({ 'openid.op_endpoint': 'https://evil.example/openid/login' }), fetchFn)
  assert.equal(url, STEAM_OP)
  const p = new URLSearchParams(body)
  assert.equal(p.get('openid.mode'), 'check_authentication')
  assert.equal(p.get('openid.sig'), 'c2lnbmF0dXJl')
  assert.equal(p.get('openid.claimed_id'), 'https://steamcommunity.com/openid/id/' + SID)
})
