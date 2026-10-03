import './v2.css'
import { Bell, Gem } from 'lucide-react'
import { Btn, Chip, IconBtn, Lamp, Panel, Pill, Skeleton, Src, Tile, Val } from './ui.tsx'

// Новая панель (спецификация v2). Открывается по /?ui=v2 на время миграции;
// на этапе 9 переключатель исчезает, а старая панель удаляется.
//
// Пока — витрина кирпичей (задача 2); каркас приходит задачей 3.
export default function AppV2() {
  return (
    <div className="v2" style={{ padding: 24, display: 'grid', gap: 16, maxWidth: 720 }}>
      <Panel title="Панель" aside="подпись">
        <div style={{ display: 'grid', gap: 8 }}>
          <Tile>плитка</Tile>
          <Tile className="is-on">плитка выбрана</Tile>
        </div>
      </Panel>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Pill>пилюля <b>12</b></Pill>
        <Pill tone="warn">показ — снимок</Pill>
        <Pill tone="stop">данные устарели</Pill>
        <Btn>кнопка</Btn>
        <Btn tone="soft">мягкая</Btn>
        <Btn tone="go">▶ Накрутить</Btn>
        <Btn tone="stop">Остановить</Btn>
        <Btn loading>жду</Btn>
        <IconBtn label="Обзор"><Gem size={16} /></IconBtn>
        <IconBtn label="Тревоги" boxed badge={3}><Bell size={15} /></IconBtn>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip tone="ok" dot>дойдёт</Chip>
        <Chip tone="warn" dot>не дойдёт</Chip>
        <Chip tone="stop" dot>стоп</Chip>
        <Src>инвентарь</Src>
        <Lamp tone="ok" word="накручивает" pulse />
        <Lamp tone="idle" word="стоит" />
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        <Val state="known">51 вещь</Val>
        <Val state="estimated">7 вещей</Val>
        <Val state="stale" when="18 мин назад">$1.66</Val>
        <Val state="none" why="площадка не ответила" />
        <Skeleton h={12} w={180} />
      </div>
    </div>
  )
}
