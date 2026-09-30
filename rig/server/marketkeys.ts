// Ключ площадки — у каждого аккаунта свой.
//
// Раньше ключ был один на всю панель, а план закупки считался по активному
// аккаунту. Переключились на второй — план честно говорил «этого гема у вас
// нет, берите», а лоты приезжали на первый: площадка шлёт их на тот Steam,
// к которому привязан её профиль, и о выборе в панели не знает.
//
// Теперь у аккаунта свой файл ключа, и ключ проверяется: площадка отдаёт
// steamid своего профиля (get-my-steam-id). Не совпал со steamid аккаунта —
// покупка запрещена, потому что лоты ушли бы не туда.
//
// Сам ключ наружу не отдаётся никогда: ни в состоянии, ни в ответах API.
// Панель видит только статус.
//
//   main     tools/market.key (или MARKET_KEY) — как было
//   прочие   tools/market-<id>.key

import fs from 'node:fs'
import path from 'node:path'
import { TOOLS } from './paths.ts'
import { steamIdOf } from './market.ts'
import type { Account } from './accounts.ts'

export type KeyState = 'missing' | 'unchecked' | 'ok' | 'mismatch' | 'invalid'

export type KeyStatus = {
  state: KeyState
  // steamid профиля площадки — только при mismatch, чтобы было видно, чей ключ
  marketSteamid: string | null
  checkedAt: number
  error: string | null
}

export const keyFile = (id: string) => (id === 'main' ? 'market.key' : `market-${id}.key`)

// Для main — прежний порядок: переменная окружения, потом файл.
export function keyFor(a: Pick<Account, 'id'>, env = process.env, dir = TOOLS): string | null {
  if (a.id === 'main' && env.MARKET_KEY?.trim()) return env.MARKET_KEY.trim()
  try { return fs.readFileSync(path.join(dir, keyFile(a.id)), 'utf8').trim() || null } catch { return null }
}

// Ключ площадки — буквы, цифры, дефис и подчёркивание. Всё прочее — либо
// опечатка, либо попытка протащить в путь или в запрос что-то чужое.
export const validKey = (k: string) => /^[A-Za-z0-9_-]{16,64}$/.test(String(k ?? '').trim())

const cache = new Map<string, KeyStatus>()
const TTL = 10 * 60_000

// Вердикт по ответу площадки. Без ввода-вывода — для тестов.
export function judgeKey(res: any, accountSteamid: string): Pick<KeyStatus, 'state' | 'marketSteamid' | 'error'> {
  if (res?.ambiguous) return { state: 'unchecked', marketSteamid: null, error: String(res.error ?? 'нет ответа') }
  if (!res?.success) return { state: 'invalid', marketSteamid: null, error: String(res?.error ?? 'площадка отвергла ключ') }
  const sid = String(res.steamid64 ?? '')
  if (!/^\d{17}$/.test(sid)) return { state: 'unchecked', marketSteamid: null, error: 'площадка не назвала steamid' }
  if (sid !== String(accountSteamid)) return { state: 'mismatch', marketSteamid: sid, error: null }
  return { state: 'ok', marketSteamid: null, error: null }
}

export function cachedStatus(a: Account): KeyStatus {
  if (!keyFor(a)) return { state: 'missing', marketSteamid: null, checkedAt: 0, error: null }
  return cache.get(a.id) ?? { state: 'unchecked', marketSteamid: null, checkedAt: 0, error: null }
}

// Проверка по сети. Кешируется: статус показывается часто, а ключ меняется редко.
export async function checkKey(a: Account, force = false): Promise<KeyStatus> {
  const key = keyFor(a)
  if (!key) { cache.delete(a.id); return cachedStatus(a) }
  const was = cache.get(a.id)
  if (!force && was && was.state !== 'unchecked' && Date.now() - was.checkedAt < TTL) return was
  const v = judgeKey(await steamIdOf(key), a.steamid)
  const st: KeyStatus = { ...v, checkedAt: Date.now() }
  cache.set(a.id, st)
  return st
}

// Запись ключа. Файл закрыт для остальных пользователей машины; кеш
// сбрасывается, статус считается заново.
export async function setKey(a: Account, key: string, dir = TOOLS): Promise<KeyStatus | { error: string }> {
  const k = String(key ?? '').trim()
  if (!validKey(k)) return { error: 'ключ площадки — 16–64 знака: латиница, цифры, «-» и «_»' }
  if (a.id === 'main' && process.env.MARKET_KEY?.trim()) {
    return { error: 'ключ основного аккаунта задан переменной MARKET_KEY — меняйте его там' }
  }
  fs.writeFileSync(path.join(dir, keyFile(a.id)), k + '\n', { encoding: 'utf8', mode: 0o600 })
  cache.delete(a.id)
  return checkKey(a, true)
}

export function removeKey(a: Account, dir = TOOLS): { ok: true } | { error: string } {
  if (a.id === 'main' && process.env.MARKET_KEY?.trim()) {
    return { error: 'ключ основного аккаунта задан переменной MARKET_KEY — убирайте его там' }
  }
  try { fs.unlinkSync(path.join(dir, keyFile(a.id))) } catch { /* и так нет */ }
  cache.delete(a.id)
  return { ok: true }
}

// Можно ли покупать на этот аккаунт — одна дверь для закупки.
export async function buyKey(a: Account): Promise<{ key: string } | { error: string }> {
  const key = keyFor(a)
  if (!key) return { error: 'у аккаунта «' + a.label + '» нет ключа площадки — задайте его на экране аккаунтов' }
  const st = await checkKey(a)
  if (st.state === 'mismatch') {
    return { error: 'ключ площадки привязан к другому Steam (' + st.marketSteamid + ') — лоты ушли бы не на «' + a.label + '»' }
  }
  if (st.state === 'invalid') return { error: 'площадка отвергла ключ «' + a.label + '»: ' + (st.error ?? '') }
  if (st.state !== 'ok') return { error: 'не удалось проверить, чей ключ площадки: ' + (st.error ?? 'нет ответа') + ' — повторите позже' }
  return { key }
}
