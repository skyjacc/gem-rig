// Работник — то, что крутится само, пока вы покупаете гемы.
//
// Модель не «прогон, который запустили», а постоянный процесс:
//
//   раз в минуту смотрим инвентарь
//   появился новый гем  →  его матчи входят в очередь
//   очередь не пуста    →  отправщик работает
//   очередь пуста       →  ждём, ничего не жжём
//
// Человек нужен только чтобы купить гем. Остальное система замечает сама.
//
// Здесь — чистое решение «что делать дальше». Без ввода-вывода, чтобы
// его можно было проверить тестами, а не гадать по логам.

export type Snapshot = {
  enabled: boolean          // включён ли работник
  senderAlive: boolean      // жив ли процесс отправщика
  queueLength: number       // сколько матчей осталось в очереди
  inventoryChanged: boolean // изменился ли состав гемов с прошлой сборки
  lastSendAt: number        // когда отправщик последний раз слал, 0 = ещё ни разу
  now: number
  failures: number          // сколько раз подряд отправщик падал
}

export type Action = 'idle' | 'start' | 'restart' | 'rebuild' | 'watch' | 'halt'
export type Decision = { action: Action; why: string }

// Отправщик, который молчит дольше этого, считается зависшим.
// Замер 20 августа: при паузе в секунду отправка идёт раз в 1,3 с,
// так что минута тишины — это уже не темп, а поломка.
const SILENT_LIMIT = 60_000

// Сколько падений подряд терпим, прежде чем остановиться с причиной.
const MAX_FAILURES = 5

export function decide(s: Snapshot): Decision {
  if (!s.enabled) return { action: 'idle', why: 'работник выключен' }

  if (s.failures >= MAX_FAILURES) {
    return { action: 'halt', why: s.failures + ' падений подряд — остановился, нужен разбор' }
  }

  // Состав важнее всего: жечь по устаревшей очереди значит терять
  // купленные только что гемы. Пересобираем до любых других действий.
  if (s.inventoryChanged) {
    return { action: 'rebuild', why: 'инвентарь изменился, пересобираю очередь' }
  }

  if (s.queueLength <= 0) {
    return { action: 'idle', why: 'нечего жечь — жду новых гемов' }
  }

  if (!s.senderAlive) {
    return { action: 'start', why: 'в очереди ' + s.queueLength + ', запускаю отправщик' }
  }

  // lastSendAt === 0 означает «запустился, но ещё не успел отправить».
  // Это не тишина, это разогрев.
  if (s.lastSendAt > 0 && s.now - s.lastSendAt > SILENT_LIMIT) {
    return {
      action: 'restart',
      why: 'отправщик молчит ' + Math.round((s.now - s.lastSendAt) / 1000) + ' с, перезапускаю',
    }
  }

  return { action: 'watch', why: 'работает' }
}
