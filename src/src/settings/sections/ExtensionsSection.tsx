import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'

import type { ApiError } from '@/api/client'
import type { EngineExtensionRow } from '@/api/extensions'
import { AnimatedBadge } from '@/components/motion/animated-badge'
import { Button } from '@/components/motion/button'
import { Switch } from '@/components/motion/switch'
import { useCopy, type Localized } from '@/lib/i18n'
import { SettingsBadge, SettingsCard, SettingsEmpty, SettingsGroup, SettingsLoadState, SettingsNotice, SettingsRow } from '@/settings/parts'
import type { SettingsSectionProps } from '@/settings/SettingsPage'
import { useWorkspaceScope } from '@/settings/use-workspace-scope'
import { extensionsResource, readExtensions, writeExtension } from '@/state/extensions-store'
import { useResourceState } from '@/state/resource'
import { WorkspaceScopeSelect } from '@/settings/WorkspaceScopeSelect'

/** The order the engine's own dashboard groups its rows in, and the names those groups carry. */
const KIND_ORDER = ['skill', 'rule', 'tool', 'hook', 'prompt', 'slash-command', 'context-file', 'extension-module'] as const

interface ExtensionsCopy {
  loading: string
  loadFailed: string
  retry: string
  empty: string
  refresh: string
  truncated: string
  toggleOn: (name: string) => string
  toggleOff: (name: string) => string
  writeFailed: string
  stateLabels: Readonly<Record<string, string>>
  reasonLabels: Readonly<Record<string, string>>
  kindLabels: Readonly<Record<string, string>>
  levelLabels: Readonly<Record<string, string>>
  providerPrefix: string
  shadowedSuffix: (name: string) => string
}

const COPY: Localized<ExtensionsCopy> = {
  en: {
    loading: 'Reading the engine’s extensions…',
    loadFailed: 'The extensions could not be read.',
    retry: 'Retry',
    empty: 'The engine discovered no extension items in this scope.',
    refresh: 'Refresh',
    truncated: 'This list is a prefix: the engine discovered more rows than this page shows.',
    toggleOn: (name) => `Disable ${name}`,
    toggleOff: (name) => `Enable ${name}`,
    writeFailed: 'The switch did not change.',
    stateLabels: { active: 'Active', disabled: 'Disabled', shadowed: 'Shadowed' },
    reasonLabels: {
      'item-disabled': 'Disabled by you',
      'provider-disabled': 'Its provider is off',
      'user-opt-in': 'This source is not opted in',
      shadowed: 'A higher-priority copy is active',
    },
    kindLabels: {
      skill: 'Skills',
      rule: 'Rules',
      tool: 'Tools',
      hook: 'Hooks',
      prompt: 'Prompts',
      'slash-command': 'Commands',
      'context-file': 'Context files',
      'extension-module': 'Extension modules',
    },
    levelLabels: { user: 'User', project: 'Project' },
    providerPrefix: 'from',
    shadowedSuffix: (name) => `shadowed by ${name}`,
  },
  zh: {
    loading: '正在读取引擎的扩展项…',
    loadFailed: '无法读取扩展项。',
    retry: '重试',
    empty: '这个范围内引擎没有发现任何扩展项。',
    refresh: '刷新',
    truncated: '列表被截断：引擎发现的条目比本页显示的多。',
    toggleOn: (name) => `关闭 ${name}`,
    toggleOff: (name) => `开启 ${name}`,
    writeFailed: '开关没有生效。',
    stateLabels: { active: '启用', disabled: '停用', shadowed: '被遮蔽' },
    reasonLabels: {
      'item-disabled': '你停用了它',
      'provider-disabled': '它的来源被关闭',
      'user-opt-in': '这个来源尚未启用',
      shadowed: '高优先级副本生效中',
    },
    kindLabels: {
      skill: '技能',
      rule: '规则',
      tool: '工具',
      hook: '钩子',
      prompt: '提示词',
      'slash-command': '命令',
      'context-file': '上下文文件',
      'extension-module': '扩展模块',
    },
    levelLabels: { user: '用户', project: '项目' },
    providerPrefix: '来自',
    shadowedSuffix: (name) => `被 ${name} 遮蔽`,
  },
}

/**
 * The engine's `/extensions` dashboard, as a settings page.
 *
 * Every row is a capability the engine discovered for this directory, with the provider and level it
 * came from; the switch writes the engine's own `disabledExtensions` id, the host reloads every live
 * session, and the answer is the refreshed list. Nothing here re-discovers an item or invents an id.
 * MCP servers are not in this list: they are the MCP page's own write (`disabledServers`), and a
 * switch here would be a second mechanism for one state.
 */
export default function ExtensionsSection({ active = true }: SettingsSectionProps) {
  const copy = useCopy(COPY)
  const { workspaceId, target, setTarget } = useWorkspaceScope()
  const state = useResourceState(extensionsResource)
  const view = state.value
  const [busyId, setBusyId] = useState('')
  const [failure, setFailure] = useState<ApiError | null>(null)

  const read = useCallback((force = false) => {
    void readExtensions(workspaceId, force)
  }, [workspaceId])

  useEffect(() => {
    if (!active) return
    read()
  }, [active, read])

  const toggle = useCallback(
    async (row: EngineExtensionRow, enabled: boolean) => {
      if (busyId !== '') return
      setBusyId(row.id)
      setFailure(null)
      const error = await writeExtension(workspaceId, row.id, enabled)
      setBusyId('')
      if (error !== null) setFailure(error)
    },
    [busyId, workspaceId],
  )

  const groups = useMemo(() => {
    const byKind = new Map<string, EngineExtensionRow[]>()
    for (const row of view?.extensions ?? []) {
      const group = byKind.get(row.kind)
      if (group === undefined) byKind.set(row.kind, [row])
      else group.push(row)
    }
    return KIND_ORDER.flatMap((kind) => {
      const rows = byKind.get(kind)
      return rows === undefined || rows.length === 0 ? [] : [{ kind, rows }]
    })
  }, [view])

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <WorkspaceScopeSelect value={target} onChange={setTarget} />
        <span className="text-xs leading-[18px] text-muted-foreground" role="status">
          {view === null ? '' : `${String(view.extensions.length)} items`}
        </span>
        <Button
          size="sm"
          variant="secondary"
          disabled={state.status === 'loading' || busyId !== ''}
          onClick={() => read(true)}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {copy.refresh}
        </Button>
      </div>

      {failure === null ? null : (
        <SettingsNotice variant="destructive" title={copy.writeFailed}>
          <span className="flex flex-wrap items-center gap-1.5">
            {failure.code === '' ? null : <SettingsBadge>{failure.code}</SettingsBadge>}
            {failure.message === '' ? null : <span className="min-w-0">{failure.message}</span>}
          </span>
        </SettingsNotice>
      )}

      {view === null || state.status === 'error' ? (
        <SettingsLoadState
          status={state.status === 'idle' ? 'loading' : state.status}
          error={state.error}
          loadingLabel={copy.loading}
          failedLabel={copy.loadFailed}
          retryLabel={copy.retry}
          onRetry={() => read(true)}
        />
      ) : (
        <>
          {view.truncated ? (
            <SettingsNotice variant="warning" title={copy.truncated} />
          ) : null}
          {groups.length === 0 ? (
            <SettingsEmpty>{copy.empty}</SettingsEmpty>
          ) : (
            groups.map((group) => (
              <SettingsGroup key={group.kind} title={copy.kindLabels[group.kind] ?? group.kind}>
                <SettingsCard>
                  {group.rows.map((row) => (
                    <SettingsRow
                      key={row.id}
                      title={row.displayName === '' ? row.name : row.displayName}
                      description={[
                        row.description ?? '',
                        row.trigger ?? '',
                        `${copy.providerPrefix} ${row.providerName === '' ? row.provider : row.providerName} · ${copy.levelLabels[row.level] ?? row.level}`,
                        row.shadowedBy === null ? '' : copy.shadowedSuffix(row.shadowedBy),
                      ]
                        .filter((part) => part !== '')
                        .join(' · ')}
                      control={
                        <span className="flex items-center gap-2">
                          {row.state === 'active' ? null : (
                            <AnimatedBadge status={row.state === 'shadowed' ? 'warning' : 'neutral'} size="sm" showIcon={false} animated={false}>
                              {copy.reasonLabels[row.disabledReason ?? ''] ?? copy.stateLabels[row.state] ?? row.state}
                            </AnimatedBadge>
                          )}
                          <Switch
                            checked={row.state === 'active'}
                            disabled={busyId !== '' || row.state === 'shadowed'}
                            ariaLabel={row.state === 'active' ? copy.toggleOn(row.name) : copy.toggleOff(row.name)}
                            onCheckedChange={(next) => void toggle(row, next)}
                          />
                        </span>
                      }
                    />
                  ))}
                </SettingsCard>
              </SettingsGroup>
            ))
          )}
        </>
      )}
    </>
  )
}
