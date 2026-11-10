import { Folder, Monitor } from 'lucide-react'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@/components/motion/select'
import { useCopy, type Localized } from '@/lib/i18n'
import { useStoreSelector } from '@/state/store'
import { workspaceStore, type WorkspaceState } from '@/state/workspace-store'
import type { WorkspaceScopeTarget } from '@/settings/use-workspace-scope'

/**
 * The scope picker: the user's own machine, or one workspace, as one dropdown.
 *
 * The engine resolves skills, MCP definitions and plugin registries per directory, so a page that
 * followed only the rail's active workspace could not answer "what does this other project have".
 * This control names the directory the page is about; `user` is the machine-wide scope, where only
 * user-level rows apply.
 *
 * The list is the workspace store's own order, the same one the rail shows, and a workspace that is
 * missing on disk is still listed: the host refuses its reads with the code the page states.
 */

interface ScopeCopy {
  /** The control's accessible name. */
  label: string
  /** The machine-wide scope: user-level definitions, every workspace. */
  user: string
  /** The suffix on every row: this machine, as opposed to a remote host. */
  machine: string
  /** The heading over the workspace rows. */
  workspaces: string
}

const COPY: Localized<ScopeCopy> = {
  en: {
    label: 'Scope',
    user: 'User',
    machine: 'This machine',
    workspaces: 'Workspaces',
  },
  zh: {
    label: '作用域',
    user: '用户',
    machine: '本机',
    workspaces: '工作区',
  },
}

/** The store's workspaces, in the rail's order. */
const selectWorkspaces = (state: WorkspaceState) => state.items

export function WorkspaceScopeSelect({
  value,
  onChange,
}: {
  value: WorkspaceScopeTarget
  onChange: (value: WorkspaceScopeTarget) => void
}) {
  const copy = useCopy(COPY)
  const workspaces = useStoreSelector(workspaceStore, selectWorkspaces)
  const selected =
    typeof value === 'number'
      ? workspaces.find((workspace) => workspace.id === value)
      : undefined
  const userLabel = `${copy.user} · ${copy.machine}`
  const label = selected === undefined ? userLabel : `${selected.name} · ${copy.machine}`

  return (
    <div className="w-[190px]">
      <Select
        value={selected === undefined ? 'user' : String(selected.id)}
        onValueChange={(next) => onChange(next === 'user' ? 'user' : Number(next))}
      >
        <SelectTrigger className="h-9 rounded-lg" ariaLabel={copy.label}>
          {selected === undefined ? (
            <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1 truncate text-left text-sm">{label}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="user">
            <span className="flex min-w-0 items-center gap-2">
              <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{userLabel}</span>
            </span>
          </SelectItem>
          <SelectLabel>{copy.workspaces}</SelectLabel>
          {workspaces.map((workspace) => (
            <SelectItem key={workspace.id} value={String(workspace.id)}>
              <span className="flex min-w-0 items-center gap-2">
                <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">{`${workspace.name} · ${copy.machine}`}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
