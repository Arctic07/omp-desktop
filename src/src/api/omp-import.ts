/**
 * Another omp installation's configuration, read and copied into this application.
 *
 * Four thin calls: the first-run check, the scan the dialog renders, the copy itself, and the record
 * that the prompt was answered. No caching and no defaults live here - the desktop owns what counts
 * as "already present", and an answer is the only thing this module knows.
 */

import { call } from '@/api/client'
import { COMMANDS, type ImportApplyResult, type ImportProbe, type ImportScan } from '@/api/types'

/**
 * Whether the first-run prompt should be shown at all.
 *
 * `sourceDir` is omitted on purpose: the desktop discovers the terminal installation from the user's
 * profile, which is the only source a first-run check can mean.
 */
export function ompImportProbe(): Promise<ImportProbe> {
  return call(COMMANDS.ompImportProbe)
}

/** What the directory offers, without copying anything. */
export function ompImportScan(sourceDir?: string): Promise<ImportScan> {
  return call(COMMANDS.ompImportScan, sourceDir === undefined ? undefined : { sourceDir })
}

/** Copies the selected categories, skipping everything already present. */
export function ompImportApply(
  categories: { models: boolean; mcp: boolean; skills: boolean },
  sourceDir?: string,
): Promise<ImportApplyResult> {
  return call(COMMANDS.ompImportApply, sourceDir === undefined ? { ...categories } : { ...categories, sourceDir })
}

/** Records the user's answer so the prompt is not shown again. */
export function ompImportDismiss(): Promise<void> {
  return call(COMMANDS.ompImportDismiss)
}
