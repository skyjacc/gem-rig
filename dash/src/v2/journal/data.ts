// Откуда экран «Журнал» берёт данные (план 2.5).
//
//   отправки        state.events — последние 240 активного аккаунта
//   журнал расхода  GET /api/burned (total, byState, до 500 строк)
//   очередь         GET /api/queue
//   израсходовано   GET /api/tree
//   приход          GET /api/arrivals
// В показе (VITE_DEMO) журнала расхода, прихода, отправок без ответа и с
// числом вещей в снимке нет — они из demo/journal.json, составленного руками
// (план 2.5, решение 6). Остальное — из снимка, как везде.

import fixture from '../../demo/journal.json'
import snapshot from '../../demo/snapshot.json'
import { DEMO, useJson, type QueueData, type SendEvent, type Settings, type State } from '../../lib/api.ts'
import type { Burned, TreeNode } from './model.ts'

const FIX: any = fixture
const SNAP: any = snapshot

export type ArrivalRow = {
  account?: string
  assetid: string
  gem: string
  item: string
  carrier: string
  value: number
  expected: number
  unexplained: number
  verdict: 'выигрыш' | 'наш' | 'чисто'
  aside: boolean
  ts: number | null
  now: number | null
  gone: boolean
}
export type Arrivals = { summary: { open: number; wins: number; fresh: number }; rows: ArrivalRow[] }

export const eventsOf = (state: State): SendEvent[] =>
  DEMO ? [...FIX.events, ...state.events].sort((a, b) => b.ts - a.ts) : state.events

export const dupsOf = (state: State): { waiting: number; exhausted: number; resolved: number } | null =>
  DEMO ? FIX.dups : state.dups ?? null

// Запросы — только пока Журнал открыт; в показе их нет вовсе.
export function useJournal(state: State | null, on: boolean, settings: Settings | null) {
  const ts = state?.ts
  const top = settings?.treeTop
  const burned = useJson<Burned>(on && !DEMO ? '/api/burned?limit=500' : null, ts)
  const arrivals = useJson<Arrivals>(on && !DEMO ? '/api/arrivals' : null, ts)
  const queue = useJson<QueueData>(on && !DEMO ? '/api/queue?limit=300' : null, ts)
  const tree = useJson<TreeNode>(on && !DEMO ? '/api/tree' + (top ? '?top=' + top : '') : null, ts)
  // В показе useJson берёт снимок только при первом рендере, а Журнал
  // включает запросы позже — очередь и дерево берём из снимка прямо.
  const canned = <T,>(d: T) => ({ data: d, loading: false, error: null, reload: () => { } })
  return {
    burned: DEMO ? canned(FIX.burned as Burned) : burned,
    arrivals: DEMO ? canned(FIX.arrivals as Arrivals) : arrivals,
    queue: DEMO ? canned(SNAP.queue as QueueData) : queue,
    tree: DEMO ? canned(SNAP.tree as TreeNode) : tree,
  }
}

export type JournalData = ReturnType<typeof useJournal>
