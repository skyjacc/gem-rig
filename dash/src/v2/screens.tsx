// Шесть экранов новой панели — пока заглушки. Каждый честно говорит, что
// на нём будет и на каком этапе он появится; числа-заглушки не рисуются.
// Тексты — из спецификации §5.1–§5.6, одной-двумя строками.

import { ExternalLink } from 'lucide-react'
import type { ScreenId } from './Rail.tsx'
import { Chip, Panel } from './ui.tsx'

type Info = { why: string; what: string; side: string; sideWhat: string; stage: string }

const INFO: Record<ScreenId, Info> = {
  overview: {
    why: 'Ежедневный экран: работает ли, что с гемами, что требует внимания.',
    what: 'Холст «аккаунт → гемы → вещи» и режим «сеть матчей», тревоги с кнопками действий.',
    side: 'Инспектор',
    sideWhat: 'Выбранный гем: прогресс к цели, факты, его вещи.',
    stage: '2.1',
  },
  inventory: {
    why: 'Что лежит, что дойдёт до цели, что можно продавать.',
    what: 'Связки гемов, стопки одинаковых вещей, фильтры, отсеки по гемам.',
    side: 'Карточка вещи',
    sideWhat: 'Шкала счётчика с потолком команды, копии по аккаунтам.',
    stage: '2.2',
  },
  buy: {
    why: 'Запустить робота закупки на market.dota2.net и видеть, как он работает.',
    what: 'Конвейер «план → покупка → приход», лента покупок, план с доп. временем накрутки.',
    side: 'Корзина',
    sideWhat: 'На какой аккаунт закупка, бюджет, корзина и запуск.',
    stage: '2.3',
  },
  sales: {
    why: 'Сколько реальных денег принесла работа.',
    what: 'Путь денег от гемов до выплаты, кошелёк Steam по дням, ключи Mann Co. и их освобождение.',
    side: 'Куда продать ключи',
    sideWhat: 'Площадки по тому, сколько придёт на руки.',
    stage: '2.6',
  },
  accounts: {
    why: 'У каждого аккаунта свои сожжённые матчи, сессия, ключ и настройки.',
    what: 'Карточки аккаунтов с проверками, настройки аккаунта, привязка по QR, отвязка.',
    side: 'Работник',
    sideWhat: 'Процесс, падения подряд, очередь, последнее решение.',
    stage: '2.4',
  },
  journal: {
    why: 'Что уйдёт, что ушло и почему.',
    what: 'Отправки, очередь, израсходовано, приход, решения.',
    side: 'Отправка',
    sideWhat: 'Выбранная отправка подробно и как читать ответы.',
    stage: '2.5',
  },
}

// Старая панель — тот же адрес без ?ui=v2.
const oldPanel = () => location.pathname

export function Screen({ id, title }: { id: ScreenId; title: string }) {
  const i = INFO[id]
  return (
    <div className="v2-screen">
      <h1 className="v2-h1">{title}</h1>
      <p className="v2-lead">{i.why}</p>
      <Panel title="Что здесь будет" aside={<Chip>этап {i.stage}</Chip>}>
        <p className="v2-text">{i.what}</p>
        <p className="v2-hint">Пока экран переезжает, эти данные — в старой панели.</p>
        <a className="v2-btn is-soft v2-link" href={oldPanel()}>
          <ExternalLink size={14} aria-hidden="true" />
          открыть в старой панели
        </a>
      </Panel>
    </div>
  )
}

export function ScreenSide({ id }: { id: ScreenId }) {
  const i = INFO[id]
  return (
    <Panel title={i.side} aside={<Chip>этап {i.stage}</Chip>}>
      <p className="v2-text">{i.sideWhat}</p>
    </Panel>
  )
}
