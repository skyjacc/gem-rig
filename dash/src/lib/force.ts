// Раскладка сети.
//
// Своя, а не библиотека: нужно ровно три силы, а d3-force тянет за собой
// свой жизненный цикл и вдвое больше кода. Здесь шестьдесят строк,
// которые можно прочитать целиком.
//
// Силы:
//   притяжение по ребру   чем больше общих матчей, тем ближе узлы
//   отталкивание          все ото всех, чтобы не слипались
//   к центру              слабое, чтобы граф не уползал
//
// Шаг затухает: сначала узлы разлетаются быстро, потом замирают.
// Схваченный мышью узел силам не подчиняется — он там, где его держат.

export type Sim = {
  key: string
  x: number
  y: number
  vx: number
  vy: number
  r: number
  fixed: boolean
}

export type Link = { a: string; b: string; w: number }

const REPEL = 5200
const CENTER = 0.012
const DAMP = 0.86

export function step(nodes: Sim[], links: Link[], alpha: number, w: number, h: number) {
  const by = new Map(nodes.map(n => [n.key, n]))
  const cx = w / 2
  const cy = h / 2

  // отталкивание
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let d2 = dx * dx + dy * dy
      if (d2 < 1) { dx = (i - j) * 0.5 + 0.1; dy = 0.1; d2 = dx * dx + dy * dy }
      const d = Math.sqrt(d2)
      const f = (REPEL * alpha) / d2
      const ux = dx / d
      const uy = dy / d
      a.vx -= ux * f
      a.vy -= uy * f
      b.vx += ux * f
      b.vy += uy * f
    }
  }

  // притяжение по рёбрам: длина покоя тем меньше, чем толще связь
  for (const l of links) {
    const a = by.get(l.a)
    const b = by.get(l.b)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.hypot(dx, dy) || 1
    const rest = 150 + 240 * (1 - l.w)
    const f = ((d - rest) * 0.012 * alpha) * (0.35 + l.w)
    const ux = dx / d
    const uy = dy / d
    a.vx += ux * f
    a.vy += uy * f
    b.vx -= ux * f
    b.vy -= uy * f
  }

  for (const n of nodes) {
    if (n.fixed) { n.vx = 0; n.vy = 0; continue }
    n.vx += (cx - n.x) * CENTER * alpha
    n.vy += (cy - n.y) * CENTER * alpha
    n.vx *= DAMP
    n.vy *= DAMP
    n.x += n.vx
    n.y += n.vy
  }
}

// Стартовая раскладка: кольцо по убыванию веса. Из кольца силы расходятся
// предсказуемо, из случая — по-разному каждый раз.
export function seed(keys: string[], w: number, h: number): Sim[] {
  const R = Math.min(w, h) * 0.32
  return keys.map((key, i) => {
    const a = -Math.PI / 2 + (i / keys.length) * Math.PI * 2
    return {
      key,
      x: w / 2 + Math.cos(a) * R,
      y: h / 2 + Math.sin(a) * R,
      vx: 0, vy: 0, r: 6, fixed: false,
    }
  })
}
