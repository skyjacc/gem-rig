import { test } from 'node:test'
import assert from 'node:assert/strict'

// Черновик правил после «Сохранить» (ревью PR #30, P2). Модель окна — в
// панели (dash/src/v2/tuneModel.ts), чистая функция, поэтому проверяется здесь.
const { afterSave, GROUPS } = await import('../../dash/src/v2/tuneModel.ts')

const [a, b, c] = GROUPS.flatMap(g => g.rules).map(r => r.path)

test('после сохранения уходит только отправленное и не тронутое; правка во время запроса остаётся', () => {
  const sent = { [a]: '900', [b]: '1500' }
  // Пока ждали ответа: переписали одно из отправленных и поменяли ещё одно поле.
  const now = { [a]: '900', [b]: '1600', [c]: '5' }
  assert.deepEqual(afterSave(now, sent), { [b]: '1600', [c]: '5' })
  assert.deepEqual(now, { [a]: '900', [b]: '1600', [c]: '5' }, 'черновик не меняется на месте')
})

test('ничего не трогали во время запроса — черновик пуст', () => {
  const sent = { [a]: '900', [b]: '1500' }
  assert.deepEqual(afterSave({ ...sent }, sent), {})
})
