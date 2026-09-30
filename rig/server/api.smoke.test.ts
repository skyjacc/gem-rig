import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountList, burnedList, graph, itemPool, queuePreview, tree } from './api.ts'
import { buildState } from './state.ts'

// Свежая установка: панель поднялась, обходчик ещё не запускался.
//
// В такой базе есть только таблицы, которые создаёт сама панель — vmatch
// и vplayer появляются позже, от rig/crawl.ts. Ни один экран не имеет права
// уронить сервер на этом: человек открывает панель до того, как выкачает
// карту матчей, и должен увидеть пустые списки, а не пятисотую ошибку.

test('состояние собирается на базе без карты матчей', () => {
  const s = buildState()
  assert.equal(typeof s.ts, 'number')
  assert.ok(Array.isArray(s.mine))
  assert.ok(Array.isArray(s.catalog))
  assert.ok(Array.isArray(s.events))
  assert.equal(typeof s.burned, 'number')
})

test('снимок состояния несёт ровно то, что объявлено фронту', () => {
  const keys = Object.keys(buildState()).sort()
  assert.deepEqual(keys, [
    'arrivals', 'autopilot', 'burned', 'catalog', 'confirmed', 'dups',
    'events', 'inv', 'keys', 'mine', 'purchase', 'rate', 'ts',
  ], 'поле, которого нет в типе State, — это либо мёртвый груз, либо as any на фронте')
})

test('у вещи в снимке нет своего значка — он один на гем', () => {
  for (const m of buildState().mine) {
    for (const r of m.rows) {
      assert.equal('icon' in r, false, 'хеш картинки на каждой вещи — сорок процентов снимка')
    }
  }
})

test('экраны не падают без карты матчей', () => {
  assert.doesNotThrow(() => queuePreview(10), 'очередь')
  assert.doesNotThrow(() => tree(3), 'дерево')
  assert.doesNotThrow(() => graph('owned'), 'сеть по своим')
  assert.doesNotThrow(() => graph('all'), 'сеть по каталогу')
  assert.doesNotThrow(() => itemPool(), 'наборы')
  assert.doesNotThrow(() => burnedList(5), 'израсходованные')
  assert.doesNotThrow(() => accountList(), 'аккаунты')
})

test('пустая очередь — это ноль строк, а не отсутствие ответа', () => {
  const q = queuePreview(10)
  assert.equal(typeof q.total, 'number')
  assert.ok(Array.isArray(q.rows))
})

test('дерево всегда имеет корень', () => {
  const t = tree(3)
  assert.equal(t.kind, 'root')
  assert.ok(Array.isArray(t.children))
})

test('сеть отдаёт узлы и рёбра, даже когда их нет', () => {
  const g = graph('owned')
  assert.ok(Array.isArray(g.nodes))
  assert.ok(Array.isArray(g.edges))
})

test('список аккаунтов знает активного', () => {
  const a = accountList()
  assert.ok(Array.isArray(a.list))
  assert.ok(a.list.length > 0, 'первый аккаунт заводится сам')
  assert.equal(typeof a.list[0].burned, 'number')
})
