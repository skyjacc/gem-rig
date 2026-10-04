// Журнал (§5.6, план 2.5): пульс, фильтры, плитки, израсходовано по гему.
// Только чистые функции — без запросов и React.

import { nf, type SendEvent } from '../../lib/api.ts'

export type Result = SendEvent['result']
export type Filter = 'all' | Result
export type Tone = 'ok' | 'warn' | 'idle'

// Слово у каждого ответа: смысл не только цветом (§4.3).
export const ANSWER: Record<Result, { word: string; tone: Tone; hint: string }> = {
  update: { word: 'засчитан', tone: 'ok', hint: 'пришёл msg 26 — единственное подтверждение, что счётчики сдвинулись' },
  dup: { word: 'спорный', tone: 'warn', hint: '7204 без msg 26 — дубль или отказ, снаружи не различить; из остатка не вычитается' },
  silent: { word: 'без ответа', tone: 'idle', hint: 'GC промолчал — матч не помечается сожжённым' },
}

export const dotaMatch = (id: string) => 'https://www.opendota.com/matches/' + encodeURIComponent(id)

export const answerOf = (r: string) => ANSWER[r as Result] ?? ANSWER.silent

// Ключ отправки: в базе ключ — метка + аккаунт + матч, у одного аккаунта
// хватает метки и матча (отправщик закрывает молчания пачкой с одной меткой).
export const keyOf = (e: Pick<SendEvent, 'ts' | 'match_id'>) => e.ts + ':' + e.match_id

// Пульс — по времени слева направо (лента приходит новыми сверху).
export const pulse = (events: SendEvent[]) => [...events].sort((a, b) => a.ts - b.ts)

export const filterEvents = (events: SendEvent[], f: Filter) => f === 'all' ? events : events.filter(e => e.result === f)

export function counts(events: SendEvent[]) {
  const c = { all: events.length, update: 0, dup: 0, silent: 0 }
  for (const e of events) if (e.result in c) c[e.result]++
  return c
}

// «Изменено вещей» — точное число отправщика (план 2.5, решение 1). Нет
// числа — не ноль, а «—» с причиной.
export function itemsWord(e: Pick<SendEvent, 'items' | 'result'>): { v: string; why: string | null } {
  if (typeof e.items === 'number') return { v: nf(e.items), why: null }
  if (e.result !== 'update') return { v: '—', why: 'msg 26 не было' }
  return { v: '—', why: 'до этапа 2.5 не записывалось' }
}

// ── имена лиг ──

export type TreeNode = { id: string; label: string; kind: string; value: number; burned?: number; counter?: number; icon?: string; children?: TreeNode[] }
export type BurnedRow = { match: string; league: string; leagueName: string; ts: number | null; state: string; gems: string[] }
export type Burned = { total: number; byState?: { confirmed: number; dup: number; ledger: number; reconstructed: number }; rows: BurnedRow[] }

// Имя лиги — из того, что уже загружено: узлы дерева (id «<гем>:<лига>») и
// строки журнала расхода. Новых запросов ради имени нет.
export function leagueNames(tree: TreeNode | null, burned: Burned | null) {
  const m = new Map<string, string>()
  for (const g of tree?.children ?? []) {
    for (const l of g.children ?? []) {
      const id = l.id.split(':').pop()
      if (id && id !== 'rest' && l.label && !m.has(id)) m.set(id, l.label)
    }
  }
  for (const r of burned?.rows ?? []) if (r.league && r.leagueName && !m.has(r.league)) m.set(r.league, r.leagueName)
  return m
}

// ── израсходовано по гему ──

// rest — сводка «ещё N турниров» (узел сервера `<гем>:rest`): не турнир,
// сожжённое по ней сервер не считает — показывается отдельно, без полоски.
export type Used = { gem: string; icon: string | null; value: number; burned: number; leagues: { id: string; label: string; value: number; burned: number }[]; rest: { label: string; value: number } | null }

export function usedByGem(tree: TreeNode | null, top: number): Used[] {
  return (tree?.children ?? [])
    .filter(g => g.kind === 'gem')
    .map(g => ({
      gem: g.label,
      icon: g.icon ?? null,
      value: g.value,
      burned: g.burned ?? 0,
      rest: (g.children ?? []).filter(l => l.id.endsWith(':rest')).map(l => ({ label: l.label, value: l.value }))[0] ?? null,
      leagues: [...(g.children ?? [])]
        .filter(l => l.kind === 'league' && !l.id.endsWith(':rest'))
        .sort((a, b) => b.value - a.value)
        .slice(0, Math.max(1, top))
        .map(l => ({ id: l.id, label: l.label, value: l.value, burned: l.burned ?? 0 })),
    }))
    .sort((a, b) => b.burned - a.burned || b.value - a.value)
}
