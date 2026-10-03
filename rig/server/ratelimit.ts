// Ограничитель частоты запросов к площадке.
//
// market.dota2.net удаляет ключ, если с ним приходит больше пяти запросов
// в секунду (документация API v2, проверено 2026-10-03). Ключ — это деньги
// на счету и все покупки, поэтому держим четыре в секунду на ключ: запас
// на неточность часов и сетевые задержки — наше решение, не правило площадки.
//
// Место под каждый запрос резервируется синхронно, до первого await:
// параллельные вызовы получают разные окна и не могут проскочить вместе.
// Часы подменяются — тесты проверяют расписание, а не ждут секундами.

export type Clock = { now(): number; sleep(ms: number): Promise<void> }

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

export function createLimiter(perSecond: number, clock: Clock = realClock) {
  const gap = 1000 / perSecond
  // Для каждого ключа — самое раннее время, когда может начаться следующий запрос.
  const next = new Map<string, number>()
  // До какого времени ключ молчит после ответа «слишком часто».
  const quiet = new Map<string, number>()

  // Окно бронируется заранее, а пока запрос его ждёт, другой запрос того же
  // ключа может получить 429. Поэтому после сна окно проверяется ещё раз:
  // если на него легла пауза, запрос встаёт в очередь заново, уже за паузой.
  // Проверка и отправка идут одним синхронным шагом, без await между ними, —
  // иначе 429 мог бы проскочить в эту щель.
  async function slot<T>(key: string, go: (at: number) => T): Promise<T> {
    for (;;) {
      const now = clock.now()
      const at = Math.max(now, next.get(key) ?? 0)
      next.set(key, at + gap)
      if (at > now) await clock.sleep(at - now)
      if (Math.max(at, clock.now()) >= (quiet.get(key) ?? 0)) return go(at)
    }
  }

  return {
    // Ждёт своего окна и возвращает время, на которое запрос был запланирован.
    take: (key: string): Promise<number> => slot(key, at => at),
    // Ждёт окна и сразу отправляет: send вызывается в том же шаге, что и проверка паузы.
    run: <T>(key: string, send: () => T): Promise<T> => slot(key, () => send()),
    // Площадка ответила «слишком часто»: ни один ещё не ушедший запрос по ключу —
    // и тот, что уже ждёт окна, — не уйдёт раньше чем через ms.
    cool(key: string, ms: number) {
      const until = clock.now() + ms
      quiet.set(key, Math.max(quiet.get(key) ?? 0, until))
      next.set(key, Math.max(next.get(key) ?? 0, until))
    },
  }
}

export type Limiter = ReturnType<typeof createLimiter>
