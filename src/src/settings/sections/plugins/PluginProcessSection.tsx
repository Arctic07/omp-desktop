import { useEffect, useState } from 'react'

import { Play, RotateCcw } from 'lucide-react'

import type { ApiError } from '@/api/client'
import type { PluginRow } from '@/api/plugins-types'
import { Button } from '@/components/motion/button'
import type { Language } from '@/lib/i18n'
import { SettingsBadge, SettingsCard, SettingsGroup, SettingsRow } from '@/settings/parts'
import type { PluginsCopy } from '@/settings/sections/plugins/copy'
import {
  commandResultValue,
  pluginProcessCrashLabel,
  pluginProcessOf,
  pluginProcessRefusalLabel,
  pluginProcessRestartable,
  pluginProcessStateLabel,
} from '@/settings/sections/plugins/process-rows'
import { formatPluginTimestamp } from '@/settings/sections/plugins/rows'
import {
  readPluginProcess,
  restartPluginProcess,
  runPluginCommand,
  usePluginProcess,
} from '@/state/plugin-process'
import { pageTitle } from '@/state/plugin-text'

/** What one command's last press left behind, drawn under the list it came from. */
type CommandOutcome =
  | { kind: 'ran'; commandId: string; text: string; value: string | null }
  | { kind: 'failed'; commandId: string; code: string; message: string }

/**
 * One plugin's resident process: its state, the manual restart, and the commands it contributes.
 *
 * This is the runner this build has. The plan puts contributed commands in a command palette beside
 * the application's session commands, but this build has no palette — `pluginPaletteCommands` is
 * the shared list a future one would read, and until then the detail view is where a command is
 * actually executed. It also owns the restart control, because a crashed process stays crashed and
 * enabled (plan §6.4): nothing here disables a plugin, and the reader is the one who tries again.
 *
 * The view asks the store, never the page: the process table is the supervisor's and is pushed to
 * every window, so a restart this view did not start still shows up on the row.
 */
export function PluginProcessSection({
  row,
  copy,
  language,
  workspaceId,
}: {
  row: PluginRow
  copy: PluginsCopy
  language: Language
  workspaceId: number | null
}) {
  const process = pluginProcessOf(row)
  const processRow = usePluginProcess(row.id, row.scope)
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState<ApiError | null>(null)
  const [runningId, setRunningId] = useState('')
  const [outcome, setOutcome] = useState<CommandOutcome | null>(null)
  const declaredMain = process?.main ?? null

  // The table is read once per workspace, and only for a plugin that has a process to report on: a
  // commands-only plugin is still answered by the pushed events.
  useEffect(() => {
    if (declaredMain === null) return
    void readPluginProcess(workspaceId)
  }, [declaredMain, workspaceId])

  if (process === null) return null

  const state = processRow?.state ?? 'stopped'
  const stateLabel = pluginProcessStateLabel(state, processRow?.pid ?? null, copy)
  const lastExit = formatPluginTimestamp(processRow?.lastExitAt ?? null, language)
  const details = [
    copy.processRestarts(processRow?.restarts ?? 0),
    lastExit === '' ? '' : copy.processLastExit(lastExit),
    // The manifest's own answer, shown beside the count: "restarted 0 times" and "this plugin never
    // restarts" are different facts, and only one of them explains a process that stays down.
    process.autoRestart ? '' : copy.processAutoRestartOff,
  ]
    .filter((line) => line !== '')
    .join(' · ')
  const crashReason = (processRow?.reason ?? '').trim()
  // The reason is a crash reason: a row that has since started again may still carry the last one,
  // and stating it beside "running" would read as a live fault.
  const crashNote =
    process.available && state === 'crashed' && crashReason !== ''
      ? pluginProcessCrashLabel(crashReason, copy)
      : ''

  const restart = async (): Promise<void> => {
    setRestartError(null)
    setRestarting(true)
    const error = await restartPluginProcess(workspaceId, row.id, row.scope)
    setRestarting(false)
    setRestartError(error)
  }

  const run = async (commandId: string, title: string): Promise<void> => {
    setOutcome(null)
    setRunningId(commandId)
    const answer = await runPluginCommand(workspaceId, row.id, row.scope, commandId)
    setRunningId('')
    if (answer.error !== null) {
      setOutcome({
        kind: 'failed',
        commandId,
        code: answer.error.code,
        message: answer.error.message,
      })
      return
    }
    const result = answer.result
    if (result === null) return
    if (!result.ok) {
      const code = (result.code ?? '').trim()
      setOutcome({
        kind: 'failed',
        commandId,
        code: code === '' ? copy.commandFailed : code,
        message: (result.message ?? '').trim(),
      })
      return
    }
    setOutcome({
      kind: 'ran',
      commandId,
      text: copy.commandRan(title),
      value: commandResultValue(result.value),
    })
  }

  const commandNote =
    outcome === null ? null : outcome.kind === 'ran' ? (
      <div role="status" className="flex flex-col gap-1.5 px-5 pb-[15px] text-xs leading-[18px] text-muted-foreground">
        <span>{outcome.text}</span>
        {outcome.value === null ? null : (
          <>
            <span className="text-[11px] uppercase tracking-wide opacity-70">{copy.commandResultLabel}</span>
            <pre className="max-h-48 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-[16px] whitespace-pre-wrap break-words">
              {outcome.value}
            </pre>
          </>
        )}
      </div>
    ) : (
      <p
        role="alert"
        className="flex flex-wrap items-center gap-1.5 px-5 pb-[15px] text-xs leading-[18px] text-destructive"
      >
        {copy.commandFailed}
        <SettingsBadge>{outcome.code}</SettingsBadge>
        {outcome.message === '' ? null : (
          <span className="min-w-0 text-muted-foreground">{outcome.message}</span>
        )}
      </p>
    )

  return (
    <>
      {process.main === null ? null : (
        <SettingsGroup
          title={copy.processTitle}
          description={process.available ? copy.processCodeNote : undefined}
        >
          <SettingsCard>
            {process.available ? (
              <SettingsRow
                title={stateLabel}
                description={details}
                control={
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={restarting || !pluginProcessRestartable(state)}
                    onClick={() => void restart()}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    {restarting ? copy.processRestarting : copy.processRestartAction}
                  </Button>
                }
              />
            ) : (
              <SettingsRow
                title={copy.processStateLabels.stopped}
                description={
                  process.reason === null
                    ? undefined
                    : pluginProcessRefusalLabel(process.reason, copy)
                }
              />
            )}
            {crashNote === '' ? null : (
              <p className="px-5 pb-[15px] text-xs leading-[18px] text-destructive">{crashNote}</p>
            )}
            {restartError === null ? null : (
              <p
                role="alert"
                className="flex flex-wrap items-center gap-1.5 px-5 pb-[15px] text-xs leading-[18px] text-destructive"
              >
                {copy.processRestartFailed}
                <SettingsBadge>{restartError.code}</SettingsBadge>
                {restartError.message === '' ? null : (
                  <span className="min-w-0 text-muted-foreground">{restartError.message}</span>
                )}
              </p>
            )}
          </SettingsCard>
        </SettingsGroup>
      )}

      <SettingsGroup
        title={copy.commandsTitle}
        description={process.main === null && process.available ? copy.processCodeNote : undefined}
      >
        <SettingsCard>
          {process.commands.length === 0 ? (
            <p className="px-5 py-[15px] text-[13px] leading-[19px] text-muted-foreground">
              {copy.commandsNone}
            </p>
          ) : (
            process.commands.map((command) => {
              const own = pageTitle(command.title, language)
              const title = own === '' ? command.id : own
              const busy = runningId === command.id
              return (
                <SettingsRow
                  key={command.id}
                  title={title}
                  description={own === '' ? undefined : command.id}
                  control={
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || !process.available}
                      onClick={() => void run(command.id, title)}
                    >
                      <Play size={14} aria-hidden="true" />
                      {busy ? copy.commandRunning : copy.commandRunAction}
                    </Button>
                  }
                />
              )
            })
          )}
          {commandNote}
        </SettingsCard>
      </SettingsGroup>
    </>
  )
}
