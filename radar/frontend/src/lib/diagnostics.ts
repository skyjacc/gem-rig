/**
 * Client-side recorder.
 *
 * The backend journal explains what the scanner did. It cannot explain why the
 * interface looked wrong: a thrown render, a rejected promise, a request that
 * failed on the way to the panel, or a layout that broke at one window size.
 * Those facts only exist in the browser, so they are collected here and shipped
 * in the same diagnostic bundle, next to the server's own record.
 *
 * Nothing leaves the machine on its own. The buffer lives in memory and is
 * written to a file only when the operator asks for one.
 */

export type ClientEvent = {
  at: string
  kind: 'error' | 'rejection' | 'request' | 'action' | 'resource'
  message: string
  detail?: Record<string, unknown>
}

const LIMIT = 400
const events: ClientEvent[] = []

/** A session id ties one browser tab's events to the server events beside them. */
export const sessionID = `ui-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`

export const buildInfo = {
  version: __APP_VERSION__,
  builtAt: __BUILD_TIME__,
  mode: import.meta.env.MODE,
}

function push(e: ClientEvent) {
  events.push(e)
  if (events.length > LIMIT) events.splice(0, events.length - LIMIT)
}

function stamp(): string {
  return new Date().toISOString()
}

/** Record something the operator did, so a report says what led to the state. */
export function recordAction(message: string, detail?: Record<string, unknown>) {
  push({ at: stamp(), kind: 'action', message, detail })
}

/** Record an API call that did not come back clean. */
export function recordRequest(url: string, status: number | null, message: string, ms: number) {
  push({
    at: stamp(),
    kind: 'request',
    message: `${status ?? 'network'} ${url} — ${message}`,
    detail: { url, status, ms: Math.round(ms) },
  })
}

let installed = false

/** Attach the global listeners. Safe to call more than once. */
export function installDiagnostics() {
  if (installed) return
  installed = true

  window.addEventListener('error', (e) => {
    // A failed image or stylesheet arrives here too, with no `error` object.
    // It is worth recording: a missing socket sprite is exactly the kind of
    // "why does it look wrong" the operator cannot otherwise see.
    const target = e.target as HTMLElement | null
    if (target && target !== (window as unknown as HTMLElement) && 'src' in (target as HTMLImageElement)) {
      push({
        at: stamp(),
        kind: 'resource',
        message: `не загрузился ${target.tagName.toLowerCase()}`,
        detail: { src: (target as HTMLImageElement).src },
      })
      return
    }
    push({
      at: stamp(),
      kind: 'error',
      message: e.message || 'неизвестная ошибка',
      detail: { source: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack },
    })
  }, true)

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason
    push({
      at: stamp(),
      kind: 'rejection',
      message: reason instanceof Error ? reason.message : String(reason),
      detail: { stack: reason instanceof Error ? reason.stack : undefined },
    })
  })
}

/** What the window looks like right now — layout bugs are size-dependent. */
function viewport() {
  return {
    inner: `${window.innerWidth}x${window.innerHeight}`,
    outer: `${window.outerWidth}x${window.outerHeight}`,
    dpr: window.devicePixelRatio,
    zoom: Math.round((window.outerWidth / window.innerWidth) * 100) / 100,
    colorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    language: navigator.language,
    userAgent: navigator.userAgent,
  }
}

/** Everything the browser knows, ready to sit beside the server's journal. */
export function clientReport(ui: Record<string, unknown>) {
  return {
    session: sessionID,
    collected_at: stamp(),
    build: buildInfo,
    viewport: viewport(),
    ui,
    counts: events.reduce<Record<string, number>>((acc, e) => {
      acc[e.kind] = (acc[e.kind] ?? 0) + 1
      return acc
    }, {}),
    events: events.slice(),
  }
}
