/**
 * The skill an earlier build wrote into the agent directory by hand.
 *
 * Up to the 2026-10-22 restore, `omp-desktop-terminal` was seeded as a *native user skill*
 * (`<agentDir>/skills/omp-desktop-terminal/SKILL.md` before the module graph loaded), because the
 * build shipped no plugin that could carry it. It is back inside its plugin package now - as a
 * `rules/` document the engine injects into the prompt, not as a skill - and a native user skill
 * outranks anything a package ships in the engine's own discovery: leaving the old copy behind would
 * add a second, stale copy of the same text and keep saying the terminal is the build's own rather
 * than the plugin's.
 *
 * So this is a one-way migration, not a setting: the file was this application's own writing, the
 * package is where it belongs, and the plugin's switch is what decides whether the model sees it.
 * Deleting is best effort - a data root that keeps it still works, it just reads the older text.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { logLine } from './log.ts'

/** The skill name the earlier build seeded as a native user skill. */
const RETIRED_SEEDED_SKILLS = ['omp-desktop-terminal'] as const

/**
 * Removes the retired native copies, once per start.
 *
 * Only the application's own directory is touched (`<agentDir>/skills/<name>`), never a user's own
 * skill that happens to carry the same name elsewhere. A failure is logged and not fatal: the worst
 * case is the duplicate the engine already tolerated.
 */
export function retireSeededSkills(agentDir: string): void {
  for (const name of RETIRED_SEEDED_SKILLS) {
    const directory = path.join(agentDir, 'skills', name)
    try {
      if (!fs.existsSync(directory)) continue
      fs.rmSync(directory, { recursive: true, force: true })
      logLine(`native skill retired (its plugin now carries it): ${name}`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logLine(`native skill could not be retired: ${name}: ${reason}`)
    }
  }
}
