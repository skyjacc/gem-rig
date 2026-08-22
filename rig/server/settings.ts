// Настройки.
//
// Всё, что раньше было константой в коде и требовало правки файла. Пороги
// подбирались замерами, но замеры устаревают: у другого аккаунта, канала
// или времени суток числа будут другими. Поэтому крутится из панели.
//
// Значения по умолчанию — не выдумка, а то, что измерено 20 августа:
// 76 отправок в минуту при паузе в секунду, отклик GC 340 мс по медиане
// и 764 мс в худшем случае.

import fs from 'node:fs'
import path from 'node:path'
import { TOOLS, readJson } from './paths.ts'

export type Settings = {
  // Сколько просмотров считается товаром.
  goal: number
  // Как часто работник смотрит инвентарь и состояние отправщика, мс.
  tick: number
  // Сколько отправщик может молчать, прежде чем его перезапустят, мс.
  silentLimit: number
  // Сколько ждать первой отправки после запуска, мс. Срок отдельный
  // и длиннее: у отправщика своя лестница отходов при обрывах связи.
  startLimit: number
  // Сколько падений подряд терпим, прежде чем встать с причиной.
  maxFailures: number
  // Через сколько считать прочитанный инвентарь устаревшим, мс.
  invTtl: number
  // Насколько старым счётчикам ещё можно верить при работе с потолком.
  invStale: number
  // Сколько турниров показывать под гемом в дереве.
  treeTop: number
  // За сколько уходит готовая вещь, в долларах. От этого числа считается
  // вся экономика закупки: дешёвый гем сам по себе ничего не значит.
  sellPrice: number
  // Сколько брать одного гема за раз в плане закупки.
  perGem: number
  // Насколько цена может вырасти между планом и покупкой и всё ещё
  // считаться приемлемой. Ноль означает «только по своей цене или дешевле».
  priceTolerance: number

  pace: {
    floor: number   // ниже этой паузы не опускаемся никогда, мс
    ceil: number    // выше этой не поднимаемся, мс
    enough: number  // меньше этого числа отправок — не выборка, а совпадение
    clean: number   // доля молчаний, ниже которой темп считается чистым
    down: number    // множитель ускорения, когда чисто
    up: number      // множитель замедления, когда молчит
  }

  spread: {
    band: number    // ширина полосы разброса, доля от заказа
    jitter: number  // дрожание поверх ровного шага, доля от заказа
  }
}

export const DEFAULTS: Settings = {
  goal: 2000,
  tick: 20_000,
  silentLimit: 60_000,
  startLimit: 300_000,
  maxFailures: 5,
  invTtl: 60_000,
  invStale: 1_800_000,
  treeTop: 12,
  sellPrice: 10,
  perGem: 25,
  priceTolerance: 0,
  // Пол 500 мс — не осторожность, а предел отправщика: значение ниже он
  // из файла не принимает вовсе и молча остаётся на прежнем темпе.
  pace: { floor: 500, ceil: 30_000, enough: 40, clean: 0.01, down: 0.8, up: 1.4 },
  spread: { band: 0.18, jitter: 0.025 },
}

// Пределы. Панель — не место, где можно случайно выставить паузу в ноль
// и получить бан: каждая отправка необратима.
const LIMITS: Record<string, [number, number]> = {
  goal: [1, 100_000],
  tick: [5_000, 600_000],
  silentLimit: [10_000, 3_600_000],
  startLimit: [30_000, 3_600_000],
  maxFailures: [1, 50],
  invTtl: [10_000, 3_600_000],
  invStale: [60_000, 86_400_000],
  treeTop: [1, 60],
  sellPrice: [0.01, 10_000],
  perGem: [1, 5_000],
  priceTolerance: [0, 1],
  'pace.floor': [100, 60_000],
  'pace.ceil': [1_000, 600_000],
  'pace.enough': [5, 5_000],
  'pace.clean': [0, 1],
  'pace.down': [0.5, 0.99],
  'pace.up': [1.05, 4],
  'spread.band': [0.02, 0.6],
  'spread.jitter': [0, 0.2],
}

const clamp = (key: string, v: number) => {
  const l = LIMITS[key]
  if (!l) return v
  return Math.min(l[1], Math.max(l[0], v))
}

const num = (key: string, v: unknown, fallback: number) => {
  // null и пустая строка — это «не прислали», а не ноль. Number(null) === 0,
  // и без этой проверки пустое поле обнуляло бы настройку.
  if (v === null || v === undefined || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  const whole = key === 'pace.clean' || key.startsWith('spread.') || key === 'pace.down' || key === 'pace.up' || key === 'sellPrice' || key === 'priceTolerance'
  return clamp(key, whole ? n : Math.trunc(n))
}

// Правка накладывается полем на поле: панель шлёт только то, что меняет.
export function merge(base: Settings, patch: any): Settings {
  const p = patch && typeof patch === 'object' ? patch : {}
  const pace = p.pace && typeof p.pace === 'object' ? p.pace : {}
  const spread = p.spread && typeof p.spread === 'object' ? p.spread : {}

  const out: Settings = {
    goal: num('goal', p.goal, base.goal),
    tick: num('tick', p.tick, base.tick),
    silentLimit: num('silentLimit', p.silentLimit, base.silentLimit),
    startLimit: num('startLimit', p.startLimit, base.startLimit),
    maxFailures: num('maxFailures', p.maxFailures, base.maxFailures),
    invTtl: num('invTtl', p.invTtl, base.invTtl),
    invStale: num('invStale', p.invStale, base.invStale),
    treeTop: num('treeTop', p.treeTop, base.treeTop),
    sellPrice: num('sellPrice', p.sellPrice, base.sellPrice),
    perGem: num('perGem', p.perGem, base.perGem),
    priceTolerance: num('priceTolerance', p.priceTolerance, base.priceTolerance),
    pace: {
      floor: num('pace.floor', pace.floor, base.pace.floor),
      ceil: num('pace.ceil', pace.ceil, base.pace.ceil),
      enough: num('pace.enough', pace.enough, base.pace.enough),
      clean: num('pace.clean', pace.clean, base.pace.clean),
      down: num('pace.down', pace.down, base.pace.down),
      up: num('pace.up', pace.up, base.pace.up),
    },
    spread: {
      band: num('spread.band', spread.band, base.spread.band),
      jitter: num('spread.jitter', spread.jitter, base.spread.jitter),
    },
  }

  // Потолок ниже пола — бессмыслица, из которой не выбраться настройкой.
  if (out.pace.ceil < out.pace.floor) out.pace.ceil = out.pace.floor
  return out
}

const FILE = path.join(TOOLS, 'settings.json')

let current: Settings = merge(DEFAULTS, readJson<any>(FILE, {}))

export const settings = () => current

export function update(patch: any): Settings {
  current = merge(current, patch)
  fs.writeFileSync(FILE, JSON.stringify(current, null, 2), 'utf8')
  return current
}

export function reset(): Settings {
  current = { ...DEFAULTS, pace: { ...DEFAULTS.pace }, spread: { ...DEFAULTS.spread } }
  fs.writeFileSync(FILE, JSON.stringify(current, null, 2), 'utf8')
  return current
}
