import type { PluginsCopy } from '@/settings/sections/plugins/copy'
import {
  PLUGIN_FS_MODE_PERMISSIONS,
  pluginPermissionLabel,
  pluginPermissionScope,
  pluginReachesAnyHost,
  pluginReachesAnyPath,
} from '@/settings/sections/plugins/rows'

/**
 * One plugin's declared permissions.
 *
 * Every entry is a pair — the permission's own wording and the scope it comes with — because a
 * permission is never shown as a name alone. The scope is the manifest key the declaration lives
 * under rather than a resolved range: the host payload carries the declared names and the network
 * domains, and a range declared elsewhere in the manifest is named by its key instead of being
 * invented here. A permission this build does not know is still listed, spelled exactly as the
 * engine sent it — dropping it would hide a fact the manifest states.
 *
 * Two widenings replace the range a permission would otherwise state, because the range is no longer
 * what the gate reads: `net.anyHost` replaces the domain list, and `fs.anyPath` replaces the three
 * file modes' scope lines. A page that showed both would be telling the reader two different reaches
 * and letting them guess which one is honoured.
 */
export function PluginPermissionList({
  permissions,
  netDomains,
  netAnyHost,
  copy,
}: {
  permissions: readonly string[]
  netDomains: readonly string[]
  /** `omp.desktop.net.anyHost`: the second key, which replaces the list with one sentence. */
  netAnyHost?: boolean
  copy: PluginsCopy
}) {
  if (permissions.length === 0) {
    return <p className="text-[13px] leading-[19px] text-muted-foreground">{copy.permissionsNone}</p>
  }

  // The domains only mean something next to `net.fetch`, which is the permission they scope.
  const domains = permissions.includes('net.fetch') ? netDomains : []
  // A block that holds both keys reaches every host, and there is no list to show beside that.
  const anyHost = pluginReachesAnyHost(permissions, netAnyHost)
  // `fs.anyPath` reaches every path, so the three file modes have no scope line left to state.
  const anyPath = pluginReachesAnyPath(permissions)

  return (
    <ul className="flex flex-col gap-3">
      {permissions.map((permission) => {
        const widened = anyPath && (PLUGIN_FS_MODE_PERMISSIONS as readonly string[]).includes(permission)
        const scope = widened ? '' : pluginPermissionScope(permission, copy)
        return (
          <li key={permission} className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <strong className="text-[13px] leading-5 font-medium text-foreground">
                {pluginPermissionLabel(permission, copy)}
              </strong>
              <code className="rounded-md bg-muted px-1.5 py-px font-mono text-[11px] leading-4 text-muted-foreground">
                {permission}
              </code>
            </span>
            {scope === '' ? null : (
              <span className="text-[13px] leading-[19px] text-muted-foreground">{scope}</span>
            )}
            {permission === 'net.fetch' && domains.length > 0 ? (
              <span className="flex flex-wrap items-center gap-1.5 text-[13px] leading-[19px] text-muted-foreground">
                <span>{copy.permissionDomainsLabel}</span>
                {domains.map((domain) => (
                  <code
                    key={domain}
                    className="rounded-md bg-muted px-1.5 py-px font-mono text-[11px] leading-4 text-muted-foreground"
                  >
                    {domain}
                  </code>
                ))}
              </span>
            ) : null}
            {permission === 'net.anyHost' && anyHost ? (
              <span className="text-[13px] leading-[19px] text-muted-foreground">
                {copy.permissionAnyHostLabel}
              </span>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
