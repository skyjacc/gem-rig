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
  target: number | null     // сколько отправок заказано; null = до конца очереди
  done: number              // сколько уже сделано в этом заходе
}

export type Action = 'idle' | 'start' | 'restart' | 'rebuild' | 'watch' | 'halt'
export type Decision = { action: Action; why: string }

// Пороги приходят снаружи, из настроек панели. Значения по умолчанию —
// замер 20 августа: при паузе в секунду отправка идёт раз в 1,3 с, так что
// минута тишины — это уже не темп, а поломка.
export type Limits = { silentLimit: number; maxFailures: number }
const FALLBACK: Limits = { silentLimit: 60_000, maxFailures: 5 }

// Отметка последней отправки годится, только если её сделал нынешний процесс
// отправщика. Файл отчёта переживает перезапуск панели и компьютера, и метка
// со вчерашнего запуска выглядит как «молчит двадцать два часа»: работник
// начинает убивать живой отправщик каждый такт, новый вход выбивает
// предыдущий, и не уходит ни одна отправка. Проверено 21 августа.
export function freshSendAt(lastSendAt: number, senderStartedAt: number): number {
  if (!lastSendAt || !senderStartedAt) return 0
  return lastSendAt > senderStartedAt ? lastSendAt : 0
}

export function decide(s: Snapshot, limits: Limits = FALLBACK): Decision {
  const SILENT_LIMIT = limits.silentLimit
  const MAX_FAILURES = limits.maxFailures
  if (!s.enabled) return { action: 'idle', why: 'работник выключен' }

  if (s.failures >= MAX_FAILURES) {
    return { action: 'halt', why: s.failures + ' падений подряд — остановился, нужен разбор' }
  }

  // Цель проверяется раньше всего остального, включая пересборку: иначе
  // гем, купленный в последнюю секунду, продлил бы заказанный прогон.
  if (s.target !== null && s.done >= s.target) {
    return { action: 'halt', why: 'цель достигнута: ' + s.done + ' из ' + s.target }
  }

  // Состав важнее всего: жечь по устаревшей очереди значит терять
  // купленные только что гемы. Пересобираем до любых других действий.
  if (s.inventoryChanged) {
    return { action: 'rebuild', why: 'инвентарь изменился, пересобираю очередь' }
  }

  if (s.queueLength <= 0) {
    return { action: 'idle', why: 'нечего накручивать — жду новых гемов' }
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
