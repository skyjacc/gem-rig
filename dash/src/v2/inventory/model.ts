// Модель экрана «Инвентарь» (§5.2) — чистые функции, без React.
//
// Статус вещи строится на gemStatus() (lib/worker.ts), как статус гема на
// Обзоре, — чтобы два экрана не расходились:
//   ready    счётчик вещи не меньше цели
//   going    не готово, гем в порядке — дойдёт при этой работе
//   stuck    не готово, матчей у команды меньше цели — не дойдёт
//   unknown  не готово, гема нет в карте — потолок неизвестен
// Нет цели — статуса нет (null): «дойдёт / не дойдёт» не считается (§3.2).
//
// Сравнение со старым Пультом (output() в views/Work.tsx) — план 2.2,
// критерий 1: совпадает, кроме гема не из карты с неизвестным запасом
// (старый — «дойдут», здесь — «не дойдут: потолок неизвестен»).

import type { State } from '../../lib/api.ts'
import { gemStatus } from '../../lib/worker.ts'

export type Gem = State['mine'][number]
export type Row = Gem['rows'][number]
export type ItemState = 'ready' | 'going' | 'stuck' | 'unknown'

export function itemState(value: number, m: Gem, goal: number | null): ItemState | null {
  if (goal == null) return null
  if (value >= goal) return 'ready'
  const s = gemStatus(m, goal)
  return s === 'map' ? 'unknown' : s === 'reach' ? 'stuck' : 'going'
}

// Стопка — одинаковые вещи одного гема. Ключ — «гем | имя»: одинаковое имя у
// разных гемов не смешивается. Голый самоцвет (carrier = 'gem') — своя стопка.
//
// max и differ — разные факты (план 2.2, критерий 3): max — для прогресса,
// differ — у копий неодинаковые счётчики (пояснение с меткой «оценка»).
export type Stack = {
  key: string
  gem: Gem
  name: string
  bare: boolean
  rows: Row[]        // копии, по счётчику вниз, при равенстве надетые первыми
  max: number
  differ: boolean
  equipped: number
  state: ItemState | null
}

export const stackKey = (gem: string, row: Pick<Row, 'carrier' | 'name'>) =>
  gem + '|' + (row.carrier === 'gem' ? '§gem' : row.name)

export function stacksOf(gems: Gem[], goal: number | null): Stack[] {
  const out: Stack[] = []
  for (const g of gems) {
    const by = new Map<string, Row[]>()
    for (const r of g.rows) {
      const k = stackKey(g.gem, r)
      const list = by.get(k)
      if (list) list.push(r)
      else by.set(k, [r])
    }
    for (const [key, list] of by) {
      const rows = [...list].sort((a, b) => b.value - a.value || Number(b.equipped) - Number(a.equipped))
      const max = rows[0].value
      out.push({
        key,
        gem: g,
        name: rows[0].name,
        bare: rows[0].carrier === 'gem',
        rows,
        max,
        differ: new Set(rows.map(r => r.value)).size > 1,
        equipped: rows.filter(r => r.equipped).length,
        state: itemState(max, g, goal),
      })
    }
  }
  return out
}

// Сводка — по каждой вещи (не по стопкам). Нет цели — только «всего».
export type Summary = { total: number; ready: number | null; going: number | null; stuck: number | null }

export function summarize(gems: Gem[], goal: number | null): Summary {
  const total = gems.reduce((n, g) => n + g.rows.length, 0)
  if (goal == null) return { total, ready: null, going: null, stuck: null }
  let ready = 0, going = 0, stuck = 0
  for (const g of gems) {
    for (const r of g.rows) {
      const s = itemState(r.value, g, goal)
      if (s === 'ready') ready++
      else if (s === 'going') going++
      else stuck++   // stuck и unknown — «не дойдут»
    }
  }
  return { total, ready, going, stuck }
}

// Фильтры экрана. «не дойдут» включает «потолок неизвестен».
export type Filter = 'all' | 'going' | 'stuck' | 'ready' | 'dups'

export function passes(st: Stack, f: Filter, bond: [string, string] | null, query: string) {
  if (bond && !bond.includes(st.gem.gem)) return false
  if (f === 'going' && st.state !== 'going') return false
  if (f === 'stuck' && st.state !== 'stuck' && st.state !== 'unknown') return false
  if (f === 'ready' && st.state !== 'ready') return false
  if (f === 'dups' && st.rows.length < 2) return false
  const q = query.trim().toLowerCase()
  if (q) return (st.name + ' ' + st.gem.gem + ' ' + st.gem.heroes).toLowerCase().includes(q)
  return true
}

// Счётчик у чипа — сколько вещей (не стопок) пройдёт этот фильтр.
export function countFor(stacks: Stack[], f: Filter, bond: [string, string] | null, query: string) {
  return stacks.filter(s => passes(s, f, bond, query)).reduce((n, s) => n + s.rows.length, 0)
}
