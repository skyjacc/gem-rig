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

// Ниже этого не опускаемся. При 300 мс отправки идут чаще, чем GC успевал
// отвечать в худших замерах, и «без ответа» станет нормой.
const FLOOR = 300

// Выше этого советовать бессмысленно: если и здесь молчит, дело не в темпе.
const CEIL = 30_000

// Меньше этого числа отправок — не выборка, а совпадение.
const ENOUGH = 40

// Доля молчаний, ниже которой темп считается чистым. Ноль был бы слишком
// строг: одно молчание на сотню бывает от сети, а не от частоты.
const CLEAN = 0.01

const round = (ms: number) => Math.max(FLOOR, Math.min(CEIL, Math.round(ms / 50) * 50))

export function advise(samples: Sample[]): Advice {
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
    const back = share > 0.1 ? 2 : 1.4
    return {
      suggest: round(atDelay * back),
      why: silent + ' из ' + measured + ' без ответа — это потолок, отхожу',
      measured, silent, atDelay,
    }
  }

  // Чисто. Шаг вниз небольшой: перелёт стоит дороже, чем лишняя минута.
  return {
    suggest: round(atDelay * 0.8),
    why: measured + ' отправок подряд с ответом — можно быстрее',
    measured, silent, atDelay,
  }
}
