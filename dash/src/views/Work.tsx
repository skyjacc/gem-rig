import { useMemo, useState } from 'react'
import {
  ChevronDown, ChevronRight, ExternalLink, Play, Search, Settings2, Square, TriangleAlert,
} from 'lucide-react'
import {
  ago, nf, plural, span, useAction, useJson,
  type CatalogRow, type Kit, type Live, type Pool, type State,
} from '../lib/api.ts'
import { Bar, Button, Card, Dot, Empty, ItemIcon, Label, Note, Num, PageHead, Segmented } from '../parts/ui.tsx'
import { Chart } from '../parts/Chart.tsx'
import { Tune } from '../parts/Tune.tsx'
import { Reveal } from '../parts/Reveal.tsx'
import { Confirm } from '../parts/Confirm.tsx'

// Пульт — единственный экран, на который заходят каждый день.
//
// Он отвечает на пять вопросов, и в этом порядке:
//
//   работает ли система       состояние: лампа, слово, причина
//   что происходит прямо сейчас очередь, темп, срок, последнее подтверждение
//   есть ли проблема          отдельный блок, и его нет, когда нечего сказать
//   нужно ли мне что-то делать у каждой строки внимания написано, что именно
//   сколько товара я получу   выход: готово, дойдёт, не дойдёт
//
// Раньше экран открывался графиком роста, а состояние работы было одной
// строчкой под заголовком. График отвечает на «как было», а не на «что
// сейчас», и ради него приходилось листать. Теперь он ниже и свёрнут.

const MARKET = 'https://steamcommunity.com/market/search?q=&category_570_Type%5B%5D=tag_supply_crate&appid=570&q='

export function Work({ state, live, now }: { state: State; live: Live; now: number }) {
  const [tuning, setTuning] = useState(false)
  const [starting, setStarting] = useState(false)
  const stop = useAction()

  const ap = state.autopilot
  const goal = ap.goal || 2000
  const owned = state.mine.filter(m => m.gem !== '—')

  const out = output(state, goal)
  const warn = attention(state, live, now)

  return (
    <div className="view-in space-y-6">
      <PageHead
        title="Пульт"
        sub={verdict(state, live, now)}
        right={
          <>
            <Button onClick={() => setTuning(true)}>
              <Settings2 className="h-3.5 w-3.5" />
              <span>настроить</span>
            </Button>
            {ap.enabled ? (
              <Button tone="danger" loading={stop.busy} onClick={() => stop.run('/api/autopilot', { id: ap.id, on: false })}>
                <Square className="h-3.5 w-3.5" />
                <span>остановить</span>
              </Button>
            ) : (
              // Пуск — необратимое действие: каждая отправка тратит матч
              // навсегда. Поэтому он открывает предпросмотр, а не уходит
              // в работу с первого нажатия.
              <Button tone="burn" onClick={() => setStarting(true)}>
                <Play className="h-3.5 w-3.5" />
                <span>накрутить</span>
              </Button>
            )}
          </>
        }
      />

      {stop.error ? (
        <Note title="работник не остановился" action={<Button onClick={() => stop.run('/api/autopilot', { id: ap.id, on: false })}>ещё раз</Button>}>
          {stop.error} — отправщик мог остаться живым. Проверьте состояние ниже.
        </Note>
      ) : null}

      <Console state={state} live={live} now={now} />

      {warn.length ? <Attention list={warn} /> : null}

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr))] xl:[grid-template-columns:1.35fr_1fr]">
        <Inventory state={state} goal={goal} />
        <Output out={out} goal={goal} state={state} />
      </div>

      <Growth state={state} />

      <Shop state={state} goal={goal} />

      <Tune open={tuning} onClose={() => setTuning(false)} state={state} unit={ap} />

      <Confirm
        open={starting}
        title="Запустить накрутку"
        note={ap.label}
        verb="накрутить"
        url="/api/autopilot"
        body={{ id: ap.id, on: true }}
        onClose={() => setStarting(false)}
        what={preview(state, goal)}
      >
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Отправленный матч расходуется навсегда: тот же матч на этом же аккаунте
          второго раза счётчика не поднимет. Вернуть его нельзя — ни остановкой,
          ни отвязкой аккаунта. На другом аккаунте он останется свежим.
        </p>
        {owned.length === 0 ? (
          <Note tone="warn" title="в инвентаре нет гемов">
            Работник включится и будет ждать: без гемов жечь нечего. Ничего не потратится.
          </Note>
        ) : null}
      </Confirm>
    </div>
  )
}

// ── состояние ──
//
// Одна плотная полоса вместо россыпи карточек. Панель — прибор, а не отчёт:
// показания стоят в ряд, читаются одним взглядом и не переставляются местами.

type Lamp = { tone: 'ok' | 'warn' | 'stop' | 'idle'; word: string; why: string }

function lamp(s: State, live: Live): Lamp {
  const ap = s.autopilot
  if (live.stale) return { tone: 'stop', word: 'нет связи', why: 'панель показывает последнее, что успела получить' }
  if (ap.fatal) return { tone: 'stop', word: 'встал', why: ap.fatal }
  if (!ap.enabled) return { tone: 'idle', word: 'стоит', why: ap.why || 'накрутка выключена, ничего не уходит' }
  if (ap.running) return { tone: 'ok', word: 'накручивает', why: ap.why }
  return { tone: 'warn', word: 'ждёт', why: ap.why }
}

function Console({ state, live, now }: { state: State; live: Live; now: number }) {
  const ap = state.autopilot
  const l = lamp(state, live)
  const fresh = state.confirmed && now - state.confirmed.ts < 15_000

  return (
    <Card>
      <div className="flex flex-wrap items-stretch">
        <div className="flex min-w-[240px] flex-1 items-center gap-3 px-3.5 py-3">
          <span className={l.tone === 'ok' ? 'halo-host' : ''}>
            <Dot tone={l.tone} pulse={l.tone === 'ok'} />
          </span>
          <span className="min-w-0">
            <span className="block text-[17px] font-medium leading-tight tracking-[-0.02em]">{l.word}</span>
            <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">{l.why}</span>
          </span>
        </div>

        <div className="flex flex-1 flex-wrap items-stretch border-t border-white/[0.06] sm:border-l sm:border-t-0">
          <Read k="очередь" v={nf(ap.queueLength)} />
          <Read k="до конца" v={span(ap.etaMinutes)} />
          <Read k="темп" v={state.rate ? nf(state.rate) + '/мин' : '—'} />
          <Read k="пауза" v={pace(ap)} />
          <Read
            k="подтверждение"
            v={state.confirmed ? ago(state.confirmed.ts, now) + ' назад' : 'нет'}
            tone={fresh ? 'ok' : undefined}
          />
        </div>
      </div>

      {/* Лента отправок: одна засечка на отправку, цвет — итог. Отвечает
          на «идёт ли и ровно ли» без чтения журнала. */}
      <Tape events={state.events} />

      <Progress ap={ap} now={now} />
    </Card>
  )
}

const pace = (ap: State['autopilot']) =>
  ap.even && ap.until ? nf(ap.delay) + ' мс к сроку'
    : ap.auto ? nf(ap.delay) + ' мс сама'
      : nf(ap.delay) + ' мс'

function Read({ k, v, tone }: { k: string; v: string; tone?: 'ok' }) {
  return (
    <span className="min-w-[104px] flex-1 border-l border-white/[0.06] px-3.5 py-3 first:border-l-0">
      <Label>{k}</Label>
      <span
        className="tnum mt-1 block font-mono text-[15px]"
        style={{ color: tone === 'ok' ? 'var(--ok)' : undefined }}
      >
        {v}
      </span>
    </span>
  )
}

// Засечка на отправку: зелёная — засчитан, жёлтая — спорный, серая — без
// ответа. Ровная зелёная гребёнка означает, что всё идёт как надо; пробелы
// и жёлтые полосы видно раньше, чем это скажет любое число.
function Tape({ events }: { events: State['events'] }) {
  const rows = events.slice(0, 120).reverse()
  if (!rows.length) return null
  return (
    <div className="flex h-6 items-end gap-[2px] overflow-hidden border-t border-white/[0.06] px-3.5 py-1.5" aria-hidden="true">
      {rows.map(e => (
        <span
          key={e.ts + ':' + e.match_id}
          className="w-[3px] shrink-0"
          style={{
            height: e.result === 'update' ? '100%' : e.result === 'dup' ? '55%' : '25%',
            background: e.result === 'update' ? 'var(--ok)' : e.result === 'dup' ? 'var(--warn)' : 'rgb(255 255 255 / 0.22)',
          }}
        />
      ))}
    </div>
  )
}

// Полоса хода: по цели, если она задана, иначе по сроку. Без того и другого
// полосы нет вовсе — рисовать прогресс работы без конца было бы враньём.
function Progress({ ap, now }: { ap: State['autopilot']; now: number }) {
  if (ap.target) {
    const pct = (ap.done / ap.target) * 100
    return (
      <div className="border-t border-white/[0.06] px-3.5 py-2.5">
        <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
          <span className="text-muted-foreground">
            цель <span className="tnum font-mono text-foreground">{nf(ap.target)}</span>
            {ap.ordered && ap.ordered !== ap.target
              ? <span className="text-muted-foreground/60"> — заказ {nf(ap.ordered)}, круглое выдаёт накрутку</span>
              : null}
          </span>
          <span className="tnum font-mono">{nf(ap.done)} / {nf(ap.target)}</span>
        </div>
        <Bar pct={pct} tone={ap.done >= ap.target ? 'ok' : 'run'} />
      </div>
    )
  }
  if (ap.until) {
    const left = ap.until - now
    // Заполнение считается от того момента, когда работника включили.
    // Без начала полоса была бы выдумкой: остаток известен, длина — нет.
    const from = ap.startedAt || now
    const whole = Math.max(1, ap.until - from)
    const gone = Math.max(0, Math.min(100, ((now - from) / whole) * 100))
    return (
      <div className="border-t border-white/[0.06] px-3.5 py-2.5">
        <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
          <span className="text-muted-foreground">
            работаю до{' '}
            <span className="tnum font-mono text-foreground">
              {new Date(ap.until).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}
            </span>
            {ap.even ? <span className="text-muted-foreground/60"> — работа поделена ровно на срок</span> : null}
          </span>
          <span className="tnum font-mono" style={{ color: left <= 0 ? 'var(--warn)' : undefined }}>
            {left <= 0 ? 'срок вышел' : span(Math.round(left / 60_000))}
          </span>
        </div>
        <Bar pct={gone} tone={left <= 0 ? 'warn' : 'run'} />
      </div>
    )
  }
  return null
}

// ── внимание ──

type Alert = { level: 'stop' | 'warn'; text: string; todo?: string }

function Attention({ list }: { list: Alert[] }) {
  const bad = list.filter(a => a.level === 'stop').length
  return (
    <Card style={{ borderColor: bad ? 'color-mix(in oklab, var(--stop) 45%, transparent)' : undefined }}>
      <div className="flex items-baseline gap-2 border-b border-white/[0.06] px-3.5 py-2.5">
        <TriangleAlert className="h-3.5 w-3.5 self-center" style={{ color: bad ? 'var(--stop)' : 'var(--warn)' }} />
        <span className="text-[15px] font-medium">Требует внимания</span>
        <span className="ui-label ml-auto text-muted-foreground/75">
          {nf(list.length)} {plural(list.length, 'вопрос', 'вопроса', 'вопросов')}
        </span>
      </div>
      <ul className="divide-y divide-white/[0.06]">
        {list.map((w, i) => (
          <li key={i} className="flex items-start gap-2.5 px-3.5 py-2.5 text-[13px] leading-relaxed">
            <span className="mt-[7px]"><Dot tone={w.level} /></span>
            <span className="min-w-0">
              <span className="block">{w.text}</span>
              {w.todo ? <span className="mt-0.5 block text-[12px] text-muted-foreground">{w.todo}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function attention(s: State, live: Live, now: number): Alert[] {
  const a: Alert[] = []
  const ap = s.autopilot
  const goal = ap.goal || 2000

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

// Одна строка вместо четырёх чисел: ответ на «всё нормально?».
function verdict(s: State, live: Live, now: number): string {
  const ap = s.autopilot
  const goal = ap.goal || 2000
  const owned = s.mine.filter(m => m.gem !== '—')
  const items = owned.reduce((n, m) => n + m.items, 0)
  const ready = owned.reduce((n, m) => n + (m.max >= goal ? m.items : 0), 0)

  if (live.stale) return 'связи с сервером нет — всё ниже показано на момент последнего снимка'
  if (s.inv.private) return 'инвентарь Steam закрыт — состав не виден, работа с потолком невозможна'
  if (s.inv.error) return 'Steam не отвечает: ' + s.inv.error
  if (ap.fatal) return 'работник встал: ' + ap.fatal
  if (!ap.enabled) {
    return items
      ? `${nf(ready)} из ${nf(items)} ${plural(items, 'вещи', 'вещей', 'вещей')} готово · накрутка выключена, ничего не уходит`
      : 'гемов нет — купите, работник заметит сам за двадцать секунд'
  }
  if (!ap.running) return 'включено, поднимаю отправщик — ' + ap.why
  const last = s.confirmed ? ago(s.confirmed.ts, now) : null
  return `накручиваю · ${nf(ap.queueLength)} ${plural(ap.queueLength, 'матч', 'матча', 'матчей')} в очереди · ${span(ap.etaMinutes)} до конца` +
    (last ? ` · подтверждение ${last} назад` : '')
}

// Что человек увидит перед необратимым пуском.
function preview(s: State, goal: number) {
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
  rows.push({ k: 'цель счётчика', v: nf(goal) })
  return rows
}

// ── выход ──
//
// Не «сколько просмотров всего», а «сколько вещей я смогу продать». Товар —
// вещь со счётчиком выше цели; всё остальное это заготовка.

type Out = { ready: number; reachable: number; stuck: number; items: number; views: number }

function output(s: State, goal: number): Out {
  let ready = 0, reachable = 0, stuck = 0, items = 0, views = 0
  for (const m of s.mine) {
    if (m.gem === '—') continue
    items += m.items
    views += m.rows.reduce((a, r) => a + r.value, 0)
    for (const r of m.rows) {
      if (r.value >= goal) ready++
      else if (m.supply != null && m.supply < goal) stuck++
      else reachable++
    }
  }
  return { ready, reachable, stuck, items, views }
}

function Output({ out, goal, state }: { out: Out; goal: number; state: State }) {
  const pct = out.items ? (out.ready / out.items) * 100 : 0
  return (
    <Card className="p-3.5">
      <div className="flex items-end gap-3">
        <span>
          <Label>готово к продаже</Label>
          <span className="mt-1 block">
            <Num value={out.ready} className="font-mono text-[34px] font-medium leading-none tracking-[-0.03em]" />
            <span className="tnum font-mono text-[15px] text-muted-foreground/50"> / {nf(out.items)}</span>
          </span>
        </span>
        <span className="ml-auto text-right">
          <Label>счётчик товара</Label>
          <span className="tnum mt-1 block font-mono text-[17px]">{nf(goal)}</span>
        </span>
      </div>

      <div className="mt-3"><Bar pct={pct} tone={out.ready === out.items && out.items ? 'ok' : 'run'} /></div>

      <div className="mt-3.5 space-y-2 border-t border-white/[0.06] pt-3">
        <Line
          k="дойдут при этой работе"
          v={nf(out.reachable)}
          note={out.reachable ? 'матчей у их команд хватает' : undefined}
        />
        <Line
          k="не дойдут никогда"
          v={nf(out.stuck)}
          tone={out.stuck ? 'warn' : undefined}
          note={out.stuck ? 'матчей у команды меньше цели — потолок ниже' : undefined}
        />
        <Line k="просмотров накоплено" v={nf(out.views)} />
        <Line k="матчей израсходовано" v={nf(state.burned)} note="на этом аккаунте; на другом они свежие" />
      </div>
    </Card>
  )
}

function Line({ k, v, note, tone }: { k: string; v: string; note?: string; tone?: 'ok' | 'warn' }) {
  return (
    <span className="block">
      <span className="flex items-baseline justify-between gap-2">
        <Label>{k}</Label>
        <span
          className="tnum font-mono text-[13px]"
          style={{ color: tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : undefined }}
        >
          {v}
        </span>
      </span>
      {note ? <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground/60">{note}</span> : null}
    </span>
  )
}

// ── рост счётчиков ──
//
// Отвечает на «как было», а не на «что сейчас», поэтому лежит ниже состояния
// и свёрнут по умолчанию: место нужнее спискам.
function Growth({ state }: { state: State }) {
  const [open, setOpen] = useState(false)

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-baseline gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-white/[0.02]"
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground" />}
        <span className="text-[15px] font-medium">Рост счётчиков</span>
        <span className="ui-label ml-auto text-muted-foreground/75">
          каждая вещь · {nf(state.inv.items)} шт
        </span>
      </button>
      <Reveal open={open}>
        <div className="border-t border-white/[0.06] p-3.5">
          {open ? <Chart state={state} /> : null}
        </div>
      </Reveal>
    </Card>
  )
}

// ── мини-инвентарь ──

function Inventory({ state, goal }: { state: State; goal: number }) {
  const [open, setOpen] = useState<string | null>(null)
  const [view, setView] = useState<'gems' | 'sets'>('sets')
  // Список на шестьсот вещей длиннее экрана в несколько раз. Свернуть его
  // нужно ровно так же, как ветку внутри него: одним и тем же движением.
  const [shown, setShown] = useState(true)
  const owned = state.mine.filter(m => m.gem !== '—')
  const picked = new Set(state.autopilot.picked ?? owned.map(m => m.gem))

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-3.5 py-2.5">
        <button
          type="button"
          onClick={() => setShown(!shown)}
          aria-expanded={shown}
          className="flex min-w-0 items-center gap-2.5 text-left transition-colors hover:text-foreground"
        >
          {shown
            ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <span className="text-[15px] font-medium">Инвентарь</span>
          <span className="ui-label text-muted-foreground/75">
            {nf(owned.length)} {plural(owned.length, 'гем', 'гема', 'гемов')} · {nf(owned.reduce((n, m) => n + m.items, 0))} {plural(owned.reduce((n, m) => n + m.items, 0), 'вещь', 'вещи', 'вещей')}
          </span>
        </button>
        <span className="ml-auto">
          <Segmented
            value={view}
            items={[{ id: 'sets' as const, label: 'наборы' }, { id: 'gems' as const, label: 'гемы' }]}
            onPick={setView}
          />
        </span>
      </div>

      <Reveal open={shown}>
        {view === 'sets' ? <Sets state={state} goal={goal} /> : null}
        <div hidden={view !== 'gems'}>
          {owned.length === 0 ? (
            <Empty>пусто — купите гем, он появится здесь сам</Empty>
          ) : (
            <div>
              {owned.map(m => {
                const done = m.max >= goal
                const capped = m.supply != null && m.supply < goal
                const spread = m.min !== m.max
                const isOpen = open === m.gem
                return (
                  <div key={m.gem} className="border-b border-white/[0.06] last:border-0">
                    <button
                      type="button"
                      onClick={() => setOpen(isOpen ? null : m.gem)}
                      aria-expanded={isOpen}
                      className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-white/[0.02]"
                    >
                      {isOpen
                        ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                      <ItemIcon hash={m.icon} size={22} />

                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate text-[13px] font-medium">{m.gem}</span>
                          <span className="tnum shrink-0 font-mono text-[11px] text-muted-foreground/60">×{m.items}</span>
                          {!picked.has(m.gem) ? (
                            <span className="ui-label shrink-0 text-muted-foreground/50">не в накрутке</span>
                          ) : null}
                        </span>
                        <span className="mt-1 block">
                          <Bar pct={(m.max / goal) * 100} tone={done ? 'ok' : capped ? 'warn' : 'run'} />
                        </span>
                      </span>

                      <span className="shrink-0 text-right">
                        <span className="block">
                          <Num
                            value={m.max}
                            className="font-mono text-[15px] font-medium"
                            style={{ color: done ? 'var(--ok)' : capped ? 'var(--warn)' : undefined }}
                          />
                          <span className="tnum font-mono text-[12px] text-muted-foreground/50"> / {nf(goal)}</span>
                        </span>
                        <span className="tnum block font-mono text-[11px] text-muted-foreground/60">
                          {spread ? nf(m.min ?? 0) + '…' + nf(m.max) : 'потолок ' + (m.supply != null ? nf(m.supply) : '—')}
                        </span>
                      </span>
                    </button>

                    <Reveal open={isOpen}>
                      <div className="scroll-thin max-h-[240px] overflow-auto border-t border-white/[0.06] bg-white/[0.01]">
                        {isOpen ? m.rows.map((r, i) => (
                          <div
                            key={r.assetid}
                            className="rise flex items-center gap-2.5 px-3.5 py-1.5 pl-11"
                            style={{ animationDelay: Math.min(i, 20) * 10 + 'ms' }}
                          >
                            <span className="min-w-0 flex-1 truncate text-[12px]">
                              {r.carrier === 'gem'
                                ? <span className="text-muted-foreground">самоцвет, никуда не вставлен</span>
                                : r.name}
                            </span>
                            {r.equipped ? <span className="ui-label shrink-0 text-muted-foreground/50">надет</span> : null}
                            <span className="tnum shrink-0 font-mono text-[12px]" style={{ color: r.value >= goal ? 'var(--ok)' : undefined }}>
                              {nf(r.value)}
                            </span>
                          </div>
                        )) : null}
                        {isOpen && m.supply != null ? (
                          <div className="px-3.5 py-2 pl-11 text-[11px] text-muted-foreground/60">
                            потолок {nf(m.supply)}
                            {m.supplyKind === 'estimated' ? ' (оценка)' : ''}
                            {m.left != null ? ' · осталось ' + nf(m.left) : ''}
                            {m.supply < goal ? ' · до цели не дойдёт' : ''}
                          </div>
                        ) : null}
                      </div>
                    </Reveal>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </Reveal>
    </Card>
  )
}

// ── наборы ──
//
// Продаётся собранный набор на героя, а не россыпь частей: семь предметов
// Pugna со счётчиками стоят иначе, чем семь одиночных вещей. Состав Steam
// отдаёт в описании каждого предмета, поэтому видно и сколько комплектов
// собирается, и какой части не хватает до следующего.

function Sets({ state, goal }: { state: State; goal: number }) {
  const { data, loading, error, reload } = useJson<Pool>('/api/pool', state.ts)
  const [open, setOpen] = useState<string | null>(null)

  if (error) {
    return (
      <div className="p-3.5">
        <Note title="наборы не собрались" action={<Button onClick={reload}>ещё раз</Button>}>{error}</Note>
      </div>
    )
  }
  if (!data) return <Empty>{loading ? 'собираю наборы…' : 'наборов пока нет'}</Empty>
  if (!data.kits.length) return <Empty>пусто — купите гем, он появится здесь сам</Empty>

  return (
    <div>
      {data.kits.map(k => (
        <KitRow
          key={k.key}
          k={k}
          goal={goal}
          open={open === k.key}
          onToggle={() => setOpen(open === k.key ? null : k.key)}
        />
      ))}
    </div>
  )
}

function KitRow({ k, goal, open, onToggle }: { k: Kit; goal: number; open: boolean; onToggle: () => void }) {
  const done = k.max >= goal
  const bare = !k.hero
  const spread = k.min !== k.max

  return (
    <div className="border-b border-white/[0.06] last:border-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-white/[0.02]"
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <ItemIcon hash={k.icon} size={22} />

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate text-[13px] font-medium">{k.set}</span>
            {bare ? null : <span className="shrink-0 text-[12px] text-muted-foreground">{k.hero}</span>}
            <span className="tnum shrink-0 font-mono text-[11px] text-muted-foreground/60">×{k.items}</span>
          </span>
          <span className="mt-1 block">
            <Bar pct={(k.max / goal) * 100} tone={done ? 'ok' : 'run'} />
          </span>
        </span>

        <span className="shrink-0 text-right">
          <span className="block">
            <Num
              value={k.max}
              className="font-mono text-[15px] font-medium"
              style={{ color: done ? 'var(--ok)' : undefined }}
            />
            <span className="tnum font-mono text-[12px] text-muted-foreground/50"> / {nf(goal)}</span>
          </span>
          <span className="block text-[11px] text-muted-foreground/60">
            {bare
              ? k.gem
              : k.complete
                ? nf(k.complete) + ' ' + plural(k.complete, 'комплект', 'комплекта', 'комплектов') + (k.spare ? ' + ' + nf(k.spare) : '')
                : k.distinct + ' из ' + k.pieces + ' частей'}
          </span>
        </span>
      </button>

      <Reveal open={open}>
        <div className="border-t border-white/[0.06] bg-white/[0.01] px-3.5 py-2.5 pl-11 text-[12px]">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
            <span>гем <span className="text-foreground">{k.gem || '—'}</span></span>
            <span>счётчик <span className="tnum font-mono text-foreground">{spread ? nf(k.min) + '…' + nf(k.max) : nf(k.max)}</span></span>
            {k.equipped ? <span>надето <span className="tnum font-mono text-foreground">{k.equipped}</span></span> : null}
            {bare ? null : <span>частей в наборе <span className="tnum font-mono text-foreground">{k.pieces}</span></span>}
          </div>
          {k.missing.length ? (
            <div className="mt-2" style={{ color: 'var(--warn)' }}>
              до полного не хватает: {k.missing.join(', ')}
            </div>
          ) : k.complete ? (
            <div className="mt-2" style={{ color: 'var(--ok)' }}>
              набор полный — собирается {nf(k.complete)} {plural(k.complete, 'комплект', 'комплекта', 'комплектов')}
              {k.spare ? `, ещё ${nf(k.spare)} ${plural(k.spare, 'предмет', 'предмета', 'предметов')} сверх` : ''}
            </div>
          ) : null}
        </div>
      </Reveal>
    </div>
  )
}

// ── магазин ──
//
// Два списка, потому что покупки бывают двух совершенно разных сортов.
//
//   копия того, что уже жжётся — стоит ноль отправок, только цена гема:
//     одно сообщение поднимает все подходящие вещи разом
//   новая сущность — это полный прогон в две с половиной тысячи отправок

function Shop({ state, goal }: { state: State; goal: number }) {
  const [q, setQ] = useState('')
  const [all, setAll] = useState(false)

  const { copies, fresh } = useMemo(() => {
    const price = (c: CatalogRow) => parseFloat(String(c.price).replace(/[^\d.]/g, '')) || 999
    const reach = (c: CatalogRow) => c.supply != null && c.supply >= goal
    const list = [...state.catalog]
    return {
      copies: list.filter(c => c.ownedItems > 0 && reach(c)).sort((a, b) => price(a) - price(b)),
      fresh: list.filter(c => !c.ownedItems && reach(c)).sort((a, b) => price(a) - price(b)),
    }
  }, [state.catalog, goal])

  const shown = all
    ? state.catalog.filter(c => c.short.toLowerCase().includes(q.toLowerCase()))
    : []

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-medium text-foreground/95">Магазин Steam</h2>
        <span className="ui-label text-muted-foreground/75">
          копия уже идущего гема стоит ноль отправок — только цену
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="floating inline-flex h-10 items-center gap-2 border border-white/[0.08] px-2.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && q.trim()) {
                  window.open(MARKET + encodeURIComponent('Spectator ' + q), '_blank', 'noopener')
                }
              }}
              placeholder="найти на рынке Steam"
              aria-label="найти гем на рынке Steam"
              className="ui-label w-48 max-w-[40vw] bg-transparent text-foreground outline-none placeholder:text-muted-foreground/50"
            />
          </span>
          <Segmented
            value={all ? 'all' : 'top'}
            items={[{ id: 'top' as const, label: 'что докупить' }, { id: 'all' as const, label: 'весь каталог' }]}
            onPick={id => setAll(id === 'all')}
          />
        </div>
      </div>

      {all ? (
        <Card>
          <div className="scroll-thin max-h-[520px] divide-y divide-white/[0.06] overflow-auto">
            {shown.map(c => <Offer key={c.name} c={c} goal={goal} />)}
          </div>
          {shown.length === 0 ? <Empty>ничего не нашлось</Empty> : null}
        </Card>
      ) : (
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr))]">
          <Card>
            <div className="border-b border-white/[0.06] px-3.5 py-2.5">
              <span className="text-[13px] font-medium">Копии — ноль отправок</span>
              <span className="ml-2 text-[12px] text-muted-foreground">вторая вещь того же гема идёт следом за первой</span>
            </div>
            {copies.length === 0
              ? <Empty>таких нет</Empty>
              : <div className="divide-y divide-white/[0.06]">{copies.slice(0, 6).map(c => <Offer key={c.name} c={c} goal={goal} />)}</div>}
          </Card>

          <Card>
            <div className="border-b border-white/[0.06] px-3.5 py-2.5">
              <span className="text-[13px] font-medium">Новые команды и игроки</span>
              <span className="ml-2 text-[12px] text-muted-foreground">накручивать с нуля, зато свои матчи</span>
            </div>
            {fresh.length === 0
              ? <Empty>таких нет</Empty>
              : <div className="divide-y divide-white/[0.06]">{fresh.slice(0, 6).map(c => <Offer key={c.name} c={c} goal={goal} />)}</div>}
          </Card>
        </div>
      )}
    </div>
  )
}

function Offer({ c, goal }: { c: CatalogRow; goal: number }) {
  const reach = c.supply != null && c.supply >= goal
  return (
    <a
      href={c.market}
      target="_blank"
      rel="noreferrer noopener"
      className="flex items-center gap-2.5 px-3.5 py-2 transition-colors hover:bg-white/[0.02]"
    >
      <ItemIcon hash={c.icon} size={22} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]">{c.short}</span>
        <span className="block truncate text-[11px] text-muted-foreground/60">
          потолок {c.supply != null ? nf(c.supply) : '—'}
          {c.supplyKind === 'estimated' ? ' (оценка)' : ''}
          {reach ? '' : ' · до цели не дойдёт'}
          {c.ownedItems ? ' · есть ' + c.ownedItems : ''}
        </span>
      </span>
      <span className="tnum shrink-0 font-mono text-[13px]">{c.price}</span>
      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </a>
  )
}
