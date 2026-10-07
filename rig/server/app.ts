// Приложение панели: маршруты /api, вход, поток состояния (план 7.2).
//
// Вынесено из index.ts, чтобы маршруты проверялись настоящими запросами в
// тестах (app.inject), без запуска сервера, таймеров и работы со Steam.
// index.ts — запуск: база, токен, слушать порт, такты работника и обновления.

import Fastify from 'fastify'
import fstatic from '@fastify/static'
import fs from 'node:fs'
import path from 'node:path'
import { GC, PANEL_URL, readJson } from './paths.ts'
import { counterLines, db, pushEvent } from './db.ts'
import { fresh, ingestOne } from './ledger.ts'
import { refreshInventory } from './steam.ts'
import { buildState } from './state.ts'
import { senderState, statusFile, stop } from './sender.ts'
import { ATTEMPT_COOKIE, attemptCookie, attemptCookieClear, bearer, cookieValue, gate, loginCookie, logoutCookie, sameToken } from './auth.ts'
import { accountList, accountsApi, arrivalAside, arrivalList, burnedList, graph, itemPool, marketScan, queuePreview, tree, webCheck } from './api.ts'
import { purchaseState, startPurchase, stopPurchase, vetLines } from './purchase.ts'
// Охранник владения (план 7.2, решение 5): в маршрутах аккаунт берётся
// только через own — аккаунт пользователя запроса или null. Все аккаунты
// сервера (accountList2) — только для его собственной работы.
import { ACCOUNT, active as activeAccount, activeId as activeAccountId, own as accountById, list as accountList2, listFor } from './accounts.ts'
import { asUser, currentUser } from './ctx.ts'
import { activePermit, createInvite, entryOpen, grantPermit, inviteByToken, listInvites, revokeInvite, revokePermit, setEntryOpen } from './access.ts'
import { DB_FILE } from './db.ts'
import { buyKey, checkKey, keyFor, removeKey, setKey } from './marketkeys.ts'
import { listOps, migrateMoney, MONEY_DDL } from './money.ts'
import {
  attemptLimiter, ensureOwner, getPersonalSettings, handleFinish, handleReturn, limitsOf, logAuth, markDisabled, markEnabled, migrateUsers,
  newSession, OWNER_ID, revokeAll, sessionUser, setPersonalSettings, startAttempt, STEAM_TTL, TOKEN_TTL, userActive, userById, USERS_DDL,
} from './users.ts'
import { accountsHooks, linkCancel, linkState, webLinkCancel } from './accounts.ts'
import { purchaseHooks } from './purchase.ts'
import { autopilotHooks, unitOn } from './autopilot.ts'
import { settingsHooks } from './settings.ts'
import { authUrl } from './openid.ts'
import { logoutAllFor, logoutFor, streamHub } from './streams.ts'
import { handleCorrect, handlePayout, handleStorno, listPayouts } from './payouts.ts'
import { ensureJournal, moneySync, recordBuy, reconcile } from './marketbuys.ts'
import { checkSession, webCookieHeader } from './steamweb.ts'
import { steamSync } from './steammarket.ts'
import { keyState, lastSnapshot, summarize, syncKeys, TF2_DDL } from './tf2keys.ts'
import { autopilotState, setAutopilot } from './autopilot.ts'
import { reset as resetSettings, settings, update as updateSettings } from './settings.ts'


// Таблицы при запуске — только добавление (create if not exists).
export function prepareDb() {
  // Деньги и журнал закупки (план 3.1): таблицы — при запуске, только
  // добавление (create if not exists). Начало журнала пишется один раз.
  // Таблицу этапа 3.1 (gross NOT NULL) переделываем один раз — до создания.
  const moneyMigrated = migrateMoney(db)
  if (moneyMigrated.migrated) console.log('миграция: money_ops — gross может быть пустым')
  db.exec(MONEY_DDL)
  db.exec(USERS_DDL)
  migrateUsers(db)
  ensureOwner(db)
  ensureJournal(db)
  // Ключи TF2 (план 3.4): снимки — только вставка.
  db.exec(TF2_DDL)
}

export type AppOpts = {
  token: string
  allowed: Set<string>
  dist?: string | null
}

export async function buildApp(opts: AppOpts) {
  const ALLOWED = opts.allowed
  const PANEL_TOKEN = opts.token

  // Что модули сервера знают о пользователях (план 7.2): активен ли,
  // пределы, личные настройки. Модули базу пользователей не читают сами.
  accountsHooks.userActive = u => userActive(db, u)
  accountsHooks.maxAccounts = u => limitsOf(db, u).accounts
  purchaseHooks.userActive = u => userActive(db, u)
  autopilotHooks.userActive = u => userActive(db, u)
  autopilotHooks.maxSenders = u => limitsOf(db, u).senders
  settingsHooks.getPersonal = u => getPersonalSettings(db, u)
  settingsHooks.setPersonal = (u, v) => setPersonalSettings(db, u, v)
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 })

  // ─────────────────────────────── вход ───────────────────────────────
  // Host, Origin и токен на каждый запрос — см. auth.ts. Адрес 127.0.0.1
  // защищает от сети, но не от страницы в том же браузере.

  // Пропуск — сессия пользователя (план 7.1). Сам токен панели больше не
  // пропуск: им владелец входит и получает сессию на 12 часов.
  const authed = (presentedToken: string) => !!sessionUser(db, presentedToken)
  const hub = streamHub()

  // Пропуск и чей запрос. Всё, что вызывает обработчик, видит пользователя
  // запроса (ctx.ts): «активный аккаунт», настройки, закупку, поток.
  // Без входа (открытые пути входа) — пустой пользователь: ничьих данных.
  app.addHook('onRequest', (req, reply, done) => {
    const g = gate({ method: req.method, url: req.url, headers: req.headers as any }, authed, ALLOWED)
    if (!g.ok) {
      reply.code(g.code).type('application/json; charset=utf-8').send({ error: g.why, auth: g.code === 401 })
      return
    }
    const who = sessionUser(db, presented(req))
    asUser(who ? who.user.id : '', done)
  })

  // Чужой и несуществующий объект — один и тот же ответ (решение 11): 404
  // с тем же текстом.
  const NOT_FOUND = new Set(['нет такого аккаунта', 'нет такой выплаты Clover', 'нет такой выплаты'])
  app.addHook('preSerialization', async (_req, reply, payload: any) => {
    if (reply.statusCode === 200 && payload && typeof payload === 'object' && NOT_FOUND.has(payload.error)) reply.code(404)
    return payload
  })

  const presented = (req: any) =>
    cookieValue(req.headers.cookie) || bearer(req.headers.authorization)
  const isHttps = (req: any) =>
    req.protocol === 'https' || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'

  app.get('/api/auth', async (req: any) => {
    const who = sessionUser(db, presented(req))
    const owner = userById(db, OWNER_ID)
    return {
      authed: !!who,
      user: who ? { name: who.user.name, role: who.user.role, via: who.kind, steamBound: !!owner?.steamid } : null,
      steamLogin: !!PANEL_URL,
    }
  })

  // Запасной вход владельца — токен панели (решение 3): сессия на 12 часов,
  // без продления; не больше 5 попыток в минуту с адреса; каждый вход — в журнал.
  const tokenTries = attemptLimiter(5, 60_000)
  function tokenLogin(req: any, reply: any, given: string) {
    if (!tokenTries.allow(String(req.ip ?? ''))) return { code: 429, error: 'слишком много попыток — подождите минуту' }
    if (!sameToken(given, PANEL_TOKEN)) { logAuth(db, 'токен не подошёл', Date.now()); return { code: 401, error: 'токен не подходит' } }
    const s = newSession(db, OWNER_ID, 'токен', Date.now(), String(req.headers['user-agent'] ?? ''))
    logAuth(db, 'вход по токену', Date.now())
    reply.header('set-cookie', loginCookie(s.token, isHttps(req), TOKEN_TTL / 1000))
    return null
  }

  // Вход: ссылка из консоли (GET) или поле на экране входа (POST).
  app.get('/api/login', async (req: any, reply) => {
    const bad = tokenLogin(req, reply, String(req.query?.token ?? ''))
    if (bad) return reply.code(bad.code).type('text/plain; charset=utf-8').send(bad.error)
    return reply.redirect('/')
  })

  app.post('/api/login', async (req: any, reply) => {
    const bad = tokenLogin(req, reply, String(req.body?.token ?? ''))
    if (bad) return reply.code(bad.code).send({ error: bad.error })
    return { ok: true }
  })

  // Выход закрывает и уже открытые потоки этой сессии (ревью PR #32, P1).
  app.post('/api/logout', async (req: any, reply) => {
    logoutFor(db, hub, presented(req))
    reply.header('set-cookie', logoutCookie())
    return { ok: true }
  })

  app.post('/api/auth/logout-all', async (req: any, reply) => {
    logoutAllFor(db, hub, presented(req))
    reply.header('set-cookie', logoutCookie())
    return { ok: true }
  })

  // Вход через Steam (план 7.1, решения 2–2б). Начало — с нашей страницы
  // (Origin проверен); возврат — от Steam, с куки попытки этого браузера;
  // завершение — со своей страницы возврата.
  app.post('/api/auth/steam/start', async (req: any, reply) => {
    if (!PANEL_URL) return { error: 'вход через Steam выключен: не задан PANEL_URL' }
    const purpose = req.body?.purpose === 'привязка владельца' ? 'привязка владельца' : req.body?.purpose === 'приглашение' ? 'приглашение' : 'вход'
    const a = startAttempt(db, purpose, presented(req) || null, Date.now(), String(req.body?.invite ?? ''))
    if ('error' in a) return a
    reply.header('set-cookie', attemptCookie(a.binding, isHttps(req)))
    return { url: authUrl(PANEL_URL, a.state) }
  })

  const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
  const page = (body: string) => '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Вход</title>'
    + '<body style="font:15px system-ui;background:#0e0e10;color:#ecebe8;display:grid;place-items:center;height:100vh;margin:0">' + body + '</body>'

  app.get('/api/auth/steam/return', async (req: any, reply) => {
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.query ?? {})) if (typeof v === 'string') q[k] = v
    const r = PANEL_URL
      ? await handleReturn(db, q, cookieValue(req.headers.cookie, ATTEMPT_COOKIE), PANEL_URL)
      : { error: 'вход через Steam выключен: не задан PANEL_URL' }
    reply.type('text/html; charset=utf-8')
    if ('error' in r) return page('<p>Не вошли: ' + esc(r.error) + '. <a style="color:#8fb2ff" href="/">На главную</a></p>')
    // Завершение — новым запросом с этой страницы: для браузера он уже не
    // с чужого сайта, и кука сессии (Strict) в нём есть.
    // Вход по приглашению сначала спрашивает «это вы?» (§18): какой Steam
    // станет входом. Подтвердили — второй finish с confirm.
    return page('<div style="max-width:420px;text-align:center"><p id="m">Входим…</p><p id="who"></p><p id="act"></p></div><script>'
      + 'const S=' + JSON.stringify(q.state ?? '').replace(/</g, '\\u003c') + ';'
      + 'const m=document.getElementById("m"),who=document.getElementById("who"),act=document.getElementById("act");'
      + 'const go=c=>fetch("/api/auth/steam/finish",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({state:S,confirm:c})}).then(r=>r.json()).then(d=>{'
      + 'if(d&&(d.ok||d.bound))return location.replace("/");'
      + 'if(d&&d.confirm){m.textContent="Это вы?";who.textContent="Входом станет Steam "+d.confirm.steamid+" — приглашение «"+d.confirm.name+"». Проверьте профиль: steamcommunity.com/profiles/"+d.confirm.steamid;'
      + 'act.innerHTML="";const y=document.createElement("button");y.textContent="Да, это я";y.onclick=()=>{act.textContent="Входим…";go(true)};'
      + 'const n=document.createElement("a");n.textContent="Нет — войти другим Steam";n.href="/";n.style.cssText="display:block;margin-top:12px;color:#8fb2ff";'
      + 'y.style.cssText="font:inherit;padding:10px 18px;border-radius:10px;border:0;background:#b8f25c;color:#0c0c0e;cursor:pointer";act.append(y,n);return}'
      + 'm.textContent="Не вошли: "+((d&&d.error)||"ошибка");act.innerHTML="<a style=\\"color:#8fb2ff\\" href=\\"/\\">На главную</a>"}).catch(()=>{m.textContent="Нет связи с панелью"});'
      + 'go(false)</script>')
  })

  app.post('/api/auth/steam/finish', async (req: any, reply) => {
    const r = handleFinish(db, String(req.body?.state ?? ''), cookieValue(req.headers.cookie, ATTEMPT_COOKIE), presented(req) || null, Date.now(), req.body?.confirm === true)
    // «Это вы?» — попытка ещё нужна: кука попытки остаётся до ответа.
    if ('confirm' in r) return r
    const cookies = [attemptCookieClear()]
    if ('session' in r) cookies.push(loginCookie(r.session.token, isHttps(req), STEAM_TTL / 1000))
    reply.header('set-cookie', cookies)
    if ('error' in r) return r
    return 'bound' in r ? { bound: true } : { ok: true }
  })

  // Ссылка-приглашение (план 7.3): действует ли — без входа. Не чаще 5 раз в
  // минуту с адреса. Через tailscale serve все приходят с 127.0.0.1 — предел
  // тогда общий: перебору это не помогает, а приглашённому хватает.
  const inviteTries = attemptLimiter(5, 60_000)
  app.get('/api/invite', async (req: any, reply) => {
    if (!inviteTries.allow(String(req.ip ?? ''))) return reply.code(429).send({ error: 'слишком много попыток — подождите минуту' })
    const inv = inviteByToken(db, String(req.query?.token ?? ''))
    if (!inv) return reply.code(404).send({ error: 'приглашение недействительно: истекло, отозвано или уже использовано' })
    return { name: inv.name, expiresAt: inv.expiresAt, open: entryOpen(db), steamLogin: !!PANEL_URL }
  })


  // ─────────────────────────────── SSE ───────────────────────────────
  // Каждый открытый поток помнит свою сессию (streams.ts): выход и истечение
  // сессии закрывают и его, а не только следующий запрос.

  // Толчок состояния — не чаще раза в 250 мс.
  //
  // Толкают все: отправщик пишет отчёт на каждую отправку, работник тикает,
  // каждый POST зовёт push. При паузе в полсекунды это два полных снимка
  // в секунду на каждого зрителя, и каждый снимок фронт принимает за повод
  // перезапросить вторичные экраны. Склейка ничего не теряет: последний
  // снимок всегда уходит.
  const PUSH_GAP = 250
  let pushAt = 0
  let pending: NodeJS.Timeout | null = null

  function flush() {
    pushAt = Date.now()
    pending = null
    if (!hub.size()) return
    // Состояние — своё у каждого пользователя (план 7.2, решение 6): собирается
    // от его имени и уходит только его клиентам.
    for (const user of hub.users()) {
      let line: string
      try { line = 'data: ' + JSON.stringify(asUser(user, () => buildState())) + '\n\n' } catch (e: any) {
        console.error('состояние не собралось:', e.message)
        continue
      }
      hub.sendTo(user, line)
    }
  }

  function push() {
    if (pending) return
    const wait = Math.max(0, pushAt + PUSH_GAP - Date.now())
    if (!wait) return flush()
    pending = setTimeout(flush, wait)
  }

  app.get('/api/stream', (req, reply) => {
    const who = sessionUser(db, presented(req))
    if (!who) return reply.code(401).send({ error: 'нужен вход', auth: true })
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.write('retry: 2000\n\n')
    reply.raw.write('data: ' + JSON.stringify(buildState()) + '\n\n')
    hub.add(reply as any, who.sessionId, who.user.id)
    req.raw.on('close', () => hub.remove(reply as any))
  })


  app.get('/api/state', async () => buildState())

  // ───────────────────────── управление отправщиком ─────────────────────────
  //
  // Запуска отправщика снаружи больше нет. Он принимал имя файла, склеивал
  // его с папкой отправщика без проверки и поднимал процесс, который шлёт
  // необратимые сообщения. Отправщиком владеет работник: он знает, что за
  // файл, чья сессия и сколько отправок заказано. Остановка оставлена —
  // она ничего не тратит и нужна при разборе.
  // Стоп выключает и работника. Раньше гасился только процесс, а включённый
  // работник на следующем такте видел мёртвый отправщик и поднимал его снова:
  // кнопка «стоп» останавливала отправку секунд на двадцать.
  app.post('/api/sender/stop', async (req: any) => {
    const id = String(req.body?.id ?? activeAccountId())
    if (!accountById(id)) return { error: 'нет такого аккаунта' }
    const was = senderState(id).running
    setAutopilot(id, { on: false })
    if (senderState(id).running) stop(id)
    push()
    return was ? { ok: true } : { error: 'отправщик не запущен' }
  })

  app.get('/api/autopilot', async () => autopilotState())

  // Настройки работника: выключатель, пауза, цель прогона, автоподбор темпа.
  // Аккаунт по умолчанию — активный, но можно указать любой: включённых
  // одновременно бывает несколько.
  app.post('/api/autopilot', async (req: any) => {
    const b = req.body ?? {}
    const id = String(b.id ?? activeAccountId())
    if (!accountById(id)) return { error: 'нет такого аккаунта' }
    const patch: any = {}
    if (b.on !== undefined) patch.on = !!b.on
    if (b.delay !== undefined) patch.delay = Number(b.delay)
    if (b.auto !== undefined) patch.auto = !!b.auto
    if (b.target !== undefined) patch.target = b.target === null ? null : Number(b.target)
    if (b.waves !== undefined) patch.waves = Number(b.waves)
    if (b.until !== undefined) patch.until = Number(b.until)
    if (b.cap !== undefined) patch.cap = Number(b.cap)
    if (b.even !== undefined) patch.even = !!b.even
    if (b.only !== undefined) patch.only = b.only
    const r = setAutopilot(id, patch)
    push()
    return r
  })

  // ── аккаунты ──
  app.get('/api/accounts', async () => accountList())

  app.post('/api/accounts/active', async (req: any) => {
    const r = accountsApi.setActive(String(req.body?.id ?? ''))
    // Переключились — инвентарь нового аккаунта может быть ещё не прочитан.
    // Не ждём ответа: снимок придёт следующим толчком, а панель пока честно
    // покажет пустой инвентарь с возрастом «—», а не чужой.
    void refreshInventory(ACCOUNT()).then(() => push())
    push()
    return r
  })

  app.post('/api/accounts/link', async (req: any) => {
    // relink — обновить сессию существующего аккаунта (протухший токен).
    // Работник этого аккаунта на время входа гасится: он бы стучался
    // со старым токеном и выбивал новую сессию.
    const relink = req.body?.relink ? String(req.body.relink) : null
    if (relink && !accountById(relink)) return { error: 'нет такого аккаунта' }
    if (relink) {
      setAutopilot(relink, { on: false })
      if (senderState(relink).running) stop(relink)
    }
    const r = accountsApi.linkStart(String(req.body?.label ?? ''), () => push(), relink)
    push()
    return r
  })

  app.post('/api/accounts/link/cancel', async () => {
    const r = accountsApi.linkCancel()
    push()
    return r
  })

  // Веб-вход по QR (план 2.4, решение 2Б). Игровой токен и работник не
  // трогаются; новый веб-токен принимается, только если вошли тем же Steam.
  app.post('/api/accounts/web-link', async (req: any) => {
    const r = accountsApi.webLinkStart(String(req.body?.id ?? ''), () => push())
    push()
    return r
  })

  app.post('/api/accounts/web-link/cancel', async () => {
    const r = accountsApi.webLinkCancel()
    push()
    return r
  })

  app.post('/api/accounts/rename', async (req: any) => {
    const r = accountsApi.rename(String(req.body?.id ?? ''), String(req.body?.label ?? ''))
    push()
    return r
  })

  // Отвязка удаляет сохранённую сессию: вернуть аккаунт можно только новым QR.
  // Журнал расхода остаётся — матчи на нём действительно израсходованы.
  // Сначала гасим работу аккаунта и забираем его последний отчёт, потом
  // отвязываем. Раньше отвязка удаляла только сессию и строку реестра:
  // запущенный отправщик продолжал слать, а его отчёт больше никто не
  // разбирал — расход шёл мимо журнала.
  app.post('/api/accounts/unlink', async (req: any) => {
    const id = String(req.body?.id ?? '')
    if (accountById(id)) {
      setAutopilot(id, { on: false })
      if (senderState(id).running) stop(id)
      ingestStatus()
      // Ключ площадки уходит вместе с аккаунтом: он тратит деньги на его Steam,
      // и оставлять его без хозяина незачем. tools/market.key основного
      // не трогаем: это прежнее место ключа, его человек удаляет сам.
      const a = accountById(id)
      if (a && a.id !== 'main' && listFor(currentUser()).length > 1) removeKey(a)
    }
    const r = accountsApi.unlink(id)
    push()
    return r
  })

  // ── настройки ──
  //
  // Всё, что раньше было константой в коде. Пороги подбирались замерами,
  // но замеры устаревают: у другого канала и времени суток числа другие.
  app.get('/api/settings', async () => settings())

  app.post('/api/settings', async (req: any) => {
    const r = updateSettings(req.body ?? {})
    push()
    return r
  })

  app.post('/api/settings/reset', async () => {
    const r = resetSettings()
    push()
    return r
  })

  // ── граф и очередь ──
  app.get('/api/graph', async (req: any) => graph(req.query?.scope === 'all' ? 'all' : 'owned'))
  app.get('/api/queue', async (req: any) => queuePreview(Number(req.query?.limit) || 200))

  // Закупка запускается и дальше живёт сама: панель смотрит на её состояние.
  app.post('/api/market/buy', async (req: any) => {
    const b = req.body ?? {}
    const currency = String(b.currency ?? 'RUB') as any
    // Покупаем на конкретный аккаунт: план считался по нему, и лоты должны
    // прийти туда же. Без явного id — активный, как видит панель.
    const who = b.id ? accountById(String(b.id)) : activeAccount() ?? null
    if (!who) return { error: 'нет такого аккаунта' }
    // Цены сверяются с разбором площадки в той же валюте: сервер покупает
    // только то и не дороже того, что видел сам.
    const scan: any = await marketScan(false, currency, who)
    const seen = new Map<string, number>((scan?.offers ?? []).map((o: any) => [String(o.name), Number(o.price)]))
    const s = settings()
    const vet = vetLines(b.lines ?? [], seen, s.priceTolerance, s.purchaseCap)
    if ('error' in vet) return vet
    // Ключ этого аккаунта и проверка, что площадка шлёт лоты именно ему.
    const k = await buyKey(who)
    if ('error' in k) return k
    // Журнал закупки — колбэком: закупка базу не знает. Не записалось —
    // закупка идёт дальше, а сверка покажет покупку «отсутствует в журнале».
    const r = await startPurchase(vet.lines, currency, () => push(), { key: k.key, id: who.id, label: who.label }, {
      onBought: b => { const w = recordBuy(db, b); if ('error' in w) throw new Error(w.error) },
    })
    push()
    return r
  })

  // Ключ площадки аккаунта: записать, удалить, перепроверить. В ответ —
  // только статус; сам ключ сервер не отдаёт никогда.
  app.post('/api/accounts/market-key', async (req: any) => {
    const a = accountById(String(req.body?.id ?? ''))
    if (!a) return { error: 'нет такого аккаунта' }
    const r = await setKey(a, String(req.body?.key ?? ''))
    push()
    return r
  })

  app.post('/api/accounts/market-key/remove', async (req: any) => {
    const a = accountById(String(req.body?.id ?? ''))
    if (!a) return { error: 'нет такого аккаунта' }
    const r = removeKey(a)
    push()
    return r
  })

  // Жива ли сессия Steam аккаунта — без входа в сеть Steam.
  app.post('/api/accounts/session-check', async (req: any) => {
    const a = accountById(String(req.body?.id ?? ''))
    if (!a) return { error: 'нет такого аккаунта' }
    const r = await checkSession(a)
    push()
    return r
  })

  // Веб-сессия аккаунта (план 2.4) — один обмен токена на куки, по кнопке.
  // В ответ — только состояние; куки остаются на сервере.
  app.post('/api/accounts/web-check', async (req: any) => {
    if (!accountById(String(req.body?.id ?? ''))) return { error: 'нет такого аккаунта' }
    const r = await webCheck(String(req.body?.id ?? ''))
    push()
    return r
  })

  app.post('/api/accounts/market-key/check', async (req: any) => {
    const a = accountById(String(req.body?.id ?? ''))
    if (!a) return { error: 'нет такого аккаунта' }
    const r = await checkKey(a, true)
    push()
    return r
  })

  app.post('/api/market/stop', async () => {
    const r = stopPurchase()
    push()
    return r
  })

  app.get('/api/market/run', async () => purchaseState())

  // Журнал денег (план 3.1). Импорт истории площадки — только по запросу,
  // через общий ограничитель; ключ берётся на сервере и в ответ не попадает.
  app.post('/api/money/sync', async (req: any) => {
    const a = accountById(String(req.body?.id ?? ''))
    if (!a) return { error: 'нет такого аккаунта' }
    const key = keyFor(a)
    if (!key) return { error: 'у аккаунта «' + a.label + '» нет ключа площадки' }
    return moneySync(db, { accountId: a.id, key, days: Number(req.body?.days) || undefined })
  })

  app.get('/api/money', async (req: any) => {
    const a = req.query?.id ? accountById(String(req.query.id)) : activeAccount() ?? null
    if (!a) return { error: 'нет такого аккаунта' }
    return listOps(db, { accountId: a.id, limit: Number(req.query?.limit) || undefined })
  })

  // История рынка Steam (план 3.3) — только по запросу. Куки — из веб-токена
  // аккаунта на сервере, в ответ не попадают; нет веб-сессии — понятная ошибка.
  app.post('/api/money/steam-sync', async (req: any) => {
    const a = accountById(String(req.body?.id ?? ''))
    if (!a) return { error: 'нет такого аккаунта' }
    const b = req.body ?? {}
    // Куки берёт сам steamSync — после проверки параметров.
    return steamSync(db, {
      accountId: a.id, me: a.steamid, getCookie: () => webCookieHeader(a),
      pages: b.pages == null ? undefined : Number(b.pages),
      mode: b.mode == null ? undefined : b.mode,
      from: b.from == null ? undefined : Number(b.from),
    })
  })

  // Ключи TF2 (план 3.4): чтение инвентаря — только по запросу, без кук,
  // через ограничитель Steam; неполный инвентарь не сохраняется.
  app.post('/api/keys/sync', async (req: any) => {
    const a = accountById(String(req.body?.id ?? ''))
    if (!a) return { error: 'нет такого аккаунта' }
    return syncKeys(db, { accountId: a.id, steamid: a.steamid })
  })

  // Итог по последнему снимку — без сети. Состояния считаются на сейчас.
  app.get('/api/keys', async (req: any) => {
    const a = accountById(String(req.query?.id ?? ''))
    if (!a) return { error: 'нет такого аккаунта' }
    const s = lastSnapshot(db, a.id)
    if (!s) return { snapshot: null }
    const now = Date.now()
    return {
      snapshot: { id: s.id, seenAt: s.seenAt },
      summary: summarize(s.keys, now),
      keys: s.keys.map(k => ({ ...k, state: keyState(k, now) })),
    }
  })

  // Выплаты Clover руками (план 3.2). Аккаунт приходит в теле явно — форма
  // закрепляет его при открытии; сервер активный не подставляет.
  const accountForPayout = (id: string) => {
    const a = accountById(id)
    return a ? { id: a.id, label: a.label } : undefined
  }

  app.post('/api/money/payout', async (req: any) => {
    const r = handlePayout(db, req.body, accountForPayout)
    push()
    return r
  })

  app.post('/api/money/payout/correct', async (req: any) => {
    const r = handleCorrect(db, req.body, accountForPayout)
    push()
    return r
  })

  app.post('/api/money/storno', async (req: any) => {
    const r = handleStorno(db, req.body, accountForPayout)
    push()
    return r
  })

  // Все выплаты аккаунта и их сторно — без предела общего журнала (решение 11).
  app.get('/api/money/payouts', async (req: any) => {
    const a = accountById(String(req.query?.id ?? ''))
    if (!a) return { error: 'нет такого аккаунта' }
    return listPayouts(db, a.id)
  })

  // Отчёт сверки — без обращения к площадке.
  app.get('/api/money/reconcile', async (req: any) => {
    const a = accountById(String(req.query?.id ?? ''))
    if (!a) return { error: 'нет такого аккаунта' }
    return reconcile(db, a.id)
  })
  app.get('/api/market', async (req: any) => marketScan(req.query?.force === '1', (req.query?.cur ?? 'USD')))
  app.get('/api/pool', async () => itemPool())
  app.get('/api/burned', async (req: any) => burnedList(Number(req.query?.limit) || 500))

  // Приходы сканера слепых лотов. Откладывание меняет farm-решения работника,
  // поэтому после него — толчок состояния.
  app.get('/api/arrivals', async () => arrivalList(listFor(currentUser()).map(a => a.steamid)))
  app.post('/api/arrivals/aside', async (req: any) => {
    const r = arrivalAside(String(req.body?.assetid ?? ''), !!req.body?.aside, listFor(currentUser()).map(a => a.steamid))
    push()
    return r
  })
  // ── пользователи: только владельцу (решение 10; экран — 7.3) ──
  //
  // Отключение — одним действием, по порядку: пометка и сессии → потоки →
  // работники и отправщики → закупка → QR-входы. Запоздавшие ответы
  // отключённого ничего не оживляют: модули проверяют «активен ли» сами.
  function disableUser(id: string) {
    const r = markDisabled(db, id)
    if ('error' in r) return r
    endAccess(id)
    push()
    return { ok: true }
  }

  // Доступ кончился (ревью PR #34) — сразу, а не на следующей проверке:
  // сессии отозваны, потоки закрыты, работники и отправщики остановлены,
  // закупка и QR-входы отменены.
  function endAccess(id: string) {
    revokeAll(db, id)
    hub.closeUser(id)
    for (const a of accountList2().filter(x => (x.user || OWNER_ID) === id)) {
      setAutopilot(a.id, { on: false })
      if (senderState(a.id).running) stop(a.id)
    }
    stopPurchase(id)
    linkCancel(id)
    webLinkCancel(id)
  }

  // Все, кто сейчас не пущен (закрыт вход, кончился или снят допуск,
  // отключён), — без живых сессий и работы. Зовётся при закрытии входа и
  // снятии допуска и раз в 15 с (index.ts) — для допуска, истёкшего по сроку.
  function enforceAccess(now = Date.now()) {
    const ended: string[] = []
    for (const u of db.prepare(`select id from users where role = 'пользователь'`).all() as { id: string }[]) {
      if (userActive(db, u.id, now)) continue
      const live = (db.prepare('select count(*) c from sessions where user_id = ? and revoked_at is null').get(u.id) as any).c > 0
      const l = linkState(u.id)
      const working = accountList2().some(a => a.user === u.id && (senderState(a.id).running || unitOn(a.id)))
        || asUser(u.id, () => purchaseState()).active || (!!l && !l.done)
      if (!live && !working && !hub.users().has(u.id)) continue
      endAccess(u.id)
      ended.push(u.id)
    }
    if (ended.length) push()
    return ended
  }

  const ownerOnly = (reply: any) => {
    if (currentUser() === OWNER_ID) return false
    reply.code(403).send({ error: 'только владельцу' })
    return true
  }

  app.post('/api/users/disable', async (req: any, reply) => {
    if (ownerOnly(reply)) return reply
    return disableUser(String(req.body?.id ?? ''))
  })

  app.post('/api/users/enable', async (req: any, reply) => {
    if (ownerOnly(reply)) return reply
    return markEnabled(db, String(req.body?.id ?? ''))
  })

  // Пользователи и нагрузка (план 7.3, макет 8). Владелец видит только
  // счётчики: ни чужих аккаунтов, ни ключей, ни денег.
  app.get('/api/users', async (_req, reply) => {
    if (ownerOnly(reply)) return reply
    const rows = db.prepare(`select id, steamid, name, role, limits_json, disabled_at, created_at from users order by (role = 'владелец') desc, created_at`).all() as any[]
    const seen = db.prepare('select max(last_seen_at) t from sessions where user_id = ?')
    const list = rows.map(u => {
      const accs = accountList2().filter(a => (a.user || OWNER_ID) === u.id)
      return {
        id: u.id,
        name: u.name,
        role: u.role,
        steamid: u.steamid ? u.steamid.slice(0, 4) + '…' + u.steamid.slice(-4) : null,
        disabled: u.disabled_at != null,
        active: userActive(db, u.id),
        lastSeen: (seen.get(u.id) as any)?.t ?? null,
        accounts: accs.length,
        running: accs.filter(a => senderState(a.id).running).length,
        buying: asUser(u.id, () => purchaseState()).active,
        limits: u.role === 'владелец' ? null : limitsOf(db, u.id),
      }
    })
    let dbBytes: number | null = null
    try { dbBytes = fs.statSync(DB_FILE).size } catch { }
    const p = activePermit(db)
    return {
      users: list,
      entryOpen: entryOpen(db),
      permit: p ? { steamid: p.steamid.slice(0, 4) + '…' + p.steamid.slice(-4), expiresAt: p.expires_at } : null,
      load: { users: list.length, accounts: list.reduce((n, u) => n + u.accounts, 0), running: list.reduce((n, u) => n + u.running, 0), dbBytes },
    }
  })

  app.get('/api/users/invites', async (_req, reply) => {
    if (ownerOnly(reply)) return reply
    return listInvites(db)
  })

  // Ссылка показывается один раз — в базе только хэш токена.
  app.post('/api/users/invite', async (req: any, reply) => {
    if (ownerOnly(reply)) return reply
    const b = req.body ?? {}
    const r = createInvite(db, { name: String(b.name ?? ''), days: Number(b.days), limits: b.limits }, OWNER_ID)
    if ('error' in r) return r
    return { id: r.id, expiresAt: r.expiresAt, link: (PANEL_URL || '') + '/i/' + r.token, panelUrl: !!PANEL_URL }
  })

  app.post('/api/users/invite/revoke', async (req: any, reply) => {
    if (ownerOnly(reply)) return reply
    return revokeInvite(db, Number(req.body?.id), OWNER_ID)
  })

  app.post('/api/users/limits', async (req: any, reply) => {
    if (ownerOnly(reply)) return reply
    const id = String(req.body?.id ?? '')
    const u = userById(db, id)
    if (!u || u.role === 'владелец') return { error: 'нет такого пользователя' }
    const n = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 50 ? (v as number) : null)
    const accounts = n(req.body?.accounts)
    const senders = n(req.body?.senders)
    if (accounts == null || senders == null) return { error: 'пределы — целые от 0 до 50' }
    db.prepare('update users set limits_json = ? where id = ?').run(JSON.stringify({ accounts, senders }), id)
    push()
    return { ok: true, limits: { accounts, senders } }
  })

  // Вход для приглашённых (решение 16) — только действием владельца, после
  // живой приёмки. Закрыли — сессии и работа впущенных встают: их потоки
  // закрываются сразу, остальное — проверкой «активен ли» в каждом модуле.
  app.post('/api/users/entry', async (req: any, reply) => {
    if (ownerOnly(reply)) return reply
    const open = req.body?.open === true
    setEntryOpen(db, open, OWNER_ID)
    if (!open) enforceAccess()
    push()
    return { ok: true, open }
  })

  // Допуск для приёмки (решение 16): один steamid на 24 часа.
  app.post('/api/users/permit', async (req: any, reply) => {
    if (ownerOnly(reply)) return reply
    const sid = String(req.body?.steamid ?? '').trim()
    if (sid && sid === userById(db, OWNER_ID)?.steamid) return { error: 'это Steam владельца — нужен второй, тестовый' }
    const r = grantPermit(db, sid, OWNER_ID)
    if ('error' in r) return r
    return { ok: true, expiresAt: r.expiresAt }
  })

  app.post('/api/users/permit/revoke', async (_req, reply) => {
    if (ownerOnly(reply)) return reply
    const r = revokePermit(db, OWNER_ID)
    if ('error' in r) return r
    enforceAccess()
    push()
    return { ok: true }
  })

  // История счётчиков — по вещам всех аккаунтов сервера, без деления по
  // владельцам (её рисовал график, снятый на этапе 9): только владельцу.
  app.get('/api/counters', async (_req, reply) => {
    if (currentUser() !== OWNER_ID) return reply.code(403).send({ error: 'только владельцу' })
    return counterLines()
  })
  app.get('/api/tree', async (req: any) => tree(Number(req.query?.top) || settings().treeTop))

  // ───────────────────── файлы отправщика: ловим изменения ─────────────────────
  // Каждый аккаунт пишет свой отчёт: два отправщика в один файл затирали бы
  // друг друга. Разбираем все и приписываем расход тому, кто его сделал —
  // иначе журнал снова станет общим и второй аккаунт получит пустую очередь.
  const seenBy = new Map<string, number>()

  function ingestStatus() {
    for (const a of accountList2()) {
      const st = readJson<any>(path.join(GC, statusFile(a.id)), null)
      if (!Array.isArray(st?.recent)) continue
      const { rows, watermark } = fresh(st.recent, seenBy.get(a.id) ?? 0)
      for (const e of rows) {
        pushEvent(e, a.steamid)
        // В ленту попадает всё, включая silent. В журнал — только то, что GC
        // подтвердил: silent означает «не знаем», а не «сожжён».
        if (e.match) ingestOne(db, e as any, a.steamid)
      }
      seenBy.set(a.id, watermark)
    }
  }

  function watchSender() {
    if (!fs.existsSync(GC)) return
    let t: NodeJS.Timeout | null = null
    fs.watch(GC, (_ev, name) => {
      if (!name || !/^status.*\.json$/.test(String(name))) return
      if (t) clearTimeout(t)
      t = setTimeout(() => { ingestStatus(); push() }, 120)
    })
  }

  // ───────────────────────────── статика ─────────────────────────────
  if (opts.dist && fs.existsSync(opts.dist)) {
    await app.register(fstatic, { root: opts.dist })
    app.setNotFoundHandler((_req, reply) => reply.sendFile('index.html'))
  } else {
    app.get('/', async (_req, reply) => {
      reply.type('text/html').send('<pre style="font:14px monospace;padding:24px">Фронт не собран.\n\ncd dash && npm run deploy   — собрать фронт в dash/dist\nnpm run dev     — режим разработки на http://localhost:5173</pre>')
    })
  }


  return { app, push, hub, ingestStatus, watchSender, disableUser, enforceAccess }
}
