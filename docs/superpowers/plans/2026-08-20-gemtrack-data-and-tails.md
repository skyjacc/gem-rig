# Gemtrack Data & Tails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перемерить запас всех 53 гемов из источника, который отдаёт `league_id`, и закрыть хвосты, накопившиеся за три дня.

**Architecture:** Единственный источник истины по матчам — SQL-эндпоинт OpenDota `/explorer`. Он отдаёт `match_id` вместе с `leagueid` одним запросом, чего не умеет ни один обычный эндпоинт. Результат складывается в `entity_matches` с настоящей лигой, и списки для отправщика перестают быть нерабочими. Старые источники — `_sets.pkl` и `gem-supply.json` — становятся историей, их числа сохраняются рядом для сверки.

**Tech Stack:** Node 24, `node:test`, `node:sqlite`, OpenDota `/explorer` (PostgreSQL).

**Spec:** `docs/superpowers/specs/2026-08-20-gemtrack-redesign-design.md` — разделы 13a и 13b устарели, задача 3 их правит.

## Global Constraints

- Node 24, встроенный `node:test`, без внешних раннеров.
- TypeScript исполняется нативно. Запрещены `enum`, `namespace`, parameter properties.
- OpenDota `/explorer` — пауза не меньше 1500 мс между запросами, ключ из `tools/opendota.key`.
- Ни один шаг этого плана не отправляет сообщений в Game Coordinator, кроме задачи 6, которая помечена явно и требует отдельного разрешения.
- `league_id` обязателен. Строка списка без него не отправляется — проверено, GC молча отвергает.
- Подтверждением засчёта считается только `update`. `dup` подтверждением не является.

---

## Что изменилось в понимании 20 августа

Три замера подряд переписали модель, и план построен уже на новой.

**`league_id` обязателен.** Матч `8003261364`, две попытки:

```
без league_id  →  7204, 0 байт, счётчик неподвижен
с league_id    →  ОБНОВЛЕНО, 507 байт, Alliance 1→2, голый гем 3→4
```

**`dup` не означает «сожжён».** Отвергнутый матч ответил тем же `7204` без `msg 26` и остался целым. Ответ пуст по протоколу, различить отказ и дубль нельзя.

**Оценки в `gem-map.json` верны, сломано было измерение.** Я называл их фантомами — ошибочно. `/explorer` даёт для Ohaiyo ровно `1672`, то самое число, что стоит в справочнике. Пусто отдавал `/players/{id}/matches`, а не реальность.

**Запас у игроков завышен, а не занижен.** Фильтр `lobby_type === 1` втянул турнирные лобби без лиги, а такие матчи отправить нельзя вовсе:

```
            измерено   /explorer с leagueid>0
Ohaiyo             0                    1672
BZZ             2433                    1990
DD              1017                     508
Alliance        2340                    2360
```

---

### Task 1: Клиент к OpenDota /explorer

Единственный источник, отдающий `match_id` и `leagueid` вместе. Проверен: 508 строк за 697 мс, ограничения на объём не обнаружено.

**Files:**
- Create: `rig/server/explorer.ts`
- Test: `rig/server/explorer.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: `playerSql(accountId: number): string`, `teamSql(teamId: number): string`, `leagueSql(leagueId: number): string`, `parseRows(payload: unknown): Match[]` где `Match = { id: string; league: string }`

- [ ] **Step 1: Написать падающий тест**

Создать `rig/server/explorer.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { playerSql, teamSql, leagueSql, parseRows } from './explorer.ts'

test('запрос по игроку джойнит matches и требует настоящую лигу', () => {
  const sql = playerSql(93616251)
  assert.match(sql, /player_matches/)
  assert.match(sql, /account_id\s*=\s*93616251/)
  assert.match(sql, /leagueid\s*>\s*0/)
})

test('запрос по команде смотрит обе стороны', () => {
  const sql = teamSql(111474)
  assert.match(sql, /radiant_team_id\s*=\s*111474/)
  assert.match(sql, /dire_team_id\s*=\s*111474/)
  assert.match(sql, /leagueid\s*>\s*0/)
})

test('запрос по лиге фильтрует по ней самой', () => {
  assert.match(leagueSql(19944), /leagueid\s*=\s*19944/)
})

test('идентификаторы приводятся к числу — в SQL не уходит строка', () => {
  assert.match(playerSql('93616251; drop table matches' as any), /account_id = 0/)
  assert.match(teamSql(Number.NaN), /radiant_team_id = 0/)
})

test('разбор ответа даёт строковые id и строковые лиги', () => {
  const rows = parseRows({ rows: [{ match_id: 26819809, leagueid: 7 }] })
  assert.deepEqual(rows, [{ id: '26819809', league: '7' }])
})

test('строки без лиги отбрасываются — их всё равно нельзя отправить', () => {
  const rows = parseRows({ rows: [{ match_id: 1, leagueid: 0 }, { match_id: 2, leagueid: null }] })
  assert.deepEqual(rows, [])
})

test('ошибка и мусор дают пустой список, а не падение', () => {
  assert.deepEqual(parseRows({ err: 'syntax error' }), [])
  assert.deepEqual(parseRows(null), [])
  assert.deepEqual(parseRows({ rows: 'nope' }), [])
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `cd rig; npm test`
Expected: FAIL, `Cannot find module './explorer.ts'`

- [ ] **Step 3: Реализовать**

Создать `rig/server/explorer.ts`:

```ts
// OpenDota /explorer — произвольный SQL по их PostgreSQL.
//
// Зачем он вообще нужен: обычный /players/{id}/matches НЕ содержит поля
// leagueid — проверено перечислением ключей ответа. А league_id обязателен,
// GC без него молча отвергает сообщение. Поэтому для гемов-игроков обычные
// эндпоинты дают принципиально непригодные списки.
//
// Условие leagueid > 0 здесь не украшение: матч без лиги отправить нельзя.
// Раньше фильтровали по lobby_type = 1, и в набор попадали турнирные лобби
// без лиги — у DD таких оказалось 509 из 1017.

export type Match = { id: string; league: string }

// Идентификаторы вставляются в текст запроса, поэтому приводятся к числу.
// Строка в SQL не уходит ни при каких входных данных.
const num = (v: unknown) => {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function playerSql(accountId: number): string {
  return `SELECT pm.match_id, m.leagueid
FROM player_matches pm JOIN matches m ON m.match_id = pm.match_id
WHERE pm.account_id = ${num(accountId)} AND m.leagueid > 0
ORDER BY pm.match_id`
}

export function teamSql(teamId: number): string {
  const t = num(teamId)
  return `SELECT m.match_id, m.leagueid
FROM matches m
WHERE (m.radiant_team_id = ${t} OR m.dire_team_id = ${t}) AND m.leagueid > 0
ORDER BY m.match_id`
}

export function leagueSql(leagueId: number): string {
  return `SELECT m.match_id, m.leagueid
FROM matches m WHERE m.leagueid = ${num(leagueId)}
ORDER BY m.match_id`
}

export function parseRows(payload: unknown): Match[] {
  const rows = (payload as any)?.rows
  if (!Array.isArray(rows)) return []
  const out: Match[] = []
  for (const r of rows) {
    const league = Number(r?.leagueid)
    if (!Number.isFinite(league) || league <= 0) continue
    out.push({ id: String(r.match_id), league: String(league) })
  }
  return out
}
```

- [ ] **Step 4: Запустить и убедиться, что проходит**

Run: `cd rig; npm test`
Expected: PASS, 26 тестов

- [ ] **Step 5: Коммит**

```bash
git add rig/server/explorer.ts rig/server/explorer.test.ts
git commit -m "feat: OpenDota explorer client, the only source that returns leagueid"
```

---

### Task 2: Перемер запаса всех 53 гемов

Разовый прогон: для каждого гема из `gem-map.json` тянем набор через explorer и складываем в базу. Прежние числа сохраняем рядом, чтобы видеть, что изменилось и в какую сторону.

**Files:**
- Create: `rig/remeasure.ts` (разовый скрипт, живёт в корне `rig/`, не в `server/`)
- Modify: `tools/gem-supply.json` (перезаписывается результатом)
- Create: `tools/gem-supply-old.json` (копия прежнего, для сверки)

**Interfaces:**
- Consumes: `playerSql`, `teamSql`, `leagueSql`, `parseRows` из Task 1
- Produces: заполненный `entity_matches` с настоящими `league_id`; отчёт в консоль

- [ ] **Step 1: Сохранить прежние числа**

```bash
cd "C:\Users\oblako\Desktop\gem-rig"
cp tools/gem-supply.json tools/gem-supply-old.json
cp tools/rig.db "tools/rig.db.backup-before-remeasure"
```

- [ ] **Step 2: Написать скрипт**

Создать `rig/remeasure.ts`:

```ts
// Разовый перемер запаса. Идёт по gem-map.json, для каждого гема тянет набор
// матчей через /explorer и кладёт в entity_matches вместе с настоящей лигой.
//
//   node rig/remeasure.ts            только показать, ничего не писать
//   node rig/remeasure.ts --write    записать в базу и в gem-supply.json

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { playerSql, teamSql, leagueSql, parseRows } from './server/explorer.ts'

const TOOLS = path.resolve(import.meta.dirname, '..', 'tools')
const WRITE = process.argv.includes('--write')
const KEY = fs.readFileSync(path.join(TOOLS, 'opendota.key'), 'utf8').trim()
const PAUSE = 1600

const db = new DatabaseSync(path.join(TOOLS, 'rig.db'))
const map = JSON.parse(fs.readFileSync(path.join(TOOLS, 'gem-map.json'), 'utf8')) as any[]
const oldSupply = JSON.parse(fs.readFileSync(path.join(TOOLS, 'gem-supply.json'), 'utf8')) as Record<string, number>

const sqlFor = (g: any) =>
  g.kind === 'player' ? playerSql(g.entity_id)
  : g.kind === 'team' ? teamSql(g.entity_id)
  : g.kind === 'league' ? leagueSql(g.entity_id)
  : null

const ins = db.prepare(
  `insert or replace into entity_matches (kind, entity_id, match_id, league_id) values (?,?,?,?)`)

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const fresh: Record<string, number> = {}

console.log(WRITE ? 'режим: запись' : 'режим: только показать, --write чтобы записать')
console.log('гем'.padEnd(34), 'вид'.padEnd(8), 'было'.padStart(6), 'стало'.padStart(7), '  разница')

for (const g of map) {
  const sql = sqlFor(g)
  if (!sql) { console.log(String(g.name).padEnd(34), String(g.kind).padEnd(8), '— сущность не опознана'); continue }

  const url = 'https://api.opendota.com/api/explorer?api_key=' + KEY + '&sql=' + encodeURIComponent(sql)
  let rows: { id: string; league: string }[] = []
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'gemtrack' } })
    rows = parseRows(await res.json())
  } catch (e: any) {
    console.log(String(g.name).padEnd(34), String(g.kind).padEnd(8), '— ошибка:', e.message)
    await wait(PAUSE); continue
  }

  const was = oldSupply[g.name] ?? 0
  const now = rows.length
  fresh[g.name] = now
  const diff = now - was
  const mark = diff === 0 ? '' : (diff > 0 ? '  +' + diff : '  ' + diff)
  console.log(String(g.name).padEnd(34), String(g.kind).padEnd(8),
    String(was).padStart(6), String(now).padStart(7), mark)

  if (WRITE) for (const r of rows) ins.run(g.kind, g.entity_id, r.id, r.league)
  await wait(PAUSE)
}

if (WRITE) {
  fs.writeFileSync(path.join(TOOLS, 'gem-supply.json'), JSON.stringify(fresh, null, 1))
  console.log('\nзаписано: entity_matches и gem-supply.json')
} else {
  console.log('\nничего не записано')
}

const sum = Object.values(fresh).reduce((a, b) => a + b, 0)
const uni = (db.prepare('select count(distinct match_id) c from entity_matches').get() as any).c
console.log('сумма по гемам:', sum, ' уникальных матчей в базе:', uni)
```

- [ ] **Step 3: Сухой прогон**

Run: `cd "C:\Users\oblako\Desktop\gem-rig"; node rig/remeasure.ts`
Expected: таблица на 53 строки. Проверить ключевые:

```
Spectator: Ohaiyo        player       0    1672   +1672
Spectator: DD            player    1017     508    -509
Spectator: BZZ           player    2433    1990    -443
Spectator: Alliance      team      2340    2360     +20
```

Если Ohaiyo снова показывает 0 — explorer не отвечает или ключ не подхватился, дальше не идти.

- [ ] **Step 4: Запись**

Run: `node rig/remeasure.ts --write`
Expected: те же числа и строка `записано: entity_matches и gem-supply.json`

- [ ] **Step 5: Проверить, что лиги проставились**

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('tools/rig.db',{readOnly:true});console.log(db.prepare(\"select kind, count(*) n, sum(case when league_id is null or league_id='' or league_id='0' then 1 else 0 end) empty from entity_matches group by kind\").all())"
```

Expected: `empty` равен нулю для всех видов. Раньше у `player` он равнялся полному числу строк.

- [ ] **Step 6: Коммит**

```bash
git add rig/remeasure.ts tools/gem-supply.json tools/gem-supply-old.json
git commit -m "feat: remeasure supply for all 53 gems through explorer, real league ids"
```

---

### Task 3: Починить opendota.ts

Панель до сих пор строит списки через `/players/{id}/matches` без лиги. После Task 2 наборы уже в базе, и ходить в OpenDota на лету больше не нужно — но фильтр по лиге обязан появиться и там, где ходит.

**Files:**
- Modify: `rig/server/opendota.ts:20-40`
- Test: `rig/server/opendota.test.ts`

**Interfaces:**
- Consumes: `playerSql`, `teamSql`, `leagueSql`, `parseRows` из Task 1
- Produces: `entityMatches(kind, id)` — сигнатура прежняя, источник другой

- [ ] **Step 1: Написать падающий тест**

Создать `rig/server/opendota.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usableOnly } from './opendota.ts'

test('матчи без лиги отбрасываются — их нельзя отправить', () => {
  const rows = usableOnly([
    { id: '1', league: '16710' },
    { id: '2', league: '' },
    { id: '3', league: '0' },
    { id: '4', league: '19944' },
  ])
  assert.deepEqual(rows.map(r => r.id), ['1', '4'])
})

test('пустой вход не падает', () => {
  assert.deepEqual(usableOnly([]), [])
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `cd rig; npm test`
Expected: FAIL, `usableOnly` не экспортируется

- [ ] **Step 3: Реализовать**

В `rig/server/opendota.ts` добавить экспорт и применить его в `entityMatches`:

```ts
// league_id обязателен: GC молча отвергает сообщение без него.
// Матч без лиги в списке — это гарантированно потраченное впустую сообщение.
export function usableOnly(rows: { id: string; league: string }[]) {
  return rows.filter(r => /^[0-9]{1,10}$/.test(String(r.league)) && Number(r.league) > 0)
}
```

и в конце `entityMatches`, перед `saveEntityMatches`, обернуть результат:

```ts
    const out: Match[] = usableOnly(rows
      .filter((m: any) => m.match_id)
      .map((m: any) => ({ id: String(m.match_id), league: String(m.leagueid ?? m.league_id ?? '') })))
```

- [ ] **Step 4: Запустить и убедиться, что проходит**

Run: `cd rig; npm test`
Expected: PASS, 28 тестов

- [ ] **Step 5: Коммит**

```bash
git add rig/server/opendota.ts rig/server/opendota.test.ts
git commit -m "fix: drop matches without a league, they cannot be sent at all"
```

---

### Task 4: Привести спеку и README в соответствие

Оба документа описывают модель, которая уже опровергнута. README вообще не знает ни об одном замере 19–20 августа.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-20-gemtrack-redesign-design.md` — разделы 13a, 13b
- Modify: `README.md` — разделы 3, 4, 5, 11

- [ ] **Step 1: Исправить спеку**

В разделе 13a убрать утверждение про фантомы и 15 442 несуществующих матча. Заменить на:

> Оценки `matches_estimate` в `gem-map.json` верны — `/explorer` подтверждает их
> число в число: у Ohaiyo и там и там 1672. Сломано было измерение через
> `/players/{id}/matches`, которое для части игроков отдаёт пусто.
>
> Запас у гемов-игроков был искажён в обе стороны. Фильтр `lobby_type === 1`
> втягивал турнирные лобби без лиги, а такие матчи отправить нельзя: у DD из
> 1017 пригодны 508. Единственный корректный источник — `/explorer` с условием
> `leagueid > 0`.

В разделе 13b убрать пункты 1 и 2 — оба закрыты замерами. Пункт 1 заменить на констатацию:
`league_id` обязателен, проверено. Пункт 2 — на констатацию: `7204` пуст по протоколу,
`dup` и отказ неразличимы, поэтому подтверждением считается только `update`.

- [ ] **Step 2: Дописать README**

В раздел 3 добавить подраздел «3.6 Замеры 19–20 августа»:

```markdown
### 3.6 Замеры 19–20 августа

**Голый гем без сокета считается.** `OBSERVED`
Купили `Spectator: Alliance` со счётчиком 2, отправили один матч Alliance.
Гем 2 → 3, три предмета с сокетом 0 → 1, остальные гемы неподвижны.
Artificer's Chisel не нужен, закупка упирается в гемы по три цента.

**Гем считает сущность, а не лигу.** `OBSERVED`
В лиге 14389 у Empire один матч, у NaVi десять. Сожгли матч Empire из этой
лиги: Empire 1 → 11, BZZ 0 → 10, NaVi остался 5.

**Аккаунтный журнал GC не истекает.** `OBSERVED`
Пять матчей NaVi, сожжённых 26 часами ранее, отправлены повторно:
пять ответов 7204, ноль обновлений. Потолок сущности реален.

**`league_id` обязателен.** `OBSERVED`
Матч 8003261364 без лиги — 7204 без обновления, счётчик неподвижен.
Тот же матч с лигой 16710 — ОБНОВЛЕНО, 507 байт, счётчики выросли.

**`dup` не означает «сожжён».** `VERIFIED`
`CMsgUpgradeLeagueItemResponse` — пустое сообщение, полей нет вовсе.
Отвергнутый матч отвечает тем же 7204 без msg 26, что и настоящий дубль,
и остаётся целым. Подтверждением засчёта считается только msg 26.
```

В разделе 4 добавить шестое правило:

```markdown
6. **`league_id` обязателен.** Сообщение без него уходит, GC отвечает, счётчик
   не двигается, а матч остаётся целым. Снаружи это выглядит как дубль.
```

В разделе 5 заменить числа запаса на перемеренные и добавить строку про то, что
`Genuine Spectator: Evil Geniuses` за $40.60 не даёт ни одного нового матча —
его набор совпадает с обычным EG за $0.09 полностью, 2674 из 2674.

В разделе 11 убрать вопросы 1 и 4 — оба закрыты. Оставить потолок студийных
гемов, сущности трёх гемов, реакцию Valve. Добавить извлечение чиселом.

- [ ] **Step 3: Коммит**

```bash
git add README.md docs/superpowers/specs/2026-08-20-gemtrack-redesign-design.md
git commit -m "docs: record the 19-20 August measurements, correct the phantom-supply claim"
```

---

### Task 5: Хвосты

Мелочи, каждая на минуту, но пока они висят — проект живёт в двух копиях, а панель работает по старому коду.

**Files:**
- Delete: копии файлов гем-проекта в `C:\Users\oblako\Desktop\Dota 2 market`

- [ ] **Step 1: Перезапустить панель**

На порту 4322 крутится процесс, поднятый до правок. Он работает по коду, где
`silent` жжёт матчи, а `markBurned` пишет в обход проверки.

```bash
Get-NetTCPConnection -LocalPort 4322 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
cd "C:\Users\oblako\Desktop\gem-rig\rig"; npm run start
```

- [ ] **Step 2: Убедиться, что переезд состоялся**

README раздела 12 предписывает удалить копии из старой папки после проверки.
Проверка состоялась: панель поднимается, тесты идут, замеры сделаны из новой папки.

Сначала сверить, что ничего уникального в старой папке не осталось:

```bash
cd "C:\Users\oblako\Desktop"
diff -rq "gem-rig/tools/gcwatch" "Dota 2 market/tools/gcwatch" --exclude=node_modules
```

Ожидается список расхождений только в сторону `gem-rig` — там новые файлы
(`lib.js`, `league-*.csv`, обновлённый `index.js`). Ничего, чего нет в `gem-rig`,
быть не должно.

- [ ] **Step 3: Удалить копии из старой папки**

Только после того, как Step 2 показал, что уникального там нет:

```bash
cd "C:\Users\oblako\Desktop\Dota 2 market"
Remove-Item -Recurse -Force rig, tools\gcwatch, tools\gemtrack-data
Remove-Item -Force tools\gemtrack.js, tools\getreplay.js, tools\gem-*.json, tools\gems.json, tools\rig.db, tools\panel.js, tools\opendota.key, tools\steam.key, tools\_sets.pkl
```

`_sets.pkl` удаляется последним и только если Task 2 отработала: он больше не
источник истины, но пока перемер не сделан — это единственная копия старых наборов.

- [ ] **Step 4: Влить ветку**

```bash
cd "C:\Users\oblako\Desktop\gem-rig"
git checkout master
git merge --no-ff gemtrack-foundation -m "merge: Gemtrack foundation"
git branch -d gemtrack-foundation
```

---

### Task 6: Извлечение чиселом — последний открытый вопрос механики

**ТРЕБУЕТ ОТДЕЛЬНОГО РАЗРЕШЕНИЯ.** Стоит денег и необратим.

Переживает ли счётчик выемку гема из предмета. Рынок намекает, что да —
голые гемы торгуются со счётчиками до 168, — но прямо это не проверено, а
теперь известно, что голый гем и сам умеет набирать, так что рыночные лоты
доказательством больше не служат.

```
EXPERIMENT PROPOSAL — «переживает ли счётчик чисел»

Вопрос:      Сохраняется ли Games Watched при извлечении гема из предмета?
Цена:        Artificer's Chisel ≈ $1.07. На рынке около трёх штук в сутки.
Риск:        Необратимо. Если счётчик обнуляется — предмет теряет накрученное.
             Поэтому берётся предмет с МАЛЫМ счётчиком, а не с 18.
Состояние:   Предмет Alliance со счётчиком 2 (их три штуки, любой).
             Голый гем Alliance со счётчиком 4 в инвентаре — как эталон.
Действие:    1) снять срез
             2) извлечь гем чиселом из Tail of Reminiscence
             3) снять срез
Исходы:      голый гем со счётчиком 2 появился в инвентаре
               → счётчик переживает извлечение, гемы можно перекладывать
             появился со счётчиком 0
               → счётчик привязан к сокету, извлекать нельзя, это потеря
             гем не появился вовсе
               → чисел уничтожает гем, а не извлекает
Зачем нужно: определяет, можно ли накрутить дёшево на россыпи и потом собрать
             ценность в один предмет. Если да — меняется вся стратегия закупки.
Откат:       нет
```

---

## Порядок

Task 1 → 2 → 3 подряд: второй использует клиент из первого, третий опирается на
наборы, которые запишет второй.

Task 4 после Task 2 — в README и спеку идут перемеренные числа.

Task 5 независим, но Step 3 не делать раньше Task 2: до перемера `_sets.pkl`
остаётся единственной копией старых наборов.

Task 6 отдельно и только по явному разрешению.

## Чего этот план не делает

- **Не строит панель.** Это план 2, он ещё не написан.
- **Не решает вопрос сбыта.** Снят по решению владельца проекта.
- **Не трогает 8 оставшихся реконструированных записей.** После Task 2 наборы
  меняются, и сверять реконструкцию надо будет заново, по новым числам.
