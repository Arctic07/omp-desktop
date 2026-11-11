/**
 * The key one installation's settings are read under, and the scope it addresses.
 *
 * A settings resource is keyed by the workspace the page acts on and the plugin id; the
 * machine-wide scope is the *absence* of a workspace, and it has to survive the round trip. Encoding
 * that absence as the empty string and parsing it back as a number turned `null` into workspace `0`,
 * a workspace no registry holds — so every user-scope plugin's settings read was answered
 * `WORKSPACE_NOT_FOUND` (user report, 2026-11-11). Both halves live here, apart from the store, so
 * the rule is testable without the IPC surface the store is wired to.
 */

export function pluginSettingsKey(workspaceId: number | null, id: string): string {
  return `${workspaceId ?? ''}\u0000${id}`
}

export function pluginSettingsTarget(key: string): { workspaceId: number | null; id: string } {
  const separator = key.indexOf('\u0000')
  const rawWorkspace = key.slice(0, separator)
  return {
    workspaceId: rawWorkspace === '' ? null : Number(rawWorkspace),
    id: key.slice(separator + 1),
  }
}
