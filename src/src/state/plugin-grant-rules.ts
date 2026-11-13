import type { PluginGrantRow, PluginRow } from '../api/plugins-types'

/**
 * Which installations one write may grant, decided without a host.
 *
 * Split from `plugins-store.ts` because the rule is the whole point and it must be assertable: the
 * store module reaches the host through `@/api`, which the node test runner does not resolve, so a
 * rule that lived there could only be checked by hand.
 */

/** A plugin's own key: an id is only unique within its scope. */
export function pluginRowKey(plugin: Pick<PluginRow, 'id' | 'scope'>): string {
  return `${plugin.id}\u0000${plugin.scope}`
}

/** Whether this installation's code has been agreed to, keyed the way the host keys a grant. */
export function installationGranted(
  grants: readonly PluginGrantRow[],
  pluginId: string,
  scope: string,
): boolean {
  return grants.some((grant) => grant.pluginId === pluginId && grant.scope === scope)
}

/**
 * The rows one write added that still need a grant: absent from `before`, running code, unconfirmed.
 *
 * The scope is the write's own additions. An earlier version swept every unconfirmed row in the
 * workspace, which re-granted and re-enabled installations the user had deliberately withdrawn
 * (`set_grant(false)` disables and forgets) and reversed the host's own widening reconciliation
 * after an upgrade. A withdrawal is a decision, not a gap for the next install to fill.
 */
export function installationsToConfirm(
  rows: readonly PluginRow[],
  grants: readonly PluginGrantRow[],
  before: ReadonlySet<string>,
): PluginRow[] {
  return rows.filter(
    (row) =>
      !before.has(pluginRowKey(row)) &&
      row.consent.required &&
      !installationGranted(grants, row.id, row.scope),
  )
}
