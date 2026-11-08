/**
 * The engine's skills for the active workspace: what discovery found, and the three switches that
 * decide what loads.
 *
 * The engine owns every fact here — the rows, the levels, the warnings and the summary all come from
 * its own discovery, and the switches are its own settings (`skills.enabled`, `skills.enable*`,
 * `disabledExtensions`). A write answers with the whole refreshed view, so this store never patches
 * a row: it adopts the answer.
 */

import { engineSkills, setEngineSkill } from '@/api/capabilities'
import type { EngineSkillSetTarget, EngineSkillsView } from '@/api/capabilities-types'
import { toApiError, type ApiError } from '@/api/client'
import { createWorkspaceResource } from '@/state/resource'

export const skillsResource = createWorkspaceResource<EngineSkillsView>((workspaceId) =>
  engineSkills(workspaceId),
)

/** Read this workspace's skills. Idempotent for the workspace already answered. */
export function readSkills(workspaceId: number | null, force = false): Promise<void> {
  return skillsResource.read(workspaceId, { force })
}

/**
 * Turn the master switch, one source, or one skill.
 *
 * The failure is returned rather than thrown: a refused switch keeps the page as it was and reports
 * the refusal beside the row that asked for it.
 */
export async function writeSkill(
  workspaceId: number | null,
  target: EngineSkillSetTarget,
  id: string | null,
  enabled: boolean,
): Promise<ApiError | null> {
  try {
    skillsResource.adopt(await setEngineSkill(workspaceId, target, id, enabled))
    return null
  } catch (error) {
    return toApiError(error)
  }
}

/** One switch's own identity, so a row's busy state and its failure are keyed the same way. */
export function skillWriteKey(target: EngineSkillSetTarget, id: string | null): string {
  return `${target}\u0000${id ?? ''}`
}
