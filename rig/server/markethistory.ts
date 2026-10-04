// История операций market.dota2.net → журнал операций (план 3.1).
//
// Пока здесь только нарезка периода на окна. Разбор строк (какое поле —
// сумма, как строится external_id, что такое status) появится после живого
// чтения истории (задача 2) — до этого смысл полей не зашивается.

const DAY = 86_400

// Окно не длиннее 7 суток — наше ограничение импорта, не факт площадки:
// пределы периода и постраничность operation-history в docs-v2 не описаны.
export const WINDOW_DAYS = 7

// Период [from, to] в unix-секундах → окна подряд, без дыр и наложений:
// каждое следующее начинается там, где кончилось предыдущее.
export function windows(from: number, to: number, days = WINDOW_DAYS): { from: number; to: number }[] {
  const a = Math.trunc(from)
  const b = Math.trunc(to)
  if (!(b > a) || !(days > 0)) return []
  const step = Math.trunc(days * DAY)
  const out: { from: number; to: number }[] = []
  for (let s = a; s < b; s += step) out.push({ from: s, to: Math.min(s + step, b) })
  return out
}
