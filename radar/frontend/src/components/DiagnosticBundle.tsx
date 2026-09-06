import { useState } from 'react'
import { DownloadIcon } from './animated'
import { api } from '../api'
import { buildInfo, clientReport, recordAction, sessionID } from '../lib/diagnostics'
import { Button } from './ui'

/**
 * One file that answers "why did it do that".
 *
 * A journal export alone is not enough: it says what the scanner decided, but
 * not which build was running, what the settings were at the time, how complete
 * the data was, or whether the browser threw on the way to drawing it. Chasing
 * those down one endpoint at a time is exactly the work this avoids.
 *
 * Everything is fetched at the moment the button is pressed, so the snapshot is
 * internally consistent, and it is written straight to disk — nothing is sent
 * anywhere.
 */

type UIState = {
  tab: string
  filters?: unknown
  openItem?: string | null
}

async function settle<T>(label: string, p: Promise<T>): Promise<{ ok: boolean; label: string; value?: T; error?: string }> {
  try {
    return { ok: true, label, value: await p }
  } catch (e) {
    // A section that failed to collect is itself a finding — record it in the
    // bundle rather than dropping the key and leaving a silent hole.
    return { ok: false, label, error: e instanceof Error ? e.message : String(e) }
  }
}

export function DiagnosticBundle({ ui, onToast }: { ui: UIState; onToast: (t: string, tone?: 'good' | 'bad') => void }) {
  const [busy, setBusy] = useState(false)

  const collect = async () => {
    setBusy(true)
    recordAction('собран диагностический пакет')
    try {
      const parts = await Promise.all([
        settle('status', api.status()),
        settle('coverage', api.coverage()),
        settle('runs', api.runs(50)),
        settle('settings', api.settings()),
        settle('economics', api.economics()),
        settle('journal', api.journal(2000)),
        settle('history', api.history()),
        settle('findings', api.findings()),
      ])

      const server: Record<string, unknown> = {}
      const failures: Record<string, string> = {}
      for (const p of parts) {
        if (p.ok) server[p.label] = p.value
        else failures[p.label] = p.error ?? 'неизвестная ошибка'
      }

      const bundle = {
        schema: 'kinetic-radar/diagnostic-bundle@1',
        generated_at: new Date().toISOString(),
        session: sessionID,
        build: buildInfo,
        // Sections that could not be collected are named, so a reader never
        // mistakes a fetch failure for an empty result.
        incomplete: Object.keys(failures).length > 0 ? failures : undefined,
        client: clientReport(ui as unknown as Record<string, unknown>),
        server,
      }

      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `radar-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)

      const missing = Object.keys(failures)
      onToast(
        missing.length === 0
          ? 'Диагностический пакет собран'
          : `Пакет собран, но без разделов: ${missing.join(', ')}`,
        missing.length === 0 ? 'good' : 'bad',
      )
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'Не удалось собрать пакет', 'bad')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      onClick={collect}
      disabled={busy}
      size="sm"
      title="Один JSON: сборка, настройки, покрытие, проходы, журнал, ошибки браузера и размер окна"
    >
      <DownloadIcon size={15} />
      {busy ? 'Собираю…' : 'Диагностический пакет'}
    </Button>
  )
}
