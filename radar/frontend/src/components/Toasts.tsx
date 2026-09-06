import { BadgeAlertIcon, CircleCheckIcon, XIcon } from './animated'

export type Toast = { id: number; text: string; tone: 'good' | 'bad' }

export function Toasts({ items, onDismiss }: { items: Toast[]; onDismiss: (id: number) => void }) {
  if (items.length === 0) return null
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-60 flex w-80 flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast-in pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm shadow-[0_18px_40px_-20px_rgba(0,0,0,1)] backdrop-blur ${
            t.tone === 'good'
              ? 'border-accent/35 bg-panel/95 text-text'
              : 'border-danger/45 bg-panel/95 text-text'
          }`}
        >
          {t.tone === 'good' ? (
            <CircleCheckIcon size={17} className="mt-0.5 shrink-0 text-accent" />
          ) : (
            <BadgeAlertIcon size={17} className="mt-0.5 shrink-0 text-danger" />
          )}
          <span className="flex-1 leading-snug">{t.text}</span>
          <button
            onClick={() => onDismiss(t.id)}
            className="shrink-0 text-faint transition-colors hover:text-text"
            aria-label="Закрыть"
          >
            <XIcon size={15} />
          </button>
        </div>
      ))}
    </div>
  )
}
