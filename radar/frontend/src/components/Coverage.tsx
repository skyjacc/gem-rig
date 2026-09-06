import { useEffect, useState } from 'react'
import { CircleAlert, CircleSlash } from 'lucide-react'
import { CircleCheckIcon, ClockIcon } from './animated'
import { ago, api, type Coverage as CoverageData, type SourceStatus } from '../api'
import { Badge, Panel, Progress } from './ui'
import { sourceLabel } from './meta'

/**
 * A source row saying "5 · 15 минут назад" is not evidence of anything. What
 * makes it trustworthy is a denominator, a freshness limit and a verdict.
 */
const STALE_MINUTES = 45

type Verdict = { label: string; tone: 'good' | 'warn' | 'bad' | 'default'; why: string }

function verdictFor(s: SourceStatus): Verdict {
  if (!s.enabled) {
    return { label: 'выключен', tone: 'default', why: 'нет ключа или источник отключён' }
  }
  if (s.error) {
    return { label: 'не отвечает', tone: 'bad', why: s.error }
  }
  const minutes = s.at ? (Date.now() - Date.parse(s.at)) / 60000 : Infinity
  if (!Number.isFinite(minutes)) {
    return { label: 'нет ответа', tone: 'bad', why: 'источник ни разу не ответил' }
  }
  if (minutes > STALE_MINUTES) {
    return {
      label: 'устарел',
      tone: 'warn',
      why: `последний успешный ответ ${Math.round(minutes)} мин назад, обновление раз в 30 мин`,
    }
  }
  if (s.gems === 0) {
    return { label: 'пусто', tone: 'warn', why: `ответил, но ни одного ${unitOf(s.name)} не вернул` }
  }
  return { label: 'работает', tone: 'good', why: `отдал ${s.gems} ${unitOf(s.name)}, ответ свежий` }
}

/**
 * What each source is actually for, so its number means something.
 *
 * `share` says whether the count can be divided by "гемов с ценой". For the
 * order books it cannot: that row counts item names with a readable book, a
 * different denominator entirely, and dividing the two produced a percentage
 * that looked authoritative and meant nothing.
 */
const roleOf: Record<string, { role: string; unit: string; share: boolean }> = {
  'tm.net': {
    role: 'объявления сканируемой площадки — это и есть цена покупки',
    unit: 'цен',
    share: true,
  },
  'tm.net:orders': {
    role: 'стаканы ордеров: за сколько выкупят прямо сейчас',
    unit: 'стаканов',
    share: false,
  },
  dmarket: { role: 'реальные завершённые сделки, вторая площадка покупки', unit: 'цен', share: true },
  steam: { role: 'объявления Steam, количество предложений', unit: 'цен', share: true },
  lootfarm: { role: 'прайс обменного сервиса; не гарантированный денежный выход', unit: 'цен', share: true },
  waxpeer: { role: 'объявления, третье независимое мнение', unit: 'цен', share: true },
  'lis-skins': { role: 'объявления по каждому лоту отдельно', unit: 'цен', share: true },
}

const unitOf = (name: string) => roleOf[name]?.unit ?? 'цен'

export function Coverage() {
  const [data, setData] = useState<CoverageData | null>(null)
  const [error, setError] = useState('')
  const [showUnlisted, setShowUnlisted] = useState(false)

  useEffect(() => {
    const load = () =>
      api
        .coverage()
        .then((value) => { setData(value); setError('') })
        .catch((e: Error) => setError(e.message))
    load()
    const id = window.setInterval(load, 20000)
    return () => window.clearInterval(id)
  }, [])

  if (!data) {
    return (
      <Panel title="Покрытие">
        <p className="text-sm text-mute">{error || 'Загрузка…'}</p>
      </Panel>
    )
  }

  const { catalogue, gems, sources, order_books: books } = data
  const unknown = gems.unknown ?? []
  const unlisted = gems.unlisted ?? []
  const checkedNow = catalogue.current_resolved ?? 0
  const resolvedPct =
    catalogue.candidates > 0 ? Math.round((checkedNow / catalogue.candidates) * 100) : 0
  const gemPct = gems.in_game > 0 ? Math.round((gems.priced / gems.in_game) * 100) : 0

  return (
    <div className="space-y-5">
      <Panel
        title="Что радар вообще видит"
        subtitle="цифры без знаменателя ничего не значат — вот знаменатели"
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-sm font-medium">Каталог маркета</span>
              <span className="font-mono text-sm text-accent">
                {checkedNow.toLocaleString('ru-RU')} / {catalogue.candidates.toLocaleString('ru-RU')}
              </span>
            </div>
            <Progress value={resolvedPct} />
            <dl className="mt-3 space-y-1 text-xs">
              <div className="flex justify-between">
                <dt className="text-mute">всего вариантов на площадке</dt>
                <dd className="font-mono">{catalogue.variants.toLocaleString('ru-RU')}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-mute">из них проходят по цене</dt>
                <dd className="font-mono">{catalogue.candidates.toLocaleString('ru-RU')}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-mute">сокеты прочитаны в этом каталоге</dt>
                <dd className="font-mono text-accent">{checkedNow.toLocaleString('ru-RU')}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-mute" title="включая варианты, уже ушедшие с площадки">
                  запомнено за всё время
                </dt>
                <dd className="font-mono">{catalogue.resolved.toLocaleString('ru-RU')}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-mute">осталось проверить</dt>
                <dd className="font-mono">{catalogue.pending.toLocaleString('ru-RU')}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-mute">оказались с кинетиком</dt>
                <dd className="font-mono text-accent">{catalogue.with_gems.toLocaleString('ru-RU')}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-mute">каталог собран маркетом</dt>
                <dd className="font-mono">{ago(catalogue.built_at)}</dd>
              </div>
            </dl>
          </div>

          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-sm font-medium">Кинетические гемы</span>
              <span className="font-mono text-sm text-accent">
                {gems.priced} / {gems.in_game}
              </span>
            </div>
            <Progress value={gemPct} tone="info" />
            <p className="mt-3 text-xs text-mute">
              В файлах игры <span className="font-mono text-text">{gems.in_game}</span> кинетиков с
              рыночными именами в локальном справочнике. Собраны котировки для{' '}
              <span className="font-mono text-accent">{gems.priced}</span>. Для остальных{' '}
              <span className="font-mono text-text">{unlisted.length}</span> котировок нет в доступных данных.
              Это не доказывает отсутствие предложений на рынке; свежесть проверяется отдельно.
            </p>
            {unknown.length > 0 && (
              <p className="mt-2 text-xs text-warn">
                Рынки котируют {unknown.length} гемов, которых нет в справочнике игры:{' '}
                {unknown.slice(0, 3).join(', ')}
                {unknown.length > 3 && '…'} — вероятно переименованы или добавлены недавно.
              </p>
            )}
            <button
              onClick={() => setShowUnlisted((v) => !v)}
              className="mt-2 text-xs text-info underline-offset-2 hover:underline"
            >
              {showUnlisted ? 'скрыть' : `показать ${unlisted.length} без котировки`}
            </button>
            {showUnlisted && (
              <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-line bg-panel-2 p-2 text-[11px] text-faint">
                {unlisted.join(' · ')}
              </div>
            )}
          </div>
        </div>
      </Panel>

      <Panel
        title="Источники цен"
        subtitle={`стаканов ордеров в памяти: ${books} · обновление раз в 30 минут`}
      >
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full min-w-[800px] text-sm">
            <thead>
              <tr className="border-b border-line-soft text-[11px] tracking-[0.1em] text-faint uppercase">
                <th className="px-5 py-2 text-left font-medium">Источник</th>
                <th className="px-3 py-2 text-left font-medium">Роль</th>
                <th className="px-3 py-2 text-right font-medium">Цен</th>
                <th className="px-3 py-2 text-right font-medium">Доля</th>
                <th className="px-3 py-2 text-left font-medium">Ответ</th>
                <th className="px-5 py-2 text-left font-medium">Вердикт</th>
              </tr>
            </thead>
            <tbody>
              {(sources ?? []).map((s) => {
                const v = verdictFor(s)
                const Icon =
                  v.tone === 'good' ? CircleCheckIcon : v.tone === 'default' ? CircleSlash : CircleAlert
                const meta = roleOf[s.name]
                const hasShare = meta?.share !== false && gems.priced > 0 && s.enabled && !s.error
                const share = hasShare ? Math.round((s.gems / (gems.priced + unknown.length)) * 100) : null
                return (
                  <tr key={s.name} className="border-b border-line-soft/60 last:border-0">
                    <td className="px-5 py-2.5 font-medium">{sourceLabel(s.name)}</td>
                    <td className="px-3 py-2.5 text-xs text-mute">{meta?.role ?? '—'}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{s.gems}</td>
                    <td
                      className="px-3 py-2.5 text-right font-mono text-xs text-faint"
                      title={
                        share === null
                          ? 'считается по другому знаменателю — здесь доля смысла не имеет'
                          : `${s.gems} из ${gems.priced + unknown.length} названий с котировками; включает неизвестные справочнику`
                      }
                    >
                      {share === null ? '—' : `${share}%`}
                    </td>
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap text-faint">
                      <ClockIcon size={12} className="mr-1 inline-block" />
                      {s.at ? ago(s.at) : '—'}
                    </td>
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-2">
                        <Icon
                          size={14}
                          className={
                            v.tone === 'good'
                              ? 'text-accent'
                              : v.tone === 'bad'
                                ? 'text-danger'
                                : v.tone === 'warn'
                                  ? 'text-warn'
                                  : 'text-faint'
                          }
                        />
                        <Badge tone={v.tone}>{v.label}</Badge>
                        <span className="truncate text-[11px] text-faint" title={v.why}>
                          {v.why}
                        </span>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-faint">
          Доля показывает, какую часть всех оценённых гемов покрывает источник; прочерк значит, что
          у строки другой знаменатель. Источник считается устаревшим, если не отвечал больше{' '}
          {STALE_MINUTES} минут при цикле обновления в 30. market.dota2.net обновляется не по этому
          циклу, а каждым обходом каталога.
        </p>
      </Panel>
    </div>
  )
}
