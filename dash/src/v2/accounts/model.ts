// Аккаунты (§5.5, план 2.4): слова и тон каждой проверки, цифры карточки,
// «если что-то сломалось». Только чистые функции — без запросов и React.
//
// Две сессии Steam — две разные строки (инвариант плана 2.4):
//   вход игры  SteamClient — снаружи не проверить; известен только срок
//              токена. Слова «жива» у неё нет ни в одном состоянии.
//   веб-вход   WebBrowser — «работает» только по факту полученных кук.

import { ago, nf, type AccountRow, type InvState, type MarketKeyStatus, type Unit } from '../../lib/api.ts'

export type Tone = 'ok' | 'warn' | 'stop' | 'idle'

export type Check = {
  id: 'game' | 'web' | 'market' | 'inv'
  title: string
  word: string
  tone: Tone
  hint: string
}

const DAY = 86_400_000
// Срок игрового токена ближе этого — заранее предупреждаем.
const SOON = 7 * DAY

export const day = (ts: number) => new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })

// ── вход игры ──

export function gameCheck(a: AccountRow, now: number): Check {
  const s = a.sessionState ?? { state: a.session ? 'unknown' : 'missing', checkedAt: 0, error: null, validUntil: null }
  const until = s.validUntil ?? null
  const c = (word: string, tone: Tone, hint: string): Check => ({ id: 'game', title: 'Вход игры', word, tone, hint })
  if (s.state === 'missing') return c('нет', 'stop', 'файла игровой сессии нет — работник не запустится. Привяжите заново по QR.')
  if (s.state === 'error') return c('не читается', 'stop', (s.error ?? 'файл сессии повреждён') + ' — обновите по QR.')
  if (s.state === 'revoked') {
    return c(until ? 'истёк ' + day(until) : 'отозван', 'stop', (s.error ?? 'Steam не примет этот вход') + ' — отправщик не войдёт. Обновите по QR: журнал, ключ и настройки останутся.')
  }
  // unknown — и прежнее «ok» старого сервера: снаружи проверить нельзя.
  const why = 'жив ли вход — видно только клиенту Steam; если Steam его отверг, работник встанет и скажет об этом сам'
  if (until == null) return c('срок неизвестен', 'idle', why)
  if (until - now < SOON) return c('токен до ' + day(until), 'warn', 'срок скоро кончится — обновите по QR заранее; ' + why)
  return c('токен до ' + day(until), 'idle', why)
}

// ── веб-вход ──

export function webCheck(a: AccountRow, now: number): Check {
  const w = a.web
  const c = (word: string, tone: Tone, hint: string): Check => ({ id: 'web', title: 'Веб-вход', word, tone, hint })
  const need = 'нужен для истории рынка Steam и продаж; игре и накрутке не нужен'
  if (!w) return c('неизвестно', 'idle', 'сервер не сообщает состояние веб-входа')
  const until = w.validUntil ? ' · токен до ' + day(w.validUntil) : ''
  if (w.state === 'ok') return c('работает', 'ok', 'Steam выдал веб-куки ' + ago(w.checkedAt, now) + ' назад' + until)
  if (w.state === 'unchecked') return c('не проверен', 'warn', 'файл есть' + until + '; работает ли — покажет проверка (один запрос к Steam)')
  if (w.state === 'expired') return c(w.validUntil ? 'истёк ' + day(w.validUntil) : 'истёк', 'stop', 'войдите по QR заново — ' + need)
  if (w.state === 'error') return c('не работает', 'stop', (w.error ?? 'Steam не выдал куки') + ' — ' + need)
  return c('нет', 'warn', 'веб-входа ещё не было — ' + need)
}

// ── ключ площадки ──

export function keyCheck(k: MarketKeyStatus | undefined, now: number): Check {
  const c = (word: string, tone: Tone, hint: string): Check => ({ id: 'market', title: 'Ключ market.dota2.net', word, tone, hint })
  if (!k) return c('неизвестно', 'idle', 'сервер не сообщает статус ключа')
  if (k.state === 'ok') return c('проверен', 'ok', 'площадка назвала Steam этого аккаунта · ' + ago(k.checkedAt, now) + ' назад')
  if (k.state === 'unchecked') return c('не проверен', 'warn', (k.error ? k.error + ' — ' : '') + 'проверка спросит у площадки, чей это Steam')
  if (k.state === 'mismatch') return c('чужой Steam', 'stop', 'ключ привязан к ' + (k.marketSteamid ?? 'другому Steam') + ' — лоты ушли бы не сюда; замените ключ')
  if (k.state === 'invalid') return c('площадка отвергла', 'stop', k.error ?? 'ключ не принят')
  return c('не задан', 'stop', 'без ключа закупка на этот аккаунт не запустится')
}

// ── инвентарь Dota ──

export function invCheck(inv: InvState | undefined, now: number): Check {
  const c = (word: string, tone: Tone, hint: string): Check => ({ id: 'inv', title: 'Инвентарь', word, tone, hint })
  if (!inv) return c('ещё не читался', 'idle', 'работник прочитает его, когда дойдёт до этого аккаунта')
  if (inv.private) return c('закрыт', 'stop', 'Steam не отдаёт инвентарь — откройте его в настройках приватности профиля')
  if (inv.error) return c('ошибка', 'stop', inv.error)
  const age = inv.age != null ? ' · снимок ' + ago(now - inv.age * 1_000, now) + ' назад' : ''
  if (inv.truncated) return c('не весь', 'warn', nf(inv.items) + ' вещей прочитано, остальное обрезано' + age)
  return c('открыт', 'ok', nf(inv.items) + ' вещей' + age)
}

export const checks = (a: AccountRow, u: Unit | undefined, now: number): Check[] =>
  [gameCheck(a, now), webCheck(a, now), keyCheck(a.market, now), invCheck(u?.inv, now)]

// ── цифры карточки ──

export const PACE: [number, string][] = [[500, '0,5 с'], [1_000, '1 с'], [2_000, '2 с'], [5_000, '5 с'], [30_000, '30 с']]
export const WAVES = [1, 2, 3, 4, 5]

export function pauseWord(u: Unit | undefined) {
  if (!u) return '—'
  if (u.auto) return 'сама'
  if (u.even) return 'к сроку'
  return PACE.find(p => p[0] === u.delay)?.[1] ?? nf(u.delay) + ' мс'
}

// «X из Y»: Y — гемы в инвентаре, по которым понятно, чьи матчи считать.
export function gemsWord(u: Unit | undefined) {
  const all = u?.available
  if (!all) return '—'
  const have = new Set(all.map(g => g.gem))
  const x = u!.only ? u!.only.filter(g => have.has(g)).length : all.length
  return nf(x) + ' из ' + nf(all.length)
}

export const cells = (a: AccountRow, u: Unit | undefined) => [
  { k: 'сожжено', v: nf(a.burned) },
  { k: 'в очереди', v: u ? nf(u.queueLength) : '—' },
  { k: 'пауза', v: pauseWord(u) },
  { k: 'гемов', v: gemsWord(u) },
]

// Чипы паузы: ниже пола из общих правил — неактивны.
export const pauseChips = (floor: number | null) =>
  PACE.map(([ms, label]) => ({ ms, label, below: floor != null && ms < floor }))

// Цель в отправках → время при нынешней паузе. Оценка.
export function targetMinutes(target: number, u: Unit | undefined) {
  if (!u || !(target > 0) || !(u.delay > 0)) return null
  return Math.max(1, Math.round(target * u.delay / 60_000))
}

// ── если что-то сломалось ──

export type Trouble = { title: string; text: string; fix?: 'relink' | 'web' }

export function troubles(a: AccountRow, u: Unit | undefined, now: number): Trouble[] {
  const out: Trouble[] = []
  if (u?.fatal) out.push({ title: 'Работник встал', text: u.fatal, fix: 'relink' })
  if ((u?.displaced ?? 0) >= 2) {
    out.push({ title: 'Выбило сессией', text: 'с этого аккаунта зашли в Steam где-то ещё (' + nf(u!.displaced!) + ' раз). Закройте игру и клиент Steam — тогда продолжу.' })
  }
  const g = gameCheck(a, now)
  if (g.tone === 'stop') out.push({ title: 'Вход игры: ' + g.word, text: g.hint, fix: 'relink' })
  const w = webCheck(a, now)
  if (w.tone === 'stop') out.push({ title: 'Веб-вход: ' + w.word, text: 'история рынка Steam и продажи не читаются, пока нет рабочего веб-входа.', fix: 'web' })
  return out
}
