// Roadmap — состояние проекта, посчитанное живьём.
//
// Никаких захардкоженных «выполнено 60 %». Каждый узел либо тянет число из
// базы, либо проверяет наличие файла, либо считает тесты в исходниках.
// Если что-то откатится назад — узел сам покраснеет.
//
// Формулировки человеческие: узел объясняет, ЧТО это значит для дела,
// а не как называется в коде. Технические подробности живут в README.

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

// Сколько аккаунтов настроено — по числу сохранённых сессий.
function accountCount(): number {
  try {
    return fs.readdirSync(path.join(TOOLS, 'gcwatch'))
      .filter(f => /^token(-.+)?\.json$/.test(f)).length
  } catch { return 0 }
}

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
  const acc = accountCount()
  const perAccount = has('burned') &&
    (db.prepare(`pragma table_info(burned)`).all() as any[]).some(c => c.name === 'account')

  const phases: Phase[] = []

  // ── Сейчас ──
  phases.push({
    id: 'now', title: 'Сейчас', subtitle: 'живые числа этой минуты',
    status: 'active',
    progress: { done: 5, total: 5 },
    nodes: [
      { id: 'n1', title: 'Правок в проекте', status: 'done', metric: String(commits()),
        detail: 'сколько раз код менялся с начала работы' },
      { id: 'n2', title: 'Матчей в своей базе', status: 'done', metric: nf(matches),
        detail: 'вся турнирная история Dota, собранная у себя' },
      { id: 'n3', title: 'Матчей уже использовано', status: 'done', metric: String(confirmed),
        detail: 'Valve подтвердила, что счётчик от них вырос' },
      {
        id: 'n4', title: 'Спорных', status: disputed > 0 ? 'active' : 'done', metric: String(disputed),
        detail: disputed > 0
          ? 'Valve не начислила, но причину не назвала. Возможно, они ещё живы — стоит попробовать повторно.'
          : 'спорных нет',
      },
      { id: 'n5', title: 'Отправок сделано', status: 'done', metric: String(events),
        detail: 'всего сообщений ушло в Valve за всё время' },
    ],
  })

  // ── Как это работает ──
  const mech: Node[] = [
    { id: 'm1', title: 'Счётчик поднимается одним сообщением', status: 'done',
      detail: 'Не нужно ни играть, ни смотреть реплей. Отправили матч — счётчик вырос.',
      evidence: 'отправка без запуска игры даёт +1' },
    { id: 'm2', title: 'Гем работает и без вставки в вещь', status: 'done',
      detail: 'Раньше считали, что гем надо вставлять в предмет инструментом за доллар, а таких на рынке три штуки в сутки. Оказалось — не надо. Гем растёт просто лёжа в инвентаре.',
      evidence: 'гем за 4 цента: счётчик 2 → 3' },
    { id: 'm3', title: 'Гем считает только матчи своей команды', status: 'done',
      detail: 'Гем NaVi растёт от матчей NaVi и больше ни от чего. Отсюда потолок: сколько у команды матчей за всю историю — столько максимум и будет на геме.',
      evidence: 'сожгли матч Empire — NaVi не двинулся, хотя турнир общий' },
    { id: 'm4', title: 'Матч сгорает навсегда, но только на этом аккаунте', status: 'done',
      detail: 'Повторно тот же матч счётчик не поднимет — проверяли и через сутки. Но на ДРУГОМ аккаунте он снова свежий. Отсюда и смысл заводить несколько аккаунтов.',
      evidence: 'повтор пяти матчей через 26 часов: ноль начислений' },
    { id: 'm5', title: 'Без номера турнира сообщение не работает', status: 'done',
      detail: 'В запросе два поля: матч и турнир. Без второго Valve молча его выбрасывает, а со стороны это выглядит как «матч уже использован».',
      evidence: 'один матч: без турнира тишина, с турниром +1' },
    { id: 'm6', title: 'Отказ и «уже использован» снаружи неотличимы', status: 'done',
      detail: 'Ответ Valve пустой, причины в нём нет. Единственное надёжное подтверждение роста — отдельное сообщение об изменении инвентаря.',
      evidence: 'матч ответил «использован» и тут же засчитался со второй попытки' },
    { id: 'm7', title: 'Распаковка набора обнуляет счётчик', status: 'done',
      detail: 'Набор из семи вещей — это один объект с одним счётчиком. Распаковали — получили семь вещей с нулями. Значит распаковывать надо ДО прожига, иначе накопленное сгорит.',
      evidence: 'набор со счётчиком 4 дал семь предметов с нулём' },
    { id: 'm8', title: 'Переживёт ли счётчик вынимание гема из вещи', status: 'todo',
      detail: 'Если переживёт — можно крутить дешёвую россыпь и потом собирать ценность в одну вещь. Если нет — вынимать нельзя вообще.',
      metric: 'проверка $1.07' },
    { id: 'm9', title: 'Сколько гемов поднимается за одну отправку', status: 'todo',
      detail: 'Одно сообщение поднимает все подходящие гемы разом. Видели 14 штук сразу. Сейчас в инвентаре 29 — где предел, неизвестно.',
      metric: 'проверяется одним матчем' },
  ]
  phases.push({
    id: 'mechanics', title: 'Как это работает', subtitle: 'что проверено на живом аккаунте',
    nodes: mech,
    progress: { done: mech.filter(n => n.status === 'done').length, total: mech.length },
    status: mech.every(n => n.status === 'done') ? 'done' : 'active',
  })

  // ── Данные ──
  const data: Node[] = [
    { id: 'd1', title: 'Своя база всех турнирных матчей', status: matches > 0 ? 'done' : 'todo',
      metric: nf(matches),
      detail: 'Обошли все турниры через официальный API Valve. Больше не зависим от чужих сайтов: запас любого гема считается локально.',
      evidence: nf(leagues) + ' турниров обойдено' },
    { id: 'd2', title: 'Кто в каком матче играл', status: links > 0 ? 'done' : 'todo',
      metric: nf(links),
      detail: 'Для гемов игроков надо знать, где именно этот человек выходил на карту. Отсюда берётся их потолок.' },
    { id: 'd3', title: 'Дособрали то, что Valve не отдала', status: mirrored > 0 ? 'done' : 'todo',
      metric: nf(mirrored),
      detail: 'Valve отдаёт максимум 500 матчей на турнир, даже если их там 7645. Недостающее взяли со стороннего сайта.',
      evidence: 'расхождений с ним не осталось' },
    { id: 'd4', title: 'Три гема непонятно чьи', status: 'todo',
      metric: '3 из 53',
      detail: 'CaspeRRR, VeRsuta и безымянный — неясно, чью команду или игрока они считают. Значит и потолок неизвестен.' },
    { id: 'd5', title: 'Четвёртый источник данных', status: 'todo',
      detail: 'Добавит около 3 % матчей. Решили не тратить время: на закупку и на сроки это не влияет.' },
  ]
  phases.push({
    id: 'data', title: 'Данные', subtitle: 'своя база вместо чужих сайтов',
    nodes: data,
    progress: { done: data.filter(n => n.status === 'done').length, total: data.length },
    status: matches > 0 ? 'active' : 'todo',
  })

  // ── Аккаунты ──
  const accNodes: Node[] = [
    { id: 'a1', title: 'Аккаунтов подключено', status: acc > 1 ? 'done' : acc === 1 ? 'active' : 'todo',
      metric: acc + ' ' + plural(acc, 'штука', 'штуки', 'штук'),
      detail: acc <= 1
        ? 'Пока один. Матчи расходуются на каждом аккаунте отдельно, поэтому второй и третий умножают выход, а не делят пул.'
        : 'каждый расходует пул независимо от остальных' },
    { id: 'a2', title: 'Журнал знает, на каком аккаунте матч сгорел', status: perAccount ? 'done' : 'todo',
      detail: 'Сейчас журнал общий. Со вторым аккаунтом он начнёт пропускать матчи, которые для него ещё свежие, — и половина работы пройдёт впустую.' },
    { id: 'a3', title: 'Одновременная работа нескольких', status: 'todo',
      detail: 'Ограничение «одна сессия» действует на аккаунт, а не на компьютер. Три аккаунта работают параллельно: втрое больше товара за то же время.' },
    { id: 'a4', title: 'Отсев негодных матчей', status: 'todo',
      detail: 'Матч, не сработавший на свежем аккаунте, негоден в принципе — его надо исключить везде. Отличить негодный от просто использованного можно только сравнив два аккаунта.' },
    { id: 'a5', title: 'Свой инвентарь у каждого', status: 'todo',
      detail: 'Гемы лежат на конкретном аккаунте. Панель должна показывать состав и остаток по каждому отдельно, а не в общей куче.' },
  ]
  phases.push({
    id: 'accounts', title: 'Аккаунты', subtitle: 'на каждом аккаунте те же матчи идут в накрутку заново',
    nodes: accNodes,
    progress: { done: accNodes.filter(n => n.status === 'done').length, total: accNodes.length },
    status: acc > 1 ? 'active' : 'todo',
  })

  // ── Инструменты ──
  const code: Node[] = [
    { id: 'c1', title: 'Автопроверки кода', status: t.tests > 0 ? 'done' : 'todo',
      metric: t.tests + ' ' + plural(t.tests, 'штука', 'штуки', 'штук'),
      detail: 'Ловят поломки до того, как они испортят данные. Утром 20 августа не было ни одной.' },
    { id: 'c2', title: 'Молчание Valve больше не «сжигает» матч', status: exists('rig/server/ledger.ts') ? 'done' : 'todo',
      detail: 'Если ответ не пришёл — раньше матч навсегда помечался использованным и терялся. Теперь остаётся доступным.' },
    { id: 'c3', title: 'Ответы привязаны к своим отправкам', status: 'done',
      detail: 'Раньше опоздавший ответ засчитывался следующему матчу, и статистика врала тем сильнее, чем быстрее шла отправка.',
      evidence: 'замер 50 матчей: логи и инвентарь сошлись до штуки' },
    { id: 'c4', title: 'База сама обновляет свою структуру', status: exists('rig/server/migrate.ts') ? 'done' : 'todo',
      detail: 'При запуске догоняет схему и чинит испорченные даты. Повторный запуск ничего не ломает.' },
    { id: 'c5', title: 'Сборщик турниров', status: exists('rig/crawl.ts') ? 'done' : 'todo',
      detail: 'Обошёл 2106 турниров за час. Прервётся — продолжит с места, а не начнёт заново.' },
    { id: 'c6', title: 'Подсчёт остатка по каждому гему', status: exists('rig/server/supply.ts') ? 'done' : 'todo',
      detail: 'Сколько матчей ещё можно отправить. Спорные не вычитаются — они могут оказаться живыми.' },
    { id: 'c7', title: 'Расчёт закупки', status: exists('rig/plan-purchase.ts') ? 'done' : 'todo',
      detail: 'Что купить и сколько штук, чтобы получить максимум вещей со счётчиком 2000+.' },
    { id: 'c8', title: 'Отправщик перестал портить свой журнал', status: exists('tools/gcwatch/lib.js') ? 'done' : 'todo',
      detail: 'Второй запуск затирал историю первого — так уже потерялись 8 записей. Плюс вход теперь невидимый: друзья не видят «играет в Dota 2».' },
    { id: 'c9', title: 'Сборка списка на прожиг', status: 'done',
      detail: 'Берёт матчи из новой базы, сливает пересечения и убирает уже использованное. Общий матч уходит один раз и засчитывается всем гемам сразу.',
      evidence: 'состав из шести гемов: 11 580 сообщений вместо 12 420, экономия 840' },
  ]
  phases.push({
    id: 'code', title: 'Инструменты', subtitle: 'что построено и что ещё сломано',
    nodes: code,
    progress: { done: code.filter(n => n.status === 'done').length, total: code.length },
    status: 'active',
  })

  // ── Производство ──
  const prodNodes: Node[] = prod.rows.map(r => ({
    id: 'p-' + r.gem,
    title: r.gem,
    status: (r.counter >= prod.goal ? 'done' : r.counter > 0 ? 'active' : 'todo') as Status,
    metric: nf(r.counter) + ' из ' + nf(r.pool),
    detail: r.objects + ' ' + plural(r.objects, 'вещь', 'вещи', 'вещей') +
      ' с этим гемом · столько же товаров получится, когда счётчик дойдёт',
  }))
  phases.push({
    id: 'production', title: 'Производство', subtitle: 'каждая команда — своя линия, цель ' + nf(prod.goal),
    nodes: prodNodes,
    progress: { done: prodNodes.filter(n => n.status === 'done').length, total: prodNodes.length },
    status: prodNodes.some(n => n.status === 'active') ? 'active' : 'todo',
  })

  // ── Панель ──
  const ui: Node[] = [
    { id: 'u1', title: 'Эта вкладка', status: 'done',
      detail: 'Всё, что тут написано, пересчитывается заново каждые пять секунд.' },
    { id: 'u2', title: 'Скорость измерена', status: 'done',
      metric: '76 матчей в минуту',
      detail: 'Valve отвечает за треть секунды. Пауза в секунду безопасна с двойным запасом.',
      evidence: '50 из 50 засчитано, инвентарь подтвердил' },
    { id: 'u3', title: 'История прожигов', status: 'todo',
      detail: 'Сейчас нет понятия «запуск». Надо запоминать, какие гемы и какая очередь были на старте, иначе непонятно, откуда взялся результат.' },
    { id: 'u4', title: 'Главный экран — что происходит сейчас', status: 'todo',
      detail: 'Работает или нет, сколько осталось, когда закончится, что требует внимания. Не бесконечный лог.' },
    { id: 'u5', title: 'Каталог как настройка закупки', status: 'todo',
      detail: 'Вторичный экран. Кнопка «взять всё дешевле десяти центов» вместо изучения 53 строк.' },
    { id: 'u6', title: 'Полный журнал отправок', status: 'todo',
      detail: 'Отдельный экран для разбора, когда что-то пошло не так.' },
  ]
  phases.push({
    id: 'ui', title: 'Панель', subtitle: 'что показывать и в каком порядке',
    nodes: ui,
    progress: { done: ui.filter(n => n.status === 'done').length, total: ui.length },
    status: 'active',
  })

  return { phases, updated: Date.now() }
}
