// Веб-сторона Steam по сохранённой сессии аккаунта.
//
// Две вещи:
//
//   жива ли сессия  — refresh-токен Steam отзывает при смене пароля, «выйти
//                     на всех устройствах», сбросе Steam Guard. Файл токена
//                     при этом лежит как ни в чём не бывало, и панель
//                     показывала «сессия есть», хотя отправщик не вошёл бы.
//                     30 сентября так и оказалось с основным аккаунтом.
//
//   веб-куки        — для чтения своей истории рынка (продажи). Держатся
//                     только в памяти процесса и никуда не пишутся.
//
// С 2025-04-30 Steam отвечает AccessDenied на refreshAccessToken() и
// getWebCookies() для SteamClient-токена вне аутентифицированной CM-сессии
// (документация steam-session). Поэтому токенов два (план 3.3):
//
//   игровой  SteamClient, token.json / token-<id>.json — отправщик и GC.
//            Жив ли он, отсюда не узнать: проверка его сеть-методом даёт
//            ложное «отозвана». Известен только срок (exp) из самого токена,
//            а неистёкший — ещё не значит действующий.
//   веб      WebBrowser, token-web-<id>.json — только чтение steamcommunity.com.
//            Проверяется одним способом: фактическим получением веб-кук.
//
// Куки получает tools/gcwatch/webcookies.js (--platform web): steam-session
// обменивает веб-токен на куки, НЕ входя в сеть Steam клиентом, — игра
// и отправщик на том же аккаунте не выбиваются.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { GC } from './paths.ts'
import type { Account } from './accounts.ts'

export type SessionState = 'unknown' | 'ok' | 'revoked' | 'error' | 'missing'
export type SessionStatus = { state: SessionState; checkedAt: number; error: string | null; validUntil?: number | null }

function run(token: string, args: string[], timeoutMs = 45_000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['webcookies.js', '--token', token, ...args], { cwd: GC, windowsHide: true })
    let out = ''
    let err = ''
    const t = setTimeout(() => { try { child.kill() } catch { } reject(new Error('Steam не ответил за ' + Math.round(timeoutMs / 1000) + ' с')) }, timeoutMs)
    child.stdout?.on('data', b => { out += String(b) })
    child.stderr?.on('data', b => { err += String(b) })
    child.on('exit', code => {
      clearTimeout(t)
      const lines = out.split(/\r?\n/).filter(Boolean)
      if (code !== 0 && !lines.length) return reject(new Error(err.replace(/^ERROR\s*/, '').trim() || 'код ' + code))
      resolve(lines)
    })
  })
}

// Обмен токена на куки — через объект, чтобы тест мог его подменить и
// убедиться, что обычный показ аккаунтов в Steam не ходит.
export const exchange = { run }

// Разбор ответа проверки. Без ввода-вывода — для тестов.
export function parseSession(lines: string[]): Pick<SessionStatus, 'state' | 'error'> {
  const l = lines.find(x => x.startsWith('SESSION '))
  if (!l) return { state: 'error', error: 'проверка ничего не ответила' }
  const [, state, ...rest] = l.split(' ')
  if (state === 'ok') return { state: 'ok', error: null }
  if (state === 'revoked') return { state: 'revoked', error: rest.join(' ') || 'Steam отозвал сессию' }
  return { state: 'error', error: rest.join(' ') || 'неизвестная ошибка' }
}

const sessions = new Map<string, SessionStatus>()

export const sessionStatus = (a: Account, hasFile: boolean): SessionStatus =>
  !hasFile ? { state: 'missing', checkedAt: 0, error: null }
    : sessions.get(a.id) ?? { state: 'unknown', checkedAt: 0, error: null }

// Срок токена — поле exp из самого JWT. Локально, без сети.
export function validUntil(token: string): number | null {
  const part = String(token ?? '').split('.')[1]
  if (!part) return null
  try {
    const exp = Number(JSON.parse(Buffer.from(part, 'base64url').toString('utf8')).exp)
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null
  } catch { return null }
}

export const UNVERIFIABLE = 'проверка этим методом для SteamClient-токена недоступна (Steam, 2025-04-30); жив ли вход — видно только самому клиенту'

// Состояние игровой сессии по содержимому файла токена. Без ввода-вывода.
// Истёкший — точно не работает; неистёкший — «неизвестно», не «живая».
export function sessionFromToken(text: string | null, now = Date.now()): SessionStatus {
  if (text == null) return { state: 'missing', checkedAt: now, error: null, validUntil: null }
  let rt = ''
  try { rt = String(JSON.parse(text)?.refreshToken ?? '') } catch {
    return { state: 'error', checkedAt: now, error: 'файл токена не читается', validUntil: null }
  }
  if (!rt) return { state: 'error', checkedAt: now, error: 'в файле нет refresh-токена', validUntil: null }
  const until = validUntil(rt)
  if (until != null && until <= now) {
    return { state: 'revoked', checkedAt: now, error: 'срок токена истёк ' + new Date(until).toISOString().slice(0, 10), validUntil: until }
  }
  return { state: 'unknown', checkedAt: now, error: UNVERIFIABLE, validUntil: until }
}

// Игровая сессия для списка аккаунтов — из файла при каждом показе, без
// сети: срок токена виден сразу, без нажатия «проверить».
export function gameStatus(a: Pick<Account, 'token'>, now = Date.now()): SessionStatus {
  let text: string | null = null
  try { text = fs.readFileSync(path.join(GC, a.token), 'utf8') } catch { text = null }
  return sessionFromToken(text, now)
}

// Игровая сессия: в Steam не ходим — сеть-метод для SteamClient даёт ложное
// «отозвана». Только срок из токена.
export async function checkSession(a: Account): Promise<SessionStatus> {
  let text: string | null = null
  try { text = fs.readFileSync(path.join(GC, a.token), 'utf8') } catch { text = null }
  const st = sessionFromToken(text)
  sessions.set(a.id, st)
  return st
}

export const webTokenFile = (a: Pick<Account, 'id'>) => 'token-web-' + a.id + '.json'

// Веб-сессия — своё состояние, отдельно от игровой (план 2.4, решение 1).
// Без сети известно только: есть ли файл и не истёк ли срок. «Работает» —
// только по факту полученных кук, итог последней проверки.
export type WebState = 'missing' | 'expired' | 'unchecked' | 'ok' | 'error'
export type WebStatus = { state: WebState; validUntil: number | null; checkedAt: number; error: string | null }

const webChecks = new Map<string, { at: number; error: string | null }>()

export function webStatus(a: Pick<Account, 'id'>, now = Date.now()): WebStatus {
  let text: string
  try { text = fs.readFileSync(path.join(GC, webTokenFile(a)), 'utf8') } catch {
    return { state: 'missing', validUntil: null, checkedAt: 0, error: null }
  }
  let rt = ''
  try { rt = String(JSON.parse(text)?.refreshToken ?? '') } catch { rt = '' }
  if (!rt) return { state: 'error', validUntil: null, checkedAt: 0, error: 'файл веб-токена не читается' }
  const until = validUntil(rt)
  if (until != null && until <= now) {
    return { state: 'expired', validUntil: until, checkedAt: 0, error: 'срок веб-токена истёк ' + new Date(until).toISOString().slice(0, 10) }
  }
  const c = webChecks.get(a.id)
  if (!c) return { state: 'unchecked', validUntil: until, checkedAt: 0, error: null }
  return { state: c.error ? 'error' : 'ok', validUntil: until, checkedAt: c.at, error: c.error }
}

// Единственная проверка веб-сессии — фактическое получение кук (один обмен
// токена). В ответ — только состояние: ни имён, ни значений кук.
export async function checkWeb(a: Account): Promise<WebStatus> {
  let error: string | null = null
  try { await webCookieHeader(a, true) } catch (e: any) { error = String(e?.message ?? e) }
  webChecks.set(a.id, { at: Date.now(), error })
  return webStatus(a)
}

// Куки на час: Steam держит веб-сессию дольше, а обмен токена — лишний
// запрос, по которому Steam считает частоту входов.
const cookieJar = new Map<string, { at: number; list: string[] }>()

// Куки для одного сайта. Steam выдаёт steamLoginSecure и sessionid по разу на
// каждый свой домен (store, help, checkout, steamcommunity…) с разными
// значениями — склеить все в один заголовок значит послать сайту чужой вход.
// Берём только те, чей Domain совпадает с сайтом или его родителем; кука без
// Domain — не угадываем, не берём.
export function cookiesFor(list: string[], host: string): string {
  return list
    .filter(s => {
      const d = (String(s).match(/;\s*Domain=([^;]+)/i)?.[1] ?? '').trim().replace(/^\./, '').toLowerCase()
      return !!d && (host === d || host.endsWith('.' + d))
    })
    .map(s => String(s).split(';')[0].trim())
    .join('; ')
}
const COOKIE_TTL = 60 * 60_000

// Куки — только из веб-токена (WebBrowser). Игровой токен для веба не
// используется: Steam его так не обменяет. Нет веб-токена — ошибка без
// обращения к Steam.
export async function webCookieHeader(a: Pick<Account, 'id'>, force = false, host = 'steamcommunity.com'): Promise<string> {
  const c = cookieJar.get(a.id)
  if (!force && c && Date.now() - c.at < COOKIE_TTL) {
    const cached = cookiesFor(c.list, host)
    if (cached) return cached
  }
  const file = webTokenFile(a)
  if (!fs.existsSync(path.join(GC, file))) throw new Error('нет веб-сессии у аккаунта — нужен веб-вход по QR (weblogin.js)')
  const line = (await exchange.run(file, ['--platform', 'web'])).find(l => l.startsWith('COOKIES '))
  if (!line) throw new Error('Steam не выдал веб-сессию')
  const list: string[] = JSON.parse(line.slice(8))
  cookieJar.set(a.id, { at: Date.now(), list })
  const header = cookiesFor(list, host)
  if (!header) throw new Error('Steam не выдал куки для ' + host)
  return header
}

export function forgetWeb(id: string) {
  cookieJar.delete(id)
  sessions.delete(id)
  webChecks.delete(id)
}
