// Разброс счётчиков.
//
// Одно сообщение поднимает ВСЕ подходящие вещи разом. Значит двадцать девять
// предметов BZZ идут в ногу и приходят к одному и тому же числу. Двадцать
// девять одинаковых счётчиков на витрине выглядят ровно тем, чем являются.
//
// Отсюда две вещи.
//
// Первая: не останавливаться на круглом. 1000 и 2000 — числа, которых
// естественная игра не даёт почти никогда. Заказ «тысяча» превращается
// в 1147: не ниже заказанного, но и не с потолка.
//
// Вторая: разброс делается партиями. Счётчик вещи равен числу отправок,
// сделанных ПОСЛЕ её появления в инвентаре. Значит если добавлять вещи
// не сразу, а по ходу, они получат разные числа:
//
//   партия 1 лежит с самого начала  →  1320
//   партия 2 добавлена на 206-й     →  1114
//   партия 3 добавлена на 317-й     →  1003
//
// Момент добавления считается назад от самой длинной партии.
// Работник сам замечает новые вещи и сам говорит, когда пора добавлять.

// Дешёвый детерминированный хеш: одно зерно — одно число, всегда то же.
// Случайность здесь была бы вредна: перезапуск панели не должен менять план.
function hash(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967295
}

// Живое число: заказ плюс от 0,3 % до 34 %, и не оканчивающееся на круглое.
export function livelyTarget(base: number, seed: string): number {
  const b = Math.max(1, Math.trunc(base))
  let v = Math.round(b * (1.003 + hash(seed) * 0.34))
  // Круглые хвосты убираем: они и выдают накрутку.
  for (let i = 0; i < 60 && (v % 50 === 0 || v % 100 === 0); i++) v++
  return Math.max(b + 1, v)
}

export type Wave = {
  index: number
  addAt: number    // на какой отправке добавлять партию
  value: number    // какой счётчик она получит к концу
}

// Ширина полосы разброса. Восемнадцать процентов от заказа: при тысяче это
// примерно от 1020 до 1200 — числа, между которыми видно расстояние.
//
// Случайные значения из одного диапазона тут не годятся: три числа могут лечь
// в восьми единицах друг от друга, и тогда разброс выглядит хуже, чем его
// отсутствие. Партии разносятся ровным шагом, а дрожание добавляется поверх.
export type Shape = { band: number; jitter: number }
const FALLBACK: Shape = { band: 0.18, jitter: 0.025 }

export function spreadPlan(base: number, waves: number, seed: string, shape: Shape = FALLBACK): Wave[] {
  const BAND = shape.band
  const JITTER = shape.jitter
  const b = Math.max(1, Math.trunc(base))
  const n = Math.max(1, Math.trunc(waves))
  if (n === 1) return [{ index: 0, addAt: 0, value: livelyTarget(b, seed + ':0') }]

  const stepUp = (b * BAND) / (n - 1)
  const raw: number[] = []
  for (let i = 0; i < n; i++) {
    const spot = b * 1.02 + stepUp * (n - 1 - i)
    const shake = (hash(seed + ':' + i) - 0.5) * 2 * b * JITTER
    raw.push(Math.round(spot + shake))
  }

  // Совпадения и круглые хвосты ломают весь смысл — разводим.
  const seen = new Set<number>()
  const values = raw.map(v => {
    let x = Math.max(b + 1, v)
    while (seen.has(x) || x % 50 === 0 || x % 100 === 0) x++
    seen.add(x)
    return x
  }).sort((a, b2) => b2 - a)

  const longest = values[0]
  return values.map((value, index) => ({ index, addAt: longest - value, value }))
}
