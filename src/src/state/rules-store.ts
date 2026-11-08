/**
 * The engine's user-scope `RULES.md`: one file, no workspace axis.
 *
 * The engine reads it into every request, so it belongs to no project and the page that shows it
 * takes no workspace either. A file this application has not created yet is not an error — the read
 * reports `exists: false` with empty content, and the first write creates it.
 */

import { engineRules, setEngineRules } from '@/api/capabilities'
import type { EngineRulesView } from '@/api/capabilities-types'
import { toApiError, type ApiError } from '@/api/client'
import { createResource } from '@/state/resource'

export const rulesResource = createResource<EngineRulesView>(() => engineRules())

export function readRules(force = false): Promise<void> {
  return rulesResource.read({ force })
}

/** Write the whole file; the answer is the state on disk after the write. */
export async function writeRules(content: string): Promise<ApiError | null> {
  try {
    rulesResource.adopt(await setEngineRules(content))
    return null
  } catch (error) {
    return toApiError(error)
  }
}
