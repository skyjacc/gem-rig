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

  return {
    // Ждёт своего окна и возвращает время, на которое запрос был запланирован.
    async take(key: string): Promise<number> {
      const now = clock.now()
      const at = Math.max(now, next.get(key) ?? 0)
      next.set(key, at + gap)
      if (at > now) await clock.sleep(at - now)
      return at
    },
    // Площадка ответила «слишком часто»: следующий запрос по ключу — не раньше чем через ms.
    cool(key: string, ms: number) {
      next.set(key, Math.max(next.get(key) ?? 0, clock.now() + ms))
    },
  }
}

export type Limiter = ReturnType<typeof createLimiter>
