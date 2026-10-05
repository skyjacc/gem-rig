// Вход через Steam — OpenID 2.0 (план 7, решения 2, 2б; §18).
//
// Steam сообщает панели только steamid профиля: ни инвентаря, ни кошелька
// это не открывает. Ответ Steam приходит через браузер — его можно
// подделать, поэтому проверяется всё, что требует спецификация
// (https://openid.net/specs/openid-authentication-2_0.html, §10–11), и
// подпись — отдельным запросом к Steam. Подтверждённая подпись не отменяет
// ни одной проверки поля: они делаются до запроса и не пропускаются.
//
// Повтор ответа (тот же nonce) ловит вызывающий: здесь — чистые функции,
// без базы.

export const STEAM_OP = 'https://steamcommunity.com/openid/login'
export const NS = 'http://specs.openid.net/auth/2.0'
const SELECT = 'http://specs.openid.net/auth/2.0/identifier_select'
const CLAIMED = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/
const MUST_SIGN = ['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle']
export const NONCE_AGE = 5 * 60_000
const NONCE_SKEW = 60_000

const base = (panelUrl: string) => panelUrl.replace(/\/+$/, '')

export const returnTo = (panelUrl: string, state: string) =>
  base(panelUrl) + '/api/auth/steam/return?state=' + encodeURIComponent(state)

export function authUrl(panelUrl: string, state: string): string {
  const u = new URL(STEAM_OP)
  u.searchParams.set('openid.ns', NS)
  u.searchParams.set('openid.mode', 'checkid_setup')
  u.searchParams.set('openid.claimed_id', SELECT)
  u.searchParams.set('openid.identity', SELECT)
  u.searchParams.set('openid.return_to', returnTo(panelUrl, state))
  u.searchParams.set('openid.realm', base(panelUrl))
  return u.toString()
}

type Fail = { error: string }

// Проверки 1–7 ответа Steam. expectedReturnTo — ровно то, что мы отправили
// в этой попытке входа.
export function checkResponse(q: Record<string, string>, expectedReturnTo: string, now: number):
  { steamid: string; nonce: string; nonceAt: number } | Fail {
  const g = (k: string) => (typeof q['openid.' + k] === 'string' ? q['openid.' + k] : '')
  // 1
  if (g('ns') !== NS) return { error: 'ответ Steam не по OpenID 2.0 (ns)' }
  // 2
  if (g('mode') === 'cancel') return { error: 'вход отменён' }
  if (g('mode') !== 'id_res') return { error: 'ответ Steam не того режима' }
  // 3
  if (g('op_endpoint') !== STEAM_OP) return { error: 'ответ не от Steam (op_endpoint)' }
  // 4
  if (g('return_to') !== expectedReturnTo) return { error: 'ответ Steam не для этой попытки входа (return_to)' }
  // 5
  const m = CLAIMED.exec(g('claimed_id'))
  if (!m) return { error: 'ответ Steam без профиля Steam (claimed_id)' }
  if (g('identity') !== g('claimed_id')) return { error: 'ответ Steam: identity не совпадает с claimed_id' }
  // 6
  if (!g('sig')) return { error: 'ответ Steam без подписи' }
  const signed = new Set(g('signed').split(','))
  for (const f of MUST_SIGN) if (!signed.has(f)) return { error: 'в ответе Steam не подписано: ' + f }
  // 7
  const nonce = g('response_nonce')
  const t = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)./.exec(nonce)
  const at = t ? Date.parse(t[1]) : NaN
  if (!Number.isFinite(at)) return { error: 'ответ Steam: nonce не разобран' }
  if (now - at > NONCE_AGE) return { error: 'ответ Steam устарел — войдите заново' }
  if (at - now > NONCE_SKEW) return { error: 'ответ Steam из будущего — проверьте часы компьютера' }
  return { steamid: m[1], nonce, nonceAt: at }
}

type FetchFn = (url: string, init: any) => Promise<{ ok: boolean; text: () => Promise<string> }>

// Проверка 8: подпись. Все полученные openid.* с режимом
// check_authentication — POST-ом на зафиксированный адрес Steam, а не на
// op_endpoint из ответа. Ответ — пары «ключ:значение» по строкам.
export async function verifySignature(q: Record<string, string>, fetchFn: FetchFn = fetch as any): Promise<{ ok: true } | Fail> {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (k.startsWith('openid.')) body.set(k, v)
  body.set('openid.mode', 'check_authentication')
  let text = ''
  try {
    const r = await fetchFn(STEAM_OP, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) return { error: 'Steam не ответил на проверку подписи' }
    text = await r.text()
  } catch {
    return { error: 'Steam не ответил на проверку подписи' }
  }
  const kv = new Map(text.split('\n').map(l => {
    const i = l.indexOf(':')
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string]
  }))
  if (kv.get('ns') !== NS || kv.get('is_valid') !== 'true') return { error: 'подпись Steam не подтверждена' }
  return { ok: true }
}
