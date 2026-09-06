import { useEffect, useState } from 'react'
import { api, type EconomicsSettings, type Settings as SettingsType } from '../api'
import { Button, Panel } from './ui'
import { Economics } from './Economics'

type Draft = {
  max_item_price: string
  min_spread: string
  sale_fee: string
  interval_seconds: string
  max_steam_calls_per_sweep: string
}

function toDraft(s: SettingsType): Draft {
  return {
    max_item_price: String(s.MaxItemPrice),
    min_spread: String(s.MinSpread),
    // Go marshals a time.Duration as nanoseconds.
    interval_seconds: String(Math.round(s.Interval / 1e9)),
    sale_fee: String(Math.round(s.SaleFee * 100)),
    max_steam_calls_per_sweep: String(s.MaxSteamCallsPerSweep),
  }
}

const fields: { key: keyof Draft; label: string; hint: string }[] = [
  {
    key: 'max_item_price',
    label: 'Потолок цены лота, ₽',
    hint: 'Лоты дороже не проверяются — дорогие вещи редко продают по ошибке.',
  },
  {
    key: 'min_spread',
    label: 'Минимальный спред, ₽',
    hint: 'Находки с меньшей выгодой не показываются.',
  },
  {
    key: 'sale_fee',
    label: 'Комиссия при продаже гема, %',
    hint: 'Вычитается из цены гема при расчёте чистого спреда.',
  },
  {
    key: 'interval_seconds',
    label: 'Интервал полного обхода, сек',
    hint: 'Каталог маркета обновляется раз в минуту; чаще смысла нет.',
  },
  {
    key: 'max_steam_calls_per_sweep',
    label: 'Лимит запросов к Steam за обход',
    hint: 'Первый полный обход каталога — примерно 570 запросов по 100 предметов.',
  },
]

export function Settings({ onToast }: { onToast: (text: string, tone?: 'good' | 'bad') => void }) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    api
      .settings()
      .then((s) => setDraft(toDraft(s)))
      .catch((e: Error) => setMessage(e.message))
  }, [])

  if (!draft) {
    return (
      <Panel title="Настройки">
        <p className="text-sm text-mute">{message || 'Загрузка…'}</p>
      </Panel>
    )
  }

  const save = async () => {
    setSaving(true)
    setMessage('')
    try {
      const fresh = await api.saveSettings({
        max_item_price: Number(draft.max_item_price),
        min_spread: Number(draft.min_spread),
        sale_fee: Number(draft.sale_fee) / 100,
        interval_seconds: Number(draft.interval_seconds),
        max_steam_calls_per_sweep: Number(draft.max_steam_calls_per_sweep),
      })
      setDraft(toDraft(fresh))
      setMessage('')
      onToast('Настройки применены, таблица пересчитана')
    } catch (e) {
      setMessage((e as Error).message)
      onToast((e as Error).message, 'bad')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel
      title="Настройки"
      action={
        <div className="flex items-center gap-3">
          {message && <span className="text-xs text-mute">{message}</span>}
          <Button tone="primary" onClick={save} disabled={saving}>
            Сохранить
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <label key={f.key} className="block">
            <span className="text-xs font-medium tracking-wide text-mute uppercase">{f.label}</span>
            <input
              value={draft[f.key]}
              inputMode="numeric"
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              className="mt-1 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-sm outline-none focus:border-accent/60"
            />
            <span className="mt-1 block text-xs text-mute">{f.hint}</span>
          </label>
        ))}
      </div>

      <div className="mt-6 rounded-xl border border-line bg-panel-2 px-4 py-3 text-sm text-mute">
        <div className="mb-1 font-medium text-text">Ограничения, зашитые в бэкенд</div>
        <ul className="list-inside list-disc space-y-1">
          <li>4 запроса в секунду к market.dota2.net (их предел — 5, за превышение удаляют ключ).</li>
          <li>Ключ уходит в заголовке X-API-KEY, а не в строке URL.</li>
          <li>Покупка выключена; включается только переменной окружения RADAR_ALLOW_BUY=1.</li>
          <li>Trade Guard ничего не принимает и не отклоняет — только предупреждает.</li>
        </ul>
      </div>
    </Panel>
  )
}

export function SettingsPage({
  onToast,
}: {
  onToast: (text: string, tone?: 'good' | 'bad') => void
}) {
  return (
    <div className="space-y-5">
      <Economics onToast={onToast} />
      <Settings onToast={onToast} />
    </div>
  )
}

export type { EconomicsSettings }
