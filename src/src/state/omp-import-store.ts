/**
 * The local-configuration import's one dialog: what was found, what to copy, and what landed.
 *
 * The dialog is raised from two places - the first-run check (once per installation) and the
 * models page's button (any time) - so the state lives here rather than in either caller. Every
 * read and write goes through the desktop's commands; this store holds only what the dialog is
 * currently showing.
 *
 * The first-run prompt is separate state from the dialog: the probe answers whether it should be
 * asked, and once the user answers - import or decline - the desktop records it and no later start
 * asks again. The manual entry point never consults that record.
 */

import type { ApiError } from '@/api/client'
import { toApiError } from '@/api/client'
import { ompImportApply, ompImportDismiss, ompImportProbe, ompImportScan } from '@/api/omp-import'
import type { ImportApplyResult, ImportScan } from '@/api/types'
import { createStore } from '@/state/store'

/** Why the dialog is open: the first-run question, or the settings button. */
export type OmpImportEntry = 'first-run' | 'manual'

export type OmpImportCategory = 'models' | 'mcp' | 'skills'

export interface OmpImportState {
  open: boolean
  entry: OmpImportEntry
  status: 'loading' | 'ready' | 'applying' | 'done' | 'error'
  error: ApiError | null
  scan: ImportScan | null
  result: ImportApplyResult | null
  /** What to copy. All three are on when the dialog opens: an import defaults to everything. */
  selection: Record<OmpImportCategory, boolean>
}

const EMPTY: OmpImportState = {
  open: false,
  entry: 'manual',
  status: 'loading',
  error: null,
  scan: null,
  result: null,
  selection: { models: true, mcp: true, skills: true },
}

export const ompImportStore = createStore<OmpImportState>(EMPTY)

/**
 * Asks the first-run question, once per installation.
 *
 * Called from the shell on mount. A machine with no terminal omp beside this application answers
 * `available:false` and nothing opens; a prompt that was already answered opens nothing at all. A
 * failed probe opens nothing either - the settings button stays available for the reader who wants
 * to try, and a startup error toast for a feature they never asked about would be noise.
 */
export async function checkFirstRunImport(): Promise<void> {
  try {
    const probe = await ompImportProbe()
    if (probe.prompted || !probe.available) return
    await openOmpImport('first-run')
  } catch {
    // Best effort: the manual entry point re-runs the same read on demand.
  }
}

/**
 * Opens the dialog and reads the source directory.
 *
 * Idempotent while it is already up: the shell's start-up check and the models page's button can
 * both fire, and a double invoke (React's development double-mount included) must not start a
 * second scan or replace a half-answered dialog.
 */
export async function openOmpImport(entry: OmpImportEntry): Promise<void> {
  if (ompImportStore.get().open) return
  ompImportStore.set({
    ...EMPTY,
    open: true,
    entry,
    selection: EMPTY.selection,
  })
  await loadScan()
}

/** Re-reads what the source offers. Shared by the open and by the retry button. */
export async function loadScan(): Promise<void> {
  ompImportStore.set((state) => ({ ...state, status: 'loading', error: null }))
  try {
    const scan = await ompImportScan()
    ompImportStore.set((state) => ({ ...state, status: 'ready', scan }))
  } catch (error) {
    ompImportStore.set((state) => ({ ...state, status: 'error', error: toApiError(error) }))
  }
}

/** Turns one category on or off; the apply sends only what is on. */
export function toggleOmpImportCategory(category: OmpImportCategory, enabled: boolean): void {
  ompImportStore.set((state) => ({
    ...state,
    selection: { ...state.selection, [category]: enabled },
  }))
}

/**
 * Copies the selected categories and shows what landed.
 *
 * The answer is the only summary: imported and skipped names per category, and the warnings the
 * host raised. Nothing here recomputes a count from the scan, because the scan is a preview of a
 * different moment.
 */
export async function applyOmpImport(): Promise<void> {
  const state = ompImportStore.get()
  if (state.status === 'applying') return
  const categories = state.selection
  if (!categories.models && !categories.mcp && !categories.skills) return
  ompImportStore.set({ ...state, status: 'applying', error: null })
  try {
    const result = await ompImportApply(categories)
    ompImportStore.set((current) => ({ ...current, status: 'done', result }))
    // An import answers the first-run question as surely as declining does.
    await ompImportDismiss().catch(() => undefined)
  } catch (error) {
    ompImportStore.set((current) => ({
      ...current,
      status: 'error',
      error: toApiError(error),
    }))
  }
}

/** Closes the dialog. A first-run question that is declined is recorded as answered. */
export async function closeOmpImport(): Promise<void> {
  const { entry } = ompImportStore.get()
  ompImportStore.set(EMPTY)
  if (entry === 'first-run') await ompImportDismiss().catch(() => undefined)
}
