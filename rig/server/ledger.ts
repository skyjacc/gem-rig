// Журнал сожжённых матчей. Локально мы только помним — арбитр всегда GC.
//
// Состояние записи выводится из ответа GC и ниоткуда больше:
//   update  — пришёл msg 26, счётчики поднялись, матч израсходован
//   dup     — пришёл 7204 без msg 26, матч уже был израсходован раньше
//   silent  — GC не ответил. Означает «не знаем», а не «сожжён»
//
// silent НЕ ПИШЕТСЯ. Раньше писался, и один зависший ответ навсегда
// исключал матч из будущих списков: /api/build фильтрует по этой таблице.
// Пока конвейер не работал, дефект спал; 20 августа конвейер заработал.
//
// Оговорка: CMsgUpgradeLeagueItemResponse — пустое сообщение, у него нет полей.
// Поэтому «дубль» и «матч отвергнут» снаружи неразличимы, и оба приходят как
// dup. Практического вреда нет — оба означают «счётчика не будет».

import type { DatabaseSync } from 'node:sqlite'

export type BurnState = 'confirmed' | 'dup' | 'ledger' | 'reconstructed'

// dup — НЕ синоним «сожжён». Проверено 20 августа на матче 8003261364:
// отправка без league_id вернула 7204 без msg 26, то есть тот же самый dup,
// а матч при этом остался целым и засчитался со второй попытки, с лигой.
//
// Значит 7204 без обновления означает «счётчика не будет», и только.
// Причина может быть любой: матч уже израсходован, сообщение отвергнуто,
// подходящих гемов не нашлось. Различить нельзя — ответ пустой по протоколу.
//
// Поэтому dup пишется отдельным состоянием: из очереди по умолчанию убирается,
// но остаётся видимым и повторяемым. Ложно сожжённый матч не воскресить,
// а лишний повтор стоит секунд.
export function classify(result: string): BurnState | null {
  if (result === 'update') return 'confirmed'
  if (result === 'dup') return 'dup'
  return null
}

// Одно событие отправщика → запись в журнал. База передаётся аргументом,
// чтобы функцию можно было проверить на базе в памяти: модуль db.ts открывает
// рабочий rig.db прямо при импорте, и тесту его трогать нельзя.
//
// Аккаунт обязателен. Матч расходуется у каждого аккаунта отдельно: тот же
// самый матч, засчитанный на первом, на втором остаётся свежим. Запись без
// аккаунта означала бы общий журнал — а это ровно та ошибка, из-за которой
// второй аккаунт получал бы пустую очередь.
export function ingestOne(
  target: DatabaseSync,
  e: { match: string; league?: string | null; result: string; ts: number },
  account: string,
): boolean {
  if (!account) throw new Error('журнал расхода ведётся по аккаунту, аккаунт не указан')
  const state = classify(e.result)
  if (!state) return false
  const ins = target.prepare(
    `insert or ignore into burned (account, match_id, league_id, ts, source, state) values (?,?,?,?,?,?)`,
  ).run(String(account), String(e.match), e.league ? String(e.league) : null, Math.trunc(e.ts), 'live', state)
  if (Number(ins.changes) > 0) return true

  // Запись уже есть. Раньше `insert or ignore` на этом останавливался, и dup,
  // засчитанный со второй попытки, навсегда оставался dup: матч снова и снова
  // уходил в хвост очереди, хотя был израсходован.
  //
  // Теперь повтор поднимает dup до confirmed, но не наоборот: засчитанное
  // не отменяется пустым ответом. Число попыток растёт — по нему очередь
  // перестаёт гонять безнадёжные dup по кругу.
  const tries = hasTries(target) ? `, tries = coalesce(tries, 1) + 1` : ''
  target.prepare(
    `update burned set
       source = case when ? = 'confirmed' and state = 'dup' then 'resolved' else source end,
       state = case when ? = 'confirmed' then 'confirmed' else state end,
       ts    = case when ? = 'confirmed' and state != 'confirmed' then ? else ts end
       ${tries}
     where account = ? and match_id = ?`,
  ).run(state, state, state, Math.trunc(e.ts), String(account), String(e.match))
  return true
}

// Судьба dup по аккаунту — чтобы было видно, ушла ли беда после починки.
//   waiting    dup с одной попыткой, повтор ещё впереди
//   exhausted  dup, не засчитанный и после повтора, — из очереди выведен
//   resolved   был dup, засчитался со второй попытки (source = 'resolved')
export function dupStats(target: DatabaseSync, account: string, maxTries: number) {
  const tries = hasTries(target)
  const r = target.prepare(`
    select
      sum(case when state = 'dup' and ${tries ? 'coalesce(tries, 1) < ?' : '1'} then 1 else 0 end) waiting,
      sum(case when state = 'dup' and ${tries ? 'coalesce(tries, 1) >= ?' : '0'} then 1 else 0 end) exhausted,
      sum(case when state = 'confirmed' and source = 'resolved' then 1 else 0 end) resolved
    from burned where account = ?
  `).get(...(tries ? [maxTries, maxTries] : []), String(account)) as any
  return { waiting: r?.waiting ?? 0, exhausted: r?.exhausted ?? 0, resolved: r?.resolved ?? 0 }
}

// Колонка попыток добавляется миграцией. Тестовые базы и старые копии могут
// её не иметь — тогда повышаем только состояние.
const triesCache = new WeakMap<DatabaseSync, boolean>()
function hasTries(target: DatabaseSync): boolean {
  let v = triesCache.get(target)
  if (v === undefined) {
    v = (target.prepare(`pragma table_info(burned)`).all() as any[]).some(c => c.name === 'tries')
    triesCache.set(target, v)
  }
  return v
}

export type Recent = { ts: number; match?: string; league?: string | null; result: string }

// Разбор отчёта отправщика: что нового с прошлого раза.
//
// Жил внутри index.ts и потому не проверялся ничем, хотя это единственное
// место, где расход попадает в журнал. Здесь без ввода-вывода: на вход
// список из status-<id>.json и прошлая метка, на выход — что записать
// и какая метка теперь.
//
// Метка берётся по МАКСИМУМУ разобранного, а не по первой строке отчёта.
// Порядок в recent — дело отправщика, и одна переставленная запись отрезала
// бы всё, что легло после неё: расход просто не попал бы в журнал, а очередь
// на следующей пересборке выдала бы уже потраченные матчи по второму разу.
export function fresh(recent: Recent[], seen: number): { rows: Recent[]; watermark: number } {
  const rows: Recent[] = []
  let watermark = seen
  for (const e of Array.isArray(recent) ? recent : []) {
    const ts = Number(e?.ts) || 0
    if (!ts || ts <= seen) continue
    rows.push(e)
    if (ts > watermark) watermark = ts
  }
  // Разбираем от старых к новым: журнал должен ложиться в том же порядке,
  // в каком отправлялось.
  rows.sort((a, b) => Number(a.ts) - Number(b.ts))
  return { rows, watermark }
}
