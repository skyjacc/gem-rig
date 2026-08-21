// Набор, в котором лежит предмет.
//
// Steam кладёт это в описание, и цветом отличает название от состава:
//
//   Used By: Chen
//   Wings of Obelis            #9da1a9  — название набора
//   Wings of Obelis Shoulders  #6c7075  — часть
//   Wings of Obelis Arms       #6c7075
//
// Разбирать по общему куску имени нельзя: у «Nether Beetle» и «Offhand
// Nether Wand» общего начала нет вовсе, а «Styles:» покрашено тем же цветом,
// что и название. Поэтому правило простое: название — последняя строка
// светлого цвета перед идущими подряд строками тёмного.

export type Desc = { value?: string; color?: string }
export type ItemSet = { name: string; pieces: string[] }

const NAME = '9da1a9'
const PIECE = '6c7075'

const clean = (v: string) =>
  String(v ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim()

export function parseSet(descriptions: Desc[]): ItemSet {
  if (!Array.isArray(descriptions)) return { name: '', pieces: [] }

  const rows = descriptions
    .map(d => ({ text: clean(d?.value ?? ''), color: String(d?.color ?? '').toLowerCase() }))
    .filter(r => r.text)

  const pieces: string[] = []
  let name = ''
  let lastName = ''

  for (const r of rows) {
    if (r.color === NAME) {
      // «Styles:» и подобное — заголовки, а не имена наборов.
      if (!r.text.endsWith(':')) lastName = r.text
      continue
    }
    if (r.color === PIECE) {
      if (!pieces.length) name = lastName
      pieces.push(r.text)
      continue
    }
  }

  return { name: pieces.length ? name : '', pieces }
}

// Приставки качества, которые Steam добавляет к имени предмета, но не
// к названию части в составе набора. Из-за них «Inscribed Primeval Staff»
// не узнавался в «Primeval Staff», и три полных набора числились неполными.
const QUALITY = [
  'inscribed', 'genuine', 'autographed', 'elder', 'frozen', 'corrupted',
  'heroic', 'cursed', 'exalted', 'auspicious', 'unusual', 'infused',
  'legacy', 'ascendant', 'favored', 'holiday',
]

// Ключ, по которому часть набора узнаётся независимо от качества.
export function pieceKey(name: string): string {
  let s = String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  for (const q of QUALITY) {
    if (s.startsWith(q + ' ')) { s = s.slice(q.length + 1); break }
  }
  return s
}
