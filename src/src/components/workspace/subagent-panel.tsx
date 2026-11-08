/**
 * The subagent tab's body: one `task` child's own conversation.
 *
 * The panel owns the child's read for exactly as long as the tab exists — it opens the view on
 * mount and releases it on unmount — the way a terminal tab's shell lives as long as its
 * `TerminalPanel` does. Closing the tab is therefore the release point, and switching to another tab
 * in the strip is not: the panel stays mounted, so the child's rows are still there when the reader
 * comes back, and its reading position is restored by the feed from the child's own id.
 *
 * The conversation is drawn by `ConversationPane` — the same rows and the same disclosures as the
 * main column — with three things switched off: a child's transcript has one voice, so the rows
 * draw no avatars and no "智能体 + 时刻" header (`speakers={false}`); it is a record this side only
 * reads, so no turn offers a fork (`fork={false}`); and its run is a step of the parent's turn, not
 * a conversation with a bill of its own, so no usage/model footer is drawn (`showTail={false}`).
 * While the child is working the running line says **运行中**, the same word the parent's task row
 * uses.
 */

import { useCallback, useEffect } from 'react'

import { AgentProgress } from '@/components/agents/loading-states/agent-progress'
import { ConversationPane } from '@/home/ConversationPane'
import { COPY } from '@/home/homeCopy'
import { useCopy } from '@/lib/i18n'
import { openSubagentTab } from '@/state/panel-store'
import type { SubagentTab } from '@/state/panel-tabs'
import { sessionStore, type SessionStoreState } from '@/state/session-record'
import { closeSubagentView, openSubagentView, useSubagentView } from '@/state/subagent-view'
import { useStoreSelector } from '@/state/store'

export interface SubagentPanelProps {
  /** The conversation whose `task` call spawned this child: the owner of the tab. */
  ownerSessionId: string
  tab: SubagentTab
  /** Whether the tab is on screen; a hidden panel keeps its rows and its reading position. */
  active: boolean
}

export function SubagentPanel({ ownerSessionId, tab, active }: SubagentPanelProps) {
  const copy = useCopy(COPY)
  const view = useSubagentView(tab.childId)
  /**
   * Whether the engine's roster still counts this child as working.
   *
   * A screen attached to a child arrives *after* its turn opened: `agent_start` is the one engine
   * event that opens a turn, and a child has no state snapshot to read a turn that was already
   * running back from (unlike a conversation's `runtime.isStreaming`). So a child opened while it
   * works has no `turn_started` on its channel — for a one-turn child there never will be one —
   * and the running line and the live tail were drawn from nothing at all (2026-10-22, user report).
   *
   * The parent's roster is the second reading, the same way the runtime snapshot is for a
   * conversation: it is the engine's own report of the child's run, it is root-scoped (a child of
   * a child reports to the same bus, `host/src/subagents.ts`), and its settle edge arrives even
   * when the child's `agent_end` is lost. The view's own `turnId` stays the first reading — a turn
   * that started while this tab was open is stated by its own frame.
   */
  const selectLive = useCallback(
    (state: SessionStoreState) => {
      const status = state.records[ownerSessionId]?.subagents[tab.childId]?.status
      return status === 'running' || status === 'pending'
    },
    [ownerSessionId, tab.childId],
  )
  const live = useStoreSelector(sessionStore, selectLive)

  // The child's read is the panel's own life: opened with the tab, released with it. The target is
  // the tab's, resolved when the tab was created — never the conversation on screen now, which is
  // very often a different one.
  useEffect(() => {
    openSubagentView(tab.childId, ownerSessionId, tab.parentFile)
    return () => closeSubagentView(tab.childId)
  }, [ownerSessionId, tab.childId, tab.parentFile])

  if (view === null || view.status === 'resolving' || view.status === 'loading') {
    // A hidden tab draws nothing while it waits: the line is a live region with a running clock
    // (`AgentProgress`), and an off-screen tab must keep neither — the reader is looking at another
    // tab, and this one's progress would be announced at them. The tab is invisible anyway.
    if (!active) return null
    const label =
      view !== null && view.total > 0
        ? copy.conversationLoadProgress(view.loaded, view.total)
        : copy.subagentLoading
    return (
      <div className="flex h-full items-center justify-center px-6">
        <AgentProgress label={label} />
      </div>
    )
  }

  if (view.status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm font-medium text-destructive">
          {view.error?.message ?? copy.subagentNotFound}
        </p>
        <p className="text-xs text-muted-foreground">{tab.label}</p>
      </div>
    )
  }

  const childSessionId = view.sessionId
  const childFile = view.filePath
  if (childSessionId === null) return null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ConversationPane
        sessionId={childSessionId}
        messages={view.transcript.messages}
        subagents={view.transcript.subagents}
        backgroundJobs={view.transcript.runtime?.backgroundJobs}
        streaming={view.transcript.turnId !== null || live}
        retry={view.transcript.runtime?.retry ?? null}
        lastTurn={view.transcript.lastTurn}
        tipEntryId={null}
        speakers={false}
        fork={false}
        showTail={false}
        runningLabel={copy.toolRunning}
        // A `task` inside the child opens a tab of its own, one level down: the strip belongs to the
        // conversation the reader is in, so the tab joins that strip, and the parent of the child it
        // names is the child on screen — the file it was written beside.
        onOpenSubagent={(childId, label) => {
          if (childFile === null) return
          openSubagentTab(ownerSessionId, { childId, label, parentFile: childFile })
          openSubagentView(childId, childSessionId, childFile)
        }}
      />
    </div>
  )
}
