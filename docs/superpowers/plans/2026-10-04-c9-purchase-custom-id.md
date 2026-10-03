# С9: неясный ответ на покупку — проверка по custom_id — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Цель:** когда ответ на `buy` неясен, закупка не покупает заново, а сама спрашивает площадку по `custom_id` и записывает в журнал «куплено», «отказ» или «неясно» вместо «проверьте историю руками».

**Как устроено:** `market.ts` получает метод `buyInfo` (через общий ограничитель С0). В `purchase.ts` — чистая функция-вердикт `judgeBuyInfo` и шаг `resolveAmbiguous`, который после неясного `buy` делает до трёх проверок с паузами. Закупка после неясного ответа **останавливается, как и сейчас**; меняется только то, что записано в журнал и в счётчики.

**Стек:** Node 24 (`.ts` напрямую), `node:test`, без новых зависимостей.

**Спецификация:** `docs/superpowers/specs/2026-10-03-gemtrack-redesign-design.md` (ветка `design/gemtrack-v2`), §7 строка С9; roadmap `docs/superpowers/plans/2026-10-03-gemtrack-v2-roadmap.md`, этап 0B.

## Global Constraints

- Спецификация С9: «ответ неясен → **не повторять `buy`** → спросить статус по `custom_id` → по ответу записать покупку или отказ».
- Критерий roadmap 0B: «после неясного ответа второго `buy` нет ни при каком ответе проверки; повторная проверка не создаёт вторую покупку».
- Площадка: больше 5 запросов в секунду — ключ удаляется. Все вызовы с ключом — только через `marketLimiter` (С0, в `master`).
- Ключ — только заголовком `X-API-KEY`, никогда в адресе, логе или ошибке.
- Живой `rig` и живые покупки при разработке не запускаются; тесты подменяют `fetch`.
- Репозиторий публичный: ни ключей, ни личных сумм в коде и тестах.

## Факты

| Факт | Статус | Источник |
|---|---|---|
| `buy` принимает `custom_id` — «ваш уникальный ID (string[50]), по нему можно будет узнать статус операции» | `VERIFIED` | docs-v2, 2026-10-04 |
| `get-buy-info-by-custom-id?custom_id=…` → `{"success":true,"data":{item_id, market_hash_name, stage, paid, currency, refund, trade_id, …}}` | `VERIFIED` | docs-v2, пример ответа, 2026-10-04 |
| `stage`: `1` NEW, `2` ITEM_GIVEN, `5` TIMED_OUT (трейд отменён, есть `refund`) | `VERIFIED` | docs-v2, 2026-10-04 |
| Неизвестный `custom_id` → HTTP 200, `{"success":false,"error":"not found"}` | `OBSERVED` | один запрос только на чтение, ключ main, 2026-10-04 |
| Покупка регистрируется под `custom_id` сразу, без задержки | `HYPOTHESIS` | — поэтому проверок три, с паузами, а «not found» не считается отказом |
| Наши `custom_id` уникальны: `'gt-' + Date.now() + '-' + left`, ≤ 50 знаков | код | `purchase.ts` |

## Решения

1. **Закупка после неясного ответа останавливается всегда** — независимо от результата проверки. Продолжать после «отказа» спецификация не просит, и это был бы новый `buy` после неясности; критерий roadmap прямо запрещает «второй `buy` ни при каком ответе проверки».
2. **Вердикт по ответу проверки:**
   - `success:true`, `stage` `1` или `2` → **куплено**: лот засчитывается (`job.ok++`, `spent += data.paid`, позиция −1).
   - `success:true`, `stage` `5` → **отказ**: «трейд отменён площадкой, деньги возвращаются» — лот не придёт.
   - `success:true`, другой или пустой `stage` → **неясно** с этим `stage` в пояснении.
   - `success:false`, `error === "not found"` → **неясно**, даже после всех трёх проверок: что покупка видна по `custom_id` сразу, не доказано (`HYPOTHESIS`), а ложный «отказ» исказил бы журнал. «Отказ» — только когда площадка сама это подтвердила (`stage 5`).
   - любое другое (`rateLimited`, обрыв, нечитаемый ответ, иная ошибка) → **неясно**, как сейчас.
3. **Расписание проверок:** пауза 2 с после неясного `buy`, затем до трёх проверок с промежутком 3 с; первая определённая (не «not found» и не сбой) — окончательная. Паузы — в экспортируемом объекте `pace`, тесты ставят нули.
4. **Журнал:** запись о неясном лоте появляется сразу («проверяю по custom_id…»), затем обновляется на месте итогом. В записи хранится `customId` — человек может сверить сам.
5. **Не входит:** журнал операций и деньги (этап 3.1 — `job.log` не источник денег), интерфейс (этап 2.3), старые `tools/*.js`.

## Файлы

- Изменить: `rig/server/market.ts` — `buyInfo(key, customId)`.
- Изменить: `rig/server/purchase.ts` — `Entry.customId`, `pace`, `judgeBuyInfo`, `resolveAmbiguous`, ветка неясного ответа в `run`.
- Тесты: `rig/server/purchase.test.ts` (вердикт), новый `rig/server/purchase.custom-id.test.ts` (закупка целиком с подменённым `fetch`), `rig/server/market.call.test.ts` (ключ заголовком у нового метода).

---

### Task 1: `buyInfo` в market.ts

**Interfaces:** Produces `buyInfo(key: string, customId: string): Promise<any>` — сырой ответ площадки или `{success:false, ambiguous|rateLimited, error}` от `call`.

- [ ] **Step 1: падающий тест** в `market.call.test.ts`:

```ts
test('проверка покупки по custom_id: ключ заголовком, custom_id в адресе', async () => {
  answer(200, '{"success":false,"error":"not found"}')
  const r: any = await buyInfo(KEY, 'gt-1-1')
  const u = new URL(seen[0].url)
  assert.equal(u.pathname, '/api/v2/get-buy-info-by-custom-id')
  assert.equal(u.searchParams.get('custom_id'), 'gt-1-1')
  assert.ok(!seen[0].url.includes(KEY))
  assert.equal(seen[0].headers['X-API-KEY'], KEY)
  assert.equal(r.error, 'not found')
})
```

- [ ] **Step 2:** `npm test` — FAIL: `buyInfo` не экспортирован.
- [ ] **Step 3: реализация** в `market.ts` после `buyOne`:

```ts
// Что стало с покупкой, ответ на которую потерялся. custom_id мы сами
// передали в buy — по нему площадка отдаёт статус, ничего не покупая.
export const buyInfo = (key: string, customId: string) =>
  call('get-buy-info-by-custom-id', key, { custom_id: customId })
```

- [ ] **Step 4:** `npm test` — PASS. **Step 5:** коммит `feat: проверка покупки по custom_id`.

### Task 2: вердикт `judgeBuyInfo`

**Interfaces:** Produces `judgeBuyInfo(res: any): { reason: 'куплено' | 'отказ' | 'неясно' | 'не найдено'; paid: number | null; detail: string }`. `'не найдено'` — промежуточное, наружу в журнал не попадает: Task 3 по нему повторяет проверку, а после последней пишет «неясно».

- [ ] **Step 1: падающие тесты** в `purchase.test.ts`:

```ts
import { judgeBuyInfo } from './purchase.ts'

const info = (stage: string, paid = 0.05) => ({ success: true, data: { stage, paid, currency: 'RUB' } })

test('stage 1 и 2 — лот куплен, цена из ответа площадки', () => {
  assert.deepEqual(judgeBuyInfo(info('1', 0.05)).reason, 'куплено')
  assert.equal(judgeBuyInfo(info('2', 0.07)).paid, 0.07)
})
test('stage 5 — трейд отменён, лот не придёт: отказ', () => {
  assert.equal(judgeBuyInfo(info('5')).reason, 'отказ')
})
test('незнакомый stage — неясно, и он назван в пояснении', () => {
  const v = judgeBuyInfo(info('9'))
  assert.equal(v.reason, 'неясно')
  assert.ok(v.detail.includes('9'))
})
test('«not found» — не найдено, а не сразу отказ', () => {
  assert.equal(judgeBuyInfo({ success: false, error: 'not found' }).reason, 'не найдено')
})
test('сбой, 429, мусор — неясно', () => {
  for (const r of [{ success: false, ambiguous: true, error: 'x' }, { success: false, rateLimited: true }, null, { success: true }])
    assert.equal(judgeBuyInfo(r).reason, 'неясно')
})
```

- [ ] **Step 2:** FAIL. **Step 3: реализация** в `purchase.ts`:

```ts
// Что ответила площадка на вопрос «что с покупкой по custom_id».
// «не найдено» — промежуточный ответ: покупка могла ещё не записаться.
export function judgeBuyInfo(res: any): { reason: 'куплено' | 'отказ' | 'неясно' | 'не найдено'; paid: number | null; detail: string } {
  if (res?.success === false && res?.error === 'not found') return { reason: 'не найдено', paid: null, detail: 'площадка не знает эту покупку' }
  if (!res?.success || !res?.data) return { reason: 'неясно', paid: null, detail: 'проверка не удалась: ' + String(res?.error ?? 'нет ответа').slice(0, 60) }
  const stage = String(res.data.stage ?? '')
  const paid = Number(res.data.paid)
  if (stage === '1' || stage === '2') return { reason: 'куплено', paid: paid > 0 ? paid : null, detail: 'подтверждено по custom_id' }
  if (stage === '5') return { reason: 'отказ', paid: null, detail: 'трейд отменён площадкой, деньги возвращаются' }
  return { reason: 'неясно', paid: null, detail: 'площадка вернула stage ' + (stage || '—') }
}
```

- [ ] **Step 4:** PASS. **Step 5:** коммит `feat: вердикт по ответу проверки custom_id`.

### Task 3: проверка в закупке

**Interfaces:** Consumes `buyInfo` (Task 1), `judgeBuyInfo` (Task 2). Produces `pace: { settle: number; gap: number; tries: number; between: number }`, `Entry.customId?: string`.

- [ ] **Step 1: падающие тесты** — новый `purchase.custom-id.test.ts`. Подменяются `globalThis.fetch` (по пути метода) и `marketLimiter.run` (сквозной); `pace` = нули. Площадка: `get-money` → баланс; `search-item-by-hash-name` → один лот по цене плана; `buy` → бросает исключение (обрыв → `ambiguous`); `get-buy-info-by-custom-id` → вариант из таблицы.

```ts
const VARIANTS = {
  'stage 1':   () => ({ success: true, data: { stage: '1', paid: 0.01 } }),
  'stage 5':   () => ({ success: true, data: { stage: '5', paid: 0.01 } }),
  'not found': () => ({ success: false, error: 'not found' }),
  'сбой':      () => { throw new Error('ECONNRESET') },
}
for (const [name, reply] of Object.entries(VARIANTS)) {
  test('неясный buy + проверка «' + name + '» — второго buy нет, закупка встала', async () => {
    const n = await runOnce(reply)           // запускает закупку на 3 лота и ждёт конца
    assert.equal(n.buy, 1, 'buy после неясного ответа повторился')
    assert.equal(purchaseState().active, false)
  })
}
test('stage 1 — лот засчитан, в журнале «куплено» и custom_id', ...)       // ok=1, spent=0.01, log[0].reason='куплено', log[0].customId начинается с 'gt-'
test('not found во всех трёх проверках — «неясно», а не отказ', ...)        // n.info === 3, log[0].reason === 'неясно'
test('not found, потом stage 1 — «куплено», проверок две', ...)              // повторная проверка не создаёт покупку: n.buy === 1
test('сбой проверки — «неясно», как раньше', ...)
```

`runOnce` считает обращения по пути (`n.buy`, `n.info`) и ждёт `purchaseBusy() === false` (как `settle()` в `purchase.race.test.ts`).

- [ ] **Step 2:** FAIL. **Step 3: реализация** в `purchase.ts`:
  - импорт `buyInfo`; `Entry` += `customId?: string`;
  - `export const pace = { settle: 2000, gap: 3000, tries: 3, between: 350 }`; пауза между лотами `350` → `pace.between`;
  - `custom_id` выносится в переменную до `buyOne` и пишется в запись;
  - неясный ответ: запись «неясно — проверяю по custom_id…» сразу в журнал + `push()`, затем `resolveAmbiguous`:

```ts
// Ответ на покупку потерялся. Заново не покупаем — спрашиваем, что стало
// с этой покупкой. «not found» сразу может значить «ещё не записалась»,
// поэтому до трёх вопросов с паузой. Отказом он не становится никогда:
// отсутствие ответа — не доказательство, что покупки нет.
async function resolveAmbiguous(key: string, customId: string) {
  await sleep(pace.settle)
  let v = judgeBuyInfo(null)
  for (let i = 0; i < pace.tries; i++) {
    if (i) await sleep(pace.gap)
    v = judgeBuyInfo(await buyInfo(key, customId))
    if (v.reason !== 'не найдено') return v
  }
  return v.reason === 'не найдено'
    ? { reason: 'неясно' as const, paid: null, detail: 'площадка не нашла покупку по custom_id за ' + pace.tries + ' проверки — сверьте историю' }
    : v
}
```

  - итог переписывает ту же запись (`reason`, `detail`, `price` = `paid` при «куплено»); при «куплено» — `job.ok++`, `job.spent += paid`, `w.left--`; затем `mark(i)`, `push()` и **`return`** — закупка стоит при любом итоге (`after('неясно')` остаётся `'стоп'`).

- [ ] **Step 4:** `npm test` — всё PASS; `npm run check` — чисто.
- [ ] **Step 5:** коммит `fix: неясная покупка проверяется по custom_id, а не повторяется`.

### Task 4: PR и проверка

- [ ] `git push -u origin fix/purchase-custom-id`, PR в `master`; CI (Windows + Linux) зелёный.
- [ ] Мерж; перезапуск сервера штатным `restart-panel.ps1` — только когда нет соединений с площадкой.
- [ ] Живой проверки через покупку **нет**: неясный ответ нельзя вызвать безопасно. Проверено тестами и фактом `OBSERVED` о «not found».
