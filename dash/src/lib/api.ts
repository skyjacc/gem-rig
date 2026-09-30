// Связь с сервером. Одна подписка на поток, ничего не опрашиваем.

import { useCallback, useEffect, useRef, useState } from 'react'
import snapshot from '../demo/snapshot.json'

// Режим показа.
//
// Панель без сервера: данные берутся из снимка, сложенного в саму сборку,
// поток не открывается, ни один запрос наружу не уходит. Нужен ровно для
// одного — дать ссылку, по которой интерфейс можно посмотреть, не заводя
// аккаунта и не подпуская чужого человека к живой сессии Steam.
//
// Снимок обезличен: steamid подменён, номера вещей заменены.
export const DEMO = import.meta.env.VITE_DEMO === '1'
const SNAP: any = snapshot

export type Kind = 'team' | 'player' | 'league' | 'studio' | 'unknown' | null
export type SupplyKind = 'measured' | 'estimated' | 'empty'
export type ActionId = 'idle' | 'start' | 'restart' | 'rebuild' | 'watch' | 'halt'

export type Gem = {
  gem: string
  items: number
  equipped: number
  min: number | null
  max: number
  icon: string
  heroes: string
  kind: Kind
  entityId: number | null
  entityName: string | null
  supply: number | null
  left: number | null
  spent: number | null
  supplyKind: SupplyKind
  bare: number
  socketed: number
  // Сколько вещей гема отложено из фарма на продажу.
  aside: number
  // Значка у отдельной вещи нет: он один на весь гем и лежит выше, в icon
  // группы. Хеш картинки Steam — полторы сотни знаков на вещь, и на шестистах
  // вещах это сто килобайт одного и того же текста в каждом снимке.
  rows: {
    assetid: string
    name: string
    hero: string
    value: number
    equipped: boolean
    // Чем несётся счётчик: голый самоцвет или предмет с вставленным.
    carrier: 'gem' | 'item'
    aside: boolean
  }[]
}

export type CatalogRow = {
  name: string
  short: string
  price: string
  icon: string
  market: string
  supply: number | null
  supplyKind: SupplyKind
  ownedItems: number
}

export type SendEvent = {
  ts: number
  n: number | null
  total: number | null
  match_id: string
  league_id: string
  result: 'update' | 'dup' | 'silent'
  bytes: number
  account?: string | null
}

// Инвентарь одного аккаунта: возраст снимка и его беда, если она есть.
// Одно общее поле врало бы про всех, кроме активного.
export type InvState = {
  error: string | null
  private: boolean
  truncated: boolean
  age: number | null
  items: number
}

export type Unit = {
  id: string
  label: string
  steamid: string
  enabled: boolean
  // Когда работника включили. Нужно, чтобы полосу срока было чем заполнить.
  startedAt?: number
  delay: number
  auto: boolean
  target: number | null
  until?: number
  // До какого счётчика вести каждый гем; 0 — жечь весь запас матчей.
  cap?: number
  caps?: { gem: string; cap: number }[]
  capped?: string[]
  // Растяжка: работа делится на оставшееся до срока время.
  even?: boolean
  needSends?: number
  sendsLeft?: number
  done: number
  queueLength: number
  action: ActionId
  why: string
  lastTick: number
  rebuiltAt: number
  failures: number
  // Сколько раз аккаунт выбило другой сессией Steam и почему возвращаться
  // бессмысленно, если бессмысленно.
  displaced?: number
  fatal?: string | null
  running: boolean
  pid: number | null
  exit: string | null
  lines: string[]
  burned: number
  etaMinutes: number
  inv?: InvState
  log: { ts: number; action: string; why: string }[]
  ordered?: number | null
  waves?: number
  plan?: Wave[]
  nextWave?: Wave | null
  // Какие гемы жечь на этом аккаунте: null — все из инвентаря.
  only?: string[] | null
  available?: { gem: string; objects: number }[]
  picked?: string[]
}

export type Pace = { suggest: number; why: string; measured: number; silent: number; atDelay: number }

export type Wave = { index: number; addAt: number; value: number }

export type Autopilot = Unit & {
  goal: number
  objects: number
  gems: { gem: string; objects: number }[]
  units: Unit[]
  pace: Pace | null
}

export type PurchaseRun = {
  active: boolean
  cancel: boolean
  startedAt: number
  finishedAt: number
  currency: string
  planned: number
  done: number
  ok: number
  spent: number
  current: string
  pass: number
  positions: { gem: string; asked: number; got: number; done: boolean; why: string }[]
  error: string | null
  log: { ts: number; gem: string; ok: boolean; price: number; planned?: number; reason: string; detail?: string }[]
}

// Ровно то, что собирает buildState на сервере, и ничего сверх.
//
// Раньше здесь было вдвое больше полей — chart, files, seam, bundles, delay,
// current, steamid, sender, watched, — и ни одно из них фронт не читал.
// Сервер считал их на каждый толчок состояния, то есть примерно раз в секунду.
export type State = {
  ts: number
  events: SendEvent[]
  mine: Gem[]
  catalog: CatalogRow[]
  autopilot: Autopilot
  purchase: PurchaseRun
  confirmed: { ts: number; match_id: string; league_id: string; bytes: number } | null
  rate: number
  inv: InvState
  burned: number
  keys: { opendota: boolean; steam: boolean }
  // Сканер прихода: open — выигрыши, ждущие решения.
  arrivals: { open: number; wins: number; fresh: number }
  // Судьба dup: ждут повтора, брошены после повтора, засчитались со второй.
  dups: { waiting: number; exhausted: number; resolved: number }
}

export type AccountRow = {
  id: string
  label: string
  steamid: string
  token: string
  added: number
  session: boolean
  burned: number
}

export type Settings = {
  goal: number
  tick: number
  silentLimit: number
  startLimit: number
  maxFailures: number
  invTtl: number
  invStale: number
  treeTop: number
  sellPrice: number
  perGem: number
  priceTolerance: number
  pace: { floor: number; ceil: number; enough: number; clean: number; down: number; up: number }
  spread: { band: number; jitter: number }
}

export type Accounts = {
  active: string | null
  link: { id: string; label: string; url: string | null; steamid: string | null; error: string | null; done: boolean; lines: string[] } | null
  list: AccountRow[]
}

export type GraphData = {
  scope: 'owned' | 'all'
  nodes: { key: string; kind: string; id: number; owned: number; pool: number; burned: number; price: number | null; counter: number; icon: string }[]
  edges: { a: string; b: string; shared: number }[]
}

export type Kit = {
  key: string
  hero: string
  set: string
  gem: string
  icon: string
  items: number      // сколько предметов этого набора лежит
  pieces: number     // из скольких частей набор состоит
  distinct: number   // сколько разных частей есть
  missing: string[]
  complete: number   // сколько полных комплектов собирается
  spare: number      // предметов сверх комплектов
  min: number
  max: number
  equipped: number
  bare: number
  ready: boolean
}

export type Pool = { goal: number; kits: Kit[] }

export type QueueData = {
  total: number
  weight2: number
  rows: { match: string; league: string; weight: number; entities: string[] }[]
}

// Через сколько молчания поток считается оборванным.
//
// Сервер шлёт пульс раз в пятнадцать секунд даже когда ничего не меняется,
// поэтому тишина дольше сорока — это обрыв, а не затишье. Без этого панель
// показывала вчерашние числа так же уверенно, как сегодняшние: EventSource
// молчит при разрыве по дороге, и onerror не приходит.
const SILENCE = 40_000

export type Live = {
  state: State | null
  online: boolean
  // Данные на экране устарели: связь есть или нет, но свежего снимка нет.
  stale: boolean
  // Когда пришёл последний снимок.
  at: number
}

export function useLive(): Live {
  const [state, setState] = useState<State | null>(DEMO ? (SNAP.state as State) : null)
  const [online, setOnline] = useState(DEMO)
  const [at, setAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (DEMO) return
    const s = new EventSource('/api/stream')
    const beat = () => { setOnline(true); setAt(Date.now()) }
    s.onopen = beat
    s.onerror = () => setOnline(false)
    s.onmessage = e => {
      try { setState(JSON.parse(e.data)) } catch { return }
      beat()
    }
    return () => s.close()
  }, [])

  // Отдельные часы для протухания. Состояние обновляется от сервера, и без
  // своих часов «данные устарели» появлялось бы ровно тогда, когда приходят
  // свежие данные, то есть никогда.
  useEffect(() => {
    if (DEMO) return
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])

  return { state, online, at, stale: !DEMO && !!state && now - at > SILENCE }
}

// Запрос, который сам обновляется по тику потока состояния.
const CANNED: Record<string, string> = {
  '/api/accounts': 'accounts',
  '/api/settings': 'settings',
}

function canned(url: string) {
  const exact = CANNED[url]
  if (exact) return SNAP[exact]
  if (url.startsWith('/api/tree')) return SNAP.tree
  if (url.startsWith('/api/queue')) return SNAP.queue
  if (url.startsWith('/api/graph')) return url.includes('all') ? SNAP.graphAll : SNAP.graphOwned
  return null
}

export type Json<T> = {
  data: T | null
  loading: boolean
  error: string | null
  reload: () => void
}

// Вторичный экран, который обновляется по потоку — но не чаще, чем нужно.
//
// Зависимостью сюда приходит state.ts, а он меняется на КАЖДЫЙ толчок,
// то есть примерно раз в секунду во время работы. От этого панель раз
// в секунду перезапрашивала /api/market (сотни запросов к базе плюс поход
// на площадку), /api/pool, /api/graph и /api/tree — и граф, у которого
// раскладка живёт в ответе, дёргался без остановки.
//
// Метка огрубляется: десять секунд вместо секунды. Всё, что должно быть
// мгновенным — ход закупки, состояние работника, — и так приходит потоком.
export function useJson<T>(url: string | null, dep: unknown, everyMs = 10_000): Json<T> {
  const [data, setData] = useState<T | null>(DEMO && url ? (canned(url) as T) : null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const coarse = typeof dep === 'number' && everyMs > 0 ? Math.floor(dep / everyMs) : dep

  useEffect(() => {
    if (!url || DEMO) return
    let alive = true
    setLoading(true)
    fetch(url)
      .then(async r => {
        if (!r.ok) throw new Error('сервер ответил ' + r.status)
        return r.json()
      })
      .then(d => {
        if (!alive) return
        // Ошибку сервер отдаёт полем, а не кодом: без этого экран показывал
        // бы «пусто» там, где на самом деле поломка.
        if (d && typeof d === 'object' && typeof d.error === 'string' && !Array.isArray(d)) setError(d.error)
        else setError(null)
        setData(d)
      })
      .catch(e => { if (alive) setError(e.message || 'нет связи с сервером') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [url, coarse, nonce])

  const reload = useCallback(() => setNonce(n => n + 1), [])
  return { data, loading, error, reload }
}

export async function post(url: string, body: unknown) {
  // В показе ничего не отправляется. Это не заглушка ради вида: за кнопкой
  // «запустить» стоят необратимые сообщения игровому координатору.
  if (DEMO) return { error: 'показ: панель без сервера, ничего не отправляется' }
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok && !d?.error) return { error: 'сервер ответил ' + r.status }
    return d
  } catch (e: any) {
    // Сеть отвалилась. Молчаливый провал у кнопки, за которой необратимое
    // действие, — худшее из возможных поведений: человек думает, что нажал.
    return { error: e?.message ? 'не дошло до сервера: ' + e.message : 'не дошло до сервера' }
  }
}

// Кнопка, за которой запрос.
//
// Три состояния вместо одного: идёт, вышло, не вышло. Раньше post() звали
// прямо из onClick и результат выбрасывали — нажатие на «остановить» при
// упавшем сервере выглядело точно так же, как удачное.
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const run = useCallback(async (url: string, body: unknown) => {
    setBusy(true)
    setError(null)
    const r: any = await post(url, body)
    setBusy(false)
    if (r?.error) { setError(String(r.error)); return r }
    setOk(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOk(false), 1600)
    return r
  }, [])

  return { run, busy, error, ok, clear: () => setError(null) }
}

// ── формат ──

export const nf = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

export const ago = (ts: number, now: number) => {
  if (!ts) return 'никогда'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return s + ' с'
  if (s < 3600) return Math.round(s / 60) + ' мин'
  return Math.round(s / 3600) + ' ч'
}

export const span = (min: number) => {
  if (!min) return '—'
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? h + ' ч ' + m + ' мин' : m + ' мин'
}

export const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

// Склонение: «1 матч», «2 матча», «5 матчей».
export const plural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(n) % 100
  if (a > 10 && a < 20) return many
  const b = a % 10
  if (b === 1) return one
  if (b >= 2 && b <= 4) return few
  return many
}

// Настоящая картинка предмета из Steam. В инвентаре лежит только хеш.
export const icon = (hash: string, size = 96) =>
  hash ? `https://community.akamai.steamstatic.com/economy/image/${hash}/${size}fx${size}f` : ''
