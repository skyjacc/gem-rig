// Карточка справа на Инвентаре (§5.2): выбранная стопка или вещь.
//
// Источники (план 2.2):
//   - счётчики, копии, потолок — state.mine (инвентарь);
//   - «сожжено» — gem.spent из state.mine, НЕ узел графа: у гема без узла
//     графа (нет в карте) это дало бы прочерк, хотя число есть в состоянии.
//     Метка — «инвентарь»: значение приходит в state.mine рядом со счётчиками,
//     а не из данных экрана Журнала (сверка 2.2, задача 3);
//   - «поднимается вместе с» — /api/graph (edges), состояние загрузки — Loadable.
// Разные счётчики у копий — пояснение с меткой «оценка» (§5.2, §3.3).
// Копии — только текущего аккаунта: других state.mine не знает до С3 (3.5).

import { ExternalLink, Network } from 'lucide-react'
import { icon, nf, plural, useJson, type GraphData, type State } from '../../lib/api.ts'
import { Loadable } from '../States.tsx'
import { Btn, Chip, Panel, Src } from '../ui.tsx'
import { STATE, useStacks, withOf } from './Inventory.tsx'

// Та же ссылка, что в старом Пульте (views/Work.tsx:30): поиск гема
// «Spectator {гем}» в категории самоцветов — не ссылка на саму вещь.
const MARKET = 'https://steamcommunity.com/market/search?q=&category_570_Type%5B%5D=tag_supply_crate&appid=570&q='

export function ItemCard({ state, goal, sel, onOverview }: {
  state: State
  goal: number | null
  sel: string | null
  onOverview: (gem: string) => void
}) {
  // Свой запрос графа, как у экрана: поднять общий в AppV2 нельзя — там адрес
  // зависел бы от экрана, а демо-useJson смену адреса не подхватывает. Цена —
  // второй одинаковый GET раз в 10 с, пока открыт Инвентарь.
  const graph = useJson<GraphData>('/api/graph?scope=owned', state.ts)
  const { gems, stacks } = useStacks(state, goal)
  const st = stacks.find(s => s.key === sel) ?? stacks[0] ?? null
  if (!st) return <Panel title="Вещь"><p className="v2-text">Вещей в инвентаре нет.</p></Panel>

  const g = st.gem
  const n = st.rows.length
  const cap = g.supply
  // Гем не из карты — непонятно, чьи матчи: ни «у команды», ни потолка на шкале.
  const unknown = st.state === 'unknown' || !g.entityId || !g.kind || g.kind === 'unknown'
  const who = g.kind === 'player' ? 'игрока' : 'команды'
  const estimated = g.supplyKind === 'estimated'
  const pct = goal ? Math.min(100, (st.max / goal) * 100) : 0
  const capPct = !unknown && goal && cap != null && cap < goal ? (cap / goal) * 100 : null
  const icons = new Map(gems.map(x => [x.gem, x.icon]))
  const w = withOf(graph.data?.edges, g.gem)
  const acc = state.autopilot.label

  return (
    <>
      <Panel title={n > 1 ? 'Стопка' : 'Вещь'} aside={g.gem}>
        <div className="v2-card-hero">
          <span className="v2-card-pic" style={{ backgroundImage: g.icon ? `url('${icon(g.icon, 128)}')` : undefined }} aria-hidden="true">
            {n > 1 ? <span className="v2-cell-cnt v2-num">×{n}</span> : null}
          </span>
          <div className="v2-card-title">
            <h3>{st.name}</h3>
            <p className="v2-hint">{(g.heroes || '—') + ' · гем ' + g.gem}</p>
            <div className="v2-cell-chips">
              {st.state ? <Chip tone={STATE[st.state].tone} dot>{STATE[st.state].word}</Chip> : <Chip>цель не задана</Chip>}
              {st.bare ? <Chip>голый самоцвет</Chip> : null}
            </div>
          </div>
        </div>

        <div className="v2-meter">
          <div className="v2-meter-t">
            <span>лучший счётчик {n > 1 ? 'в стопке ' : ''}<Src>инвентарь</Src></span>
            <span><b className="v2-num">{nf(st.max)}</b>{goal != null ? ' / ' + nf(goal) : ' · цель не задана'}</span>
          </div>
          {goal != null ? (
            <>
              <div className="v2-meter-bar">
                <i style={{ width: Math.max(pct, st.max ? 1.5 : 0) + '%', background: st.state === 'stuck' ? 'var(--warn)' : undefined }} />
                {capPct != null ? <span className="v2-capmark" style={{ left: capPct + '%' }} aria-hidden="true" /> : null}
              </div>
              <div className="v2-meter-legend">
                <span>0</span>
                {capPct != null ? <span className="is-warn">потолок {nf(cap!)}</span> : null}
                <span>{nf(goal)}</span>
              </div>
            </>
          ) : null}
        </div>

        <div className="v2-card-facts">
          <div className="v2-tile"><span>копий у меня <Src>инвентарь</Src></span><b className="v2-num">{nf(n)}</b></div>
          <div className="v2-tile"><span>до цели</span><b className="v2-num">{goal == null ? '—' : nf(Math.max(0, goal - st.max))}</b></div>
          <div className="v2-tile">
            <span>{unknown ? 'матчей всего' : 'матчей у ' + who} <Src>карта</Src></span>
            {cap == null ? <b className="v2-kpi-none">— не измерено</b>
              : <b className="v2-num">{estimated ? '≈ ' : ''}{nf(cap)} {estimated ? <Chip tone="warn">оценка</Chip> : null}</b>}
          </div>
          <div className="v2-tile">
            <span>сожжено <Src>инвентарь</Src></span>
            {g.spent == null ? <b className="v2-kpi-none">— нет данных</b> : <b className="v2-num">{nf(g.spent)}</b>}
          </div>
        </div>

        {st.state === 'stuck' && goal != null ? (
          <div className="v2-note is-warn">
            <b>До {nf(goal)} не дойдёт</b> <Src>карта матчей</Src>
            <p>У {who} {g.gem} всего {nf(cap ?? 0)} {plural(cap ?? 0, 'матч', 'матча', 'матчей')} — выше счётчик подняться не может.</p>
          </div>
        ) : null}
        {st.state === 'unknown' ? (
          <div className="v2-note is-stop">
            <b>Потолок неизвестен</b>
            <p>Гема {g.gem} нет в карте tools/gem-map.json — непонятно, чьи матчи считать; вещь в работу не пойдёт.</p>
          </div>
        ) : null}
        {st.differ ? (
          <div className="v2-note">
            <b>Почему у копий разные счётчики</b> <Chip tone="warn">оценка</Chip>
            <p>
              Отправка поднимает все копии разом, по +1 каждой <Src>README §4.7</Src>. Значит, копии с меньшим счётчиком,
              скорее всего, пришли позже — когда {nf(st.max)} {plural(st.max, 'матч', 'матча', 'матчей')} уже сгорели, а сгоревший матч
              второй раз не засчитается <Src>README §4.1</Src>. Следующие матчи поднимут все {nf(n)} вместе.
            </p>
          </div>
        ) : null}

        <div className="v2-insp-acts">
          <Btn tone="soft" onClick={() => onOverview(g.gem)}><Network size={14} aria-hidden="true" />показать в Обзоре</Btn>
          <a className="v2-btn is-soft v2-link-btn" href={MARKET + encodeURIComponent('Spectator ' + g.gem)} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={14} aria-hidden="true" />на рынке Steam
          </a>
        </div>
      </Panel>

      <Panel title="Копии" aside={nf(n) + ' · аккаунт «' + acc + '»'}>
        <ul className="v2-insp-list">
          {st.rows.map(r => (
            <li key={r.assetid}>
              <span className="v2-ava" aria-hidden="true">{(acc || '?').slice(0, 1).toUpperCase()}</span>
              <span className="v2-item-n">{acc}{r.carrier === 'gem' ? ' · голый самоцвет' : ''}</span>
              {r.equipped ? <span className="v2-item-eq">надето</span> : null}
              <span className="v2-num">{nf(r.value)}</span>
            </li>
          ))}
        </ul>
        <p className="v2-hint">Копии на других аккаунтах появятся на этапе 3.5 (С3): сейчас сервер отдаёт инвентарь только активного аккаунта.</p>
      </Panel>

      <Panel title="Поднимается вместе с" aside={<Src>граф</Src>}>
        <Loadable what="связки гема" loading={graph.loading} error={graph.error} ready={!!graph.data} onRetry={graph.reload} lines={2}>
          {/* «Нет в карте» — по самому гему, не по узлу графа: graph.ts пропускает
              и известный гем без матчей, а у него связок просто нет. */}
          {unknown ? (
            <p className="v2-text">Гема нет в карте — связки не посчитать.</p>
          ) : w.length ? (
            <ul className="v2-insp-list">
              {w.map(x => (
                <li key={x.gem}>
                  <span className="v2-item-ico" style={{ backgroundImage: icons.get(x.gem) ? `url('${icon(icons.get(x.gem)!, 64)}')` : undefined }} aria-hidden="true" />
                  <span className="v2-item-n">{x.gem}</span>
                  <span className="v2-num">{nf(x.n)}</span>
                  <span className="v2-item-eq">общих</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="v2-text">Общих матчей с другими гемами нет.</p>
          )}
        </Loadable>
      </Panel>
    </>
  )
}
