/**
 * The capability commands: skills, MCP, memory, usage, context compaction and the user-level rules
 * file.
 *
 * Thin by construction — a name, its arguments, and the host's typed answer. Every write answers
 * with the whole refreshed view rather than an acknowledgement, because the engine is the only side
 * that knows what a write became; a caller renders that answer instead of patching its own copy.
 *
 * `workspaceId` is `Option<i64>` on the Rust side and is passed as `null` rather than omitted: the
 * host then reads its own default workspace, and the argument's presence keeps one call shape for
 * every workspace state the page can be in.
 */

import { call } from '@/api/client'
import type {
  EngineCompactionStatus,
  EngineMcpDefinitionInput,
  EngineMcpScope,
  EngineMcpView,
  EngineMemoryAction,
  EngineMemoryCatalogView,
  EngineMemoryView,
  EngineRulesView,
  EngineSkillSetTarget,
  EngineSkillsView,
  EngineUsageView,
} from '@/api/capabilities-types'
import { COMMANDS, type McpSourceApply, type McpSourceScan } from '@/api/types'

/* ------------------------------------------------------------------ skills */

/** The engine's skills for one project, as it discovered them, with the state its settings produce. */
export function engineSkills(workspaceId: number | null): Promise<EngineSkillsView> {
  return call(COMMANDS.engineSkills, { workspaceId })
}

/**
 * Turns the master skill switch, one source toggle, or one skill on or off.
 *
 * `id` is null for the master switch and the source/skill name otherwise, which is how the engine's
 * own settings path addresses each of the three.
 */
export function setEngineSkill(
  workspaceId: number | null,
  target: EngineSkillSetTarget,
  id: string | null,
  enabled: boolean,
): Promise<EngineSkillsView> {
  return call(COMMANDS.engineSkillsSet, { workspaceId, target, id, enabled })
}

/* --------------------------------------------------------------------- MCP */

export function engineMcp(workspaceId: number | null): Promise<EngineMcpView> {
  return call(COMMANDS.engineMcp, { workspaceId })
}

export function setEngineMcpEnabled(
  workspaceId: number | null,
  name: string,
  enabled: boolean,
): Promise<EngineMcpView> {
  return call(COMMANDS.engineMcpSetEnabled, { workspaceId, name, enabled })
}

/**
 * Creates one MCP definition, or replaces the keys an edit owns.
 *
 * `scope` names the file the engine writes: `user` is its own `<agentDir>/mcp.json`, `project` is
 * `<workspace>/.omp/mcp.json`.
 */
export function upsertEngineMcp(
  workspaceId: number | null,
  name: string,
  scope: EngineMcpScope,
  definition: EngineMcpDefinitionInput,
): Promise<EngineMcpView> {
  return call(COMMANDS.engineMcpUpsert, { workspaceId, name, scope, definition })
}

/** Deletes one MCP definition from the file its scope names. */
export function removeEngineMcp(
  workspaceId: number | null,
  name: string,
  scope: EngineMcpScope,
): Promise<EngineMcpView> {
  return call(COMMANDS.engineMcpRemove, { workspaceId, name, scope })
}

/**
 * What the other coding agents on this machine define, and which of it this application has.
 *
 * No workspace argument: the agents' user-level configuration is one profile, not one project. The
 * desktop names the real profile, because the host's own home is pinned into the app's data root.
 */
export function scanMcpSources(): Promise<McpSourceScan> {
  return call(COMMANDS.mcpImportScan)
}

/** Copies the selected agents' servers this application does not have, and connects them. */
export function applyMcpSources(sources: readonly string[]): Promise<McpSourceApply> {
  return call(COMMANDS.mcpImportApply, { sources })
}

/* ------------------------------------------------------------------ memory */

/** The active memory backend, its own status, and the artifacts the local backend keeps. */
export function engineMemory(workspaceId: number | null): Promise<EngineMemoryView> {
  return call(COMMANDS.engineMemory, { workspaceId })
}

/** Switches the memory backend, asks the active backend to consolidate now, or clears it. */
export function runEngineMemoryAction(
  workspaceId: number | null,
  action: EngineMemoryAction,
  backend: string | null,
): Promise<EngineMemoryView> {
  return call(COMMANDS.engineMemoryAction, { workspaceId, action, backend })
}

/**
 * The memory catalog: where each named workspace's memory lives, and the documents inside it.
 *
 * The ids are the store's own workspace ids, so no path travels from here to Rust.
 */
export function engineMemoryCatalog(workspaceIds: number[]): Promise<EngineMemoryCatalogView> {
  return call(COMMANDS.engineMemoryCatalog, { workspaceIds })
}

/** Reveals one memory document in the platform's file manager. */
export function revealEngineMemoryFile(
  workspaceId: number,
  name: string,
): Promise<{ ok: boolean }> {
  return call(COMMANDS.engineMemoryReveal, { workspaceId, name })
}

/* ------------------------------------------------------------------- usage */

/**
 * Token and cost accounting over this desktop's session files, for one window.
 *
 * `rangeDays: null` means all history. Every read re-examines the store and parses only the files
 * that changed, so `refresh` asks for nothing a plain read does not already do; a window is whole
 * local days, starting at the first day the range reaches.
 */
export function engineUsage(rangeDays: number | null, refresh = false): Promise<EngineUsageView> {
  return call(COMMANDS.engineUsage, { rangeDays, refresh })
}

/* ------------------------------------------------------ compaction + rules */

/** Whether the engine compacts a filling context by itself (its own `compaction.enabled`). */
export function engineCompactionStatus(): Promise<EngineCompactionStatus> {
  return call(COMMANDS.engineCompactionStatus)
}

export function setEngineCompactionEnabled(enabled: boolean): Promise<EngineCompactionStatus> {
  return call(COMMANDS.engineCompactionSetEnabled, { enabled })
}

/**
 * Writes one or both idle switches under the compaction card.
 *
 * An omitted field is a switch this call is not touching: the two are engine settings written one
 * at a time, so flipping one cannot revert the other.
 */
export function setEngineCompactionOptions(options: {
  idleEnabled?: boolean
  recapEnabled?: boolean
}): Promise<EngineCompactionStatus> {
  return call(COMMANDS.engineCompactionSetOptions, options)
}

/** The engine's user-scope `RULES.md`: one file answers for every workspace. */
export function engineRules(): Promise<EngineRulesView> {
  return call(COMMANDS.engineRules)
}

/** Writes the whole file; an empty one is legitimate, the engine reads it as no rules. */
export function setEngineRules(content: string): Promise<EngineRulesView> {
  return call(COMMANDS.engineRulesSet, { content })
}
