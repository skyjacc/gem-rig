// Аккаунты Steam.
//
// Пул матчей общий, журнал расхода — у каждого свой. Отсюда весь смысл
// второго и третьего аккаунта: они жгут тот же пул с нуля и дают втрое
// больше товара за то же время. Ограничение «одна сессия» действует
// на аккаунт, а не на машину.
//
// Аккаунт — это сохранённая сессия в tools/gcwatch/token-<id>.json.
// Реестр лежит рядом в tools/accounts.json и хранит только метку и steamid:
// сам ключ от аккаунта остаётся в файле сессии и никуда не копируется.

import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { GC, TOOLS, STEAMID, readJson } from './paths.ts'
import { forgetWeb, webTokenFile } from './steamweb.ts'
import { currentUser, OWNER } from './ctx.ts'

export type Account = {
  id: string
  label: string
  steamid: string
  token: string
  added: number
  // Пользователь панели, чей это рабочий аккаунт (план 7.2, решение 4).
  // Нет поля — владелец: все аккаунты до этапа 7.
  user?: string
}

// active — «активный» владельца (как до этапа 7); actives — остальных
// пользователей: у каждого свой (решение 4).
type Registry = { active: string; actives?: Record<string, string>; list: Account[] }

// ACCOUNTS_FILE — только для тестов (testenv.ts): свой реестр, рабочий не трогается.
const FILE = process.env.ACCOUNTS_FILE || path.join(TOOLS, 'accounts.json')

// Метка → безопасное имя файла. Кириллица и пробелы в путях к сессии
// ничего хорошего не дают.
export function slug(label: string, taken: string[] = []): string {
  const base = String(label).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'acc'
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) if (!taken.includes(base + '-' + i)) return base + '-' + i
}

function save(r: Registry) {
  fs.writeFileSync(FILE, JSON.stringify(r, null, 2), 'utf8')
}

// Первый аккаунт заводится сам из того, что уже есть: token.json существует
// с 19 августа, steamid известен. Спрашивать нечего.
function load(): Registry {
  const r = readJson<Registry | null>(FILE, null)
  if (r?.list?.length) return r
  // steamid снаружи нет (paths.ts, readSteamid) — аккаунт не выдумываем:
  // реестр пуст, панель зовёт привязать первый по QR. Файл не пишем.
  if (!STEAMID) return { active: '', list: [] }

  const first: Account = {
    id: 'main',
    label: 'основной',
    steamid: STEAMID,
    token: 'token.json',
    added: fs.existsSync(path.join(GC, 'token.json'))
      ? Math.trunc(fs.statSync(path.join(GC, 'token.json')).mtimeMs)
      : Date.now(),
  }
  const fresh: Registry = { active: first.id, list: [first] }
  save(fresh)
  return fresh
}

let reg: Registry = load()

// Что сервер знает о пользователях — снаружи (app.ts): accounts.ts базу
// не читает. По умолчанию — как до этапа 7: все активны, предела нет.
export const accountsHooks = {
  userActive: (_user: string) => true,
  maxAccounts: (_user: string) => Infinity,
}

export const ownerOf = (a: Pick<Account, 'user'>) => a.user || OWNER

// Все аккаунты сервера — для его собственной работы (такты, разбор отчётов).
// Пользователю — только listFor.
export const list = () => reg.list
export const listFor = (user: string) => reg.list.filter(a => ownerOf(a) === user)

function activeIdOf(user: string) {
  return user === OWNER ? reg.active : reg.actives?.[user] ?? ''
}

export function activeFor(user: string): Account | undefined {
  const mine = listFor(user)
  return mine.find(a => a.id === activeIdOf(user)) ?? mine[0]
}

export const active = () => activeFor(currentUser())
export const activeId = () => active()?.id ?? ''

// steamid активного аккаунта пользователя запроса. Журнал расхода ведётся
// по нему. Запасной STEAMID — только владельцу (как до этапа 7).
export const ACCOUNT = () => active()?.steamid || (currentUser() === OWNER ? STEAMID : '')

export function byId(id: string) {
  return reg.list.find(a => a.id === id) ?? null
}

// Охранник владения (решение 5): аккаунт этого пользователя или null.
// Чужой и несуществующий неразличимы (решение 11).
export function own(id: string, user = currentUser()): Account | null {
  const a = byId(String(id ?? ''))
  return a && ownerOf(a) === user && accountsHooks.userActive(user) ? a : null
}

// Новый аккаунт в реестр. Первый у пользователя становится его активным.
export function addAccount(a: Account) {
  const user = ownerOf(a)
  if (user !== OWNER) a.user = user
  reg.list.push(a)
  if (!listFor(user).some(x => x.id === activeIdOf(user))) setActiveOf(user, a.id)
  save(reg)
  return { ok: true as const }
}

function setActiveOf(user: string, id: string) {
  if (user === OWNER) reg.active = id
  else reg.actives = { ...(reg.actives ?? {}), [user]: id }
}

export function setActive(id: string) {
  const user = currentUser()
  if (!own(id, user)) return { error: 'нет такого аккаунта' }
  setActiveOf(user, id)
  save(reg)
  return { ok: true, active: id }
}

export function hasSession(a: Account) {
  return fs.existsSync(path.join(GC, a.token))
}

// ── привязка ──
//
// Панель не логинится сама: вход по QR умеет отправщик, у него для этого
// уже есть steam-session. Запускаем его в пустом режиме и слушаем две метки
// в выводе — ссылку на код и steamid после подтверждения.

type Link = {
  id: string
  label: string
  token: string
  url: string | null
  steamid: string | null
  error: string | null
  done: boolean
  child: ChildProcess | null
  lines: string[]
  // Обновление сессии уже привязанного аккаунта: id этого аккаунта.
  // Токен тогда пишется во временный файл и заменяет прежний, только если
  // вошли тем же Steam.
  relink: string | null
  // Чья привязка (решение 7): «одна за раз» — в пределах пользователя.
  user: string
}

const links = new Map<string, Link>()

// Запуск входа — через объект: тест подменяет его и проверяет разбор вывода
// и уборку временного файла, не входя в Steam.
export const proc = { spawn }

// Привязка одна за раз — игровая или веб: два QR сразу человек не отличит.
const alive = (x: { done: boolean; child: ChildProcess | null } | null | undefined) =>
  !!x && !x.done && !!x.child && x.child.exitCode === null

export function linkState(user = currentUser()) {
  const link = links.get(user)
  if (!link) return null
  const { id, label, url, steamid, error, done, relink } = link
  return { id, label, url, steamid, error, done, relink, lines: link.lines.slice(-12) }
}

// Сессия протухает: смена пароля, «выйти на всех устройствах», сброс
// Steam Guard — и refresh-токен Steam отзывает. Отправщик тогда не войдёт,
// а привязать тот же Steam заново как новый аккаунт нельзя (он уже есть).
// Поэтому relink: тот же вход по QR, но для существующей строки реестра.
export function linkStart(label: string, onChange: () => void, relink: string | null = null) {
  const user = currentUser()
  if (!accountsHooks.userActive(user)) return { error: 'нет такого аккаунта' }
  if (alive(links.get(user)) || alive(webLinks.get(user))) return { error: 'привязка уже идёт' }
  const target = relink ? own(relink, user) : null
  if (relink && !target) return { error: 'нет такого аккаунта' }
  // Предел аккаунтов пользователя (решение 10) — только для новой привязки.
  const max = accountsHooks.maxAccounts(user)
  if (!target && listFor(user).length >= max) return { error: 'достигнут предел рабочих аккаунтов: ' + max }
  const clean = target ? target.label : (String(label || '').trim() || 'второй')
  const id = target ? target.id : slug(clean, reg.list.map(a => a.id))
  // Новый токен — во временный файл: прежний не трогаем, пока не убедимся,
  // что вошли тем же Steam. Старый хвост от прошлой попытки убираем, иначе
  // отправщик вошёл бы по нему без QR — возможно, чужим аккаунтом.
  const token = target ? 'token-relink-' + target.id + '.json' : 'token-' + id + '.json'
  if (target) { try { fs.unlinkSync(path.join(GC, token)) } catch { } }

  const child = proc.spawn(process.execPath, ['index.js', '--dry', '--save-token', '--token', token], {
    cwd: GC,
    windowsHide: true,
  })

  const link: Link = { id, label: clean, token, url: null, steamid: null, error: null, done: false, child, lines: [], relink: target?.id ?? null, user }
  links.set(user, link)

  const read = (b: Buffer) => {
    for (const raw of String(b).split(/\r?\n/)) {
      const l = raw.trim()
      if (!l) continue
      link.lines.push(l)
      if (l.startsWith('QRURL ')) link.url = l.slice(6).trim()
      if (l.startsWith('STEAMID ')) {
        link.steamid = l.slice(8).trim()
        finish()
      }
    }
    onChange()
  }

  const finish = () => {
    if (link.done) return
    if (!link.steamid) return
    // Пользователя отключили, пока шёл вход (решение 10): поздний ответ
    // ничего не добавляет и не заменяет, временный токен — в корзину.
    if (!accountsHooks.userActive(user)) {
      try { fs.unlinkSync(path.join(GC, link.token)) } catch { }
      link.error = 'доступ отключён владельцем'
      link.done = true
      try { link.child?.kill() } catch { }
      onChange()
      return
    }
    if (link.relink) {
      const a = own(link.relink, user)
      const tmp = path.join(GC, link.token)
      if (!a || a.steamid !== link.steamid) {
        try { fs.unlinkSync(tmp) } catch { }
        link.error = a
          ? 'вошли другим Steam (' + link.steamid + '), а сессия обновлялась для «' + a.label + '» (' + a.steamid + ')'
          : 'аккаунт пропал из реестра'
      } else {
        // Тот же Steam — новый токен становится сессией аккаунта.
        fs.renameSync(tmp, path.join(GC, a.token))
        forgetWeb(a.id)   // старый статус и куки относились к отозванной сессии
      }
      link.done = true
      try { link.child?.kill() } catch { }
      onChange()
      return
    }
    // Тот же аккаунт дважды не заводим: сессия перезапишется, а строк станет две.
    // Чужой — без названия и без признака, чей он (решение 11).
    const already = reg.list.find(a => a.steamid === link.steamid)
    if (already) {
      if (ownerOf(already) !== user) { try { fs.unlinkSync(path.join(GC, link.token)) } catch { } }
      link.error = ownerOf(already) === user ? 'этот аккаунт уже привязан как «' + already.label + '»' : 'этот Steam привязать нельзя'
      link.done = true
      try { link.child?.kill() } catch { }
      onChange()
      return
    }
    addAccount({ id: link.id, label: link.label, steamid: link.steamid, token: link.token, added: Date.now(), user })
    link.done = true
    try { link.child?.kill() } catch { }
    onChange()
  }

  child.stdout?.on('data', read)
  child.stderr?.on('data', read)
  child.on('exit', () => {
    if (!link.done) {
      // Недоделанное обновление не должно оставить временный токен.
      if (link.relink) { try { fs.unlinkSync(path.join(GC, link.token)) } catch { } }
      link.error = link.error ?? 'вход не подтверждён'
      link.done = true
      onChange()
    }
  })

  return { ok: true, id }
}

export function linkCancel(user = currentUser()) {
  const link = links.get(user)
  if (!link) return { ok: true }
  try { link.child?.kill() } catch { }
  link.done = true
  link.error = link.error ?? 'отменено'
  return { ok: true }
}

// ── веб-вход по QR (план 2.4, решение 2Б) ──
//
// Отдельная сессия WebBrowser только для чтения сайта Steam (план 3.3):
// tools/gcwatch/weblogin.js. Игровой токен и работник не трогаются — вход
// веб-платформой клиента в сеть Steam не пускает и игру не выбивает.
//
// Токен пишется во временный файл и становится веб-входом аккаунта, только
// если вошли тем же Steam: QR, отсканированный не тем телефоном, иначе молча
// подменил бы веб-вход. Временный файл не переживает ни отмены, ни сбоя.

type WebLink = {
  id: string
  label: string
  tmp: string
  url: string | null
  steamid: string | null
  seen: boolean
  error: string | null
  done: boolean
  child: ChildProcess | null
  user: string
}

const webLinks = new Map<string, WebLink>()

export const webTmpFile = (a: Pick<Account, 'id'>) => 'token-web-' + a.id + '.tmp.json'

export function webLinkState(user = currentUser()) {
  const webLink = webLinks.get(user)
  if (!webLink) return null
  const { id, label, url, steamid, seen, error, done } = webLink
  return { id, label, url, steamid, seen, error, done }
}

// Сверка до замены: итоговый файл не трогается, пока steamid не сошёлся.
export function acceptWebToken(id: string, steamid: string, tmp: string): { ok: true } | { error: string } {
  const a = byId(id)
  const from = path.join(GC, tmp)
  const drop = () => { try { fs.unlinkSync(from) } catch { } }
  if (!a) { drop(); return { error: 'аккаунт пропал из реестра' } }
  if (a.steamid !== steamid) {
    drop()
    return { error: 'вошли другим Steam (' + steamid + '), а веб-вход обновлялся для «' + a.label + '» (' + a.steamid + ')' }
  }
  if (!fs.existsSync(from)) return { error: 'вход подтверждён, но веб-токен не записан' }
  fs.renameSync(from, path.join(GC, webTokenFile(a)))
  forgetWeb(a.id)   // куки и итог проверки относились к прежнему токену
  return { ok: true }
}

export function webLinkStart(id: string, onChange: () => void) {
  const user = currentUser()
  const a = own(id, user)
  if (!a) return { error: 'нет такого аккаунта' }
  if (alive(links.get(user)) || alive(webLinks.get(user))) return { error: 'привязка уже идёт' }
  const tmp = webTmpFile(a)
  const tmpPath = path.join(GC, tmp)
  try { fs.unlinkSync(tmpPath) } catch { }   // хвост прошлой попытки

  const child = proc.spawn(process.execPath, ['weblogin.js', '--id', a.id, '--out', tmp], { cwd: GC, windowsHide: true })
  const w: WebLink = { id: a.id, label: a.label, tmp, url: null, steamid: null, seen: false, error: null, done: false, child, user }
  webLinks.set(user, w)

  const finish = (error: string | null) => {
    if (w.done) return
    w.done = true
    w.error = error
    if (error) { try { fs.unlinkSync(tmpPath) } catch { } }
    try { w.child?.kill() } catch { }
    onChange()
  }

  // Вывод не храним: в нём QR рисунком и имя входа Steam.
  const read = (b: Buffer) => {
    for (const raw of String(b).split(/\r?\n/)) {
      const l = raw.trim()
      if (l.startsWith('QRURL ')) w.url = l.slice(6).trim()
      else if (l.startsWith('телефон увидел код')) w.seen = true
      else if (l.startsWith('ERROR ')) w.error = l.slice(6).trim()
      else if (l.startsWith('STEAMID ')) {
        w.steamid = l.slice(8).trim()
        // Отключён, пока шёл вход (решение 10) — веб-токен не принимается.
        const r = accountsHooks.userActive(user) && own(w.id, user)
          ? acceptWebToken(w.id, w.steamid, w.tmp)
          : { error: 'доступ отключён владельцем' }
        finish('error' in r ? r.error : null)
      }
    }
    onChange()
  }

  child.stdout?.on('data', read)
  child.stderr?.on('data', read)
  child.on('error', e => finish('вход не запустился: ' + e.message))
  child.on('exit', () => finish(w.error ?? 'вход не подтверждён'))
  return { ok: true, id: a.id }
}

export function webLinkCancel(user = currentUser()) {
  const w = webLinks.get(user)
  if (!w || w.done) return { ok: true }
  w.done = true
  w.error = 'отменено'
  try { w.child?.kill() } catch { }
  try { fs.unlinkSync(path.join(GC, w.tmp)) } catch { }
  return { ok: true }
}

// ── отвязка ──
//
// Удаляются сессии (игровая и веб) и строка реестра. Журнал расхода остаётся:
// матчи на том аккаунте действительно израсходованы, и если его привяжут
// заново, очередь должна об этом помнить.
export function unlink(id: string) {
  const user = currentUser()
  const a = own(id, user)
  if (!a) return { error: 'нет такого аккаунта' }
  if (listFor(user).length === 1) return { error: 'это единственный аккаунт' }

  try { fs.unlinkSync(path.join(GC, a.token)) } catch { }
  // И веб-вход: без хозяина он остался бы на диске, а аккаунт, получивший
  // потом тот же id, читал бы историю чужого Steam.
  try { fs.unlinkSync(path.join(GC, webTokenFile(a))) } catch { }
  forgetWeb(a.id)
  reg.list = reg.list.filter(x => x.id !== id)
  if (activeIdOf(user) === id) setActiveOf(user, listFor(user)[0].id)
  save(reg)
  return { ok: true }
}

export function rename(id: string, label: string) {
  const a = own(id)
  if (!a) return { error: 'нет такого аккаунта' }
  a.label = String(label).trim() || a.label
  save(reg)
  return { ok: true }
}
