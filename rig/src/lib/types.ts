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
  left: number | null
  spent: number | null
  supplyKind: 'measured' | 'estimated' | 'empty'
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
  supplyKind: 'measured' | 'estimated' | 'empty'
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

export type AutopilotState = {
  enabled: boolean
  delay: number
  goal: number
  queueLength: number
  action: 'idle' | 'start' | 'restart' | 'rebuild' | 'watch' | 'halt'
  why: string
  lastTick: number
  rebuiltAt: number
  failures: number
  objects: number
  gems: { gem: string; objects: number }[]
  log: { ts: number; action: string; why: string }[]
  etaMinutes: number
}

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
  autopilot: AutopilotState
  confirmed: { ts: number; match_id: string; league_id: string; bytes: number } | null
  rate: number
  files: MatchFile[]
  inv: { error: string | null; age: number | null; items: number }
  burned: number
  watched: number
  keys: { opendota: boolean; steam: boolean }
}
