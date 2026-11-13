/**
 * `approval_mode` / `approval_mode_set`: the engine's tool-approval setting, read and written.
 *
 * The setting is the engine's own (`tools.approvalMode`), and the engine is the only place it is
 * acted on: which tool calls run freely and which ones stop to ask is the engine's tier table, and
 * a call that has to ask arrives here as an ordinary `extension_ui_request` (answered by
 * `session_ui_response`). Nothing about the tiers is duplicated in this module - it reads the value
 * and writes the value, so the desktop never keeps a second interpretation of them. The caller is
 * this application's own convergence onto the mode it runs with (`services::runtime::approval` in
 * `src-tauri`, `yolo` since 2026-10-07): the settings page used to be the second caller and was
 * removed, so the read and the write here serve that convergence alone.
 *
 * `compaction_status` / `compaction_set_enabled` / `compaction_set_options` are the same shape for
 * the other engine settings a settings card owns: `compaction.enabled`, which decides whether the
 * engine compacts the context by itself when it fills; `compaction.idleEnabled`, which decides
 * whether it compacts a settled conversation while the reader is away; and `recap.enabled`, which
 * decides whether an idle stretch is summarized. Which method that compaction uses, when it
 * triggers and what it keeps are the engine's rules, read here and written here but never restated.
 * All three are engine settings under one card because they are one subject: the reader asks what
 * happens to a filling context, and these are the three answers it has.
 */

import { DEFAULT_COMPACTION_METHOD_ORDER, resolveCompactionMethodOrder } from '@oh-my-pi/pi-coding-agent/session/compaction-methods'
import {
  cfgCompactionEnabled,
  cfgCompactionIdleEnabled,
  cfgCompactionMethodOrder,
} from '@oh-my-pi/pi-coding-agent/session/context-settings'
import { cfgRecap, cfgRecapEnabled, cfgMarketplaceAutoUpdate } from '@oh-my-pi/pi-coding-agent/modes/settings'
import { cfgToolsApprovalMode } from '@oh-my-pi/pi-coding-agent/tools/settings'

import type { BootServices } from './boot.ts'
import { enumField, requireBoolean } from './capabilities.ts'
import { logLine } from './log.ts'

/**
 * The engine's approval vocabulary, in the engine's own spelling.
 *
 * The three values are the engine's (`cfgToolsApprovalMode`), but they are spelled here as well:
 * this is the frame-level gate that decides which of them a caller may *name*, and a value outside
 * it has to be refused as bad input rather than written and silently repaired by the engine.
 */
const APPROVAL_MODES = ['always-ask', 'write', 'yolo'] as const

/**
 * The mode in effect, and whether a value was ever chosen.
 *
 * `configured` is the difference between "the user picked yolo" and "nothing was ever chosen, so
 * the engine's schema default (yolo) applies": the first-run convergence in `services/runtime/session.rs`
 * writes the product default - `yolo`, the user's decision of 2026-09-26: a fresh installation
 * allows everything and the settings page narrows it - only in the second case, which it cannot
 * tell from the effective value alone.
 */
export function readApprovalMode(services: BootServices): Record<string, unknown> {
  return {
    mode: cfgToolsApprovalMode.get(services.settings),
    configured: cfgToolsApprovalMode.isConfigured(services.settings),
  }
}

/** `approval_mode_set`: refuses a mode outside the engine's vocabulary, writes the rest, then flushes. */
export async function setApprovalMode(
  services: BootServices,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const mode = enumField(frame.mode, APPROVAL_MODES, 'mode')
  const settings = services.settings
  cfgToolsApprovalMode.set(settings, mode)
  // The write is only real once it is on disk, the same reason `skills_set` flushes: the answer is
  // read back from these settings, so a caller that repeats `approval_mode` after the response sees
  // exactly what the response said.
  await settings.flush()
  return readApprovalMode(services)
}

/**
 * `compaction_status`: whether the engine compacts a filling context by itself, from its own
 * settings.
 *
 * The answer is the engine's own gate rather than a raw leaf: `compaction.enabled` **and** a method
 * order that resolves to at least one method (`session-maintenance.ts::autoCompactionEnabled`),
 * because a legacy `compaction.strategy: "off"` migrates to an empty order and a switch that
 * reported `enabled` alone would claim automation the engine never runs. Nothing here converges the
 * value either: the engine's own defaults already are the behaviour this desktop wants, so there is
 * no first-run default to write. Both leaves are read through the engine's own handles, so each is
 * already the type the engine declares (`boolean`, and the method order as a list).
 */
export function readCompaction(services: BootServices): Record<string, unknown> {
  return {
    enabled: compactionEnabled(services),
    // The idle half of the same subject, each read as the engine resolves it: whether a settled
    // conversation is compacted while nobody is looking, and whether an idle stretch is summarized.
    // Both are the engine's own switches (`compaction.idleEnabled`, `recap.enabled`); this host does
    // not interpret either, it reports them.
    idleEnabled: cfgCompactionIdleEnabled.get(services.settings),
    recapEnabled: cfgRecap.get(services.settings).enabled,
  }
}

/** The engine's own gate, read through the engine's own resolver and no copy of its vocabulary. */
function compactionEnabled(services: BootServices): boolean {
  const settings = services.settings
  return (
    cfgCompactionEnabled.get(settings) &&
    resolveCompactionMethodOrder(cfgCompactionMethodOrder.get(settings)).length > 0
  )
}

/** `compaction_set_enabled`: refuses a non-boolean, writes the rest, then flushes. */
export async function setCompaction(
  services: BootServices,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const enabled = requireBoolean(frame.enabled, 'enabled')
  const settings = services.settings
  cfgCompactionEnabled.set(settings, enabled)
  // The engine's own toggle repairs the gate's other half: switching automation on while the method
  // order resolves to nothing - a migrated `strategy: "off"`, a hand-typed name - writes the
  // default order back, which is what makes "on" mean what the settings card promises
  // (`session-maintenance.ts::setAutoCompactionEnabled(enabled, persist: true)`).
  if (
    enabled &&
    resolveCompactionMethodOrder(cfgCompactionMethodOrder.get(settings)).length === 0
  ) {
    cfgCompactionMethodOrder.set(settings, [...DEFAULT_COMPACTION_METHOD_ORDER])
  }
  // The write is only real once it is on disk, the same reason `skills_set` flushes: the answer is
  // read back from these settings, so a caller that repeats `compaction_status` after the response
  // sees exactly what the response said.
  await settings.flush()
  return readCompaction(services)
}

/**
 * `compaction_set_options`: the two idle switches under the same card, each written only when the
 * frame names it.
 *
 * A field the caller omits is a field it is not changing - the card has two switches, and one of
 * them being flipped must not write the other's value back over a change that landed in between.
 * Both leaves take effect for running conversations as well: the engine's idle scheduler listens to
 * them and re-arms what a stretch still owes (`session/idle-maintenance.ts`), so a reader who turns
 * the recap on does not have to open a new conversation first.
 *
 * The whole frame is read before either leaf is written, the same order `setCompaction` and
 * `setApprovalMode` keep: a second field the engine refuses must not leave the first one already
 * applied in memory - writing notifies the idle scheduler, and the next unrelated flush would then
 * persist a change whose command answered `invalid_input`.
 */
export async function setCompactionOptions(
  services: BootServices,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const settings = services.settings
  const idle =
    frame.idleEnabled === undefined ? undefined : requireBoolean(frame.idleEnabled, 'idleEnabled')
  const recap =
    frame.recapEnabled === undefined ? undefined : requireBoolean(frame.recapEnabled, 'recapEnabled')
  if (idle === undefined && recap === undefined) {
    throw new Error('compaction_set_options needs idleEnabled or recapEnabled')
  }
  if (idle !== undefined) cfgCompactionIdleEnabled.set(settings, idle)
  if (recap !== undefined) cfgRecapEnabled.set(settings, recap)
  // On disk before the answer, like every other settings write: the reply is read back from these
  // settings, so repeating `compaction_status` must show what the answer showed.
  await settings.flush()
  return readCompaction(services)
}

/** The engine's marketplace auto-update mode (`marketplace.autoUpdate`). */
export function readPluginAutoUpdate(services: BootServices): Record<string, unknown> {
  return { value: cfgMarketplaceAutoUpdate.get(services.settings) }
}

/**
 * `plugins_auto_update`: read, or write, the engine's startup marketplace policy.
 *
 * The setting is the engine's own (`marketplace.autoUpdate`, `off` | `notify` | `auto`); `omp config
 * set marketplace.autoUpdate` writes the same key. A write is flushed before the answer so the next
 * process reads what this one reported.
 */
export async function writePluginAutoUpdate(
  services: BootServices,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (frame.value !== undefined) {
    const mode = enumField(frame.value, ['off', 'notify', 'auto'], 'value')
    cfgMarketplaceAutoUpdate.set(services.settings, mode)
    await services.settings.flush()
  }
  return { value: cfgMarketplaceAutoUpdate.get(services.settings) }
}

/**
 * The defaults this product holds the engine at, written once on a setting the reader has never
 * chosen and never again.
 *
 * Only one today: `recap.enabled` is `false`. The engine's own default is `true`, which is right for
 * its terminal - a terminal has one screen of scrollback, so a line saying where the conversation
 * stands is the only way back - and wrong here: this window keeps the whole transcript, and every
 * idle stretch would spend a full-context call to restate it. The switch on the compaction card turns
 * it back on, and a reader who does that is `isConfigured`, so this never writes over the choice.
 *
 * A setting written into `config.yml` by hand counts as configured too: the engine resolves
 * environment, then the layer it was set in, and `isConfigured` answers to the layers rather than to
 * the effective value. That is what keeps this a first-run default rather than a policy.
 */
export async function convergeProductDefaults(services: Pick<BootServices, 'settings'>): Promise<void> {
  const settings = services.settings
  if (cfgRecapEnabled.isConfigured(settings)) return
  cfgRecapEnabled.set(settings, false)
  // On disk before the first session exists, so the value a restart reads is the one this process
  // ran under - and so `isConfigured` answers true from now on and this never runs twice.
  await settings.flush()
  logLine('engine default written: recap.enabled=false (this application keeps the transcript)')
}
