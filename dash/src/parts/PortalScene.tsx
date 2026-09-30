import { useMemo } from 'react'
import source from '../vendor/threeui/portal-field.html.js'

// Фон экрана входа — сцена Portal Field из ThreeUI (MIT, src/vendor/threeui).
//
// В оригинале это целая страница-герой: кольцо портала стоит в точке
// (0,5·H; 0,5·H) от левого края при радиусе 0,6·H, то есть нарочно уходит
// за левый край, а вокруг — текст и кнопки героя. Для входа две правки:
//
//   центр кольца — в центр экрана при любой пропорции; раньше на 1920×1080
//   кольцо уезжало в левый угол, а сдвиг всей сцены оставлял видимый обрез;
//
//   от страницы остаётся только слой с кольцом (#webgl-container), всё
//   остальное скрыто.
//
// Сцена в iframe без allow-same-origin: её скрипты не видят панель.

const ORIGINAL_CENTER = 'vec2 center = vec2(0.5, 0.5);'
// Центр — в центр экрана. Радиус задан в долях высоты, и на телефоне в
// портрете кольцо уходило за края целиком: k сжимает его на узких экранах
// (на обычных k = 1, кольцо прежнее).
const TRUE_CENTER =
  'vec2 center = vec2(0.5 * u_resolution.x / u_resolution.y, 0.5);\n' +
  '                float k = min(1.0, u_resolution.x / u_resolution.y * 1.25);'
const RADII: [string, string][] = [
  ['sdArc(st, center, 0.6,', 'sdArc(st, center, 0.6 * k,'],
  ['sdArc(st, center, 0.65,', 'sdArc(st, center, 0.65 * k,'],
]

const ONLY_RING = `<style>
  body > *:not(#webgl-container):not(script) { display: none !important; }
  #webgl-container { opacity: 1 !important; }
</style>`

export function PortalScene({ className }: { className?: string }) {
  const doc = useMemo(() => {
    if (!source.includes(ORIGINAL_CENTER)) console.warn('PortalScene: строка центра в сцене изменилась — кольцо может стоять не по центру')
    let out = source.replace(ORIGINAL_CENTER, TRUE_CENTER).replace('</head>', ONLY_RING + '</head>')
    for (const [from, to] of RADII) out = out.replace(from, to)
    return out
  }, [])
  return (
    <iframe
      className={className}
      title="Портал"
      srcDoc={doc}
      sandbox="allow-scripts"
      aria-hidden="true"
      tabIndex={-1}
    />
  )
}
