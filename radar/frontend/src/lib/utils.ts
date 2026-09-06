/**
 * Class-name joiner used by the vendored animated icons.
 *
 * The upstream components import `cn` from `@/lib/utils`, which in a shadcn
 * project is clsx + tailwind-merge. Nothing here needs conflict resolution
 * between Tailwind classes, so joining the truthy values keeps two more
 * dependencies out of the bundle.
 */
export type ClassValue = string | number | null | undefined | false

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ')
}
