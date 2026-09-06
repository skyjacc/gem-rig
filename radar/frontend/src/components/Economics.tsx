import { useEffect, useState } from 'react'
import { CheckIcon, WalletIcon } from './animated'
import { ago, api, rub, type EconomicsSettings } from '../api'
import { Badge, Panel } from './ui'
import { HammerMark } from './icons'

/** How much a rouble of Steam funds is worth to this operator. */
const walletPresets: { value: number; label: string; hint: string }[] = [
  { value: 0, label: 'Не нужны', hint: 'Steam вообще не участвует в выборе выхода' },
  { value: 0.5, label: 'Наполовину', hint: 'Трачу в Steam, но предпочёл бы живые деньги' },
  { value: 1, label: 'Как деньги', hint: 'Всё равно покупаю в Steam — считать наравне с рублями' },
]

export function Economics({
  onToast,
}: {
  onToast: (text: string, tone?: 'good' | 'bad') => void
}) {
  const [settings, setSettings] = useState<EconomicsSettings | null>(null)
  const [feeAt, setFeeAt] = useState('')
  const [feeError, setFeeError] = useState('')
  const [books, setBooks] = useState(0)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = () => {
    api
      .economics()
      .then((d) => {
        setSettings(d.settings)
        setFeeAt(d.market_fee_at)
        setFeeError(d.market_fee_error)
        setBooks(d.order_books)
      })
      .catch((e: Error) => setError(e.message))
  }

  useEffect(load, [])

  if (!settings) {
    return (
      <Panel title="Экономика сделки">
        <p className="text-sm text-mute">{error || 'Загрузка…'}</p>
      </Panel>
    )
  }

  // Go serialises a zero time.Time as "0001-01-01T00:00:00Z", which is a
  // truthy string. Only a parsed, positive timestamp proves the commission was
  // ever actually read off the account.
  const feeRead = !feeError && Date.parse(feeAt) > 0

  const patch = async (body: Record<string, number | boolean>, note: string) => {
    setSaving(true)
    try {
      await api.saveEconomics(body)
      load()
      onToast(note)
    } catch (e) {
      onToast((e as Error).message, 'bad')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel
      title="Экономика сделки"
      subtitle={`стаканов ордеров в памяти: ${books}`}
      action={
        feeError ? (
          <Badge tone="bad">комиссия не прочитана</Badge>
        ) : (
          <Badge tone="good">
            <CheckIcon size={12} /> комиссия маркета {settings.MarketFeePercent}%
          </Badge>
        )
      }
    >
      <section className="mb-6">
        <h3 className="mb-1 flex items-center gap-2 text-[11px] font-semibold tracking-[0.14em] text-faint uppercase">
          <WalletIcon size={13} /> Сколько для тебя стоят деньги Steam
        </h3>
        <p className="mb-3 text-sm text-mute">
          На Steam гем часто уходит дороже, но эти деньги нельзя вывести — только тратить внутри
          Steam. Радар не решает это за тебя.
        </p>
        <div className="flex flex-wrap gap-2">
          {walletPresets.map((p) => {
            const active = Math.abs(settings.SteamWalletValue - p.value) < 0.01
            return (
              <button
                key={p.value}
                disabled={saving}
                onClick={() =>
                  patch(
                    { steam_wallet_value: p.value },
                    `Деньги Steam учитываются на ${Math.round(p.value * 100)}%`,
                  )
                }
                className={`rounded-xl border px-3.5 py-2.5 text-left transition-colors disabled:opacity-50 ${
                  active
                    ? 'border-accent/50 bg-accent/10'
                    : 'border-line bg-panel-2 hover:border-faint'
                }`}
              >
                <div className={`text-sm font-medium ${active ? 'text-accent' : 'text-text'}`}>
                  {p.label}
                </div>
                <div className="mt-0.5 max-w-[220px] text-[11px] text-faint">{p.hint}</div>
              </button>
            )
          })}
        </div>
      </section>

      <section className="mb-6">
        <h3 className="mb-2 text-[11px] font-semibold tracking-[0.14em] text-faint uppercase">
          Чем считать цену выхода
        </h3>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-panel-2 px-3.5 py-3">
          <input
            type="checkbox"
            checked={settings.AllowListedExit}
            disabled={saving}
            onChange={(e) =>
              patch(
                { allow_listed_exit: e.target.checked },
                e.target.checked
                  ? 'Объявления учитываются, расчёты помечены как оптимистичные'
                  : 'Считаем только по стоящим ордерам',
              )
            }
            className="mt-0.5 accent-accent"
          />
          <span>
            <span className="text-sm font-medium">Разрешить считать по объявлениям</span>
            <span className="mt-0.5 block text-xs text-mute">
              По умолчанию выходом считается только стоящий ордер — деньги приходят сразу и по
              известной цене. Объявление это лишь чужой запрос: чтобы продать, придётся его
              перебить и ждать. С включённой галкой такие расчёты помечаются как «по объявлению».
            </span>
          </span>
        </label>
      </section>

      <section className="mb-6">
        <h3 className="mb-1 flex items-center gap-2 text-[11px] font-semibold tracking-[0.14em] text-faint uppercase">
          <HammerMark size={12} /> Стоимость извлечения
        </h3>
        <p className="mb-2 text-sm text-mute">
          Сейчас {rub(settings.ExtractionCost)} за один гем. Молоток в игровом магазине идёт пачкой
          по 15 за $0.99 — это примерно 5,70 ₽ за извлечение. На маркете тот же молоток стоит около
          40 ₽ за штуку.
        </p>
        <div className="flex flex-wrap gap-2">
          {[
            { v: 5.7, label: 'из игрового магазина · 5,70 ₽' },
            { v: 40, label: 'с маркета · 40 ₽' },
          ].map((o) => (
            <button
              key={o.v}
              disabled={saving}
              onClick={() => patch({ extraction_cost: o.v }, `Извлечение считается по ${rub(o.v)}`)}
              className={`rounded-lg border px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
                Math.abs(settings.ExtractionCost - o.v) < 0.01
                  ? 'border-accent/50 bg-accent/10 text-accent'
                  : 'border-line bg-panel-2 text-mute hover:text-text'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-[11px] font-semibold tracking-[0.14em] text-faint uppercase">
          Комиссии площадок
        </h3>
        <table className="w-full text-sm">
          <tbody>
            <tr className="border-b border-line-soft">
              <td className="py-2 text-mute">market.dota2.net</td>
              <td className="py-2 text-right font-mono">{settings.MarketFeePercent}%</td>
              <td className={`py-2 pl-4 text-xs ${feeRead ? 'text-accent' : 'text-warn'}`}>
                {feeRead
                  ? `прочитано с аккаунта ${ago(feeAt)}`
                  : `значение по умолчанию — прочитать не удалось${feeError ? `: ${feeError}` : ''}`}
              </td>
            </tr>
            <tr className="border-b border-line-soft">
              <td className="py-2 text-mute">Steam</td>
              <td className="py-2 text-right font-mono">{settings.SteamFeePercent}%</td>
              <td className="py-2 pl-4 text-xs">
                {settings.SteamFeeConfirmed ? (
                  <span className="text-accent">подтверждено</span>
                ) : (
                  <button
                    onClick={() =>
                      patch({ steam_fee_confirmed: true }, 'Комиссия Steam отмечена как проверенная')
                    }
                    className="text-warn underline-offset-2 hover:underline"
                  >
                    не подтверждено — сверь при выставлении лота и нажми здесь
                  </button>
                )}
              </td>
            </tr>
            <tr>
              <td className="py-2 text-mute">DMarket</td>
              <td className="py-2 text-right font-mono">{settings.DMarketFeePercent}%</td>
              <td className="py-2 pl-4 text-xs">
                {settings.DMarketFeeConfirmed ? (
                  <span className="text-accent">подтверждено</span>
                ) : (
                  <button
                    onClick={() =>
                      patch(
                        { dmarket_fee_confirmed: true },
                        'Комиссия DMarket отмечена как проверенная',
                      )
                    }
                    className="text-warn underline-offset-2 hover:underline"
                  >
                    не подтверждено — в API не публикуется
                  </button>
                )}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="mt-3 text-xs text-faint">
          Неподтверждённая комиссия помечает расчёт как неполный: цифра взята по умолчанию, а не с
          твоего аккаунта.
        </p>
      </section>
    </Panel>
  )
}
