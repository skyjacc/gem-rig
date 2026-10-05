// Чей это запрос (план 7.2, решение 5).
//
// Пользователь запроса кладётся в AsyncLocalStorage на входе (app.ts,
// onRequest) и виден всему, что этот запрос вызывает: «активный аккаунт»,
// настройки, закупка, поток состояния берут его отсюда, а не из общей
// переменной сервера. Вне запроса (такты работника, обновление инвентаря
// при запуске) пользователь — владелец, как было до этапа 7; такт работника
// оборачивает работу каждого аккаунта в asUser(владелец аккаунта).

import { AsyncLocalStorage } from 'node:async_hooks'

export const OWNER = 'owner'

const als = new AsyncLocalStorage<{ userId: string }>()

// Пустая строка — запрос без входа (открытые пути входа): ничьих данных.
export const currentUser = () => {
  const s = als.getStore()
  return s ? s.userId : OWNER
}

export const asUser = <T>(userId: string, fn: () => T): T => als.run({ userId }, fn)
