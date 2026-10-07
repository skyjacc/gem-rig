// Таблица маршрутов /api по видам (план 7.2, решение 5).
//
//   вход      — открытые или про свою сессию: проверка входа, вход и выход;
//   свой      — данные и действия пользователя запроса: аккаунт берётся только
//               через own() (accounts.ts) — явный id или свой «активный»;
//               чужой и несуществующий — один и тот же 404;
//   владелец  — только владельцу: пользователи и общие сведения сервера.
//
// Тест (isolation.users.test.ts) сверяет таблицу со всеми маршрутами app.ts:
// новый маршрут без строки здесь — тест падает. Так ни один маршрут не
// окажется вне проверки владения по забывчивости.

export type Kind = 'вход' | 'свой' | 'владелец'

export const ROUTES: Record<string, Kind> = {
  'GET /api/auth': 'вход',
  'GET /api/login': 'вход',
  'POST /api/login': 'вход',
  'POST /api/logout': 'вход',
  'POST /api/auth/logout-all': 'вход',
  'POST /api/auth/steam/start': 'вход',
  'GET /api/auth/steam/return': 'вход',
  'POST /api/auth/steam/finish': 'вход',
  'GET /api/invite': 'вход',

  'GET /api/stream': 'свой',
  'GET /api/state': 'свой',
  'POST /api/sender/stop': 'свой',
  'GET /api/autopilot': 'свой',
  'POST /api/autopilot': 'свой',
  'GET /api/accounts': 'свой',
  'POST /api/accounts/active': 'свой',
  'POST /api/accounts/link': 'свой',
  'POST /api/accounts/link/cancel': 'свой',
  'POST /api/accounts/web-link': 'свой',
  'POST /api/accounts/web-link/cancel': 'свой',
  'POST /api/accounts/rename': 'свой',
  'POST /api/accounts/unlink': 'свой',
  'POST /api/accounts/market-key': 'свой',
  'POST /api/accounts/market-key/remove': 'свой',
  'POST /api/accounts/market-key/check': 'свой',
  'POST /api/accounts/session-check': 'свой',
  'POST /api/accounts/web-check': 'свой',
  'GET /api/settings': 'свой',
  'POST /api/settings': 'свой',
  'POST /api/settings/reset': 'свой',
  'GET /api/graph': 'свой',
  'GET /api/queue': 'свой',
  'GET /api/tree': 'свой',
  'GET /api/pool': 'свой',
  'GET /api/burned': 'свой',
  'GET /api/arrivals': 'свой',
  'POST /api/arrivals/aside': 'свой',
  'GET /api/market': 'свой',
  'GET /api/market/run': 'свой',
  'POST /api/market/buy': 'свой',
  'POST /api/market/stop': 'свой',
  'GET /api/money': 'свой',
  'POST /api/money/sync': 'свой',
  'POST /api/money/steam-sync': 'свой',
  'GET /api/money/payouts': 'свой',
  'GET /api/money/reconcile': 'свой',
  'POST /api/money/payout': 'свой',
  'POST /api/money/payout/correct': 'свой',
  'POST /api/money/storno': 'свой',
  'GET /api/keys': 'свой',
  'POST /api/keys/sync': 'свой',

  'GET /api/counters': 'владелец',
  'POST /api/users/disable': 'владелец',
  'POST /api/users/enable': 'владелец',
  'GET /api/users': 'владелец',
  'GET /api/users/invites': 'владелец',
  'POST /api/users/invite': 'владелец',
  'POST /api/users/invite/revoke': 'владелец',
  'POST /api/users/limits': 'владелец',
  'POST /api/users/entry': 'владелец',
  'POST /api/users/permit': 'владелец',
  'POST /api/users/permit/revoke': 'владелец',
}
