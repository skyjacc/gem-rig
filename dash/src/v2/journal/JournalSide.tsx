// Правая колонка Журнала (§5.6, план 2.5, решение 7): выбранная отправка,
// как читать ответы, последнее подтверждение.

import { ago, nf, type State } from '../../lib/api.ts'
import { Chip, Panel } from '../ui.tsx'
import { MatchLink } from './Journal.tsx'
import { ANSWER, answerOf, itemsWord, keyOf, leagueNames } from './model.ts'
import { eventsOf, type JournalData } from './data.ts'

export function JournalSide({ state, data, sel, now }: { state: State; data: JournalData; sel: string | null; now: number }) {
  const e = sel ? eventsOf(state).find(x => keyOf(x) === sel) : undefined
  const names = leagueNames(data.tree.data, data.burned.data)
  const c = state.confirmed

  return (
    <>
      <Panel title="Отправка" aside={e ? <Chip tone={answerOf(e.result).tone === 'idle' ? undefined : answerOf(e.result).tone as 'ok' | 'warn'} dot>{answerOf(e.result).word}</Chip> : undefined}>
        {e ? (
          <>
            <dl className="v2-rows v2-jr-kv">
              <div><dt>когда</dt><dd className="v2-num">{new Date(e.ts).toLocaleString('ru-RU')}</dd></div>
              <div><dt>матч</dt><dd><MatchLink id={e.match_id} /></dd></div>
              <div><dt>лига</dt><dd>{names.get(e.league_id) ?? '—'} <span className="v2-hint v2-num">{e.league_id || ''}</span></dd></div>
              <div><dt>в прогоне</dt><dd className="v2-num">{e.n != null && e.total != null ? nf(e.n) + ' из ' + nf(e.total) : '—'}</dd></div>
              <div><dt>ответ</dt><dd>{answerOf(e.result).word}</dd></div>
              <div><dt>размер msg 26</dt><dd className="v2-num">{e.bytes ? nf(e.bytes) + ' Б' : '—'}</dd></div>
              <div><dt>изменено вещей · ответ GC</dt><dd className="v2-num">{itemsWord(e).v}{itemsWord(e).why ? <span className="v2-hint"> ({itemsWord(e).why})</span> : null}</dd></div>
            </dl>
            <p className="v2-hint v2-jr-why">{answerOf(e.result).hint}</p>
          </>
        ) : (
          <p className="v2-text">Выберите отправку в пульсе или в списке — здесь будет она подробно.</p>
        )}
      </Panel>

      <Panel title="Как читать ответы">
        <dl className="v2-jr-read">
          {(['update', 'dup', 'silent'] as const).map(r => (
            <div key={r}>
              <dt><Chip tone={ANSWER[r].tone === 'idle' ? undefined : ANSWER[r].tone as 'ok' | 'warn'} dot>{ANSWER[r].word}</Chip></dt>
              <dd>{ANSWER[r].hint}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      <Panel title="Последнее подтверждение">
        {c ? (
          <dl className="v2-rows v2-jr-kv">
            <div><dt>когда</dt><dd className="v2-num">{ago(c.ts, now)} назад</dd></div>
            <div><dt>матч</dt><dd><MatchLink id={c.match_id} /></dd></div>
            <div><dt>лига</dt><dd>{names.get(c.league_id) ?? c.league_id ?? '—'}</dd></div>
            <div><dt>размер msg 26</dt><dd className="v2-num">{c.bytes ? nf(c.bytes) + ' Б' : '—'}</dd></div>
          </dl>
        ) : <p className="v2-hint">Подтверждений на этом аккаунте ещё не было.</p>}
      </Panel>
    </>
  )
}
