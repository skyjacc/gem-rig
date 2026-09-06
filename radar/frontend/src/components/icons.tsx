/**
 * Custom SVG marks for concepts Lucide has no icon for: the radar sweep, the
 * socket types Valve renders, and the hammer that pulls a gem out of an item.
 * Everything is currentColor so it inherits from the surrounding text.
 */

import { useState } from 'react'

type IconProps = { size?: number; className?: string; style?: React.CSSProperties }

export function RadarSweep({ size = 22, className = '' }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9.2" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.2" />
      <circle cx="12" cy="12" r="5.6" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.2" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <g className="sweep-spin">
        <path d="M12 12 L12 2.8 A9.2 9.2 0 0 1 20.6 9.1 Z" fill="url(#sweep-fade)" />
      </g>
      <defs>
        <linearGradient id="sweep-fade" x1="12" y1="12" x2="21" y2="6" gradientUnits="userSpaceOnUse">
          <stop stopColor="currentColor" stopOpacity="0.55" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}

/** The faceted gem used for a filled kinetic socket. */
export function GemMark({ size = 16, className = '', style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path
        d="M7.4 3h9.2l4.1 6.1L12 21.2 3.3 9.1 7.4 3Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M3.3 9.1h17.4" stroke="currentColor" strokeWidth="1.2" strokeOpacity="0.65" />
      <path d="M9.6 9.1 12 21.2l2.4-12.1L12 3l-2.4 6.1Z" stroke="currentColor" strokeWidth="1.2" strokeOpacity="0.65" />
    </svg>
  )
}

/** An empty socket: the same silhouette, hollow and dimmed. */
export function EmptySocketMark({ size = 16, className = '' }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M7.4 3h9.2l4.1 6.1L12 21.2 3.3 9.1 7.4 3Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeDasharray="2.6 2.4"
        strokeOpacity="0.8"
      />
    </svg>
  )
}

/** Artificer's Hammer — the tool that extracts a gem. */
export function HammerMark({ size = 16, className = '' }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M14.6 3.4 20.6 9.4l-2.5 2.5-1.6-1.6-6.7 6.7a2 2 0 0 1-2.9 0l-.9-.9a2 2 0 0 1 0-2.9l6.7-6.7-1.6-1.6 2.5-2.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Rouble mark, used on money statistics. */
export function RoubleMark({ size = 16, className = '' }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M8 20V4h4.9a4.1 4.1 0 0 1 0 8.2H8M6 15.4h7.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Valve renders each socket type with its own sprite and the game colours them
 * consistently. Matching those colours means a kinetic gem reads as a kinetic
 * gem at a glance, instead of every socket being the same shade of green.
 */
export const SOCKET_COLORS: Record<string, string> = {
  kinetic: '#2ee6a8',
  spectator: '#4cc2ff',
  prismatic: '#a78bfa',
  ethereal: '#f5a524',
  empty: '#55627a',
  other: '#7f8da3',
}

export function socketColor(kind: string): string {
  return SOCKET_COLORS[kind] ?? SOCKET_COLORS.other
}

/** Valve's own socket sprite, with our drawn mark as the fallback. */
export function SocketIcon({
  kind,
  iconURL,
  size = 18,
  className = '',
}: {
  kind: string
  iconURL?: string
  size?: number
  className?: string
}) {
  const [failedURL, setFailedURL] = useState<string | undefined>()
  if (iconURL && failedURL !== iconURL) {
    return (
      <img
        src={iconURL}
        onError={() => setFailedURL(iconURL)}
        alt=""
        loading="lazy"
        width={size * 1.5}
        height={size}
        className={`shrink-0 object-contain ${className}`}
      />
    )
  }
  const color = socketColor(kind)
  if (kind === 'empty') {
    return <EmptySocketMark size={size} className={className} />
  }
  return <GemMark size={size} className={className} style={{ color }} />
}

const RARITY_COLORS: Record<string, string> = {
  common: 'var(--color-rarity-common)',
  uncommon: 'var(--color-rarity-uncommon)',
  rare: 'var(--color-rarity-rare)',
  mythical: 'var(--color-rarity-mythical)',
  legendary: 'var(--color-rarity-legendary)',
  immortal: 'var(--color-rarity-immortal)',
  arcana: 'var(--color-rarity-arcana)',
}

/**
 * Resolves the colour Dota uses for a rarity. The market reports rarity in
 * whichever language the row was written in, so a hex from `name_color`
 * (which the market always sends) is the reliable fallback.
 */
export function rarityColor(rarity: string, nameColor: string): string {
  const known = RARITY_COLORS[rarity?.trim().toLowerCase()]
  if (known) return known
  if (/^[0-9a-fA-F]{6}$/.test(nameColor ?? '')) return `#${nameColor}`
  return 'var(--color-line)'
}
