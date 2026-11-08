/**
 * The engine state a plugin change invalidates, rebuilt for one conversation.
 *
 * Two callers need exactly the same steps: the engine's own `/reload-plugins` builtin (reached
 * through `slash.ts`), and every plugin-management frame that changed what plugins contribute
 * (`plugins.ts`, and the registry-wide `plugins_reload`). One implementation is what makes "the
 * command reported success" and "the session really runs on the new set" the same statement.
 */

import type { AgentSession, SdkBundle } from './sdk.ts'

/**
 * Rebuilds everything a plugin change invalidates: the engine's discovery caches, the session's
 * skills, and the command list the palette reads.
 *
 * The sequence is the engine's own reload path (`modes/acp/acp-agent.ts`,
 * `modes/rpc/rpc-mode.ts`): drop the plugin roots and caches, reload agent discovery, drop the
 * capability caches, reload this session's skills, and re-advertise. Without it `/reload-plugins`
 * and `/marketplace` would report success while the session still ran on the old set.
 */
export async function reloadPluginStateForSession(sdk: SdkBundle, session: AgentSession): Promise<void> {
  const cwd = session.sessionManager.getCwd()
  const projectPath = await sdk.resolveActiveProjectRegistryPath(cwd)
  sdk.clearPluginRootsAndCaches(projectPath === null ? undefined : [projectPath])
  await sdk.refreshAgentDiscovery(cwd, session.effectiveExtensionRoots)
  sdk.resetCapabilities()
  // This last step is also the one that republishes the command list: the engine reports changed
  // command metadata as its skills are reloaded, and this host answers that report with a fresh
  // advertisement and a fresh state (see `SessionRegistry`'s command watch). Publishing here as
  // well would advertise, scan and publish the same list twice for every plugin reload.
  await session.refreshSkills()
}
