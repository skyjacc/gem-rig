import { useEffect, useRef, useState } from 'react'
import type { State } from '../lib/types.ts'
import { dur, nf } from '../lib/format.ts'
import { post } from '../lib/live.ts'
import { Btn, Card } from './ui.tsx'

const PACE: [number, string][] = [
  [2000, '2 с'], [3000, '3 с'], [10000, '10 с'], [30000, '30 с'],
  [60000, '1 мин'], [120000, '2 мин'], [300000, '5 мин'],
]

// Пуск и остановка отправщика. Панель сама по себе ничего не шлёт —
// пока здесь не нажать «Запустить», ни одно сообщение в GC не уходит.
export function Control({ state }: { state: State }) {
  const s = state.sender
  const [file, setFile] = useState('')
  const [delay, setDelay] = useState(state.delay ?? 30000)
  const [err, setErr] = useState<string | null>(null)
  const log = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!file && state.files.length) setFile(s.file ?? state.files[0].name)
  }, [state.files, s.file])

  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight }, [s.lines.length])

  const picked = state.files.find(f => f.name === file)
  const eta = picked ? dur(picked.rows * delay) : '—'

  return (
    <Card title="Отправщик">
      <div className="flex items-baseline gap-2.5">
        <span className={`h-2 w-2 rounded-full ${s.running ? 'bg-malachite' : 'bg-dust'}`} />
        <span className="font-display text-[22px] font-extrabold leading-none">
          {s.running ? 'работает' : 'остановлен'}
        </span>
        {s.pid ? <span className="text-[11px] text-dust">pid {s.pid}</span> : null}
      </div>

      <div className="mt-3 space-y-2">
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-[0.18em] text-dust">список матчей</span>
          <select
            value={file} onChange={e => setFile(e.target.value)} disabled={s.running}
            className="w-full border border-rule bg-ink px-2.5 py-1.5 text-chalk disabled:opacity-50"
          >
            {state.files.length === 0 && <option value="">файлов нет — соберите список в каталоге</option>}
            {state.files.map(f => (
              <option key={f.name} value={f.name}>{f.name} · {nf(f.rows)} матчей</option>
            ))}
          </select>
        </label>

        <div>
          <span className="mb-1 block text-[10px] uppercase tracking-[0.18em] text-dust">пауза между матчами</span>
          <div className="flex flex-wrap gap-1.5">
            {PACE.map(([ms, label]) => (
              <Btn key={ms} on={delay === ms} onClick={() => { setDelay(ms); if (s.running) post('/api/delay', { delay: ms }) }}>
                {label}
              </Btn>
            ))}
          </div>
        </div>

        <div className="flex items-baseline justify-between border-t border-rule/60 pt-2 text-[11px] text-dust">
          <span>займёт</span><span className="tnum">{eta}</span>
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        {s.running ? (
          <Btn onClick={async () => { setErr(null); const r = await post('/api/sender/stop', {}); if (r.error) setErr(r.error) }}>
            Остановить
          </Btn>
        ) : (
          <Btn
            on
            disabled={!file}
            onClick={async () => {
              setErr(null)
              const r = await post('/api/sender/start', { file, delay })
              if (r.error) setErr(r.error)
            }}
          >
            Запустить
          </Btn>
        )}
      </div>

      {err ? <div className="mt-2 text-[11px] text-oxide">{err}</div> : null}
      {s.exit && !s.running ? <div className="mt-2 text-[11px] text-dust">{s.exit}</div> : null}

      {s.lines.length > 0 && (
        <div ref={log} className="mt-3 max-h-[150px] overflow-auto border border-rule bg-ink p-2 text-[11px] leading-[1.45] text-dust">
          {s.lines.map((l, i) => <div key={i} className="whitespace-pre-wrap">{l}</div>)}
        </div>
      )}
    </Card>
  )
}
