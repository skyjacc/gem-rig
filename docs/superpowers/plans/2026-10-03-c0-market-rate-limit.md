# С0 — ограничитель частоты для market.dota2.net · план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ни один запрос к market.dota2.net с ключом не уходит чаще 4 раз в секунду на ключ, ключ передаётся только заголовком `X-API-KEY` и не попадает ни в адрес, ни в текст ошибок.

**Architecture:** Новый модуль `rig/server/ratelimit.ts` — ограничитель с подменяемыми часами: место под каждый запрос резервируется синхронно, до первого `await`, поэтому параллельные вызовы не делят одно окно. Единственная точка выхода к площадке с ключом — `call()` в `market.ts`; она берёт место у общего `marketLimiter`, шлёт ключ заголовком и на ответ 429 отодвигает следующий запрос на 5 секунд. Закупку (`purchase.ts`) не трогаем.

**Tech Stack:** Node 24 (запуск `.ts` напрямую), `node:test` + `node:assert/strict`, встроенный `fetch`/`Response`, `mock.method` из `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-03-gemtrack-redesign-design.md` — §7 С0, §14 инварианты 4 и 10, §20 (факты про лимит и заголовок).

## Global Constraints

- Площадка удаляет ключ за **больше 5 запросов в секунду** (`VERIFIED`, https://market.dota2.net/docs-v2, 2026-10-03). Держим **4 в секунду на ключ**.
- Ключ можно передать `?key=` или заголовком `X-API-KEY`; заголовок площадка называет безопаснее (`VERIFIED`, там же). Используем **только заголовок**.
- Инвариант 4 спецификации: секреты никогда не уходят во фронт, в адрес запроса и в логи.
- Инвариант 10: запросы к market.dota2.net идут только через общий ограничитель на ключ.
- **Живой сервер `rig` не запускать.** Только `cd rig && npm test` и `npm run check` (тесты используют базу в памяти, `server/testenv.ts`).
- Логику закупки, плана и разбора ответов (`purchase.ts`: `decideBuy`, `after`, `classify`) не менять.
- Стиль кода — как в файлах рядом: комментарии на русском, объясняют «почему»; тесты — `test('фраза по-русски', …)`.
- Открытый список цен (`fetchPrices`, адрес `prices/*.json`) ключа не использует и в ограничитель не входит.

## Файлы

| Файл | Что |
|---|---|
| Create `rig/server/ratelimit.ts` | ограничитель: `createLimiter(perSecond, clock)` → `{ take(key), cool(key, ms) }` |
| Create `rig/server/ratelimit.test.ts` | тесты ограничителя на неподвижных часах, без ожидания |
| Modify `rig/server/market.ts` — функция `call()` (строки ~160–176) и импорт вверху | общий `marketLimiter`, ключ в заголовке, 429, вычищение ключа из ошибок |
| Create `rig/server/market.call.test.ts` | тесты `call()` через экспортированные `balance` и `buyOne` с подменённым `fetch` |

---

### Task 1: Ограничитель

**Files:**
- Create: `rig/server/ratelimit.ts`
- Test: `rig/server/ratelimit.test.ts`

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `export type Clock = { now(): number; sleep(ms: number): Promise<void> }`
  - `export const realClock: Clock`
  - `export function createLimiter(perSecond: number, clock?: Clock): { take(key: string): Promise<number>; cool(key: string, ms: number): void }` — `take` ждёт своего окна и возвращает время (мс), на которое запрос запланирован; `cool` запрещает ключу запросы ещё `ms` миллисекунд от «сейчас».
  - `export type Limiter = ReturnType<typeof createLimiter>`

- [ ] **Step 1: Написать падающие тесты**

Создать `rig/server/ratelimit.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLimiter, type Clock } from './ratelimit.ts'

// Часы стоят на месте, сон ничего не ждёт: проверяем расписание,
// а не реальное время — тесты идут мгновенно.
const frozen = (t = 1_000): Clock => ({ now: () => t, sleep: async () => {} })

test('параллельные запросы одного ключа разводятся по 250 мс', async () => {
  const lim = createLimiter(4, frozen())
  const at = await Promise.all(Array.from({ length: 6 }, () => lim.take('k')))
  assert.deepEqual(at, [1000, 1250, 1500, 1750, 2000, 2250])
})

test('в любую секунду — не больше четырёх запросов', async () => {
  const lim = createLimiter(4, frozen())
  const at = await Promise.all(Array.from({ length: 40 }, () => lim.take('k')))
  for (const s of at) assert.ok(at.filter(x => x >= s && x < s + 1000).length <= 4)
})

test('разные ключи друг друга не ждут', async () => {
  const lim = createLimiter(4, frozen())
  const [a, b] = await Promise.all([lim.take('a'), lim.take('b')])
  assert.equal(a, 1000)
  assert.equal(b, 1000)
})

test('после паузы очередь не копится — запрос идёт сразу', async () => {
  let t = 1000
  const lim = createLimiter(4, { now: () => t, sleep: async () => {} })
  await lim.take('k')
  t = 10_000
  assert.equal(await lim.take('k'), 10_000)
})

test('«слишком часто» отодвигает следующий запрос', async () => {
  const lim = createLimiter(4, frozen())
  await lim.take('k')
  lim.cool('k', 5000)
  assert.equal(await lim.take('k'), 6000)
})

test('ждёт ровно до своего окна', async () => {
  const slept: number[] = []
  const lim = createLimiter(4, { now: () => 1000, sleep: async ms => { slept.push(ms) } })
  await Promise.all([lim.take('k'), lim.take('k'), lim.take('k')])
  assert.deepEqual(slept, [250, 500])
})
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd rig && node --import ./server/testenv.ts --test server/ratelimit.test.ts`
Expected: FAIL — `Cannot find module '.../ratelimit.ts'`.

- [ ] **Step 3: Написать ограничитель**

Создать `rig/server/ratelimit.ts`:

```ts
// Ограничитель частоты запросов к площадке.
//
// market.dota2.net удаляет ключ, если с ним приходит больше пяти запросов
// в секунду (документация API v2, проверено 2026-10-03). Ключ — это деньги
// на счету и все покупки, поэтому держим четыре в секунду на ключ.
//
// Место под каждый запрос резервируется синхронно, до первого await:
// параллельные вызовы получают разные окна и не могут проскочить вместе.
// Часы подменяются — тесты проверяют расписание, а не ждут секундами.

export type Clock = { now(): number; sleep(ms: number): Promise<void> }

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

export function createLimiter(perSecond: number, clock: Clock = realClock) {
  const gap = 1000 / perSecond
  // Для каждого ключа — самое раннее время, когда может начаться следующий запрос.
  const next = new Map<string, number>()

  return {
    // Ждёт своего окна и возвращает время, на которое запрос был запланирован.
    async take(key: string): Promise<number> {
      const now = clock.now()
      const at = Math.max(now, next.get(key) ?? 0)
      next.set(key, at + gap)
      if (at > now) await clock.sleep(at - now)
      return at
    },
    // Площадка ответила «слишком часто»: следующий запрос по ключу — не раньше чем через ms.
    cool(key: string, ms: number) {
      next.set(key, Math.max(next.get(key) ?? 0, clock.now() + ms))
    },
  }
}

export type Limiter = ReturnType<typeof createLimiter>
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd rig && node --import ./server/testenv.ts --test server/ratelimit.test.ts`
Expected: PASS — 6 tests, 0 fail.

- [ ] **Step 5: Коммит**

```bash
git add rig/server/ratelimit.ts rig/server/ratelimit.test.ts
git commit -m "feat: ограничитель частоты запросов на ключ"
```

---

### Task 2: Все запросы к площадке — через ограничитель, ключ — заголовком

**Files:**
- Modify: `rig/server/market.ts` — импорт вверху файла (после `import { settings } from './settings.ts'`) и функция `call()` вместе с комментарием над ней (сейчас строки ~160–176, начинается с `// Ответ, по которому нельзя понять…`)
- Test: `rig/server/market.call.test.ts`

**Interfaces:**
- Consumes: `createLimiter` из Task 1.
- Produces:
  - `export const marketLimiter: Limiter` — общий ограничитель площадки; тесты и будущий С9 используют его же.
  - Ответ `call()` при HTTP 429: для `buy` — `{ success: false, ambiguous: true, error: 'площадка: слишком часто (429)' }`; для остальных методов — `{ success: false, rateLimited: true, error: 'площадка: слишком часто (429)' }`. Остальные ответы — как раньше.
  - Экспортированные `balance`, `steamIdOf`, `bestOffer`, `buyOne` — сигнатуры не меняются.

- [ ] **Step 1: Написать падающие тесты**

Создать `rig/server/market.call.test.ts`:

```ts
import { test, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { balance, buyOne, marketLimiter } from './market.ts'

// Настоящая площадка не трогается: fetch подменён, ограничитель не ждёт.
const KEY = 'SECRET-KEY-123'
let seen: { url: string; headers: Record<string, string> }[] = []

function answer(status: number, body: string) {
  seen = []
  mock.method(globalThis, 'fetch', async (url: unknown, init?: { headers?: Record<string, string> }) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} })
    return new Response(body, { status })
  })
}

beforeEach(() => {
  mock.restoreAll()
  mock.method(marketLimiter, 'take', async () => 0)
  mock.method(marketLimiter, 'cool', () => {})
})

test('ключ уходит заголовком X-API-KEY, а не в адресе', async () => {
  answer(200, '{"success":true}')
  await balance(KEY)
  assert.equal(seen.length, 1)
  assert.ok(!seen[0].url.includes(KEY), 'ключ в адресе: ' + seen[0].url)
  assert.equal(seen[0].headers['X-API-KEY'], KEY)
})

test('параметры покупки остаются в адресе, ключа там нет', async () => {
  answer(200, '{"success":true}')
  await buyOne(KEY, 'Spectator: Alliance', 0.03, 'USD', 'gt-1')
  const u = new URL(seen[0].url)
  assert.equal(u.pathname, '/api/v2/buy')
  assert.equal(u.searchParams.get('hash_name'), 'Spectator: Alliance')
  assert.equal(u.searchParams.get('custom_id'), 'gt-1')
  assert.ok(u.searchParams.get('price'))
  assert.equal(u.searchParams.get('key'), null)
})

test('каждый вызов берёт место у ограничителя с этим ключом', async () => {
  answer(200, '{"success":true}')
  await balance(KEY)
  await buyOne(KEY, 'Spectator: Alliance', 0.03, 'USD', 'gt-2')
  const take = marketLimiter.take as unknown as { mock: { calls: { arguments: unknown[] }[] } }
  assert.equal(take.mock.calls.length, 2)
  assert.deepEqual(take.mock.calls.map(c => c.arguments[0]), [KEY, KEY])
})

test('429 на чтении — отказ «слишком часто», не неясность, и пауза ключу 5 секунд', async () => {
  answer(429, 'Too Many Requests')
  const r: any = await balance(KEY)
  assert.equal(r.success, false)
  assert.equal(r.rateLimited, true)
  assert.equal(r.ambiguous, undefined)
  const cool = marketLimiter.cool as unknown as { mock: { calls: { arguments: unknown[] }[] } }
  assert.deepEqual(cool.mock.calls[0].arguments, [KEY, 5000])
})

test('429 на покупке — неясно: прошла ли покупка, не знаем', async () => {
  answer(429, 'Too Many Requests')
  const r: any = await buyOne(KEY, 'Spectator: Alliance', 0.03, 'USD', 'gt-3')
  assert.equal(r.success, false)
  assert.equal(r.ambiguous, true)
})

test('ключ не попадает в текст ошибки, даже если площадка его вернула', async () => {
  answer(500, 'invalid key SECRET-KEY-123')
  const r: any = await balance(KEY)
  assert.equal(r.success, false)
  assert.ok(!String(r.error).includes(KEY), 'ключ в ошибке: ' + r.error)
})
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd rig && node --import ./server/testenv.ts --test server/market.call.test.ts`
Expected: FAIL — `marketLimiter` не экспортирован (`SyntaxError: The requested module './market.ts' does not provide an export named 'marketLimiter'`).

- [ ] **Step 3: Подключить ограничитель и переписать `call()`**

В `rig/server/market.ts` после строки `import { settings } from './settings.ts'` добавить:

```ts
import { createLimiter } from './ratelimit.ts'
```

Заменить комментарий над `call()` и саму функцию (от `// Ответ, по которому нельзя понять, прошла ли операция` до закрывающей `}` функции `call`) на:

```ts
// Один ограничитель на всю площадку. Через него идут все вызовы с ключом —
// закупка, баланс, проверка ключа, — поэтому новый путь не может обойти лимит.
// Больше пяти запросов в секунду — и площадка удаляет ключ.
export const marketLimiter = createLimiter(4)

// Сколько молчать ключу после ответа «слишком часто».
const COOL_429 = 5_000

// Ключ ни при каких условиях не должен уйти в текст ошибки: ошибки
// попадают в журнал закупки и на экран.
const scrub = (s: string, key: string) => (key ? s.split(key).join('***') : s)

// Ответ, по которому нельзя понять, прошла ли операция: связь оборвалась,
// площадка отдала не JSON. Для покупки это не «отказ», а «неизвестно» —
// лот мог уже списаться. Раньше сетевая ошибка улетала исключением и рвала
// всю закупку, а нечитаемый ответ считался отказом и покупка повторялась
// с новым custom_id, то есть могла пройти дважды.
//
// Ключ — только заголовком X-API-KEY: в адресе он оседает в логах и истории.
async function call(method: string, key: string, params: Record<string, string | number>) {
  const q = String(new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))))
  const url = API + method + (q ? '?' + q : '')
  await marketLimiter.take(key)
  let status = 0
  let text = ''
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'gemtrack', 'X-API-KEY': key } })
    status = r.status
    text = await r.text()
  } catch (e: any) {
    return { success: false, ambiguous: true, error: 'нет связи с площадкой: ' + scrub(String(e?.message ?? e), key).slice(0, 120) }
  }
  if (status === 429) {
    marketLimiter.cool(key, COOL_429)
    // Для покупки «слишком часто» — всё равно неизвестность: прошла ли, не знаем.
    // Вслепую не повторяем — закупка встанет, как при любом неясном ответе.
    return method === 'buy'
      ? { success: false, ambiguous: true, error: 'площадка: слишком часто (429)' }
      : { success: false, rateLimited: true, error: 'площадка: слишком часто (429)' }
  }
  try { return JSON.parse(text) } catch { return { success: false, ambiguous: true, error: scrub(text, key).slice(0, 200) } }
}
```

- [ ] **Step 4: Убедиться, что новые тесты проходят**

Run: `cd rig && node --import ./server/testenv.ts --test server/market.call.test.ts`
Expected: PASS — 6 tests, 0 fail.

- [ ] **Step 5: Прогнать весь набор и проверку типов**

Run: `cd rig && npm test`
Expected: PASS — было 343, стало 355 (343 + 6 + 6), 0 fail.

Run: `cd rig && npm run check`
Expected: без ошибок.

- [ ] **Step 6: Убедиться, что запросов с ключом мимо `call()` нет**

Run (из корня репозитория): `grep -rn "market.dota2.net" rig/server --include=*.ts | grep -v test`
Expected: только строки в `market.ts` — константа `API`, константа `PRICES` (открытый список цен, без ключа) и комментарии. Если адрес площадки встречается в другом файле с ключом — перевести его на `call()` в этом же PR.

- [ ] **Step 7: Коммит**

```bash
git add rig/server/market.ts rig/server/market.call.test.ts
git commit -m "fix: запросы к площадке через общий ограничитель, ключ заголовком"
```

---

### Task 3: PR и проверка на живом ключе (с владельцем)

**Files:** нет изменений кода.

- [ ] **Step 1: Ветка и PR**

Работа ведётся в ветке `fix/market-rate-limit` от актуального `master` (план и спецификация лежат в `design/gemtrack-v2` и в этот PR не входят).

```bash
git push -u origin fix/market-rate-limit
gh pr create --title "fix: ограничитель частоты для market.dota2.net, ключ заголовком" --body-file -
```

Тело PR: что меняется (ограничитель 4/с на ключ, `X-API-KEY`, 429 → пауза 5 с, ключ вычищается из ошибок), почему (площадка удаляет ключ за >5 запросов/с; закупка могла делать 5–6), как проверено (`npm test`, `npm run check`), что **не** менялось (логика закупки и плана), и пункт ручной проверки из Step 2.

- [ ] **Step 2: Ручная проверка — делает владелец, после слияния**

Заголовок `X-API-KEY` по документации площадки поддерживается, но на живом ключе не проверялся. Первая проверка — безопасная, без трат: в панели «Аккаунты» → у аккаунта с ключом «проверить ключ» (это `get-my-steam-id`, только чтение). Ожидается тот же результат, что до изменения. Если площадка ответила «ключ не найден» — откатить PR и сообщить: значит, заголовок на практике не принимается.

---

## Self-review

- Покрытие спецификации: С0 — лимит (Task 1, 2), заголовок (Task 2), отступ при отказах (429 → `cool`, Task 2), ключ не в адресе и не в ошибках (Task 2), «все пути через ограничитель» (Task 2 Step 6). Инварианты 4 и 10 — Task 2.
- Не входит сюда: С9 (проверка покупки по `custom_id`) — отдельный PR `fix/purchase-custom-id`; ответ 429 на покупке намеренно помечен «неясно», чтобы до С9 закупка вставала, а не повторяла покупку.
- Пауза 350 мс в цикле закупки (`purchase.ts`) остаётся: она не мешает, а лимит теперь гарантирует ограничитель.
