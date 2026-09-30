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
// Оба пути идут через tools/gcwatch/webcookies.js: steam-session обменивает
// токен на access-токен или куки, НЕ входя в сеть Steam, поэтому игра
// и отправщик на том же аккаунте не выбиваются.

import { spawn } from 'node:child_process'
import { GC } from './paths.ts'
import type { Account } from './accounts.ts'

export type SessionState = 'unknown' | 'ok' | 'revoked' | 'error' | 'missing'
export type SessionStatus = { state: SessionState; checkedAt: number; error: string | null }

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

export async function checkSession(a: Account): Promise<SessionStatus> {
  let st: SessionStatus
  try {
    st = { ...parseSession(await run(a.token, ['--check'])), checkedAt: Date.now() }
  } catch (e: any) {
    st = { state: 'error', checkedAt: Date.now(), error: String(e?.message ?? e) }
  }
  sessions.set(a.id, st)
  return st
}

// Куки на час: Steam держит веб-сессию дольше, а обмен токена — лишний
// запрос, по которому Steam считает частоту входов.
const cookieJar = new Map<string, { at: number; header: string }>()
const COOKIE_TTL = 60 * 60_000

export async function webCookieHeader(a: Account, force = false): Promise<string> {
  const c = cookieJar.get(a.id)
  if (!force && c && Date.now() - c.at < COOKIE_TTL) return c.header
  const line = (await run(a.token, [])).find(l => l.startsWith('COOKIES '))
  if (!line) throw new Error('Steam не выдал веб-сессию')
  const list: string[] = JSON.parse(line.slice(8))
  const header = list.map(s => String(s).split(';')[0]).join('; ')
  cookieJar.set(a.id, { at: Date.now(), header })
  sessions.set(a.id, { state: 'ok', checkedAt: Date.now(), error: null })
  return header
}

export function forgetWeb(id: string) {
  cookieJar.delete(id)
  sessions.delete(id)
}
