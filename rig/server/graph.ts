// Граф пересечений сущностей.
//
// Одно сообщение поднимает ВСЕ подходящие вещи разом. Значит матч, входящий
// в наборы двух сущностей, стоит одну отправку, а счётчик поднимает обеим.
// Empire и Alliance делят 840 матчей — это 840 бесплатных единиц, если
// держать гемы обоих.
//
// Отсюда смысл графа: он показывает не «кто с кем играл», а что выгодно
// покупать вместе. Толстое ребро — дешёвые счётчики.

import type { DatabaseSync } from 'node:sqlite'
import { entityMatchIds, type Entity } from './supply.ts'
import { burnedSet } from './queue.ts'

export type Edge = { a: string; b: string; shared: number }

// Пары считаются через обратный индекс матч → сущности: перебор всех пар
// множеств на полусотне сущностей был бы в тысячу раз дороже.
//
// Концы ребра хранятся рядом с ключом, а не восстанавливаются из него.
//
// Раньше ключом было `a + ' ' + b`, а пара разбиралась обратно через
// split(' '). У сущностей имена из нескольких слов — «Evil Geniuses»,
// «Team Liquid», «Beyond the Summit» — и такая пара возвращалась как
// «Evil» и «Geniuses»: ребро указывало на узлы, которых нет, и связь
// просто пропадала с полотна.
//
// Ключ считается с длиной первого имени спереди: «A B» + «C» даёт 3:A BC,
// а «A» + «B C» даёт 1:AB C. Любой символ-разделитель рано или поздно
// встретится в имени команды, а длина — никогда.
const pairKey = (a: string, b: string) => a.length + ':' + a + b

export function coEdges(sets: Map<string, string[]>): Edge[] {
  const owners = new Map<string, Set<string>>()
  for (const [key, matches] of sets) {
    for (const m of matches) {
      let o = owners.get(m)
      if (!o) { o = new Set(); owners.set(m, o) }
      o.add(key)
    }
  }

  const pairs = new Map<string, Edge>()
  for (const o of owners.values()) {
    if (o.size < 2) continue
    const keys = [...o].sort()
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const k = pairKey(keys[i], keys[j])
        const cur = pairs.get(k)
        if (cur) cur.shared++
        else pairs.set(k, { a: keys[i], b: keys[j], shared: 1 })
      }
    }
  }

  return [...pairs.values()]
    .sort((x, y) => y.shared - x.shared || (x.a < y.a ? -1 : 1))
}

export type Node = {
  key: string
  kind: string
  id: number
  owned: number      // сколько вещей с этим гемом лежит в инвентаре
  pool: number       // потолок: сколько матчей всего
  burned: number     // сколько израсходовано этим аккаунтом
  price: number | null
  counter: number    // текущий счётчик, максимум по вещам
  icon: string
}

export type GraphEntity = Entity & {
  key: string
  owned: number
  price: number | null
  counter: number
  icon: string
}

export function buildGraph(target: DatabaseSync, entities: GraphEntity[], account: string) {
  const spent = burnedSet(target, account)
  const sets = new Map<string, string[]>()
  const nodes: Node[] = []

  // Один узел на ключ. В карте гемов одна команда бывает дважды —
  // «Spectator: Evil Geniuses» и «Genuine Spectator: Evil Geniuses», —
  // а ключ у них после нормализации один. Двойной узел ломал полотно:
  // React ругался на повтор key, раскладка схлопывала их по ключу.
  // Берём последнюю запись: рёбра по sets.set и раньше строились по ней.
  const byKey = new Map<string, GraphEntity>()
  for (const e of entities) byKey.set(e.key, e)

  for (const e of byKey.values()) {
    const ids = entityMatchIds(target, e)
    if (!ids.length) continue
    sets.set(e.key, ids)
    let burned = 0
    for (const m of ids) if (spent.has(m)) burned++
    nodes.push({
      key: e.key,
      kind: e.kind,
      id: e.id,
      owned: e.owned,
      pool: ids.length,
      burned,
      price: e.price,
      counter: e.counter,
      icon: e.icon,
    })
  }

  return { nodes, edges: coEdges(sets) }
}
