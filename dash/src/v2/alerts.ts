// Тревоги новой панели — один список для колокольчика и для «Требует
// внимания» под инспектором Обзора, чтобы они не расходились.
//
// Основа — attention() из lib/worker.ts. Сверху — своя тревога, если цели
// нет в настройках (§3.2: молча перестать считать «не дойдёт» нельзя).
// Порядок §5.7: работа стоит (stop) → «не дойдёт» (reach) → справочные;
// сортировка стабильная — внутри группы порядок attention().

import type { Live, State } from '../lib/api.ts'
import { attention, type Alert } from '../lib/worker.ts'

export function alertList(state: State, live: Live, now: number, goal: number | null): Alert[] {
  const list: Alert[] = [
    ...(goal == null ? [{ level: 'warn' as const, text: 'цель счётчика не задана в настройках', todo: '«дойдёт / не дойдёт» не считается, пока её нет — задайте в «Общих правилах»' }] : []),
    ...attention(state, live, now, goal),
  ]
  const rank = (a: Alert) => (a.level === 'stop' ? 0 : a.kind === 'reach' ? 1 : 2)
  return [...list].sort((a, b) => rank(a) - rank(b))
}
