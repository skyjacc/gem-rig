// Подбор паузы.
//
// Пауза — единственная ручка, которая меняет выход. При секунде замер
// 20 августа дал 76 отправок в минуту; отклик GC был 340 мс по медиане
// и 764 мс в худшем случае. Значит секунда — не предел, а осторожность.
//
// Правило простое и проверяемое: пока GC отвечает на КАЖДУЮ отправку,
// темп можно поднимать. Как только появляются молчания — это и есть
// потолок, отходим от него.
//
// Молчание — единственный признак перегрева. Дубли не считаются: они
// говорят про матч, а не про скорость.

export type Sample = { delay: number; ts: number; result: 'update' | 'dup' | 'silent' }

export type Advice = {
  suggest: number
  why: string
  measured: number      // сколько отправок в замере
  silent: number        // сколько из них без ответа
  atDelay: number       // на какой паузе замерено
}

// Пороги приходят из настроек. По умолчанию — то, что измерено:
//   floor  при 300 мс отправки идут чаще, чем GC успевал отвечать
//   ceil   выше этого советовать бессмысленно, дело уже не в темпе
//   enough меньше этого числа отправок — не выборка, а совпадение
//   clean  ноль был бы слишком строг: одно молчание на сотню бывает от сети
export type Tuning = {
  floor: number
  ceil: number
  enough: number
  clean: number
  down: number
  up: number
}

const FALLBACK: Tuning = { floor: 300, ceil: 30_000, enough: 40, clean: 0.01, down: 0.8, up: 1.4 }

export function advise(samples: Sample[], t: Tuning = FALLBACK): Advice {
  const { floor: FLOOR, ceil: CEIL, enough: ENOUGH, clean: CLEAN } = t
  const round = (ms: number) => Math.max(FLOOR, Math.min(CEIL, Math.round(ms / 50) * 50))
  if (!samples.length) {
    return { suggest: 1000, why: 'нет замеров — начинаем с секунды, она проверена', measured: 0, silent: 0, atDelay: 0 }
  }

  // Судим по текущему темпу: замеры на другой паузе к нему не относятся.
  const atDelay = samples[samples.length - 1].delay
  const at = samples.filter(s => s.delay === atDelay)

  const silent = at.filter(s => s.result === 'silent').length
  const measured = at.length

  if (measured < ENOUGH) {
    return {
      suggest: round(atDelay),
      why: 'мало замеров на этой паузе (' + measured + ') — не трогаем',
      measured, silent, atDelay,
    }
  }

  const share = silent / measured

  if (share > CLEAN) {
    // Нашли потолок. Отходим настолько, насколько сильно молчит.
    const back = share > 0.1 ? t.up * 1.45 : t.up
    return {
      suggest: round(atDelay * back),
      why: silent + ' из ' + measured + ' без ответа — это потолок, отхожу',
      measured, silent, atDelay,
    }
  }

  // Чисто. Шаг вниз небольшой: перелёт стоит дороже, чем лишняя минута.
  return {
    suggest: round(atDelay * t.down),
    why: measured + ' отправок подряд с ответом — можно быстрее',
    measured, silent, atDelay,
  }
}

// Растяжка по сроку.
//
// «До десяти утра» — не «жги как можешь и встань в десять», а «раздели
// работу на срок». Разница видна на числах: 40 отправок в минуту выжигают
// заказ за четыре часа и оставляют четыре часа простоя, а те же отправки,
// разложенные ровно, идут по одной в две секунды — и заканчиваются вовремя.
//
// Медленнее ещё и безопаснее: редкие отправки неотличимы от игры.
//
// Пауза считается заново каждый круг работника, поэтому промахи в оценке
// сами выправляются: отстали — темп подрастёт, обогнали — упадёт.
export const EVEN_CEIL = 120_000

// Доля отправок, за которые действительно начислили.
//
// Матч может ответить пустым: он уже сосчитан этим гемом или не годится ему
// вовсе. Такая отправка тратит время, но долг не уменьшает. Если делить срок
// на один только долг, прогон отстаёт ровно во столько раз, во сколько
// пустых отправок больше нуля: 22 августа при половине пустых работа на час
// растянулась бы на два.
export function creditRate(update: number, dup: number): number {
  const all = update + dup
  if (all < 20) return 1
  return Math.max(0.15, Math.min(1, update / all))
}

export function evenDelay(msLeft: number, sendsLeft: number, floor: number): number {
  const n = Math.max(1, Math.trunc(sendsLeft))
  const ms = Math.max(0, Math.trunc(msLeft))
  if (ms <= 0) return floor
  const raw = Math.round(ms / n / 50) * 50
  return Math.max(floor, Math.min(EVEN_CEIL, raw))
}

// Молчание отправщика судится по паузе, а не по постоянному числу.
// На растяжке пауза бывает больше минуты — прежний предел убивал бы
// живого отправщика, который просто ждёт своей очереди.
export const silenceLimit = (base: number, delay: number) => Math.max(base, delay * 3 + 20_000)
