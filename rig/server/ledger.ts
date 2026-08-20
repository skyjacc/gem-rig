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

export type BurnState = 'confirmed' | 'ledger' | 'reconstructed'

export function classify(result: string): BurnState | null {
  if (result === 'update' || result === 'dup') return 'confirmed'
  return null
}

// Одно событие отправщика → запись в журнал. База передаётся аргументом,
// чтобы функцию можно было проверить на базе в памяти: модуль db.ts открывает
// рабочий rig.db прямо при импорте, и тесту его трогать нельзя.
export function ingestOne(
  target: DatabaseSync,
  e: { match: string; league?: string | null; result: string; ts: number },
): boolean {
  const state = classify(e.result)
  if (!state) return false
  target.prepare(
    `insert or ignore into burned (match_id, league_id, ts, source, state) values (?,?,?,?,?)`,
  ).run(String(e.match), e.league ? String(e.league) : null, Math.trunc(e.ts), 'live', state)
  return true
}
