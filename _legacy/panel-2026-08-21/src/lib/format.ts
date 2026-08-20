export const nf = (n: number | null | undefined) =>
  n == null ? '—' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

export const dur = (ms: number | null | undefined) => {
  if (!ms || ms < 0) return '—'
  const m = Math.round(ms / 60000)
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`
}

export const clock = (ts: number) => new Date(ts).toLocaleTimeString('ru-RU')

export const gemIcon = (icon: string) =>
  icon ? `https://community.cloudflare.steamstatic.com/economy/image/${icon}/62fx62f` : ''

export const heroIcon = (hero: string) =>
  hero ? `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/icons/${hero}.png` : ''

export const KIND_LABEL: Record<string, string> = {
  team: 'команда', player: 'игрок', league: 'лига', studio: 'студия', unknown: '?',
}

export const KIND_CLASS: Record<string, string> = {
  team: 'text-malachite border-malachite/40',
  player: 'text-vein border-vein/40',
  league: 'text-oxide border-oxide/40',
  studio: 'text-dry border-dry/40',
}

export const reduceMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
