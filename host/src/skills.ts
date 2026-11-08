/**
 * `skills_list` / `skills_set`: the engine's skill discovery, projected and toggled.
 *
 * `enabled` is never derived here. The engine decides it, and this host simply asks twice - once
 * with every source admitted, once with the settings the engine would actually use - and reports
 * membership in the second answer as the effective state (contract §2.2). Re-implementing the
 * engine's source and glob filtering in the host is exactly the second implementation the contract
 * forbids, and it is also the reason a skill disabled through the master switch or a source toggle
 * comes back as `enabled:false` without this module knowing why.
 *
 * The same reason decides the write path: it edits the two settings the engine itself reads
 * (`skills.enable*` and `disabledExtensions`) and lets the engine's next discovery answer what the
 * new state is.
 */

import type { Setting } from '@oh-my-pi/pi-coding-agent/config/registry'
import {
  cfgDisabledExtensions,
  cfgSkills,
  cfgSkillsCustomDirectories,
  cfgSkillsEnableAgentsProject,
  cfgSkillsEnableAgentsUser,
  cfgSkillsEnableClaudeProject,
  cfgSkillsEnableClaudeUser,
  cfgSkillsEnableCodexUser,
  cfgSkillsEnablePiProject,
  cfgSkillsEnablePiUser,
  cfgSkillsEnabled,
  cfgSkillsIgnoredSkills,
  cfgSkillsIncludeSkills,
} from '@oh-my-pi/pi-coding-agent/extensibility/settings'

import type { BootServices } from './boot.ts'
import { clampText, enumField, requireBoolean, requireText, resolveCwd, takeRows, targetIdField } from './capabilities.ts'
import {
  CAPABILITY_NAME_MAX,
  CAPABILITY_ROWS_MAX,
  CAPABILITY_TEXT_MAX,
  CAPABILITY_WARNINGS_MAX,
  SKILL_SOURCE_IDS,
} from './constants.ts'
import type { HostPaths } from './env.ts'
import { invalidInput } from './protocol/errors.ts'
import type { SdkBundle, Skill, SkillWarning } from './sdk.ts'

/** Targets a skill write may address (contract §2.3). */
const SKILL_TARGETS = ['master', 'source', 'skill'] as const
type SkillTarget = (typeof SKILL_TARGETS)[number]

/** One source toggle as the protocol names it. */
type SkillSourceId = (typeof SKILL_SOURCE_IDS)[number]

/**
 * The engine's own toggle handle behind each protocol source id.
 *
 * The engine has one registered setting per source, and no group member is reachable by a computed
 * name any more (`Settings.getGroup` is gone with the string-keyed settings API), so the mapping is
 * written out once: a source id this table does not name is a compile error rather than a write
 * that lands on nothing.
 */
const SKILL_SOURCE_HANDLES: Record<SkillSourceId, Setting<boolean>> = {
  enableCodexUser: cfgSkillsEnableCodexUser,
  enableClaudeUser: cfgSkillsEnableClaudeUser,
  enableClaudeProject: cfgSkillsEnableClaudeProject,
  enablePiUser: cfgSkillsEnablePiUser,
  enablePiProject: cfgSkillsEnablePiProject,
  enableAgentsUser: cfgSkillsEnableAgentsUser,
  enableAgentsProject: cfgSkillsEnableAgentsProject,
}

/** How every source toggle maps to the engine's provider/level vocabulary. */
const SKILL_SOURCE_LABELS: Record<SkillSourceId, string> = {
  enableCodexUser: 'codex/user',
  enableClaudeUser: 'claude/user',
  enableClaudeProject: 'claude/project',
  enablePiUser: 'native/user',
  enablePiProject: 'native/project',
  enableAgentsUser: 'agents/user',
  enableAgentsProject: 'agents/project',
}

/** One row of the skill list. */
interface SkillRow {
  readonly name: string
  readonly description: string
  readonly filePath: string
  readonly baseDir: string
  readonly source: string
  readonly sourceName: string
  /**
   * The plugin whose package carries this skill, when one does (`_source.pluginName`). A skill like
   * that belongs to its plugin: it is not the user's to switch off or remove on its own, and the
   * engine stops discovering it when the plugin is disabled (`clearPluginRootsAndCaches`).
   */
  readonly plugin: string | null
  readonly level: 'user' | 'project' | 'native' | 'unknown'
  readonly hidden: boolean
  readonly enabled: boolean
}

/** Every skill the engine can see, ignoring every source toggle and the disabled list. */
interface Discovery {
  readonly skills: Skill[]
  readonly warnings: SkillWarning[]
}

/**
 * The maximal discovery: every source admitted, nothing disabled.
 *
 * `customDirectories` is the one setting this pass keeps, because those directories are configured
 * locations rather than source gates - dropping them would make a path the user added invisible to
 * the list that is supposed to be the superset.
 */
async function discoverAll(paths: HostPaths, services: BootServices, sdk: SdkBundle, cwd: string): Promise<Discovery> {
  return await sdk.discoverSkills(cwd, paths.agentDir, {
    enabled: true,
    includeSkills: [],
    ignoredSkills: [],
    disabledExtensions: [],
    enableCodexUser: true,
    enableClaudeUser: true,
    enableClaudeProject: true,
    enablePiUser: true,
    enablePiProject: true,
    enableAgentsUser: true,
    enableAgentsProject: true,
    customDirectories: cfgSkillsCustomDirectories.get(services.settings),
  })
}

/** Warnings from both passes, deduplicated: the same broken skill is reported once. */
function mergeWarnings(first: readonly SkillWarning[], second: readonly SkillWarning[]): SkillWarning[] {
  const seen = new Set<string>()
  const merged: SkillWarning[] = []
  for (const warning of [...first, ...second]) {
    const key = `${warning.skillPath}\u0000${warning.message}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({
      skillPath: warning.skillPath,
      message: clampText(warning.message, CAPABILITY_TEXT_MAX).text ?? '',
    })
  }
  return merged
}

/** One discovery result as a list row; `enabled` comes from the caller's effective-name set. */
function toRow(skill: Skill, effective: ReadonlySet<string>): SkillRow {
  const source = skill._source
  const level = source?.level
  return {
    name: skill.name,
    description: clampText(skill.description, CAPABILITY_TEXT_MAX).text ?? '',
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    // `_source` is attached by the loader for every discovered skill; `skill.source` is the
    // engine's own `provider:level` spelling and is the fallback when it is missing.
    source: source?.provider ?? skill.source.split(':')[0] ?? 'unknown',
    sourceName: source?.providerName ?? '',
    plugin: source?.pluginName ?? null,
    level: level === 'user' || level === 'project' || level === 'native' ? level : 'unknown',
    hidden: skill.hide === true,
    enabled: effective.has(skill.name),
  }
}

/**
 * The `skills_list` payload.
 *
 * `all` is a caller-supplied discovery so a write can reuse the pass it already paid for: the
 * maximal pass has no disabled list and no source toggles, so it is unaffected by anything
 * `skills_set` writes.
 */
async function skillsView(
  paths: HostPaths,
  services: BootServices,
  sdk: SdkBundle,
  cwd: string,
  all: Discovery,
): Promise<Record<string, unknown>> {
  const settings = services.settings
  // The effective pass is the discovery a session would do: the `skills` group plus the top-level
  // disabled list, which is not a group member and therefore has to be merged in - exactly what the
  // engine's own session wiring does (`legacy-pi-coding-agent-shim.ts`:
  // `{ ...cfgSkills.get(settings), disabledExtensions: cfgDisabledExtensions.get(settings) }`).
  // Without the merge, a per-skill toggle would write a setting nothing reads.
  const effective = await sdk.discoverSkills(cwd, paths.agentDir, {
    ...cfgSkills.get(settings),
    disabledExtensions: cfgDisabledExtensions.get(settings),
  })
  const effectiveNames = new Set(effective.skills.map(skill => skill.name))
  const rows = all.skills.map(skill => toRow(skill, effectiveNames))
  const warnings = mergeWarnings(all.warnings, effective.warnings)
  const capped = takeRows(rows, CAPABILITY_ROWS_MAX)
  const cappedWarnings = takeRows(warnings, CAPABILITY_WARNINGS_MAX)
  // Counted over the whole list, not the capped one: a caller that is shown 500 of 900 skills must
  // still read the true totals next to them.
  const enabledCount = rows.reduce((total, row) => total + (row.enabled ? 1 : 0), 0)
  const hiddenCount = rows.reduce((total, row) => total + (row.hidden ? 1 : 0), 0)

  return {
    masterEnabled: cfgSkillsEnabled.get(settings),
    cwd,
    skills: capped.rows,
    sources: SKILL_SOURCE_IDS.map(id => ({
      id,
      label: SKILL_SOURCE_LABELS[id],
      enabled: SKILL_SOURCE_HANDLES[id].get(settings),
    })),
    ignoredPatterns: cfgSkillsIgnoredSkills.get(settings),
    includedPatterns: cfgSkillsIncludeSkills.get(settings),
    warnings: cappedWarnings.rows,
    summary: {
      total: rows.length,
      enabled: enabledCount,
      hidden: hiddenCount,
      disabled: rows.length - enabledCount,
      warnings: warnings.length,
    },
    truncated: capped.truncated || cappedWarnings.truncated,
  }
}

/** `skills_list`: the engine's skills for one working directory. */
export async function listSkills(
  paths: HostPaths,
  services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cwd = resolveCwd(paths, frame.cwd)
  // Discovery reads skill files through a capability cache that lives as long as this process, so a
  // skill written after the host booted - by the user, or by another process - stays invisible until
  // the cache is dropped; the engine resets it after a filesystem change (`capability.reset()`,
  // ruling C22). Both skill commands drop it once here, before their first read.
  sdk.resetCapabilities()
  return await skillsView(paths, services, sdk, cwd, await discoverAll(paths, services, sdk, cwd))
}

/** `skills_set`: one of the three toggles, answered with the state the write produced. */
export async function setSkills(
  paths: HostPaths,
  services: BootServices,
  sdk: SdkBundle,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const target: SkillTarget = enumField(frame.target, SKILL_TARGETS, 'target')
  const enabled = requireBoolean(frame.enabled, 'enabled')
  const cwd = resolveCwd(paths, frame.cwd)
  const settings = services.settings
  let all: Discovery | null = null
  // Same reason as `listSkills`: the skill-exists check must see what is on disk now.
  sdk.resetCapabilities()

  switch (target) {
    case 'master': {
      // Only the target field is refused here: the envelope id is not a target id.
      if (frame.targetId !== undefined && frame.targetId !== null) throw invalidInput('target "master" takes no targetId.')
      cfgSkillsEnabled.set(settings, enabled)
      break
    }
    case 'source': {
      const id = enumField(targetIdField(frame), SKILL_SOURCE_IDS, 'targetId')
      SKILL_SOURCE_HANDLES[id].set(settings, enabled)
      break
    }
    case 'skill': {
      const name = requireText(targetIdField(frame), 'targetId', CAPABILITY_NAME_MAX)
      // A toggle has to name a skill the engine actually discovers: writing a disabled entry for
      // an unknown name would look like it worked and change nothing.
      all = await discoverAll(paths, services, sdk, cwd)
      if (!all.skills.some(skill => skill.name === name)) throw invalidInput(`No skill is named "${name}".`)
      cfgDisabledExtensions.set(settings, toggleExtension(cfgDisabledExtensions.get(settings), name, enabled))
      break
    }
  }

  // The write is only real once it is on disk: the answer is a fresh read of the same settings, so
  // a caller that repeats `skills_list` after the response sees exactly what the response said.
  await settings.flush()
  return await skillsView(paths, services, sdk, cwd, all ?? (await discoverAll(paths, services, sdk, cwd)))
}

/**
 * The disabled-extension list with `skill:<name>` added or removed.
 *
 * Idempotent and order-preserving on purpose: the list is shared with extensions and is written by
 * other commands, so a toggle must not reorder or duplicate entries it does not own.
 */
function toggleExtension(current: readonly string[], name: string, enabled: boolean): string[] {
  const id = `skill:${name}`
  if (enabled) return current.filter(entry => entry !== id)
  if (current.includes(id)) return [...current]
  return [...current, id]
}
