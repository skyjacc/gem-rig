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
import { forgetWeb } from './steamweb.ts'

export type Account = {
  id: string
  label: string
  steamid: string
  token: string
  added: number
}

type Registry = { active: string; list: Account[] }

const FILE = path.join(TOOLS, 'accounts.json')

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

export const list = () => reg.list
export const activeId = () => reg.active
export const active = () => reg.list.find(a => a.id === reg.active) ?? reg.list[0]

// steamid текущего аккаунта. Журнал расхода ведётся по нему.
export const ACCOUNT = () => active()?.steamid || STEAMID

export function byId(id: string) {
  return reg.list.find(a => a.id === id) ?? null
}

export function setActive(id: string) {
  if (!byId(id)) return { error: 'нет такого аккаунта' }
  reg.active = id
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
}

let link: Link | null = null

export function linkState() {
  if (!link) return null
  const { id, label, url, steamid, error, done, relink } = link
  return { id, label, url, steamid, error, done, relink, lines: link.lines.slice(-12) }
}

// Сессия протухает: смена пароля, «выйти на всех устройствах», сброс
// Steam Guard — и refresh-токен Steam отзывает. Отправщик тогда не войдёт,
// а привязать тот же Steam заново как новый аккаунт нельзя (он уже есть).
// Поэтому relink: тот же вход по QR, но для существующей строки реестра.
export function linkStart(label: string, onChange: () => void, relink: string | null = null) {
  if (link && !link.done && link.child && link.child.exitCode === null) {
    return { error: 'привязка уже идёт' }
  }
  const target = relink ? byId(relink) : null
  if (relink && !target) return { error: 'нет такого аккаунта' }
  const clean = target ? target.label : (String(label || '').trim() || 'второй')
  const id = target ? target.id : slug(clean, reg.list.map(a => a.id))
  // Новый токен — во временный файл: прежний не трогаем, пока не убедимся,
  // что вошли тем же Steam. Старый хвост от прошлой попытки убираем, иначе
  // отправщик вошёл бы по нему без QR — возможно, чужим аккаунтом.
  const token = target ? 'token-relink-' + target.id + '.json' : 'token-' + id + '.json'
  if (target) { try { fs.unlinkSync(path.join(GC, token)) } catch { } }

  const child = spawn(process.execPath, ['index.js', '--dry', '--save-token', '--token', token], {
    cwd: GC,
    windowsHide: true,
  })

  link = { id, label: clean, token, url: null, steamid: null, error: null, done: false, child, lines: [], relink: target?.id ?? null }

  const read = (b: Buffer) => {
    for (const raw of String(b).split(/\r?\n/)) {
      const l = raw.trim()
      if (!l) continue
      link!.lines.push(l)
      if (l.startsWith('QRURL ')) link!.url = l.slice(6).trim()
      if (l.startsWith('STEAMID ')) {
        link!.steamid = l.slice(8).trim()
        finish()
      }
    }
    onChange()
  }

  const finish = () => {
    if (!link || link.done) return
    if (!link.steamid) return
    if (link.relink) {
      const a = byId(link.relink)
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
    const already = reg.list.find(a => a.steamid === link!.steamid)
    if (already) {
      link.error = 'этот аккаунт уже привязан как «' + already.label + '»'
      link.done = true
      try { link.child?.kill() } catch { }
      onChange()
      return
    }
    reg.list.push({ id: link.id, label: link.label, steamid: link.steamid, token: link.token, added: Date.now() })
    save(reg)
    link.done = true
    try { link.child?.kill() } catch { }
    onChange()
  }

  child.stdout?.on('data', read)
  child.stderr?.on('data', read)
  child.on('exit', () => {
    if (link && !link.done) {
      // Недоделанное обновление не должно оставить временный токен.
      if (link.relink) { try { fs.unlinkSync(path.join(GC, link.token)) } catch { } }
      link.error = link.error ?? 'вход не подтверждён'
      link.done = true
      onChange()
    }
  })

  return { ok: true, id }
}

export function linkCancel() {
  if (!link) return { ok: true }
  try { link.child?.kill() } catch { }
  link.done = true
  link.error = link.error ?? 'отменено'
  return { ok: true }
}

// ── отвязка ──
//
// Удаляется только сессия и строка реестра. Журнал расхода остаётся:
// матчи на том аккаунте действительно израсходованы, и если его привяжут
// заново, очередь должна об этом помнить.
export function unlink(id: string) {
  const a = byId(id)
  if (!a) return { error: 'нет такого аккаунта' }
  if (reg.list.length === 1) return { error: 'это единственный аккаунт' }

  try { fs.unlinkSync(path.join(GC, a.token)) } catch { }
  reg.list = reg.list.filter(x => x.id !== id)
  if (reg.active === id) reg.active = reg.list[0].id
  save(reg)
  return { ok: true }
}

export function rename(id: string, label: string) {
  const a = byId(id)
  if (!a) return { error: 'нет такого аккаунта' }
  a.label = String(label).trim() || a.label
  save(reg)
  return { ok: true }
}
