// Логика работника, общая для старой и новой панели.
//
// Перенесено из views/Work.tsx без изменения смысла: лампа, пауза,
// предпросмотр запуска, список «требует внимания». Единственная правка —
// цель передаётся параметром: новая панель берёт её только из настроек
// (спецификация §3.2), старая передаёт то же, что считала сама.

import { nf, plural, type Live, type State } from './api.ts'

export type Lamp = { tone: 'ok' | 'warn' | 'stop' | 'idle'; word: string; why: string }

export function lamp(s: State, live: Live): Lamp {
  const ap = s.autopilot
  if (live.stale) return { tone: 'stop', word: 'нет связи', why: 'панель показывает последнее, что успела получить' }
  if (ap.fatal) return { tone: 'stop', word: 'встал', why: ap.fatal }
  if (!ap.enabled) return { tone: 'idle', word: 'стоит', why: ap.why || 'накрутка выключена, ничего не уходит' }
  if (ap.running) return { tone: 'ok', word: 'накручивает', why: ap.why }
  return { tone: 'warn', word: 'ждёт', why: ap.why }
}

export const pace = (ap: State['autopilot']) =>
  ap.even && ap.until ? nf(ap.delay) + ' мс к сроку'
    : ap.auto ? nf(ap.delay) + ' мс сама'
      : nf(ap.delay) + ' мс'

export type Alert = { level: 'stop' | 'warn'; text: string; todo?: string }

export function attention(s: State, live: Live, now: number, goal: number): Alert[] {
  const a: Alert[] = []
  const ap = s.autopilot

  if (live.stale) {
    a.push({
      level: 'stop',
      text: 'связь с сервером потеряна — числа на экране устарели',
      todo: 'работник и отправщик, скорее всего, продолжают работать; проверьте, жив ли процесс панели',
    })
  }

  if (s.inv.private) {
    a.push({
      level: 'stop',
      text: 'инвентарь Steam закрыт настройками приватности',
      todo: 'откройте инвентарь в настройках профиля Steam: без него не видно ни состава, ни счётчиков, и потолки не считаются',
    })
  } else if (s.inv.error) {
    a.push({
      level: 'stop',
      text: 'Steam не отдаёт инвентарь: ' + s.inv.error,
      todo: 'панель повторит сама; пока счётчики не читаются, работник с потолком останавливается, чтобы не жечь вслепую',
    })
  } else if (s.inv.truncated) {
    a.push({
      level: 'warn',
      text: 'инвентарь больше, чем панель читает за раз — виден не весь',
      todo: 'потолки считаются по видимой части: часть вещей может уйти выше заданного числа',
    })
  }

  if (ap.fatal) {
    a.push({ level: 'stop', text: 'отправщик встал: ' + ap.fatal, todo: 'после этого работник не перезапускается сам — нужно вмешательство' })
  }

  if ((ap.displaced ?? 0) > 0 && ap.enabled) {
    a.push({
      level: 'warn',
      text: 'аккаунт выбивает другой сессией Steam (' + ap.displaced + ')',
      todo: 'закройте игру и клиент Steam на этом аккаунте — иначе вход удаётся, а через минуту его отбирают',
    })
  }

  if (ap.failures > 0) {
    a.push({
      level: ap.failures >= 3 ? 'stop' : 'warn',
      text: 'отправщик не удержался ' + ap.failures + ' ' + plural(ap.failures, 'раз', 'раза', 'раз') + ' подряд',
      todo: 'посмотрите его вывод в разделе «Аккаунты» — там видно, на чём он падает',
    })
  }

  if (ap.enabled && ap.running && s.confirmed && now - s.confirmed.ts > 120_000) {
    a.push({
      level: 'warn',
      text: 'больше двух минут без подтверждений от Valve',
      todo: 'если пауза не растянута сроком, работник перезапустит отправщик сам',
    })
  }

  if (!s.keys.steam) {
    a.push({
      level: 'warn',
      text: 'нет ключа Steam Web API',
      todo: 'без него не видно, какие вещи надеты; всё остальное работает — ключ кладётся в tools/steam.key',
    })
  }

  const capped = new Set(ap.capped ?? [])
  for (const m of s.mine) {
    if (m.gem === '—') continue
    if (!m.entityId || !m.kind || m.kind === 'unknown') {
      a.push({
        level: 'warn',
        text: m.gem + ' — непонятно, чьи матчи считать',
        todo: 'этот гем в работу не пойдёт: его нет в карте гемов (tools/gem-map.json)',
      })
    } else if (m.supply != null && m.supply < goal) {
      a.push({
        level: 'warn',
        text: m.gem + ' — матчей всего ' + nf(m.supply) + ', до цели ' + nf(goal) + ' не дойдёт',
        todo: 'его вещи остановятся на ' + nf(m.supply) + '; либо снизьте цель, либо не считайте их товаром',
      })
    } else if (capped.has(m.gem)) {
      a.push({
        level: 'warn',
        text: m.gem + ' дошёл до своего потолка и вышел из работы',
        todo: 'его матчи остались целыми — новый гем той же команды поднимется по ним',
      })
    }
  }
  return a
}

export function preview(s: State, goal: number | null) {
  const ap = s.autopilot
  const picked = ap.picked ?? []
  const rows: { k: string; v: string; tone?: 'warn' | 'ok' }[] = [
    { k: 'аккаунт', v: ap.label + ' · ' + ap.steamid },
    { k: 'гемы в работе', v: picked.length ? picked.join(', ') : 'все из инвентаря' },
    { k: 'в очереди', v: ap.queueLength ? nf(ap.queueLength) + ' матчей' : 'соберу после запуска' },
  ]
  rows.push({
    k: 'сколько отправок',
    v: ap.target ? nf(ap.target) + (ap.ordered && ap.ordered !== ap.target ? ' (заказ ' + nf(ap.ordered) + ')' : '') : 'до конца очереди',
    tone: ap.target ? undefined : 'warn',
  })
  rows.push({
    k: 'докуда вести гем',
    v: ap.cap ? nf(ap.cap) : 'весь запас матчей',
    tone: ap.cap ? undefined : 'warn',
  })
  if (ap.until) {
    rows.push({
      k: 'срок',
      v: new Date(ap.until).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }),
    })
  }
  rows.push({ k: 'пауза', v: pace(ap) })
  rows.push({ k: 'цель счётчика', v: goal == null ? '— нет в настройках' : nf(goal), tone: goal == null ? 'warn' : undefined })
  return rows
}
