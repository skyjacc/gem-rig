// Вход в панель.
//
// За панелью стоят необратимые действия: отправка сообщений игровому
// координатору, трата денег на площадке, отвязка сессии Steam. До этого
// файла защитой был только адрес 127.0.0.1 — и этого мало по двум причинам.
//
// Первая: любая открытая в браузере страница может обратиться к localhost.
// Простой POST без JSON Fastify не разбирает, но через DNS rebinding чужой
// сайт получает имя, которое указывает на 127.0.0.1, и дальше говорит
// с панелью как свой. Против этого — проверка заголовка Host.
//
// Вторая: панель хотят открывать с телефона и с другого компьютера
// (HOST=0.0.0.0, Tailscale). Тогда адрес уже ничего не защищает.
//
// Поэтому три слоя:
//   Host     только свои имена: localhost, 127.0.0.1, ::1 и ALLOWED_HOSTS
//   Origin   запросы, меняющие что-то, — только со своих страниц
//   токен    каждый /api/* — с кукой входа или заголовком Authorization
//
// Токен берётся из PANEL_TOKEN, иначе из tools/panel.token. Файла нет —
// создаётся случайный, и ссылка входа печатается в консоль при запуске.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TOOLS } from './paths.ts'

export const COOKIE = 'rig_auth'
const TOKEN_FILE = path.join(TOOLS, 'panel.token')

// Токен панели. Создаётся один раз и дальше читается из файла: перезапуск
// не должен разлогинивать телефон.
export function loadToken(env = process.env, file = TOKEN_FILE): { token: string; created: boolean } {
  const fromEnv = String(env.PANEL_TOKEN ?? '').trim()
  if (fromEnv) return { token: fromEnv, created: false }
  try {
    const t = fs.readFileSync(file, 'utf8').trim()
    if (t.length >= 16) return { token: t, created: false }
  } catch { /* файла нет — создадим */ }
  const t = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(file, t + '\n', { encoding: 'utf8', mode: 0o600 })
  return { token: t, created: true }
}

// Сравнение за постоянное время: иначе токен подбирается по задержке ответа.
export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  if (!x.length || x.length !== y.length) return false
  return crypto.timingSafeEqual(x, y)
}

const LOOPBACK = ['localhost', '127.0.0.1', '::1']

export function allowedHosts(env = process.env): Set<string> {
  const extra = String(env.ALLOWED_HOSTS ?? '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  return new Set([...LOOPBACK, ...extra])
}

// Имя хоста без порта. [::1]:4322 → ::1, localhost:4322 → localhost.
export function hostname(value: string): string {
  const v = String(value ?? '').trim().toLowerCase()
  if (!v) return ''
  if (v.startsWith('[')) return v.slice(1, v.indexOf(']') > 0 ? v.indexOf(']') : undefined)
  const i = v.lastIndexOf(':')
  return i > 0 && v.indexOf(':') === i ? v.slice(0, i) : v
}

export function hostAllowed(host: string | undefined, allowed: Set<string>): boolean {
  const h = hostname(host ?? '')
  return !!h && allowed.has(h)
}

// Origin: браузер присылает его на каждый POST. Нет заголовка — это не
// браузер (curl, скрипт), и от CSRF такой запрос защищать не нужно: без
// токена он всё равно не пройдёт. Есть — должен быть своим.
export function originAllowed(origin: string | undefined, allowed: Set<string>): boolean {
  if (!origin) return true
  try {
    const u = new URL(origin)
    return (u.protocol === 'http:' || u.protocol === 'https:') && allowed.has(u.hostname.replace(/^\[|\]$/g, '').toLowerCase())
  } catch {
    return false
  }
}

export function cookieValue(header: string | undefined, name = COOKIE): string {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()) } catch { return '' }
    }
  }
  return ''
}

export function bearer(header: string | undefined): string {
  const m = String(header ?? '').match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : ''
}

export type Req = {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

// Пути, открытые без токена: сама проверка входа и вход по ссылке.
const OPEN = new Set(['/api/auth', '/api/login'])

// Решение по запросу. Без ввода-вывода — проверяется тестами.
export function gate(req: Req, token: string, allowed: Set<string>): { ok: true } | { ok: false; code: number; why: string } {
  if (!hostAllowed(one(req.headers.host), allowed)) {
    return { ok: false, code: 403, why: 'чужое имя хоста' }
  }
  const p = String(req.url ?? '').split('?')[0]
  if (!p.startsWith('/api/')) return { ok: true }  // статика фронта данных не несёт

  if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(one(req.headers.origin), allowed)) {
    return { ok: false, code: 403, why: 'запрос с чужой страницы' }
  }
  if (OPEN.has(p)) return { ok: true }

  const got = cookieValue(one(req.headers.cookie)) || bearer(one(req.headers.authorization))
  if (!sameToken(got, token)) return { ok: false, code: 401, why: 'нужен вход' }
  return { ok: true }
}

// Кука входа. HttpOnly — скрипт страницы её не прочитает. SameSite=Strict —
// чужая страница не приложит её к своему запросу. Secure — только когда
// панель открыта по https (Tailscale serve), иначе браузер её не сохранит.
export function loginCookie(token: string, secure: boolean): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}` +
    (secure ? '; Secure' : '')
}

export const logoutCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
