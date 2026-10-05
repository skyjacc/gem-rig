import { test } from 'node:test'
import assert from 'node:assert/strict'

// Правки во время отправки не теряются (ревью PR #31, P2). Форма выплаты и
// окно исправления: ответ сервера приходит с задержкой, а человек за это
// время успел что-то поменять. Логика — чистая функция панели
// (dash/src/v2/sales/payoutForm.ts); здесь — тот же порядок шагов, что в
// PayoutDialogs.tsx: снимок при нажатии → запрос → ответ → afterSend с тем,
// что на экране к приходу ответа.
const { afterSend, bodyOf, emptyDraft } = await import('../../dash/src/v2/sales/payoutForm.ts')
type Draft = ReturnType<typeof emptyDraft>

const T = Date.UTC(2026, 9, 5, 12)
const fresh = emptyDraft(T)
const filled = (over: Partial<Draft> = {}): Draft => ({ ...fresh, tx: 'TX-1', asset: 'USDT', usd: '12.50', ...over })
const later = <T,>(v: T, ms = 20) => new Promise<T>(r => setTimeout(() => r(v), ms))

// Как в компоненте: state — то, что на экране; send получает тело,
// собранное в момент нажатия.
async function submit(mode: 'new' | 'fix', state: { d: Draft; acc: string }, reply: unknown, during?: () => void) {
  const sent = { d: state.d, acc: state.acc }
  const bodies: unknown[] = []
  const send = (b: unknown) => { bodies.push(b); return later(reply) }
  const pending = send(bodyOf(sent.d, sent.acc))
  during?.()                                             // правка, пока ждём ответа
  const r = await pending
  const next = afterSend(mode, r, sent.d, sent.acc, state.d, state.acc, fresh)
  state.d = next.draft
  return { next, body: bodies[0] as any }
}

test('форма: ничего не меняли — после ответа черновик пуст, «Внесено.»', async () => {
  const s = { d: filled(), acc: 'main' }
  const { next } = await submit('new', s, { id: 1, inserted: true })
  assert.deepEqual(s.d, fresh)
  assert.equal(next.note, 'Внесено.')
})

test('форма: сумму и заметку поменяли, пока ждали ответа, — правки остаются, сказано, что не отправлены', async () => {
  const s = { d: filled(), acc: 'main' }
  const { next, body } = await submit('new', s, { id: 1, inserted: true }, () => { s.d = { ...s.d, usd: '99.00', note: 'следующая' } })
  assert.equal(body.usd, '12.50', 'ушло то, что было на момент нажатия')
  assert.equal(s.d.usd, '99.00')
  assert.equal(s.d.note, 'следующая')
  assert.match(next.note!, /Правки после нажатия не отправлены/)
})

test('форма: начали следующую выплату, пока ждали, — она не стирается', async () => {
  const s = { d: filled(), acc: 'main' }
  await submit('new', s, { id: 1, inserted: true }, () => { s.d = filled({ tx: 'TX-2', usd: '3.00' }) })
  assert.equal(s.d.tx, 'TX-2')
  assert.equal(s.d.usd, '3.00')
})

test('форма: повтор — «уже внесена», черновик не трогается', async () => {
  const s = { d: filled(), acc: 'main' }
  const { next } = await submit('new', s, { id: 1, inserted: false })
  assert.deepEqual(s.d, filled())
  assert.match(next.note!, /уже внесена/)
})

test('форма: отказ сервера — черновик как на экране', async () => {
  const s = { d: filled(), acc: 'main' }
  await submit('new', s, { error: 'номер уже внесён с другой суммой: $12.00' }, () => { s.d = { ...s.d, usd: '12.00' } })
  assert.equal(s.d.usd, '12.00')
})

test('исправление: ничего не меняли — окно закрывается', async () => {
  const s = { d: filled(), acc: 'main' }
  const { next } = await submit('fix', s, { id: 7, inserted: true })
  assert.equal(next.close, true)
})

test('исправление: поменяли сумму или аккаунт, пока ждали, — окно не закрывается, правки остаются', async () => {
  const s = { d: filled(), acc: 'main' }
  const a = await submit('fix', s, { id: 7, inserted: true }, () => { s.d = { ...s.d, usd: '13.00' } })
  assert.equal(a.next.close, false)
  assert.equal(s.d.usd, '13.00')
  assert.match(a.next.note!, /Правки после нажатия не отправлены/)

  const s2 = { d: filled(), acc: 'main' }
  const b = await submit('fix', s2, { id: 7, inserted: true }, () => { s2.acc = 'second' })
  assert.equal(b.next.close, false, 'смена аккаунта — тоже правка')
  assert.equal(b.body.accountId, 'main')
})

test('исправление: повтор — окно открыто с объяснением', async () => {
  const s = { d: filled(), acc: 'main' }
  const { next } = await submit('fix', s, { id: 7, inserted: false })
  assert.equal(next.close, false)
  assert.match(next.note!, /уже внесено/)
})
