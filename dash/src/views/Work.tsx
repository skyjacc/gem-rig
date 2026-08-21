import { useMemo, useState } from 'react'
import {
  ChevronDown, ChevronRight, ExternalLink, Play, Search, Settings2, Square, TriangleAlert,
} from 'lucide-react'
import { ago, clock, nf, post, span, useJson, type CatalogRow, type Gem, type Kit, type Pool, type State } from '../lib/api.ts'
import { Bar, Button, Card, Dot, Empty, Field, ItemIcon, Label, Num, PageHead, Segmented } from '../parts/ui.tsx'
import { Chart } from '../parts/Chart.tsx'
import { Tune } from '../parts/Tune.tsx'
import { Reveal } from '../parts/Reveal.tsx'

// Работа с гемами — единственный экран, на который заходят каждый день.
//
// Четыре части, в порядке того, как ими пользуются:
//
//   накрутка     одна кнопка. Всё остальное — за «настроить»
//   инвентарь    сколько гемов, сколько просмотров, сколько до цели
//   статистика   идёт ли работа и как росло раньше
//   магазин      что докупить и сразу ссылка на рынок
//
// Раньше это было четыре отдельные вкладки, и каждый заход начинался
// со сборки ответа из кусков. Главный вопрос — «всё нормально?» — теперь
// написан словами в первой строке, а не собирается человеком из чисел.

const MARKET = 'https://steamcommunity.com/market/search?q=&category_570_Type%5B%5D=tag_supply_crate&appid=570&q='

export function Work({ state, now }: { state: State; now: number }) {
  const [tuning, setTuning] = useState(false)
  const ap = state.autopilot
  const goal = ap.goal || 2000
  const owned = state.mine.filter(m => m.gem !== '—')

  const ready = owned.reduce((n, m) => n + (m.max >= goal ? m.items : 0), 0)
  const items = owned.reduce((n, m) => n + m.items, 0)
  const views = owned.reduce((n, m) => n + m.rows.reduce((a, r) => a + r.value, 0), 0)

  return (
    <div className="view-in space-y-6">
      <PageHead
        title="Гемы"
        sub={verdict(state, now)}
        right={
          <>
            <Button onClick={() => setTuning(true)}>
              <Settings2 className="h-3.5 w-3.5" />
              <span>настроить</span>
            </Button>
            {ap.enabled ? (
              <Button tone="danger" onClick={() => post('/api/autopilot', { id: ap.id, on: false })}>
                <Square className="h-3.5 w-3.5" />
                <span>остановить</span>
              </Button>
            ) : (
              <Button active onClick={() => post('/api/autopilot', { id: ap.id, on: true })}>
                <Play className="h-3.5 w-3.5" />
                <span>накрутить</span>
              </Button>
            )}
          </>
        }
      />

      <Growth state={state} />

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(420px,1fr))] xl:[grid-template-columns:1.35fr_1fr]">
        <Inventory state={state} goal={goal} />
        <Stats state={state} now={now} ready={ready} items={items} views={views} />
      </div>

      <Shop state={state} goal={goal} />

      <Tune open={tuning} onClose={() => setTuning(false)} state={state} unit={ap} />
    </div>
  )
}

// Рост счётчиков — во всю ширину и первым делом.
//
// Он отвечает на вопрос, ради которого экран и открывают: растёт ли. В узкой
// колонке справа сто линий сливались в кашу, и смотреть на них было незачем.
// Сворачивается — когда работа идёт ровно, место нужнее спискам.
function Growth({ state }: { state: State }) {
  const [open, setOpen] = useState(true)

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-baseline gap-3 border-b border-white/[0.06] px-3.5 py-2.5 text-left transition-colors hover:bg-white/[0.02]"
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
        <div className="p-3.5">
          <Chart state={state} />
        </div>
      </Reveal>
    </Card>
  )
}

// Одна строка вместо четырёх чисел: ответ на «всё нормально?».
function verdict(s: State, now: number): string {
  const ap = s.autopilot
  const goal = ap.goal || 2000
  const owned = s.mine.filter(m => m.gem !== '—')
  const items = owned.reduce((n, m) => n + m.items, 0)
  const ready = owned.reduce((n, m) => n + (m.max >= goal ? m.items : 0), 0)

  if (s.inv.error) return 'Steam не отвечает: ' + s.inv.error
  if (ap.failures >= 5) return 'работник встал: ' + ap.why
  if (!ap.enabled) {
    return items
      ? `${nf(ready)} из ${nf(items)} вещей готово · накрутка выключена, ничего не уходит`
      : 'гемов нет — купите, работник заметит сам за двадцать секунд'
  }
  if (!ap.running) return 'включено, поднимаю отправщик — ' + ap.why
  const last = s.confirmed ? ago(s.confirmed.ts, now) : null
  return `накручиваю · ${nf(ap.queueLength)} матчей в очереди · ${span(ap.etaMinutes)} до конца` +
    (last ? ` · подтверждение ${last} назад` : '')
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
          className="flex min-w-0 items-center gap-2.5 text-left transition-colors hover:text-foreground"
        >
          {shown
            ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <span className="text-[15px] font-medium">Инвентарь</span>
          <span className="ui-label text-muted-foreground/75">
            {nf(owned.length)} гемов · {nf(owned.reduce((n, m) => n + m.items, 0))} вещей
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
  const { data } = useJson<Pool>('/api/pool', state.ts)
  const [open, setOpen] = useState<string | null>(null)
  if (!data) return <Empty>собираю наборы…</Empty>
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
                ? nf(k.complete) + ' комплект' + tail(k.complete) + (k.spare ? ' + ' + nf(k.spare) : '')
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
              набор полный — собирается {nf(k.complete)} комплект{tail(k.complete)}
              {k.spare ? `, ещё ${nf(k.spare)} ${plural(k.spare, 'предмет', 'предмета', 'предметов')} сверх` : ''}
            </div>
          ) : null}
        </div>
      </Reveal>
    </div>
  )
}

// Склонение: «1 комплект», «2 комплекта», «5 комплектов».
const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one :
  n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many

const tail = (n: number) => plural(n, '', 'а', 'ов')

// ── статистика ──

function Stats({
  state, now, ready, items, views,
}: {
  state: State; now: number; ready: number; items: number; views: number
}) {
  const ap = state.autopilot
  const warn = attention(state, now)

  return (
    <div className="space-y-4">
      <Card className="p-3.5">
        <div className="flex items-end gap-3">
          <span>
            <Label>готово к продаже</Label>
            <span className="mt-1 block">
              <Num value={ready} className="font-mono text-[34px] font-medium leading-none tracking-[-0.03em]" />
              <span className="tnum font-mono text-[15px] text-muted-foreground/50"> / {nf(items)}</span>
            </span>
          </span>
          <span className="ml-auto text-right">
            <Label>просмотров всего</Label>
            <span className="mt-1 block"><Num value={views} className="font-mono text-[17px]" /></span>
          </span>
        </div>

        <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-white/[0.06] pt-3">
          <Fact k="матчей израсходовано" v={nf(state.burned)} />
          <Fact k="в очереди" v={nf(ap.queueLength)} />
          <Fact k="темп" v={state.rate ? nf(state.rate) + ' / мин' : '—'} />
          <Fact k="до конца" v={span(ap.etaMinutes)} />
          <Fact
            k="подтверждение"
            v={state.confirmed ? ago(state.confirmed.ts, now) + ' назад' : 'нет'}
            tone={state.confirmed && now - state.confirmed.ts < 15_000 ? 'ok' : undefined}
          />
          <Fact k="пауза" v={nf(ap.delay) + (ap.auto ? ' сама' : ' мс')} />
        </div>
      </Card>

      {warn.length ? (
        <Card>
          <div className="flex items-baseline gap-2 border-b border-white/[0.06] px-3.5 py-2.5">
            <TriangleAlert className="h-3.5 w-3.5" style={{ color: 'var(--warn)' }} />
            <span className="text-[15px] font-medium">Требует внимания</span>
            <span className="ui-label ml-auto text-muted-foreground/75">{nf(warn.length)}</span>
          </div>
          <ul className="divide-y divide-white/[0.06]">
            {warn.map((w, i) => (
              <li key={i} className="flex items-start gap-2.5 px-3.5 py-2 text-[12px] leading-relaxed">
                <span className="mt-[6px]"><Dot tone={w.level} /></span>
                <span>{w.text}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}

function Fact({ k, v, tone }: { k: string; v: string; tone?: 'ok' }) {
  return (
    <span className="flex items-baseline justify-between gap-2">
      <Label>{k}</Label>
      <span className="tnum font-mono text-[13px]" style={{ color: tone === 'ok' ? 'var(--ok)' : undefined }}>{v}</span>
    </span>
  )
}

type Alert = { level: 'stop' | 'warn'; text: string }

function attention(s: State, now: number): Alert[] {
  const a: Alert[] = []
  const goal = s.autopilot.goal || 2000
  if (s.inv.error) a.push({ level: 'stop', text: 'Steam: ' + s.inv.error })
  if (s.autopilot.failures > 0) {
    a.push({ level: 'warn', text: 'отправщик не поднялся ' + s.autopilot.failures + ' раз подряд' })
  }
  if (s.autopilot.enabled && s.autopilot.running && s.confirmed && now - s.confirmed.ts > 120_000) {
    a.push({ level: 'warn', text: 'больше двух минут без подтверждений' })
  }
  for (const m of s.mine) {
    if (m.gem === '—') continue
    if (!m.entityId || !m.kind || m.kind === 'unknown') {
      a.push({ level: 'warn', text: m.gem + ' — непонятно, чьи матчи считать, в работу не пойдёт' })
    } else if (m.supply != null && m.supply < goal) {
      a.push({ level: 'warn', text: m.gem + ' — потолок ' + nf(m.supply) + ', до цели не дойдёт' })
    }
  }
  return a
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
        <h2 className="text-[15px] font-medium text-foreground/95">Магазин</h2>
        <span className="ui-label text-muted-foreground/75">
          копия уже идущего гема стоит ноль отправок — только цену
        </span>
        <div className="ml-auto flex items-center gap-2">
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
              className="ui-label w-48 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/50"
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
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(420px,1fr))]">
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

// Лента последних отправок нужна изредка — держим её внизу, свёрнутой.
export function LastSends({ state }: { state: State }) {
  const rows = state.events.slice(0, 12)
  if (!rows.length) return null
  return (
    <details className="card">
      <summary className="cursor-pointer px-3.5 py-2.5 text-[13px]">
        последние отправки
        <span className="ml-2 text-[12px] text-muted-foreground">{nf(state.events.length)}</span>
      </summary>
      <ul className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
        {rows.map(e => (
          <li key={e.ts} className="flex items-center gap-3 px-3.5 py-1.5 text-[12px]">
            <Dot tone={e.result === 'update' ? 'ok' : e.result === 'dup' ? 'warn' : 'idle'} />
            <span className="tnum font-mono text-[11px] text-muted-foreground/60">{clock(e.ts)}</span>
            <span className="tnum font-mono">{e.match_id}</span>
            <span className="ml-auto text-muted-foreground">
              {e.result === 'update' ? 'засчитан' : e.result === 'dup' ? 'спорный' : 'без ответа'}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}
