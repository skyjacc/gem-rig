// Сканер прихода: что лежало в купленном лоте до нас.
//
// Площадка продаёт по имени предмета и счётчиков не видит: в лоте
// «Spectator: Alliance» может лежать и нулевый гем, и прокачанный —
// по одной цене. Закупка и так скупает эти имена сотнями, поэтому каждый
// приход — бесплатный лотерейный билет: вещь, приехавшая с большим числом,
// стоит продать как есть, а не жечь под неё матчи.
//
// Трудность — отличить чужое число от своего. Между покупкой и первым
// взглядом панель успевает отправить десятки сообщений, и каждое
// поднимает свежий гем. Поэтому «наш вклад» считается честно: сколько
// подтверждённых матчей ЭТОЙ сущности ушло за окно до первого взгляда.
// Всё, что сверх него, прилетело из чужой истории.

import type { DatabaseSync } from 'node:sqlite'
import { entityMatchIds } from './supply.ts'

// Сколько назад искать наши отправки. Покрывает доставку трейдом
// и пятиминутный срок перечитывания инвентаря с запасом.
const WINDOW = 15 * 60_000

// Какой излишек считать выигрышем. Полтинник за окно не объяснить даже
// на самой быстрой паузе, а меньшие числа честнее оставить фарму.
const WIN_MIN = 50

export type Verdict = 'старое' | 'чисто' | 'наш' | 'выигрыш'

// Схема живёт здесь, а не в db.ts, чтобы тесты создавали ту же таблицу
// одним источником правды.
export const ARRIVALS_DDL = `
  create table if not exists arrivals (
    assetid  text primary key,
    account  text,
    gem      text,
    item     text,
    carrier  text,
    value    integer,
    expected integer,
    verdict  text,
    aside    integer default 0,
    ts       integer
  );
`

// Вердикт по приходу.
//
//   чисто     приехал нулевым — обычное сырьё фарма
//   наш       число целиком объясняется нашими отправками в окне
//   выигрыш   сверх нашего вклада осталась чужая накрутка — продавать как есть
export function judge(value: number, expected: number, winMin: number = WIN_MIN): Verdict {
  if (value <= 0) return 'чисто'
  if (value - expected >= winMin) return 'выигрыш'
  return 'наш'
}

const norm = (s: string) => String(s ?? '').replace(/^(Genuine\s+)?Spectator:\s*/, '').trim()

// Сколько наших отправок могло попасть в гем за окно до прихода.
//
// Сущность известна — считаем только её матчи. Неизвестна — берём все
// подтверждённые отправки окна: это верхняя граница, и ошибается она
// в дешёвую сторону. Ложный «наш» стоит пропущенной находки, ложный
// «выигрыш» — вещи, отложенной из фарма зря.
export function expectedFor(
  target: DatabaseSync,
  account: string,
  gem: string,
  from: number,
  to: number,
): number {
  let mine: Set<string> | null = null
  try {
    const rows = target.prepare(`select gem, kind, entity_id from supply`).all() as any[]
    const s = rows.find(r => norm(String(r.gem ?? '')) === norm(gem))
    if (s?.kind && s.entity_id) {
      mine = new Set(entityMatchIds(target, { kind: s.kind, id: Number(s.entity_id) }).map(String))
    }
  } catch {
    mine = null // таблиц карты может ещё не быть — считаем по верхней границе
  }

  const burned = target.prepare(
    `select match_id from burned where account = ? and state = 'confirmed' and ts between ? and ?`,
  ).all(String(account), from, to) as any[]

  let n = 0
  for (const r of burned) if (!mine || mine.has(String(r.match_id))) n++
  return n
}

// Первый взгляд на инвентарь: чего раньше не видели, то приход.
//
// Памятью процесса здесь нельзя: панель перезапускается, и без базы
// каждый рестарт объявлял бы приходом весь инвентарь.
export function ingestArrivals(
  target: DatabaseSync,
  account: string,
  rows: { assetid: string; gem: string; name: string; value: number; carrier?: string }[],
  winMin: number = WIN_MIN,
): number {
  target.exec(ARRIVALS_DDL)

  // Первый запуск: всё, что уже есть в истории счётчиков, — старое.
  // Задним числом приход не восстановить: первый срез мог лечь уже
  // после наших отправок, и проверить это нечем. Сканер смотрит
  // только в будущее — с этой секунды.
  const cnt = (target.prepare(`select count(*) c from arrivals`).get() as any).c
  if (!cnt) {
    target.prepare(`
      insert into arrivals (assetid, gem, item, carrier, value, expected, verdict, aside, ts)
      select assetid, max(gem), max(item), max(carrier), null, null, 'старое', 0, null
      from counters group by assetid
    `).run()
  }

  // Первый взгляд на ЭТОТ аккаунт — то же самое, только по аккаунту.
  //
  // Раньше застёжка была одна на всю базу: второй привязанный аккаунт
  // приходил в таблицу, где уже есть записи первого, и весь его инвентарь
  // считался приходом. Вещи с накопленным числом и нулевым вкладом
  // объявлялись выигрышем, а отложенные на продажу выпадали из фарма.
  //
  // Записи без аккаунта — застёжка по истории счётчиков, сделанная, пока
  // аккаунт был один. Они принадлежат тому, кто пришёл первым, если чужих
  // записей в таблице ещё нет.
  const own = (target.prepare(`select count(*) c from arrivals where account = ?`).get(String(account)) as any).c
  const others = (target.prepare(
    `select count(*) c from arrivals where account is not null and account != ?`).get(String(account)) as any).c
  if (!own && !others) {
    target.prepare(`update arrivals set account = ? where account is null`).run(String(account))
  } else if (!own && rows.length) {
    const seed = target.prepare(
      `insert into arrivals (assetid, account, gem, item, carrier, value, expected, verdict, aside, ts)
       values (?,?,?,?,?,null,null,'старое',0,null)
       on conflict(assetid) do update set account = coalesce(arrivals.account, excluded.account)`)
    for (const r of rows) seed.run(String(r.assetid), String(account), r.gem, r.name, r.carrier ?? 'item')
    return 0
  }

  const seen = new Set(
    (target.prepare(`select assetid from arrivals`).all() as any[]).map(r => String(r.assetid)))
  const ts = Date.now()
  const ins = target.prepare(
    `insert or ignore into arrivals (assetid, account, gem, item, carrier, value, expected, verdict, aside, ts)
     values (?,?,?,?,?,?,?,?,0,?)`)

  let wins = 0
  for (const r of rows) {
    const id = String(r.assetid)
    if (seen.has(id)) continue
    const expected = r.value > 0 ? expectedFor(target, account, r.gem, ts - WINDOW, ts) : 0
    const verdict = judge(r.value, expected, winMin)
    ins.run(id, String(account), r.gem, r.name, r.carrier ?? 'item', r.value, expected, verdict, ts)
    seen.add(id)
    if (verdict === 'выигрыш') wins++
  }
  return wins
}

// Что отложено из фарма на продажу. Выигрыш выгоднее продать как есть:
// жечь матчи под вещь, которая уйдёт, значит тратить запас в пустую.
// Гем, у которого отложены все вещи, выпадает из очереди сам — нечего
// под него отправлять.
export function asideSet(target: DatabaseSync, account: string): Set<string> {
  try {
    return new Set((target.prepare(
      `select assetid from arrivals where aside = 1 and account = ?`,
    ).all(String(account)) as any[]).map(r => String(r.assetid)))
  } catch {
    return new Set()
  }
}

export function setAside(target: DatabaseSync, assetid: string, aside: boolean) {
  target.exec(ARRIVALS_DDL)
  target.prepare(`update arrivals set aside = ? where assetid = ?`).run(aside ? 1 : 0, String(assetid))
}

// Список приходов для панели. Старое не показываем: это не события,
// а фон, который сканер застал при первом запуске.
export function arrivalsOf(target: DatabaseSync, limit = 400) {
  target.exec(ARRIVALS_DDL)
  return (target.prepare(`
    select assetid, account, gem, item, carrier, value, expected, verdict, aside, ts
    from arrivals where verdict != 'старое'
    order by (verdict = 'выигрыш') desc, (ts is null), ts desc
    limit ?
  `).all(limit) as any[]).map(r => ({
    assetid: String(r.assetid),
    account: r.account ? String(r.account) : null,
    gem: String(r.gem ?? '—'),
    item: String(r.item ?? ''),
    carrier: String(r.carrier ?? 'item'),
    value: r.value ?? 0,
    expected: r.expected ?? 0,
    verdict: String(r.verdict) as Verdict,
    aside: !!r.aside,
    ts: r.ts ?? null,
    unexplained: Math.max(0, (r.value ?? 0) - (r.expected ?? 0)),
  }))
}

// Сводка для состояния: сколько выигрышей ждут решения.
export function arrivalSummary(target: DatabaseSync) {
  try {
    const r = target.prepare(`
      select
        sum(case when verdict = 'выигрыш' and aside = 0 then 1 else 0 end) open,
        sum(case when verdict = 'выигрыш' then 1 else 0 end) wins,
        sum(case when verdict != 'старое' then 1 else 0 end) fresh
      from arrivals
    `).get() as any
    return { open: r?.open ?? 0, wins: r?.wins ?? 0, fresh: r?.fresh ?? 0 }
  } catch {
    return { open: 0, wins: 0, fresh: 0 }
  }
}
