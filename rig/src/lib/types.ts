export type Kind = 'team' | 'player' | 'league' | 'studio' | 'unknown' | null

export type Gem = {
  gem: string
  items: number
  equipped: number
  min: number | null
  max: number
  icon: string
  heroes: string
  kind: Kind
  entityId: number | null
  entityName: string | null
  supply: number | null
}

export type CatalogRow = {
  name: string
  short: string
  price: string
  listings: number
  icon: string
  market: string
  kind: Kind
  entityId: number | null
  entityName: string | null
  supply: number | null
  per1000: number | null
  ownedItems: number
  ownedValue: number | null
}

export type Bundle = {
  def: number
  name: string
  partner: string
  hero: string
  price_cents: number | null
  created: string
  pieces: number
}

export type SendEvent = {
  ts: number
  n: number | null
  total: number | null
  match_id: string
  league_id: string
  result: 'update' | 'dup' | 'silent'
  bytes: number
}

export type SenderState = {
  running: boolean
  pid: number | null
  file: string | null
  delay: number | null
  startedAt: number | null
  exit: string | null
  lines: string[]
}

export type MatchFile = { name: string; rows: number; mtime: number }

export type State = {
  ts: number
  steamid: string
  delay: number | null
  current: { n: number; total: number; updates: number; responses: number; match: string; league: string; delay: number } | null
  events: SendEvent[]
  seam: { gem: string; entity: string; total: number; spent: number; left: number; items: number } | null
  mine: Gem[]
  catalog: CatalogRow[]
  bundles: Bundle[]
  chart: { stamps: number[]; series: { gem: string; points: (number | null)[] }[] }
  sender: SenderState
  files: MatchFile[]
  inv: { error: string | null; age: number | null; items: number }
  burned: number
  watched: number
  keys: { opendota: boolean; steam: boolean }
}
