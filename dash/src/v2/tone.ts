// Лампа аккаунта (перенесено из прежнего parts/Sidebar.tsx). Порядок проверок —
// по цене вопроса: сначала то, из-за чего работа не идёт и сама не пойдёт,
// потом то, что идёт само.

import type { Unit } from '../lib/api.ts'

export function accountTone(u: Unit | undefined, session: boolean): 'ok' | 'warn' | 'stop' | 'idle' {
  if (!session) return 'stop'
  if (u?.fatal) return 'stop'
  if (u?.inv?.private || u?.inv?.error) return 'stop'
  if (u?.running) return 'ok'
  if (u?.enabled) return 'warn'
  return 'idle'
}
