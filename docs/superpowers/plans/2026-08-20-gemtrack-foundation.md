# Gemtrack Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать так, чтобы числа в проекте были правдой, а отправщик не портил журнал.

**Architecture:** Три слоя. Чистые функции без ввода-вывода (`ledger.ts`, `queue.ts`, `supply.ts`) — их и тестируем. Тонкая обвязка над SQLite, которая эти функции зовёт. Точечные правки в `tools/gcwatch/index.js`, где живут дефекты записи журнала. Измеренные наборы матчей переносятся из Python-pickle в JSON один раз отдельным скриптом, дальше проект про Python не знает.

**Tech Stack:** Node 24 (`node:test`, `node:sqlite`, нативный TypeScript через type stripping), Python 3.14 разово для чтения pickle.

**Spec:** `docs/superpowers/specs/2026-08-20-gemtrack-redesign-design.md`

## Global Constraints

- Node 24. Тесты — встроенный `node:test`, без внешних раннеров.
- TypeScript исполняется нативно, без сборки. Запрещены `enum`, `namespace`, parameter properties — type stripping их не поддерживает.
- Все обращения к Steam — через существующую очередь в `rig/server/steam.ts`, пауза 2500 мс. Новых прямых `fetch` к Steam не добавлять.
- Ни один шаг этого плана не отправляет сообщений в Game Coordinator.
- Аккаунт: `76561198362481819`. Захардкожен в `rig/server/paths.ts` как `STEAMID`.
- Состояния записи журнала — ровно три строки: `confirmed`, `ledger`, `reconstructed`.
- Результаты отправки — ровно три строки: `update`, `dup`, `silent`.
- Комментарии в коде на русском, как во всём проекте. Имена идентификаторов английские.

---

### Task 1: Репозиторий и тестовый харнесс

Проекта под контролем версий нет. План меняет работающий отправщик и живую базу — откат обязан существовать до первой правки.

**Files:**
- Create: `.gitignore` (уже есть, проверить), `rig/package.json:8` (добавить скрипт)
- Create: `rig/server/ledger.ts`
- Test: `rig/server/ledger.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: `classify(result: string): 'confirmed' | null` — переводит ответ GC в состояние журнала либо `null`, если писать нельзя.

- [ ] **Step 1: Инициализировать репозиторий**

```bash
cd "C:\Users\oblako\Desktop\gem-rig"
git init
git add -A
git commit -m "chore: import existing project before Gemtrack redesign"
```

Проверить, что `tools/opendota.key`, `tools/steam.key`, `tools/gcwatch/token.json` и `tools/rig.db` в коммит **не** попали — они перечислены в корневом `.gitignore`. Если попали, удалить из индекса `git rm --cached` и переделать коммит.

- [ ] **Step 2: Добавить тестовый скрипт**

В `rig/package.json` в блок `scripts` добавить строку:

```json
"test": "node --test \"server/**/*.test.ts\""
```

- [ ] **Step 3: Написать падающий тест**

Создать `rig/server/ledger.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify } from './ledger.ts'

test('update означает засчитанный матч — пишем в журнал', () => {
  assert.equal(classify('update'), 'confirmed')
})

test('dup означает, что матч уже был засчитан — тоже пишем', () => {
  assert.equal(classify('dup'), 'confirmed')
})

test('silent не даёт права писать в журнал', () => {
  assert.equal(classify('silent'), null)
})

test('неизвестный результат не даёт права писать', () => {
  assert.equal(classify('what'), null)
  assert.equal(classify(''), null)
})
```

- [ ] **Step 4: Запустить и убедиться, что падает**

Run: `cd rig; npm test`
Expected: FAIL, `Cannot find module './ledger.ts'`

- [ ] **Step 5: Написать минимальную реализацию**

Создать `rig/server/ledger.ts`:

```ts
// Состояние записи журнала выводится из ответа GC и ниоткуда больше.
//
//   update  — пришёл msg 26, счётчики поднялись, матч израсходован
//   dup     — пришёл 7204 без msg 26, матч уже был израсходован
//   silent  — GC не ответил. Означает «не знаем», а не «сожжён»
//
// silent НЕ ПИШЕТСЯ. Раньше писался, и один зависший ответ навсегда
// исключал матч из будущих списков.

export type BurnState = 'confirmed' | 'ledger' | 'reconstructed'

export function classify(result: string): BurnState | null {
  if (result === 'update' || result === 'dup') return 'confirmed'
  return null
}
```

- [ ] **Step 6: Запустить и убедиться, что проходит**

Run: `cd rig; npm test`
Expected: PASS, 4 теста

- [ ] **Step 7: Коммит**

```bash
git add rig/package.json rig/server/ledger.ts rig/server/ledger.test.ts
git commit -m "feat: ledger state classification, silent never burns a match"
```

---

### Task 2: Перестать жечь матчи на silent

Дефект `rig/server/index.ts:103`. Конвейер ожил 20 августа, дефект теперь боевой: первый же зависший ответ вычеркнет матч навсегда.

**Files:**
- Modify: `rig/server/ledger.ts` (добавить `ingestOne`)
- Modify: `rig/server/index.ts:96-107` (функция `ingestStatus`)
- Test: `rig/server/ledger.test.ts` (дописать в существующий файл)

**Interfaces:**
- Consumes: `classify` из Task 1
- Produces: `ingestOne(target: DatabaseSync, e: { match: string; league?: string | null; result: string; ts: number }): boolean` — возвращает `true`, если запись сделана.

> **Почему не в `db.ts`.** `rig/server/db.ts` создаёт `new DatabaseSync(rig.db)` на верхнем уровне модуля. Любой `import './db.ts'` из теста открыл бы **рабочую** базу и прогнал по ней миграцию. Поэтому функция живёт в `ledger.ts`, который побочных эффектов не имеет, а базу принимает аргументом.

- [ ] **Step 1: Написать падающий тест**

Дописать в конец `rig/server/ledger.test.ts`:

```ts
import { DatabaseSync } from 'node:sqlite'
import { ingestOne } from './ledger.ts'

function fresh() {
  const db = new DatabaseSync(':memory:')
  db.exec(`create table burned (
    match_id text primary key, league_id text, ts integer,
    source text, state text default 'confirmed')`)
  return db
}

test('update записывает матч как confirmed', () => {
  const db = fresh()
  ingestOne(db, { match: '111', league: '9', result: 'update', ts: 1 })
  const r = db.prepare('select * from burned').all() as any[]
  assert.equal(r.length, 1)
  assert.equal(r[0].match_id, '111')
  assert.equal(r[0].state, 'confirmed')
})

test('dup тоже записывает как confirmed', () => {
  const db = fresh()
  ingestOne(db, { match: '222', league: '9', result: 'dup', ts: 2 })
  const r = db.prepare('select state from burned').all() as any[]
  assert.equal(r[0].state, 'confirmed')
})

test('silent не записывает ничего', () => {
  const db = fresh()
  ingestOne(db, { match: '333', league: '9', result: 'silent', ts: 3 })
  const r = db.prepare('select * from burned').all() as any[]
  assert.equal(r.length, 0)
})

test('повторный update не плодит дублей', () => {
  const db = fresh()
  ingestOne(db, { match: '444', league: '9', result: 'update', ts: 4 })
  ingestOne(db, { match: '444', league: '9', result: 'update', ts: 5 })
  const r = db.prepare('select * from burned').all() as any[]
  assert.equal(r.length, 1)
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `cd rig; npm test`
Expected: FAIL, `ingestOne` не экспортируется из `./ledger.ts`

- [ ] **Step 3: Реализовать `ingestOne`**

В `rig/server/ledger.ts` добавить импорт типа наверху файла:

```ts
import type { DatabaseSync } from 'node:sqlite'
```

и функцию в конец файла:

```ts
// Одно событие отправщика → запись в журнал. База передаётся аргументом,
// чтобы функцию можно было проверить на базе в памяти.
export function ingestOne(target: DatabaseSync, e: { match: string; league?: string | null; result: string; ts: number }) {
  const state = classify(e.result)
  if (!state) return false
  target.prepare(`insert or ignore into burned (match_id, league_id, ts, source, state) values (?,?,?,?,?)`)
    .run(String(e.match), e.league ? String(e.league) : null, Math.trunc(e.ts), 'live', state)
  return true
}
```

- [ ] **Step 4: Запустить и убедиться, что проходит**

Run: `cd rig; npm test`
Expected: PASS, 8 тестов

- [ ] **Step 4a: Проверить, что тест НЕ трогает рабочую базу**

Run: `cd rig; node -e "console.log(require('fs').statSync('../tools/rig.db').mtimeMs)"` до и после `npm test`.
Expected: значение не изменилось. Если изменилось — где-то остался импорт `./db.ts` из теста, найти и убрать.

- [ ] **Step 5: Подключить в `ingestStatus`**

В `rig/server/index.ts` заменить тело цикла в `ingestStatus`. Было:

```ts
  for (const e of st.recent) {
    if (!e?.ts || e.ts <= seenEventTs) continue
    pushEvent(e)
    if (e.match) markBurned(String(e.match), e.league ? String(e.league) : null, 'live')
  }
```

Стало:

```ts
  for (const e of st.recent) {
    if (!e?.ts || e.ts <= seenEventTs) continue
    pushEvent(e)
    if (e.match) ingestOne(db, e)
  }
```

и поправить импорт в шапке файла — `markBurned` больше не нужен, нужны `db` и `ingestOne`:

```ts
import { db, importLegacy, ingestOne, pushEvent, supplyRows } from './db.ts'
```

- [ ] **Step 6: Проверить, что сервер поднимается**

Run: `cd rig; node server/index.ts`
Expected: в консоли `Жила: http://localhost:4322` и `гемов в базе: 53`, без исключений. Остановить по Ctrl+C.

- [ ] **Step 7: Коммит**

```bash
git add rig/server/db.ts rig/server/db.test.ts rig/server/index.ts
git commit -m "fix: silent GC response no longer marks a match as burned"
```

---

### Task 3: Миграция схемы и починка испорченных меток времени

`burned.ts` содержит мусор: `stat.mtimeMs | 0` — 32-битное усечение, из 1787158694876 получается 455777412. Плюс нужны три новые колонки из спеки.

**Files:**
- Create: `rig/server/migrate.ts`
- Modify: `rig/server/db.ts:63-64` (вызвать миграцию после `db.exec`)
- Modify: `rig/server/db.ts:79` (`stat.mtimeMs | 0`)
- Test: `rig/server/migrate.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: `migrate(target: DatabaseSync): string[]` — применяет недостающие колонки, возвращает список применённых изменений.

- [ ] **Step 1: Написать падающий тест**

Создать `rig/server/migrate.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './migrate.ts'

function old() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    create table burned (match_id text primary key, league_id text, ts integer, source text);
    create table supply (gem text primary key, kind text, entity_id integer,
      entity_name text, matches integer, confidence text, updated integer);
    create table counters (ts integer, gem text, assetid text, item text, value integer,
      primary key (ts, assetid));`)
  return db
}
const cols = (db: any, t: string) =>
  (db.prepare(`pragma table_info(${t})`).all() as any[]).map(c => c.name)

test('добавляет три недостающие колонки', () => {
  const db = old()
  migrate(db)
  assert.ok(cols(db, 'burned').includes('state'))
  assert.ok(cols(db, 'supply').includes('supply_kind'))
  assert.ok(cols(db, 'counters').includes('carrier'))
})

test('повторный запуск ничего не ломает', () => {
  const db = old()
  migrate(db)
  const applied = migrate(db)
  assert.deepEqual(applied, [])
})

test('чинит метки времени, испорченные 32-битным усечением', () => {
  const db = old()
  db.prepare('insert into burned values (?,?,?,?)').run('1', null, 455777412, 'empire.csv')
  db.prepare('insert into burned values (?,?,?,?)').run('2', null, 1787158694876, 'live')
  migrate(db)
  const r = db.prepare('select match_id, ts from burned order by match_id').all() as any[]
  assert.equal(r[0].ts, null, 'мусорная метка обнуляется, а не остаётся ложной')
  assert.equal(r[1].ts, 1787158694876, 'правдоподобная метка не трогается')
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `cd rig; npm test`
Expected: FAIL, `Cannot find module './migrate.ts'`

- [ ] **Step 3: Реализовать миграцию**

Создать `rig/server/migrate.ts`:

```ts
// Миграции схемы. Идемпотентны: смотрим, чего не хватает, и добавляем.
// SQLite не умеет "add column if not exists", поэтому спрашиваем pragma.

import type { DatabaseSync } from 'node:sqlite'

// Метки времени в миллисекундах. Всё, что меньше этого, — мусор
// от 32-битного усечения (`mtimeMs | 0`), а не настоящая дата.
const MS_FLOOR = 1_000_000_000_000

const ADD: [string, string, string][] = [
  ['burned', 'state', `alter table burned add column state text default 'confirmed'`],
  ['supply', 'supply_kind', `alter table supply add column supply_kind text default 'measured'`],
  ['counters', 'carrier', `alter table counters add column carrier text default 'item'`],
]

export function migrate(target: DatabaseSync): string[] {
  const applied: string[] = []
  for (const [table, column, sql] of ADD) {
    const has = (target.prepare(`pragma table_info(${table})`).all() as any[])
      .some(c => c.name === column)
    if (has) continue
    target.exec(sql)
    applied.push(`${table}.${column}`)
  }
  const bad = target.prepare(`select count(*) c from burned where ts is not null and ts < ?`)
    .get(MS_FLOOR) as { c: number }
  if (bad.c > 0) {
    target.prepare(`update burned set ts = null where ts is not null and ts < ?`).run(MS_FLOOR)
    applied.push(`burned.ts: обнулено ${bad.c} испорченных меток`)
  }
  return applied
}
```

- [ ] **Step 4: Запустить и убедиться, что проходит**

Run: `cd rig; npm test`
Expected: PASS, 11 тестов

- [ ] **Step 5: Подключить к рабочей базе**

В `rig/server/db.ts` сразу после закрывающей скобки блока `db.exec(\`...\`)` добавить:

```ts
import { migrate } from './migrate.ts'

const migrated = migrate(db)
if (migrated.length) console.log('миграция:', migrated.join(', '))
```

Импорт поставить к остальным импортам в шапке файла, а вызов — после `db.exec`.

Там же заменить строку 79. Было:

```ts
      for (const id of list) { insBurn.run(String(id), null, stat.mtimeMs | 0, m[1]); burned++ }
```

Стало:

```ts
      for (const id of list) { insBurn.run(String(id), null, Math.trunc(stat.mtimeMs), m[1]); burned++ }
```

- [ ] **Step 6: Проверить на живой базе**

Run: `cd rig; node server/index.ts`
Expected: в консоли строка `миграция: burned.state, supply.supply_kind, counters.carrier, burned.ts: обнулено 9 испорченных меток`. Остановить по Ctrl+C, запустить снова — строки `миграция:` больше нет.

- [ ] **Step 7: Коммит**

```bash
git add rig/server/migrate.ts rig/server/migrate.test.ts rig/server/db.ts
git commit -m "feat: schema migration for ledger state, supply kind, carrier; repair truncated timestamps"
```

---

### Task 4: Перенести измеренные наборы матчей в проект

`_ref/site/../_sets.pkl` — 47 гемов, 64 799 матчей. Первоисточник всех цифр экономики, в базу никогда не попадал. Читается один раз питоном в JSON, дальше проект про Python не знает.

**Files:**
- Create: `tools/sets-to-json.py`
- Create: `tools/gem-sets.json` (результат работы скрипта)
- Create: `rig/server/sets.ts`
- Test: `rig/server/sets.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: `loadSets(path: string): Map<string, string[]>` и `importSets(target: DatabaseSync, sets: Map<string, string[]>, resolve: (gem: string) => { kind: string; id: number } | null): number` — возвращает число вставленных строк.

- [ ] **Step 1: Написать конвертер pickle → JSON**

Создать `tools/sets-to-json.py`:

```python
# Разовый перенос измеренных наборов матчей из pickle в JSON.
# Pickle умеет исполнять код при загрузке, поэтому Unpickler ограничен:
# find_class бросает исключение, и ничего кроме dict/str/frozenset не пройдёт.
#
#   python tools/sets-to-json.py

import pickle, io, json, os

SRC = os.path.expanduser(r"~\Desktop\Dota 2 market\tools\_sets.pkl")
DST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gem-sets.json")

class Safe(pickle.Unpickler):
    def find_class(self, module, name):
        raise pickle.UnpicklingError(f"запрещённый global {module}.{name}")

with open(SRC, "rb") as f:
    data = Safe(io.BytesIO(f.read())).load()

out = {gem: sorted(matches) for gem, matches in data.items()}
with open(DST, "w", encoding="utf-8") as f:
    json.dump(out, f)

total = sum(len(v) for v in out.values())
union = len(set().union(*out.values())) if out else 0
empty = [g for g, v in out.items() if not v]
print(f"гемов {len(out)}, строк {total}, уникальных матчей {union}")
print(f"пустых наборов {len(empty)}: {', '.join(empty)}")
```

- [ ] **Step 2: Запустить конвертер**

Run: `python tools/sets-to-json.py`
Expected: `гемов 47, строк 64799, уникальных матчей 40342` и `пустых наборов 10: ...`

- [ ] **Step 3: Написать падающий тест**

Создать `rig/server/sets.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { importSets } from './sets.ts'

function fresh() {
  const db = new DatabaseSync(':memory:')
  db.exec(`create table entity_matches (kind text, entity_id integer,
    match_id text, league_id text, primary key (kind, entity_id, match_id))`)
  return db
}
const resolve = (gem: string) =>
  gem === 'Spectator: Alliance' ? { kind: 'team', id: 111474 } : null

test('вставляет матчи известного гема', () => {
  const db = fresh()
  const n = importSets(db, new Map([['Spectator: Alliance', ['1', '2', '3']]]), resolve)
  assert.equal(n, 3)
  const r = db.prepare('select count(*) c from entity_matches').get() as any
  assert.equal(r.c, 3)
})

test('пропускает гем без привязки к сущности', () => {
  const db = fresh()
  const n = importSets(db, new Map([['Spectator: Nobody', ['1']]]), resolve)
  assert.equal(n, 0)
})

test('пустой набор не создаёт строк', () => {
  const db = fresh()
  const n = importSets(db, new Map([['Spectator: Alliance', []]]), resolve)
  assert.equal(n, 0)
})

test('повторный импорт не плодит дублей', () => {
  const db = fresh()
  const sets = new Map([['Spectator: Alliance', ['1', '2']]])
  importSets(db, sets, resolve)
  importSets(db, sets, resolve)
  const r = db.prepare('select count(*) c from entity_matches').get() as any
  assert.equal(r.c, 2)
})

test('не затирает league_id, уже лежащий в базе', () => {
  const db = fresh()
  db.prepare('insert into entity_matches values (?,?,?,?)').run('team', 111474, '1', '16710')
  importSets(db, new Map([['Spectator: Alliance', ['1']]]), resolve)
  const r = db.prepare('select league_id from entity_matches where match_id = ?').get('1') as any
  assert.equal(r.league_id, '16710')
})
```

- [ ] **Step 4: Запустить и убедиться, что падает**

Run: `cd rig; npm test`
Expected: FAIL, `Cannot find module './sets.ts'`

- [ ] **Step 5: Реализовать**

Создать `rig/server/sets.ts`:

```ts
// Измеренные наборы матчей: имя гема → список match_id.
// Источник — tools/gem-sets.json, полученный из _sets.pkl разовым скриптом.
//
// league_id здесь неизвестен: набор его не хранит. Поэтому вставка идёт
// через insert or ignore и НЕ трогает строки, у которых лига уже есть.

import fs from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

export type Entity = { kind: string; id: number }

export function loadSets(path: string): Map<string, string[]> {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, string[]>
  return new Map(Object.entries(raw))
}

export function importSets(
  target: DatabaseSync,
  sets: Map<string, string[]>,
  resolve: (gem: string) => Entity | null,
): number {
  const ins = target.prepare(
    `insert or ignore into entity_matches (kind, entity_id, match_id, league_id) values (?,?,?,?)`)
  let n = 0
  for (const [gem, matches] of sets) {
    const e = resolve(gem)
    if (!e || !matches.length) continue
    for (const m of matches) { ins.run(e.kind, e.id, String(m), ''); n++ }
  }
  return n
}
```

- [ ] **Step 6: Запустить и убедиться, что проходит**

Run: `cd rig; npm test`
Expected: PASS, 16 тестов

- [ ] **Step 7: Коммит**

```bash
git add tools/sets-to-json.py tools/gem-sets.json rig/server/sets.ts rig/server/sets.test.ts
git commit -m "feat: import measured match sets, 47 entities and 64799 matches"
```

---

### Task 5: Честный остаток и классификация запаса

Панель считает остаток по `entity_matches ∩ burned`. Пока в `entity_matches` было 5 сущностей, а в `burned` девять записей, число было ложью. Плюс надо различать три состояния запаса, которые сейчас неотличимы: измеренный, оценочный и пустой.

**Files:**
- Create: `rig/server/supply.ts`
- Test: `rig/server/supply.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: `classifySupply(measured: number, estimate: number | null): SupplyKind` где `SupplyKind = 'measured' | 'estimated' | 'empty'`; `leftFor(target: DatabaseSync, kind: string, id: number): { supply: number; burned: number; left: number }`.

- [ ] **Step 1: Написать падающий тест**

Создать `rig/server/supply.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { classifySupply, leftFor } from './supply.ts'

test('непустой набор — measured', () => {
  assert.equal(classifySupply(2340, 2340), 'measured')
  assert.equal(classifySupply(1, null), 'measured')
})

test('пустой набор при наличии оценки — estimated', () => {
  assert.equal(classifySupply(0, 1672), 'estimated')
})

test('пустой набор без оценки — empty', () => {
  assert.equal(classifySupply(0, null), 'empty')
  assert.equal(classifySupply(0, 0), 'empty')
})

function fresh() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    create table entity_matches (kind text, entity_id integer, match_id text,
      league_id text, primary key (kind, entity_id, match_id));
    create table burned (match_id text primary key, league_id text, ts integer,
      source text, state text default 'confirmed');`)
  return db
}

test('остаток = набор минус подтверждённое сожжённое', () => {
  const db = fresh()
  for (const m of ['1', '2', '3', '4']) db.prepare('insert into entity_matches values (?,?,?,?)').run('team', 46, m, '')
  db.prepare('insert into burned values (?,?,?,?,?)').run('1', null, 1, 'live', 'confirmed')
  const r = leftFor(db, 'team', 46)
  assert.deepEqual(r, { supply: 4, burned: 1, left: 3 })
})

test('reconstructed не считается сожжённым — его ещё надо проверить', () => {
  const db = fresh()
  for (const m of ['1', '2']) db.prepare('insert into entity_matches values (?,?,?,?)').run('team', 46, m, '')
  db.prepare('insert into burned values (?,?,?,?,?)').run('1', null, 1, 'recon', 'reconstructed')
  const r = leftFor(db, 'team', 46)
  assert.deepEqual(r, { supply: 2, burned: 0, left: 2 })
})

test('сожжённый матч чужой сущности остаток не трогает', () => {
  const db = fresh()
  db.prepare('insert into entity_matches values (?,?,?,?)').run('team', 46, '1', '')
  db.prepare('insert into burned values (?,?,?,?,?)').run('999', null, 1, 'live', 'confirmed')
  const r = leftFor(db, 'team', 46)
  assert.deepEqual(r, { supply: 1, burned: 0, left: 1 })
})

test('пустая сущность даёт нули, а не падение', () => {
  const db = fresh()
  assert.deepEqual(leftFor(db, 'team', 1), { supply: 0, burned: 0, left: 0 })
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `cd rig; npm test`
Expected: FAIL, `Cannot find module './supply.ts'`

- [ ] **Step 3: Реализовать**

Создать `rig/server/supply.ts`:

```ts
// Запас сущности и остаток по нему.
//
// Три состояния запаса, которые нельзя показывать одинаково:
//   measured   набор матчей измерен, число настоящее
//   estimated  набора нет, есть только оценка из gem-map.json
//   empty      набора нет и оценки нет
//
// Десять гемов-игроков имеют estimate от 1321 до 2117 при пустом наборе.
// Это фантомы: у Ohaiyo заявлено 1672, измерено 0, а реально ≥302.

import type { DatabaseSync } from 'node:sqlite'

export type SupplyKind = 'measured' | 'estimated' | 'empty'

export function classifySupply(measured: number, estimate: number | null): SupplyKind {
  if (measured > 0) return 'measured'
  if (estimate && estimate > 0) return 'estimated'
  return 'empty'
}

// reconstructed в вычет не идёт: такие матчи ещё не подтверждены ответом GC
// и обязаны попадать в очередь, чтобы GC их проверил.
export function leftFor(target: DatabaseSync, kind: string, id: number) {
  const supply = (target.prepare(
    `select count(*) c from entity_matches where kind = ? and entity_id = ?`)
    .get(kind, id) as { c: number }).c

  const burned = (target.prepare(
    `select count(*) c from entity_matches em
     join burned b on b.match_id = em.match_id
     where em.kind = ? and em.entity_id = ? and b.state in ('confirmed','ledger')`)
    .get(kind, id) as { c: number }).c

  return { supply, burned, left: Math.max(0, supply - burned) }
}
```

- [ ] **Step 4: Запустить и убедиться, что проходит**

Run: `cd rig; npm test`
Expected: PASS, 23 теста

- [ ] **Step 5: Сверить с эталоном на живой базе**

Создать временный файл `rig/check-left.ts` и выполнить его:

```ts
import { DatabaseSync } from 'node:sqlite'
import { leftFor } from './server/supply.ts'
const db = new DatabaseSync('../tools/rig.db', { readOnly: true })
for (const [name, kind, id] of [['Empire', 'team', 46], ['NaVi', 'team', 36],
  ['Alliance', 'team', 111474], ['BZZ', 'player', 96196828], ['DD', 'player', 89371588]] as const) {
  console.log(name.padEnd(10), JSON.stringify(leftFor(db, kind, id)))
}
```

Run: `cd rig; node check-left.ts`

Expected — ровно эти числа, сверено с живой базой 20 августа:

```
Empire     {"supply":2413,"burned":9,"left":2404}
NaVi       {"supply":2704,"burned":5,"left":2699}
Alliance   {"supply":2340,"burned":1,"left":2339}
BZZ        {"supply":2433,"burned":7,"left":2426}
DD         {"supply":1017,"burned":0,"left":1017}
```

У Empire сожжено 9, а не 17, потому что восемь реконструированных записей в базу ещё не внесены — они ждут проверки отправкой в плане 3. Это ожидаемое расхождение, а не ошибка. После их внесения и подтверждения станет 17.

Удалить файл: `rm rig/check-left.ts`

- [ ] **Step 6: Коммит**

```bash
git add rig/server/supply.ts rig/server/supply.test.ts
git commit -m "feat: honest remaining supply, reconstructed entries stay in the pool"
```

---

### Task 6: Сборка очереди со слиянием пересечений

Очередь принимает сущности, отдаёт список матчей. Пересечения сливаются: матч, входящий в наборы двух сущностей очереди, отправляется один раз и поднимает оба гема. Для четырёх владеемых сущностей это экономит 695 сообщений из 9890.

**Files:**
- Create: `rig/server/queue.ts`
- Test: `rig/server/queue.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: `buildQueue(sets: Map<string, string[]>, burned: Set<string>): QueueRow[]` где `QueueRow = { match: string; weight: number; entities: string[] }`, отсортировано по `weight` убыванию, при равном весе — по `match` возрастанию для устойчивости.

- [ ] **Step 1: Написать падающий тест**

Создать `rig/server/queue.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildQueue } from './queue.ts'

test('одна сущность — все её матчи с весом 1', () => {
  const q = buildQueue(new Map([['A', ['1', '2']]]), new Set())
  assert.equal(q.length, 2)
  assert.ok(q.every(r => r.weight === 1))
})

test('общий матч встречается один раз и получает вес 2', () => {
  const q = buildQueue(new Map([['A', ['1', '2']], ['B', ['2', '3']]]), new Set())
  assert.equal(q.length, 3, 'матч 2 не задвоился')
  const two = q.find(r => r.match === '2')!
  assert.equal(two.weight, 2)
  assert.deepEqual(two.entities.sort(), ['A', 'B'])
})

test('тяжёлые матчи идут первыми', () => {
  const q = buildQueue(new Map([['A', ['1', '9']], ['B', ['9']], ['C', ['9']]]), new Set())
  assert.equal(q[0].match, '9')
  assert.equal(q[0].weight, 3)
})

test('сожжённые исключаются', () => {
  const q = buildQueue(new Map([['A', ['1', '2', '3']]]), new Set(['2']))
  assert.deepEqual(q.map(r => r.match), ['1', '3'])
})

test('порядок устойчив при равном весе', () => {
  const a = buildQueue(new Map([['A', ['3', '1', '2']]]), new Set())
  const b = buildQueue(new Map([['A', ['2', '3', '1']]]), new Set())
  assert.deepEqual(a.map(r => r.match), b.map(r => r.match))
})

test('пустой вход даёт пустую очередь', () => {
  assert.deepEqual(buildQueue(new Map(), new Set()), [])
  assert.deepEqual(buildQueue(new Map([['A', []]]), new Set()), [])
})

test('всё сожжено — очередь пуста', () => {
  assert.deepEqual(buildQueue(new Map([['A', ['1']]]), new Set(['1'])), [])
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `cd rig; npm test`
Expected: FAIL, `Cannot find module './queue.ts'`

- [ ] **Step 3: Реализовать**

Создать `rig/server/queue.ts`:

```ts
// Сборка списка матчей для отправщика.
//
// В очередь кладутся сущности, разворачиваются в матчи здесь.
// Пересечения сливаются: одно сообщение поднимает все подходящие гемы разом,
// поэтому общий матч отправляется ОДИН раз и засчитывается обеим сущностям.
//
// Порядок — по числу обслуживаемых сущностей, по убыванию. Это не ускоряет
// прогон, но делает так, что прерванный прогон обрывается на дешёвом хвосте.

export type QueueRow = { match: string; weight: number; entities: string[] }

export function buildQueue(sets: Map<string, string[]>, burned: Set<string>): QueueRow[] {
  const by = new Map<string, string[]>()
  for (const [entity, matches] of sets) {
    for (const m of matches) {
      if (burned.has(m)) continue
      const list = by.get(m)
      if (list) list.push(entity)
      else by.set(m, [entity])
    }
  }
  return [...by.entries()]
    .map(([match, entities]) => ({ match, weight: entities.length, entities }))
    .sort((a, b) => b.weight - a.weight || (a.match < b.match ? -1 : a.match > b.match ? 1 : 0))
}
```

- [ ] **Step 4: Запустить и убедиться, что проходит**

Run: `cd rig; npm test`
Expected: PASS, 30 тестов

- [ ] **Step 5: Сверить с эталоном на реальных наборах**

Создать временный файл `rig/check-queue.ts`:

```ts
import { loadSets } from './server/sets.ts'
import { buildQueue } from './server/queue.ts'
const all = loadSets('../tools/gem-sets.json')
const pick = ['Spectator: NaVi', 'Spectator: Team Empire', 'Spectator: Alliance', 'Spectator: BZZ']
const sets = new Map(pick.map(p => [p, all.get(p) ?? []]))
const sum = [...sets.values()].reduce((a, v) => a + v.length, 0)
const q = buildQueue(sets, new Set())
const w = q.reduce((a, r) => a + r.weight, 0)
console.log('сумма наборов', sum, '· уникальных', q.length, '· экономия', sum - q.length)
console.log('начислений', w, '· максимальный вес', q[0].weight)
```

Run: `cd rig; node check-queue.ts`
Expected: `сумма наборов 9890 · уникальных 9195 · экономия 695` и `начислений 9890 · максимальный вес 2`

Удалить файл: `rm rig/check-queue.ts`

- [ ] **Step 6: Коммит**

```bash
git add rig/server/queue.ts rig/server/queue.test.ts
git commit -m "feat: queue builder merges entity overlaps and orders by weight"
```

---

### Task 7: Правки в отправщике

Четыре дефекта в `tools/gcwatch/index.js`, каждый воспроизведён аудитом. Тесты пишутся на чистые функции, которые для этого выносятся из файла.

**Files:**
- Create: `tools/gcwatch/lib.js`
- Create: `tools/gcwatch/lib.test.js`
- Modify: `tools/gcwatch/index.js:83-93` (журнал), `:157-163` (темп), `:187` (шапка), `:257-261` (ожидание GC)
- Modify: `tools/gcwatch/package.json` (скрипт `test`)

**Interfaces:**
- Consumes: ничего
- Produces: `mergeLedger(previous: string[], sent: string[]): string[]`, `effectiveDelay(flagWasGiven: boolean, flagValue: number, fileValue: number | null): number`

- [ ] **Step 1: Написать падающий тест**

Создать `tools/gcwatch/lib.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeLedger, effectiveDelay } = require('./lib.js');

test('журнал сливается, а не затирается', () => {
  assert.deepEqual(mergeLedger(['1', '2', '3'], ['4']).sort(), ['1', '2', '3', '4']);
});

test('повторы не дублируются', () => {
  assert.deepEqual(mergeLedger(['1', '2'], ['2', '3']).sort(), ['1', '2', '3']);
});

test('пустая предыстория не мешает', () => {
  assert.deepEqual(mergeLedger([], ['1']), ['1']);
});

test('явный --delay побеждает delay.txt', () => {
  assert.equal(effectiveDelay(true, 3000, 300000), 3000);
});

test('без флага работает delay.txt', () => {
  assert.equal(effectiveDelay(false, 2000, 300000), 300000);
});

test('без флага и без файла — значение по умолчанию', () => {
  assert.equal(effectiveDelay(false, 2000, null), 2000);
});

test('мусор в delay.txt игнорируется', () => {
  assert.equal(effectiveDelay(false, 2000, 10), 2000, 'меньше 500 мс не принимаем');
  assert.equal(effectiveDelay(false, 2000, NaN), 2000);
});
```

- [ ] **Step 2: Добавить тестовый скрипт и запустить**

В `tools/gcwatch/package.json` в блок `scripts` (создать блок, если его нет) добавить:

```json
"scripts": { "test": "node --test" }
```

Run: `cd tools/gcwatch; npm test`
Expected: FAIL, `Cannot find module './lib.js'`

- [ ] **Step 3: Реализовать**

Создать `tools/gcwatch/lib.js`:

```js
// Чистые функции отправщика — вынесены, чтобы их можно было проверить тестами.

// Журнал отправленного. Раньше при --no-resume loadLedger возвращал пустое
// множество, а saveLedger писал файл целиком — второй прогон затирал историю
// первого. Так потерялись 8 матчей из 23.
function mergeLedger(previous, sent) {
  return [...new Set([...previous, ...sent])];
}

// Темп. Раньше delay.txt перекрывал --delay ВСЕГДА, поэтому явный флаг молча
// не работал. Теперь флаг главнее, а файл нужен для смены темпа на лету.
function effectiveDelay(flagWasGiven, flagValue, fileValue) {
  if (flagWasGiven && Number.isFinite(flagValue) && flagValue >= 500) return flagValue;
  if (Number.isFinite(fileValue) && fileValue >= 500) return fileValue;
  return flagValue;
}

module.exports = { mergeLedger, effectiveDelay };
```

- [ ] **Step 4: Запустить и убедиться, что проходит**

Run: `cd tools/gcwatch; npm test`
Expected: PASS, 7 тестов

- [ ] **Step 5: Подключить в `index.js`**

Наверху файла, после других `require`:

```js
const { mergeLedger, effectiveDelay } = require('./lib.js');
const DELAY_GIVEN = argv.includes('--delay');
```

Заменить `loadLedger` и `saveLedger` (строки 85–93):

```js
function loadLedger() {
  if (!IDS_FILE || !fs.existsSync(ledgerFile())) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'))); }
  catch (e) { return new Set(); }
}

// Пишем слиянием с тем, что уже на диске: параллельный прогон или --no-resume
// больше не стирают чужие записи.
function saveLedger(set) {
  if (!IDS_FILE) return;
  let previous = [];
  try { previous = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8')); } catch (e) { }
  fs.writeFileSync(ledgerFile(), JSON.stringify(mergeLedger(previous, [...set])));
}
```

Заменить `currentDelay` (строки 157–163):

```js
function currentDelay() {
  let fromFile = null;
  try { fromFile = Number(fs.readFileSync(DELAY_FILE, 'utf8').trim()); }
  catch (e) { /* нет файла — работаем на --delay */ }
  return effectiveDelay(DELAY_GIVEN, DELAY, fromFile);
}
```

Заменить строку 187, которая печатала флаг вместо действующего значения:

```js
    console.log('режим: отправка ' + MSG + ', ' + ids.length + ' матчей, пауза ' + currentDelay() + ' мс');
```

и следующую строку расчёта времени — там тоже `DELAY`:

```js
    console.log('расчётное время: ' + hhmm(ids.length * currentDelay()));
```

Заменить `waitGC` (строки 257–261) — таймаут вместо вечного ожидания:

```js
  // Ждём Welcome от GC, но не бесконечно: открытый Steam-клиент занимает
  // единственную сессию, и раньше отправщик в этом случае висел молча.
  const GC_TIMEOUT = 90_000;
  const waitGC = () => new Promise((resolve, reject) => {
    if (gcReady) return resolve();
    const started = Date.now();
    const t = setInterval(() => {
      if (gcReady) { clearInterval(t); return resolve(); }
      if (Date.now() - started > GC_TIMEOUT) {
        clearInterval(t);
        reject(new Error('GC не ответил Welcome за 90 секунд — закрой Steam и Dota, они занимают сессию'));
      }
    }, 1000);
  });
```

- [ ] **Step 6: Проверить сухим прогоном, без отправки**

Run: `cd tools/gcwatch; node index.js --ids alliance-spare.csv --delay 3000`
Expected: строка `режим: сухой прогон, ничего не отправляется`, затем вход и `GC ответил Welcome`, затем `сухой прогон окончен`. Сообщений в GC не уходит — режим `--dry` включается автоматически без `--send`.

Проверить таймаут: запустить ту же команду **с открытым Steam-клиентом**.
Expected: через 90 секунд `ошибка: GC не ответил Welcome за 90 секунд — закрой Steam и Dota, они занимают сессию`, процесс завершается. Раньше висел бесконечно.

- [ ] **Step 7: Коммит**

```bash
git add tools/gcwatch/lib.js tools/gcwatch/lib.test.js tools/gcwatch/index.js tools/gcwatch/package.json
git commit -m "fix: ledger merge instead of overwrite, delay flag precedence, GC wait timeout"
```

---

## Что этот план сознательно не делает

- **Не трогает вёрстку.** Панель — план 2, она опирается на `supply.ts` и `queue.ts` отсюда.
- **Не чинит `league_id` у гемов-игроков.** Это блокирует 26 гемов из 53, но правка требует замера: неизвестно, нужен ли GC этот параметр вообще. Замер стоит один матч и вынесен в план 3.
- **Не перемеряет запас.** Четыре утечки из раздела 13a спеки — план 3.
- **Не вносит 8 оставшихся реконструированных записей.** Они попадают в базу вместе с перемером, чтобы не смешивать источники.
- **Не делает `importLegacy` идемпотентным.** После Task 4 надобность в нём отпадает: наборы приходят из `gem-sets.json`, а журнал пополняется живыми событиями.
- **Не трогает парсер инвентаря и не добавляет русскую локаль в `steam.ts`.** Парсер меняется в плане 2 — там к нему добавляется определение носителя (`item` / `gem` / `bundle`), и тестировать его дважды смысла нет. Проверен вручную 20 августа: на живом инвентаре коллизий `classid_instanceid` ноль, три набора с разными счётчиками имеют разные `instanceid`, реальная разметка голого гема распознаётся обоими парсерами.

## Порядок

Задачи 1 → 2 → 3 обязаны идти подряд: Task 2 использует `classify` из Task 1, Task 3 добавляет колонку `state`, которую Task 2 уже пишет. Если выполнять в другом порядке, `ingestOne` упадёт на несуществующей колонке.

Задачи 4, 5, 6 зависят от Task 3, но между собой независимы.

Task 7 не зависит ни от чего и может идти первой, если хочется закрыть риск потери журнала раньше всего.
