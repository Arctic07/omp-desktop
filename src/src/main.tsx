import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from 'next-themes'

import App from '@/App'
import { mainWindowReady } from '@/api/app'
import { installClientErrorReporting } from '@/state/client-errors'
import { LanguageProvider } from '@/lib/i18n'
import { startupThemeGet, startupThemeSet } from '@/api/preferences'
import { startAppSettings } from '@/state/app-settings'
import { startPluginTheme } from '@/state/plugin-theme'
import { themeToAdopt, THEME_STORAGE_KEY } from '@/state/startup-theme'
import { ensureWorkspacesLoaded } from '@/state/workspace-store'
import '@/index.css'

// Before anything renders: an uncaught throw or an unhandled rejection during start-up is exactly
// the failure a report is about, and a listener registered after the first render would miss it.
// Every line it writes goes to `app.log` through `logs_write`.
installClientErrorReporting()

// The window is created hidden and this document is the only thing that may raise it: shown before
// the webview has painted, the window carries WebView2's own white for a frame, which is the flash
// every start opened on. By the time a module runs, the start-up shell in `index.html` is parsed and
// styled, so the frame the window appears on is the shell - not an empty page.
mainWindowReady()

// The first workspace read starts here rather than in the rail's mount effect: the shell's
// hand-over waits for it below, and the rail joins the same promise when it mounts.
const workspacesReady = ensureWorkspacesLoaded()

// Both put a stored choice on the document before anything renders: the reading size, the
// conversation's density and reduced motion as attributes and one custom property, and a plugin's
// theme as the tokens it contributes. Doing it here rather than in an effect is what keeps a start
// from painting the default palette first and correcting itself afterwards.
startAppSettings()
startPluginTheme()

/*
 * The theme a start draws with is the shell's record, not this document's storage.
 *
 * The settings page records the choice in `app.sqlite` through `startup_theme_set` before applying
 * it, and that record is what the shell paints the window with before this document exists. The
 * storage here is its cache: a WebView2 profile directory the application does not own, which can be
 * evicted, and whose storage database is recovered by dropping every write after a damaged record -
 * measured on 2026-11-04, where the log's framing broke at sequence 323 and the user's `light` write
 * (sequence 324) was discarded on every open afterwards. Reading the cache first is what let a
 * recovered `dark` stand in for a choice that had been `light`, twice over: it dressed the app in the
 * wrong palette, and the mount-time push then recorded `dark` over the choice as well.
 *
 * It has to run before the provider mounts: `next-themes` reads the storage once, in the state it
 * starts with, so writing the adopted value afterwards would leave the provider on the default for
 * the rest of the session. A shell that does not answer (a plain browser page, a host that is not
 * there) ends the wait at the ceiling below and the cache or the default applies as before.
 */
const THEME_READ_CEILING_MS = 2000
// A theme must not hold the first frame of a start whose shell will not answer, so the read has a
// ceiling. `Promise.withResolvers` is what this would otherwise be written with, and the app's
// library is ES2023 (`src/tsconfig.app.json`), which does not declare it.
let readCeiling: number | undefined
const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
const recordedTheme = await Promise.race([
  startupThemeGet().catch(() => null),
  new Promise<null>((resolve) => {
    readCeiling = window.setTimeout(() => resolve(null), THEME_READ_CEILING_MS)
  }),
])
window.clearTimeout(readCeiling)
const adoptedTheme = themeToAdopt(storedTheme, recordedTheme)
// A record that does not exist yet is the only one a start may write: every other change is the
// settings page's to record, and a start that recorded its own value could overwrite the user's.
if (recordedTheme === null && adoptedTheme !== null) void startupThemeSet(adoptedTheme)
if (adoptedTheme !== null && adoptedTheme !== storedTheme) {
  // The same two writes `index.html` makes from a stored value, so the frames before the provider
  // mounts are already the adopted palette rather than the one the cache had gone stale on.
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, adoptedTheme)
  } catch {
    // A storage that refuses the write still gets the palette below; only the next start loses it,
    // and that start asks the shell again.
  }
  const resolved =
    adoptedTheme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : adoptedTheme
  document.documentElement.classList.remove('light', 'dark')
  document.documentElement.classList.add(resolved)
  document.documentElement.setAttribute('data-omp-startup-theme', resolved)
}

/*
 * The entrance's paint gate: `index.html`'s `#omp-startup` paints nothing until this attribute is
 * set, so no frame of a start is drawn in a palette nobody chose.
 *
 * The window itself is painted from the record in `app.sqlite` before any document exists, while the
 * shell's own answer comes from the webview's storage - a profile directory this application does
 * not own, which can hold a stale value or nothing at all. Letting the entrance paint from that
 * answer is what put the wrong palette on screen for the frames before this adoption: the mark in
 * the light palette is a black plate with white strokes, and on a window the record had painted dark
 * it reads as a white bar under the loading panel (reader report, 2026-11-05).
 *
 * This runs after the palette class and the plugin theme are applied, and before the provider
 * mounts, so the entrance animates in the palette the application is about to paint. The shell's own
 * ceiling (2.5 s) is what answers a document whose application never runs.
 */
document.documentElement.setAttribute('data-omp-startup-paint', '')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark">
      <LanguageProvider>
        <App />
      </LanguageProvider>
    </ThemeProvider>
  </StrictMode>,
)

// The start-up shell (`index.html`) holds the window until this document says it has something to
// show. Two waits make that answer: the first frame carrying the application, and the first
// workspace read. The frame alone used to be the whole signal, which faded the shell away before
// `workspace_list` had answered — the rail then drew its "no workspace yet" empty state until the
// rows arrived (2026-11-02, reader report). A read that never answers hands over at the ceiling
// below, where the rail draws its own loading state; the shell's 30s ceiling remains the last
// resort.
const STARTUP_DATA_CEILING_MS = 5000
let painted = false
let workspacesSettled = false
let announced = false
let ceiling: number | undefined

function announceStartupReady(): void {
  if (!painted || !workspacesSettled || announced) return
  announced = true
  clearTimeout(ceiling)
  // The first callback of a frame runs before that frame is painted, so the signal goes out one
  // frame later than the commit: by then the shell behind the overlay has been painted at least
  // once with the rows the wait was for, and fading the overlay reveals the application rather than
  // an empty box.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('omp-startup-ready'))
    })
  })
}

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    painted = true
    announceStartupReady()
  })
})

void workspacesReady.then(() => {
  workspacesSettled = true
  announceStartupReady()
})

ceiling = setTimeout(() => {
  workspacesSettled = true
  announceStartupReady()
}, STARTUP_DATA_CEILING_MS)
