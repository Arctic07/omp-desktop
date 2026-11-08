/**
 * The open-in-app state: what this machine can launch, which one the split button remembers, and
 * each application's own icon.
 *
 * The catalogue is the desktop's answer and is read once per application run; a failure leaves the
 * button off the frame rather than showing an empty menu. The remembered id is the reader's own
 * (localStorage), but it only counts while that id is still installed — an uninstalled editor must
 * not leave the split button pointing at nothing.
 *
 * Icons are warmed while the window idles, not on the first menu open: one extraction is a host
 * process (a PowerShell run on Windows), so asking for every row when the menu opens paints some
 * rows with the generic glyph and lets the artwork land one by one. One application at a time, into
 * a cache that lives as long as this page does.
 */

import { openInAppApps, openInAppIcon } from '@/api/open-in-app'
import { createStore } from '@/state/store'

export interface OpenInAppState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Installed catalogue ids, as the desktop resolved them. */
  apps: string[]
  /** The reader's last choice, before it is checked against `apps`. */
  rememberedId: string | null
  /**
   * Data URLs by catalogue id. `''` marks "asked, and this machine serves no artwork for it", so a
   * row keeps its generic glyph without asking again; a missing key is simply not asked yet.
   */
  icons: Record<string, string>
}

const STORAGE_KEY = 'omp-desktop.open-in-app'

const EMPTY: OpenInAppState = { status: 'idle', apps: [], rememberedId: null, icons: {} }

export const openInAppStore = createStore<OpenInAppState>(EMPTY)

/** How long the warm-up waits for an idle window before running anyway. */
const WARM_TIMEOUT_MS = 5000

/** Whether this page has already scheduled the one icon warm-up it performs. */
let warming = false

/** Extractions in flight by catalogue id, so a row and the warm-up share one host process. */
const asking = new Map<string, Promise<void>>()

function readRememberedId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeRememberedId(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // A choice that cannot be stored still applies to this session.
  }
}

let loading: Promise<void> | null = null

/** How many times a failed catalogue read is retried before the button stays off the frame. */
const LOAD_ATTEMPTS = 3
const LOAD_RETRY_MS = 1200

/** Read the catalogue once; later callers join the same request. */
export function loadOpenInApps(): Promise<void> {
  const current = openInAppStore.get()
  if (current.status === 'ready') return Promise.resolve()
  if (loading !== null) return loading
  openInAppStore.set((state) => ({ ...state, status: 'loading', rememberedId: readRememberedId() }))
  loading = (async () => {
    let lastError: unknown
    for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt += 1) {
      try {
        const apps = await openInAppApps()
        openInAppStore.set((state) => ({ ...state, status: 'ready', apps }))
        warmIcons(apps)
        return
      } catch (error) {
        lastError = error
        // The first call happens while the shell is still coming up. A refusal there is not the
        // machine's final answer, so it gets another two tries before the button gives up.
        if (attempt < LOAD_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, LOAD_RETRY_MS))
        }
      }
    }
    console.error('the open-in-app catalogue could not be read', lastError)
    openInAppStore.set((state) => ({ ...state, status: 'error', apps: [] }))
  })().finally(() => {
    loading = null
  })
  return loading
}

export function rememberOpenInApp(id: string): void {
  writeRememberedId(id)
  openInAppStore.set((state) => ({ ...state, rememberedId: id }))
}

/**
 * One application's icon, requested on the first ask; every later ask answers from the cache or
 * joins the run already going. A refusal is cached as `''` and is not retried: an icon describes an
 * installed binary, which does not change under a running application.
 */
export function ensureOpenInAppIcon(id: string): Promise<void> {
  if (openInAppStore.get().icons[id] !== undefined) return Promise.resolve()
  const inFlight = asking.get(id)
  if (inFlight !== undefined) return inFlight
  const run = openInAppIcon(id)
    .then((dataUrl) => putIcon(id, dataUrl))
    .catch(() => putIcon(id, ''))
    .finally(() => {
      asking.delete(id)
    })
  asking.set(id, run)
  return run
}

function putIcon(id: string, dataUrl: string): void {
  openInAppStore.set((state) => ({ ...state, icons: { ...state.icons, [id]: dataUrl } }))
}

/**
 * Extract every installed application's icon while the window idles, one at a time: each run is a
 * host process, and a burst of them at menu-open time is what makes the rows land unevenly.
 */
function warmIcons(apps: readonly string[]): void {
  if (warming) return
  warming = true
  const run = (): void => {
    void (async () => {
      for (const id of apps) await ensureOpenInAppIcon(id)
    })()
  }
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: WARM_TIMEOUT_MS })
  } else {
    window.setTimeout(run, WARM_TIMEOUT_MS)
  }
}
