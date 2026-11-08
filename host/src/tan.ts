/**
 * `/tan`: tangential work in a background agent, on a fork of this conversation.
 *
 * The engine's only implementation of this is its terminal controller
 * (`modes/controllers/tan-command-controller.ts`), which is wired to the TUI's context. This host
 * runs the same engine pieces itself - `SessionManager.forkFrom`, `createAgentSession`, the
 * session's own `AsyncJobManager`, the agent registry - and keeps the two TUI-only refinements out
 * on purpose: the terminal re-injects the request after a mid-run compaction, and it parks the
 * clone in its Agent Hub with a status flip. Here the clone is a background job whose result
 * delivers into the conversation, and its transcript is a subagent transcript beside the parent's.
 *
 * Everything that decides the clone's identity is the engine's: the forked manager, the shared
 * model registry, the parent's prepared extensions (rebound rather than re-discovered, which is
 * what keeps the shared registry's provider auth), and the parent's settings.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  createAgentSession,
  type AgentSession,
  SessionManager,
} from '@oh-my-pi/pi-coding-agent'
import tanContextSwitchPrompt from '@oh-my-pi/pi-coding-agent/prompts/system/tan-context-switch' with { type: 'text' }
import backgroundTanDispatchPrompt from '@oh-my-pi/pi-coding-agent/prompts/system/background-tan-dispatch' with { type: 'text' }
import type { MCPManager } from '@oh-my-pi/pi-coding-agent/mcp/manager'
import { AgentRegistry } from '@oh-my-pi/pi-coding-agent/registry/agent-registry'
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE } from '@oh-my-pi/pi-coding-agent/session/messages'
import {
  createMCPProxyTools,
  createSubagentSettings,
  followMCPTools,
} from '@oh-my-pi/pi-coding-agent/task/executor'
import { cfgTaskEnableLsp } from '@oh-my-pi/pi-coding-agent/task/settings'
import { USER_TODO_EDIT_CUSTOM_TYPE } from '@oh-my-pi/pi-coding-agent/tools/todo'
import { prompt, Snowflake, untilAborted } from '@oh-my-pi/pi-utils'

/** One command result line, on the engine's own notice channel. */
export type TanOutput = (text: string) => void

/** How much of the work the dispatch line shows. */
const PREVIEW_LENGTH = 80

function previewWork(work: string): string {
  const line = work.trim().replace(/\s+/g, ' ')
  return line.length <= PREVIEW_LENGTH ? line : `${line.slice(0, PREVIEW_LENGTH - 1)}…`
}

/**
 * Removes a fork that never became a run.
 *
 * A tan's transcript is a file beside its parent's (`<session>/<id>.jsonl`) with an artifacts
 * directory of the same stem; both go, or a failed dispatch leaves a conversation nobody can open.
 */
async function removeClone(cloneFile: string): Promise<void> {
  await Promise.allSettled([
    fs.rm(cloneFile, { force: true }),
    fs.rm(cloneFile.slice(0, -6), { recursive: true, force: true }),
  ])
}

/** The engine's own text for a fork that must ignore the parent's thread and take the new request. */
function contextSwitchMessage(): string {
  return tanContextSwitchPrompt
}

/**
 * Dispatches one `/tan`.
 *
 * Answers the job's label, or throws with the reason a dispatch could not start (no model, no
 * background jobs, no persisted session). The work runs in the background: its result arrives in
 * this conversation through the engine's own async delivery, like any other detached job.
 */
export async function dispatchTan(
  session: AgentSession,
  work: string,
  mcpManager: MCPManager | undefined,
): Promise<{ jobId: string }> {
  const trimmed = work.trim()
  if (trimmed.length === 0) throw new Error('Usage: /tan <work>')
  const model = session.model
  if (model === undefined) throw new Error('No active model available for /tan.')
  const manager = session.asyncJobManager
  if (manager === undefined) throw new Error('Background jobs are disabled; enable async jobs to use /tan.')
  const parentFile = session.sessionManager.getSessionFile()
  if (parentFile === undefined) throw new Error('/tan requires a persisted session.')

  const parentSessionId = session.sessionId
  const taskPromptCacheKey = session.sessionManager.getHeader()?.taskPromptCacheKey
  const thinkingLevel = session.configuredThinkingLevel()
  const systemPrompt = [...session.systemPrompt]
  const parentMnemopiSessionState = session.getMnemopiSessionState()
  const toolNames = session.getEnabledToolNames()
  const activeToolNames = session.getActiveToolNames()
  const mountedToolNames = session.getMountedXdevToolNames()
  const modelRegistry = session.modelRegistry
  const preparedExtensions = session.preparedExtensions
  const extensionPaths = session.extensionPaths
  const extensionRoots = session.effectiveExtensionRoots
  const ownerId = session.getAgentId() ?? 'main'
  const cwd = session.sessionManager.getCwd()
  const parentArtifactsDir = session.sessionManager.getArtifactsDir()
  const parentLocalSessionId = session.sessionManager.getSessionId()
  const localProtocolOptions = {
    getArtifactsDir: () => parentArtifactsDir,
    getSessionId: () => parentLocalSessionId,
  }
  const sessionDir = parentFile.slice(0, -6)
  const settings = createSubagentSettings(session.settings)
  const enableLsp = cfgTaskEnableLsp.get(session.settings) !== false
  const registry = AgentRegistry.global()
  const cloneId = `Tan-${Snowflake.next()}`
  const cloneFile = path.join(sessionDir, `${cloneId}.jsonl`)
  const label = `/tan ${previewWork(trimmed)}`

  await session.sessionManager.ensureOnDisk()
  await session.sessionManager.flush()

  let jobId = ''
  try {
    const cloneManager = await SessionManager.forkFrom(parentFile, cwd, sessionDir, undefined, {
      copyArtifacts: false,
      suppressBreadcrumb: true,
      sessionFile: cloneFile,
      // The fork carries the parent's transcript only for context; its cost must be its own.
      resetInheritedCost: true,
      // The parent may be mid-turn: pair its unresolved call with an unknown outcome so the clone
      // does not inherit a pending tool call as its own work.
      repairInterruptedTail: true,
    })
    jobId = manager.register(
      'task',
      label,
      async ({ signal }) => {
        if (signal.aborted) throw new Error('Aborted before execution')
        let clone: AgentSession | undefined
        const mcpFollower = mcpManager === undefined ? undefined : followMCPTools(mcpManager)
        try {
          const created = await createAgentSession({
            cwd,
            sessionManager: cloneManager,
            model,
            thinkingLevel,
            systemPrompt,
            toolNames,
            mountedToolNames,
            advertiseHeadlessAsk: activeToolNames.includes('ask'),
            providerSessionId: `${parentSessionId}:tan:${Snowflake.next()}`,
            taskPromptCacheKey,
            modelRegistry,
            authStorage: modelRegistry.authStorage,
            settings,
            hasUI: false,
            enableMCP: false,
            mcpTools: mcpManager === undefined ? undefined : createMCPProxyTools(mcpManager),
            enableLsp,
            agentId: cloneId,
            agentDisplayName: 'tan',
            parentTaskPrefix: cloneId,
            asyncJobManager: manager,
            parentAgentId: ownerId,
            agentRegistry: registry,
            disableExtensionDiscovery: true,
            // `[]` is truthy and would beat the path fallback, so an empty list is no list.
            preloadedPreparedExtensions: preparedExtensions?.length ? preparedExtensions : undefined,
            preloadedExtensionPaths: extensionPaths?.length ? [...extensionPaths] : undefined,
            extensionRoots: () => extensionRoots,
            localProtocolOptions,
            parentMnemopiSessionState,
          })
          clone = created.session
          await clone.setActiveToolPresentation(toolNames, mountedToolNames)
          mcpFollower?.bind(clone)
          clone.sessionManager?.appendSessionInit?.({
            systemPrompt: clone.systemPrompt ?? systemPrompt,
            task: trimmed,
            tools: clone.getEnabledToolNames(),
          })
          const abortClone = () => {
            void clone?.abort()
          }
          signal.addEventListener('abort', abortClone, { once: true })
          try {
            // The fork inherits the parent's todo list; its reminders would drag the tan back onto
            // the parent's task, so the clone starts with an empty one (persisted too).
            clone.setTodoPhases([])
            cloneManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] })
            clone.agent.appendMessage({
              role: 'developer',
              content: contextSwitchMessage(),
              attribution: 'agent',
              timestamp: Date.now(),
            })
            if (signal.aborted) throw new Error('Aborted before execution')
            await clone.prompt(trimmed, { attribution: 'user' })
            await clone.waitForIdle()
            while (clone.hasPendingAsyncWork()) {
              if (signal.aborted) throw new Error('Aborted while settling descendant work')
              await untilAborted(signal, clone.settleAsyncWork())
            }
            return lastAssistantText(clone) || '(no output)'
          } finally {
            signal.removeEventListener('abort', abortClone)
          }
        } finally {
          if (clone !== undefined) {
            if (signal.aborted) {
              registry.setStatus(cloneId, 'aborted')
              await clone.dispose()
            } else {
              // Parked, not unregistered: the transcript stays readable in the roster; the session
              // object itself is released.
              registry.setStatus(cloneId, 'parked')
              await clone.dispose()
              registry.detachSession(cloneId)
            }
          }
        }
      },
      { ownerId, agentId: cloneId },
    )
  } catch (error) {
    await removeClone(cloneFile)
    throw error
  }

  // The dispatch line is the conversation's record of a job it now owns; a running turn queues it
  // for the next turn rather than steering the answer in flight.
  await session.sendCustomMessage(
    {
      customType: BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
      content: prompt.render(backgroundTanDispatchPrompt, { jobId, work: trimmed }),
      display: true,
      attribution: 'user',
      details: { jobId, work: trimmed, sessionFile: cloneFile },
    },
    { triggerTurn: false, deliverAs: 'nextTurn' },
  )
  return { jobId }
}

/** The clone's final answer, as the engine reports it (text blocks only). */
function lastAssistantText(session: AgentSession): string {
  const message = session.getLastAssistantMessage()
  if (message === undefined) return ''
  return message.content
    .flatMap((content) => (content.type === 'text' ? [content.text] : []))
    .join('')
    .trim()
}
