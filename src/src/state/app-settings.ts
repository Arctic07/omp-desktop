/**
 * The desktop's own preferences: the ones this document keeps rather than the engine.
 *
 * Four of the five are this frontend's own business — the reading size, the conversation's spacing,
 * what happens when a prompt meets a running turn, and whether motion is reduced.
 * They are stored in one document under one key, so a write is one `localStorage.setItem` and the
 * whole set is read back in one place; a preference added later cannot end up in a second key that
 * nothing reads.
 *
 * The fifth, the theme, is deliberately *not* here: `next-themes` already owns the `.dark` class on
 * the document and persists the choice, and a second owner would be a second answer. What this
 * module does for the theme is the part `next-themes` cannot do — telling the shell which theme the
 * next start should open with (`startup_theme_set`), which is what draws the window before this
 * document exists.
 *
 * Every stored value is normalized on read: a document written by an older build, hand-edited, or
 * truncated mid-write yields the default for the field it does not answer, rather than a state the
 * UI has no rendering for.
 */

import { useCallback, useSyncExternalStore } from 'react'

import { trayLanguageSet } from '@/api/preferences'
import type { Language } from '@/lib/i18n'
import { createStore } from '@/state/store'

type ConversationDensity = 'comfortable' | 'compact'
export type BusyBehavior = 'queue' | 'interrupt'

interface AppSettings {
  /** The conversation's reading size, in pixels. */
  fontSize: number
  conversationDensity: ConversationDensity
  busyBehavior: BusyBehavior
  reduceMotion: boolean
}

/** The reading-size range the desktop offers (`stores/appSettings.ts`). */
export const FONT_SIZE_MIN = 12
export const FONT_SIZE_MAX = 17
const FONT_SIZE_DEFAULT = 14

const DEFAULT_SETTINGS: AppSettings = {
  fontSize: FONT_SIZE_DEFAULT,
  conversationDensity: 'comfortable',
  busyBehavior: 'queue',
  reduceMotion: false,
}

const STORAGE_KEY = 'omp-desktop.settings'

function clampFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return FONT_SIZE_DEFAULT
  const rounded = Math.round(value)
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, rounded))
}

function readStoredSettings(): AppSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_SETTINGS
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SETTINGS
    const stored = parsed as Partial<Record<keyof AppSettings, unknown>>
    return {
      fontSize: clampFontSize(stored.fontSize),
      conversationDensity: stored.conversationDensity === 'compact' ? 'compact' : 'comfortable',
      busyBehavior: stored.busyBehavior === 'interrupt' ? 'interrupt' : 'queue',
      reduceMotion: stored.reduceMotion === true,
    }
  } catch {
    // Storage may be unavailable (private mode) or hold a document this build cannot read; the
    // defaults are the answer either way, and the choice still applies to this session.
    return DEFAULT_SETTINGS
  }
}

function storeSettings(settings: AppSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // A preference that cannot be stored still applies to this session.
  }
}

const appSettingsStore = createStore<AppSettings>(DEFAULT_SETTINGS)

/**
 * Put the settings on the document.
 *
 * The three attributes and the one custom property are the whole contract between this store and
 * the stylesheets (`src/index.css`): `data-omp-conversation-density` and `data-omp-reduce-motion`
 * are read as attribute selectors, and `--omp-content-font-size` is what the conversation's own
 * text and the composer's field take their size from. Nothing else in the app reads these, which is
 * why they are written here rather than by whichever component happens to render first.
 */
function applyToDocument(settings: AppSettings): void {
  const root = document.documentElement
  root.style.setProperty('--omp-content-font-size', `${settings.fontSize}px`)
  document.body.dataset.ompConversationDensity = settings.conversationDensity
  document.body.dataset.ompReduceMotion = String(settings.reduceMotion)
}

/** The stored document, normalized, and applied to the document. Called once at startup. */
export function startAppSettings(): void {
  const settings = readStoredSettings()
  appSettingsStore.set(settings)
  applyToDocument(settings)
}

function updateAppSettings(patch: Partial<AppSettings>): void {
  const next: AppSettings = { ...appSettingsStore.get(), ...patch }
  appSettingsStore.set(next)
  storeSettings(next)
  applyToDocument(next)
}

/**
 * One preference, as a value and a setter.
 *
 * The setter is stable, so a control that passes it down does not re-render its subtree on every
 * write of an unrelated preference.
 */
export function useAppSetting<K extends keyof AppSettings>(
  key: K,
): [AppSettings[K], (value: AppSettings[K]) => void] {
  const value = useSyncExternalStore(
    appSettingsStore.subscribe,
    useCallback(() => appSettingsStore.get()[key], [key]),
    useCallback(() => appSettingsStore.get()[key], [key]),
  )
  const set = useCallback((next: AppSettings[K]) => updateAppSettings({ [key]: next }), [key])
  return [value, set]
}

/* ------------------------------------------------ the shell's one side channel */

/** Tell the tray which language its own menu is written in. */
export function pushTrayLanguage(language: Language): void {
  void trayLanguageSet(language).catch(() => undefined)
}
