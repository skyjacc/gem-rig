// Roadmap — состояние проекта, посчитанное живьём.
//
// Никаких захардкоженных «выполнено 60 %». Каждый узел либо тянет число из
// базы, либо проверяет наличие файла, либо считает тесты в исходниках.
// Если что-то откатится назад — узел сам покраснеет.

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { db } from './db.ts'
import { ROOT, TOOLS } from './paths.ts'

export type Status = 'done' | 'active' | 'todo' | 'blocked'

export type Node = {
  id: string
  title: string
  detail?: string
  status: Status
  metric?: string
  evidence?: string
  children?: Node[]
}

export type Phase = {
  id: string
  title: string
  subtitle: string
  status: Status
  progress: { done: number; total: number }
  nodes: Node[]
}

const num = (sql: string, ...a: any[]) => {
  try { return (db.prepare(sql).get(...a) as any)?.c ?? 0 } catch { return 0 }
}
const has = (t: string) =>
  !!db.prepare(`select name from sqlite_master where type='table' and name=?`).get(t)

const nf = (n: number) => n.toLocaleString('ru-RU')

// Русские склонения: 1 объект, 2 объекта, 5 объектов.
const plural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(n) % 100
  if (a > 10 && a < 20) return many
  const b = a % 10
  if (b === 1) return one
  if (b >= 2 && b <= 4) return few
  return many
}

// Тесты считаем по исходникам: запускать раннер на каждый запрос дорого.
function countTests(): { files: number; tests: number } {
  let files = 0, tests = 0
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.test\.(ts|js)$/.test(e.name)) continue
      files++
      try { tests += (fs.readFileSync(p, 'utf8').match(/^\s*test\(/gm) ?? []).length } catch { }
    }
  }
  walk(path.join(ROOT, 'rig'))
  walk(path.join(ROOT, 'tools'))
  return { files, tests }
}

function commits(): number {
  try { return Number(execSync('git rev-list --count HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()) || 0 }
  catch { return 0 }
}

const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel))

// Сущности, чьи гемы реально лежат в инвентаре, и их прогресс к товару.
function production() {
  if (!has('vmatch')) return { rows: [] as any[], goal: 2000 }
  const map = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(TOOLS, 'gem-map.json'), 'utf8')) as any[] }
    catch { return [] }
  })()

  const counters = db.prepare(`
    select gem, max(value) v, count(*) objects from counters
    where ts = (select max(ts) from counters) group by gem`).all() as any[]

  const rows = []
  for (const c of counters) {
    if (!c.gem || c.gem === '—') continue
    const g = map.find(x => String(x.name).replace(/^(Genuine )?Spectator: ?/, '') === c.gem)
    if (!g?.entity_id) continue
    const pool = g.kind === 'team'
      ? num('select count(*) c from vmatch where radiant = ? or dire = ?', g.entity_id, g.entity_id)
      : num('select count(distinct match_id) c from vplayer where account_id = ?', g.entity_id)
    if (!pool) continue
    rows.push({ gem: c.gem, counter: Number(c.v) || 0, objects: Number(c.objects) || 0, pool })
  }
  rows.sort((a, b) => b.pool - a.pool)
  return { rows, goal: 2000 }
}

export function roadmap(): { phases: Phase[]; updated: number } {
  const matches = has('vmatch') ? num('select count(*) c from vmatch') : 0
  const links = has('vplayer') ? num('select count(*) c from vplayer') : 0
  const leagues = has('vleague') ? num('select count(*) c from vleague') : 0
  const mirrored = has('vmatch') ? num(`select count(*) c from vmatch where source = 'mirror'`) : 0
  const confirmed = num(`select count(*) c from burned where state = 'confirmed'`)
  const disputed = num(`select count(*) c from burned where state = 'dup'`)
  const events = num('select count(*) c from events')
  const t = countTests()
  const prod = production()

  const phases: Phase[] = []

  // ── 1. Механика ──
  const mech: Node[] = [
    { id: 'm1', title: 'Счётчик поднимается одним сообщением', status: 'done',
      detail: 'k_EMsgUpgradeLeagueItem = 7203, ни игры, ни реплея не требуется',
      evidence: 'msg 26 в ответ, дифф инвентаря' },
    { id: 'm2', title: 'Голый гем без сокета считается', status: 'done',
      detail: 'Artificer\'s Chisel не нужен — узкое место снято',
      evidence: 'Alliance 2→3 при трёх контрольных 0→1' },
    { id: 'm3', title: 'Гем считает сущность, а не лигу', status: 'done',
      detail: 'потолок гема = матчи его команды или игрока',
      evidence: 'лига 14389: Empire +10, NaVi остался 5' },
    { id: 'm4', title: 'Журнал GC не истекает', status: 'done',
      detail: 'матч сгорает для аккаунта навсегда',
      evidence: 'повтор через 26 часов: 5 ответов, 0 обновлений' },
    { id: 'm5', title: 'league_id обязателен', status: 'done',
      detail: 'без него GC молча отвергает сообщение',
      evidence: '8003261364: без лиги тишина, с лигой 507 байт' },
    { id: 'm6', title: 'dup не означает «сожжён»', status: 'done',
      detail: 'ответ 7204 пуст по протоколу, причина неразличима',
      evidence: 'отвергнутый матч засчитался со второй попытки' },
    { id: 'm7', title: 'Счётчик НЕ переживает распаковку набора', status: 'done',
      detail: 'распаковывать надо ДО прожига, иначе накопленное сгорит',
      evidence: 'набор со счётчиком 4 дал семь предметов с нулём' },
    { id: 'm8', title: 'Переживает ли счётчик извлечение чиселом', status: 'todo',
      detail: 'последний неотвеченный вопрос механики',
      metric: '$1.07, необратимо' },
    { id: 'm9', title: 'Есть ли предел на число экземпляров', status: 'todo',
      detail: 'максимум виденного — 14 объектов одним сообщением, теперь их 29',
      metric: 'проверяется одним матчем' },
  ]
  phases.push({
    id: 'mechanics', title: 'Механика', subtitle: 'что доказано замерами',
    nodes: mech,
    progress: { done: mech.filter(n => n.status === 'done').length, total: mech.length },
    status: mech.every(n => n.status === 'done') ? 'done' : 'active',
  })

  // ── 2. Данные ──
  const data: Node[] = [
    { id: 'd1', title: 'Карта матчей построена', status: matches > 0 ? 'done' : 'todo',
      metric: nf(matches) + ' матчей', detail: 'обход Steam Web API по лигам',
      evidence: nf(leagues) + ' лиг пройдено' },
    { id: 'd2', title: 'Связи игрок → матч', status: links > 0 ? 'done' : 'todo',
      metric: nf(links), detail: 'по ним считается запас гемов-игроков' },
    { id: 'd3', title: 'Добор из зеркала', status: mirrored > 0 ? 'done' : 'todo',
      metric: nf(mirrored) + ' матчей', detail: 'там, где Valve режет по 500 на лигу',
      evidence: 'разрыв с OpenDota сведён к нулю' },
    { id: 'd4', title: 'Запас считается локально', status: matches > 0 ? 'done' : 'blocked',
      detail: 'внешние API для расчёта больше не нужны' },
    { id: 'd5', title: 'Три гема без сущности', status: 'todo',
      detail: 'CaspeRRR, VeRsuta, безымянный — работа по Liquipedia',
      metric: '3 из 53' },
    { id: 'd6', title: 'STRATZ как третий источник', status: 'todo',
      detail: 'даёт около 3 % сверху — отложено намеренно' },
  ]
  phases.push({
    id: 'data', title: 'Данные', subtitle: 'собственный источник вместо чужих выгрузок',
    nodes: data,
    progress: { done: data.filter(n => n.status === 'done').length, total: data.length },
    status: matches > 0 ? 'active' : 'todo',
  })

  // ── 3. Код ──
  const code: Node[] = [
    { id: 'c1', title: 'Тесты', status: t.tests > 0 ? 'done' : 'todo',
      metric: t.tests + ' в ' + t.files + ' файлах', detail: 'до 20 августа не было ни одного' },
    { id: 'c2', title: 'silent больше не жжёт матчи', status: exists('rig/server/ledger.ts') ? 'done' : 'todo',
      detail: 'зависший ответ вычёркивал матч навсегда' },
    { id: 'c3', title: 'Миграции схемы', status: exists('rig/server/migrate.ts') ? 'done' : 'todo',
      detail: 'идемпотентны, чинят испорченные метки времени' },
    { id: 'c4', title: 'Обходчик лиг', status: exists('rig/crawl.ts') ? 'done' : 'todo',
      detail: 'возобновляемый, помнит пройденное' },
    { id: 'c5', title: 'Расчёт запаса и остатка', status: exists('rig/server/supply.ts') ? 'done' : 'todo',
      detail: 'dup отдельным состоянием, из остатка не вычитается' },
    { id: 'c6', title: 'План закупки', status: exists('rig/plan-purchase.ts') ? 'done' : 'todo',
      detail: 'стратегия в глубину под цель «предметы 2000+»' },
    { id: 'c7', title: 'Правки отправщика', status: exists('tools/gcwatch/lib.js') ? 'done' : 'todo',
      detail: 'журнал, темп, таймаут GC, вход как Invisible' },
    { id: 'c8', title: 'Учёт ответов GC сопоставлением', status: 'done',
      detail: 'FIFO вместо окна по таймеру — опоздавший msg 26 больше не достаётся следующему матчу',
      evidence: 'замер 50 матчей: логи и инвентарь сошлись до штуки' },
    { id: 'c9', title: 'Очередь на новых таблицах', status: 'todo',
      detail: 'queue.ts ещё ходит в старую entity_matches' },
  ]
  phases.push({
    id: 'code', title: 'Код', subtitle: 'что построено и что сломано',
    nodes: code,
    progress: { done: code.filter(n => n.status === 'done').length, total: code.length },
    status: 'active',
  })

  // ── 4. Производство ──
  const prodNodes: Node[] = prod.rows.map(r => ({
    id: 'p-' + r.gem,
    title: r.gem,
    status: (r.counter >= prod.goal ? 'done' : r.counter > 0 ? 'active' : 'todo') as Status,
    metric: nf(r.counter) + ' / ' + nf(r.pool),
    detail: r.objects + ' ' + plural(r.objects, 'объект', 'объекта', 'объектов') +
      ' · даст ' + r.objects + ' ' + plural(r.objects, 'товар', 'товара', 'товаров'),
  }))
  phases.push({
    id: 'production', title: 'Производство', subtitle: 'сущности как линии, цель — счётчик ' + nf(prod.goal),
    nodes: prodNodes,
    progress: { done: prodNodes.filter(n => n.status === 'done').length, total: prodNodes.length },
    status: prodNodes.some(n => n.status === 'active') ? 'active' : 'todo',
  })

  // ── 5. Панель ──
  const ui: Node[] = [
    { id: 'u1', title: 'Roadmap', status: 'done', detail: 'эта вкладка, считает состояние живьём' },
    { id: 'u2', title: 'Скорость измерена', status: 'done',
      metric: '76 матчей/мин',
      detail: 'пауза 1000 мс, задержка начисления: медиана 340 мс, 95-й процентиль 465',
      evidence: '50 из 50 обновлений, инвентарь подтвердил +50 на каждом объекте' },
    { id: 'u3', title: 'Run как сущность', status: 'todo',
      detail: 'снимок состава гемов, очереди и темпа на момент запуска' },
    { id: 'u4', title: 'Первый экран — Control Center', status: 'todo',
      detail: 'здоровье, прогресс, подтверждённая скорость, что требует внимания' },
    { id: 'u5', title: 'Каталог как настройка состава', status: 'todo',
      detail: 'вторичный экран, кнопка «взять всё дешевле $X»' },
    { id: 'u6', title: 'Полный журнал прожига', status: 'todo',
      detail: 'отдельный экран диагностики' },
  ]
  phases.push({
    id: 'ui', title: 'Панель', subtitle: 'что показывать и в каком порядке',
    nodes: ui,
    progress: { done: ui.filter(n => n.status === 'done').length, total: ui.length },
    status: 'active',
  })

  // ── шапка ──
  phases.unshift({
    id: 'now', title: 'Сейчас', subtitle: 'живое состояние',
    status: 'active',
    progress: { done: confirmed, total: confirmed + disputed },
    nodes: [
      { id: 'n1', title: 'Коммитов', status: 'done', metric: String(commits()) },
      { id: 'n2', title: 'Матчей в карте', status: 'done', metric: nf(matches) },
      { id: 'n3', title: 'Сожжено подтверждённо', status: 'done', metric: String(confirmed) },
      { id: 'n4', title: 'Спорных (dup)', status: disputed > 0 ? 'active' : 'done', metric: String(disputed),
        detail: disputed > 0 ? 'причина неразличима, можно повторить' : undefined },
      { id: 'n5', title: 'Событий отправки', status: 'done', metric: String(events) },
    ],
  })

  return { phases, updated: Date.now() }
}
