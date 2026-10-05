// Общие правила окна «Настроить» (план 9, решение 1): те же 20 полей, что
// в прежнем parts/Tune.tsx, — подписи, единицы и масштабы перенесены как есть;
// группы — §5.7. Отдельно от компонента — чистые данные и функции.

export type Rule = { path: string; label: string; hint: string; unit?: string; scale?: number }

// Те же 20 полей, подписи, единицы и масштабы, что в прежнем окне; группы — §5.7.
export const GROUPS: { title: string; rules: Rule[]; more?: boolean }[] = [
  {
    title: 'Цель и деньги',
    rules: [
      { path: 'goal', label: 'цель счётчика', hint: 'сколько просмотров делает вещь товаром' },
      { path: 'sellPrice', label: 'цена готовой вещи', hint: 'за сколько уходит вещь со счётчиком — от этого числа считается вся выгода в скупке', unit: '$' },
      { path: 'perGem', label: 'сколько брать одного гема', hint: 'потолок на позицию в «собрать лучшее»: двадцать шестая копия продаётся не лучше двадцать пятой' },
      { path: 'priceTolerance', label: 'допуск по цене', hint: 'на сколько цена может вырасти между планом и покупкой; ноль — только по своей или дешевле', unit: '%', scale: 0.01 },
      { path: 'purchaseCap', label: 'потолок закупки', hint: 'больше этой суммы за один запуск не потратится, в валюте счёта площадки; пока ноль — закупка не начнётся' },
    ],
  },
  {
    title: 'Работник',
    rules: [
      { path: 'tick', label: 'как часто проверять', hint: 'через сколько заглядывать в инвентарь и состояние отправщика', unit: 'с', scale: 1_000 },
      { path: 'invTtl', label: 'когда перечитывать Steam', hint: 'через сколько запрашивать инвентарь заново', unit: 'с', scale: 1_000 },
      { path: 'silentLimit', label: 'сколько ждать молча', hint: 'после этого отправщик перезапускается; на растяжке предел растёт вместе с паузой', unit: 'с', scale: 1_000 },
      { path: 'startLimit', label: 'сколько ждать первой отправки', hint: 'у отправщика своя лестница отходов при обрывах связи — 15, 30, 60, 120 секунд', unit: 'с', scale: 1_000 },
      { path: 'maxFailures', label: 'сколько падений терпеть', hint: 'после этого встать и сказать почему' },
      { path: 'invStale', label: 'когда счётчикам больше не верить', hint: 'при работе с потолком: старее этого — работник останавливается, чтобы не жечь вслепую', unit: 'мин', scale: 60_000 },
    ],
  },
  {
    title: 'Темп',
    rules: [
      { path: 'pace.floor', label: 'пол паузы', hint: 'ниже не опускаться никогда; отправщик значение меньше 500 мс не принимает вовсе', unit: 'мс' },
      { path: 'pace.ceil', label: 'потолок паузы', hint: 'выше не подниматься', unit: 'мс' },
      { path: 'pace.enough', label: 'сколько отправок для замера', hint: 'по меньшему числу судить о темпе нельзя' },
      { path: 'pace.clean', label: 'сколько тишины терпеть', hint: 'доля отправок без ответа, которая ещё считается нормой', unit: '%', scale: 0.01 },
      { path: 'pace.down', label: 'шаг ускорения', hint: 'на сколько умножается пауза, когда GC отвечает на каждую отправку' },
      { path: 'pace.up', label: 'шаг отхода', hint: 'на сколько умножается пауза, когда появились молчания' },
    ],
  },
  {
    title: 'Остальное',
    more: true,
    rules: [
      { path: 'spread.band', label: 'насколько разные числа', hint: 'на сколько процентов расходятся партии разброса', unit: '%', scale: 0.01 },
      { path: 'spread.jitter', label: 'дрожание', hint: 'случайная добавка поверх ровного шага, чтобы партии не легли по линейке', unit: '%', scale: 0.01 },
      { path: 'treeTop', label: 'турниров в дереве', hint: 'сколько самых больших показывать под гемом' },
    ],
  },
]

export const get = (o: any, p: string) => p.split('.').reduce((a, k) => a?.[k], o)
// Значения нет в настройках сервера — пусто («нет данных»), а не NaN и не ноль.
export const shown = (r: Rule, raw: number) => Number.isFinite(raw) ? String(Math.round((r.scale ? raw / r.scale : raw) * 1_000) / 1_000) : ''

// Правка → одно тело запроса: { goal, pace: { floor, up } … }.
export function patchOf(draft: Record<string, string>, rules: Rule[]): { patch: Record<string, any>; bad: string[] } {
  const patch: Record<string, any> = {}
  const bad: string[] = []
  for (const r of rules) {
    const raw = draft[r.path]
    if (raw === undefined) continue
    const n = Number(raw.replace(/\s/g, '').replace(',', '.'))
    if (raw.trim() === '' || !Number.isFinite(n)) { bad.push(r.label); continue }
    const v = r.scale ? n * r.scale : n
    const [a, b] = r.path.split('.')
    if (b) patch[a] = { ...(patch[a] ?? {}), [b]: v }
    else patch[a] = v
  }
  return { patch, bad }
}

