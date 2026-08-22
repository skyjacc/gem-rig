import type { ReactNode } from 'react'
import { Button, Note } from './ui.tsx'
import { Modal } from './Modal.tsx'
import { useAction } from '../lib/api.ts'

// Подтверждение необратимого действия.
//
// В панели два рода кнопок, и путать их нельзя. «Показать наборы» отменяется
// повторным нажатием. «Накрутить» отправляет игровому координатору сообщения,
// каждое из которых тратит матч навсегда: тот же матч на том же аккаунте
// второй раз счётчика не поднимет. Вернуть его нельзя ничем.
//
// Поэтому у необратимого действия есть свой вид кнопки, а перед ним —
// окно, где написано, что именно произойдёт: сколько, с чем, до каких пор
// и что из этого не отменяется. Не «вы уверены?», а список последствий.
export function Confirm({
  open,
  title,
  note,
  what,
  verb,
  onClose,
  url,
  body,
  onDone,
  children,
}: {
  open: boolean
  title: string
  note?: string
  // Что именно произойдёт — строки предпросмотра, а не «вы уверены?».
  what: { k: string; v: string; tone?: 'warn' | 'ok' }[]
  verb: string
  onClose: () => void
  url: string
  body: unknown
  onDone?: () => void
  children?: ReactNode
}) {
  const act = useAction()

  const go = async () => {
    const r: any = await act.run(url, body)
    if (r?.error) return
    onDone?.()
    onClose()
  }

  return (
    <Modal
      open={open}
      title={title}
      note={note}
      width="w-[520px]"
      onClose={() => { act.clear(); onClose() }}
      footer={
        <>
          <Button onClick={() => { act.clear(); onClose() }}>отмена</Button>
          <Button tone="burn" loading={act.busy} onClick={go}>{act.busy ? 'запускаю…' : verb}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <dl className="divide-y divide-white/[0.06]">
          {what.map(w => (
            <div key={w.k} className="flex items-baseline justify-between gap-4 py-2">
              <dt className="ui-label text-muted-foreground/75">{w.k}</dt>
              <dd
                className="tnum text-right font-mono text-[13px]"
                style={{ color: w.tone === 'warn' ? 'var(--warn)' : w.tone === 'ok' ? 'var(--ok)' : undefined }}
              >
                {w.v}
              </dd>
            </div>
          ))}
        </dl>
        {children}
        {act.error ? (
          <Note title="не вышло" action={<Button onClick={go} loading={act.busy}>ещё раз</Button>}>
            {act.error}
          </Note>
        ) : null}
      </div>
    </Modal>
  )
}
