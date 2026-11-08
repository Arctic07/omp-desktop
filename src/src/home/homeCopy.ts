import type { Localized } from "@/lib/i18n";
import type { RelativeTimeCopy } from "@/home/conversation-format";

/**
 * The home screen's wording: the workspace rail, the conversation beside it, and the composer under
 * it.
 *
 * Every string here is rendered from real engine state; there is no scripted transcript any more, so
 * nothing in this record describes a demo run. The Chinese follows the desktop app's own reading
 * where it shares a word with it (`src/i18nCopyZh.ts`): `Settings`, `Rename`, `Remove`, `Running`.
 */
export interface HomeCopy {
  /** The window frame: its own name, the sidebar's toggle, the menu bar and the window controls. */
  appName: string
  toggleSidebar: string
  /** What the sidebar's toggle says it will do, with the key that does the same thing. */
  collapseSidebarHint: string
  expandSidebarHint: string
  menuLabel: string
  /** The window's menu bar, left to right: 文件 / 视图 / 帮助. */
  menuFile: string
  menuView: string
  menuHelp: string
  /** What a menu row says when it is greyed because the conversation has no message yet. */
  menuLockedHint: string
  /** 视图's one entry: the document is reloaded, the engine's turns are not touched. */
  menuReload: string
  /** 帮助's two entries: the settings page's About section, and the updater this build has not got. */
  menuAbout: string
  menuCheckUpdates: string
  /** What 检查更新 says while there is no updater behind it. */
  menuCheckUpdatesPending: string
  windowMinimize: string
  windowMaximize: string
  windowRestore: string
  windowClose: string

  /** The conversation's own menu, beside its title. */
  sessionMenu: {
    label: string
    rename: string
    pin: string
    unpin: string
    branch: string
    copyAll: string
    copySummary: string
    copyId: string
    export: string
    archive: string
    unarchive: string
    archivedNotice: string
    unarchivedNotice: string
    flagFailed: string
    copied: string
    copyFailed: string
  }

  /** The rail's own accessible name and the two run actions at its head. */
  sidebarLabel: string
  actionNewTask: string
  actionSettings: string
  projectsLabel: string
  resourcesLabel: string
  /** A workspace row's own action, beside the menu it also carries. */
  newSessionInWorkspace: string
  /** The rail's paging controls, under a workspace that has more conversations than it shows. */
  expandSessions: string
  collapseSessions: string
  /** The rail's own switch for the conversations the reader put away. */
  showArchived: string
  hideArchived: string
  /** The branch row at the head of the changes area, and the picker it opens. */
  branchPickerLabel: string
  branchFilter: string
  branchesLabel: string
  branchDetached: string
  branchNoMatches: string
  branchCurrent: string
  branchSync: (ahead: number, behind: number) => string

  /** Managing the workspaces themselves. */
  addWorkspace: string
  /** The title the desktop's own folder picker opens with. */
  chooseWorkspace: string
  cancel: string
  menuRename: string
  menuRemove: string
  menuReveal: string
  menuDeleteSession: string
  removeWorkspaceTitle: string
  removeWorkspaceBody: (name: string) => string
  renameWorkspaceTitle: (name: string) => string
  workspaceEmptyTitle: string
  workspaceEmptyHint: string
  /** The rail's wait while the first workspace list is read. */
  workspaceLoading: string
  workspaceMissing: string
  /** The rail's conversation search: its row, the field it opens, and the empty answer. */
  searchSessions: string
  searchSessionsPlaceholder: string
  searchSessionsEmpty: string
  /** The heading over matches found in what was said, beside the title matches above them. */
  searchSessionsContent: string
  /** How a conversation's recency reads, one entry per bucket. */
  relativeTime: RelativeTimeCopy
  /** A conversation the engine has not named yet. */
  untitledSession: string
  /** One workspace's conversation list when the desktop could not read it. */
  sessionListFailed: string
  /** The control that asks for that list again. */
  retryAction: string


  /** The conversation header. */
  headerFallback: string
  headerUntitled: string
  headerStreaming: string
  headerIdle: string
  headerRetrying: (attempt: number, max: number) => string

  /**
   * The transcript's navigation rail, whose rows the conversation's own row model supplies: what a
   * row with no text is called, and how one is announced with its place in the list.
   */
  railMessage: string
  railItemLabel: (sender: string, index: number, total: number) => string
  /** The way back to the newest row, offered while the reader is away from it. */
  scrollToBottom: string

  /** Who a row is from, and the marks a row carries. */
  youLabel: string
  agentLabel: string
  nowLabel: string
  sentLabel: string
  thinkingLabel: string
  thinkingToggle: string
  /** What a turn in flight is called while it runs, beside the running component's timer. */
  workingLabel: string
  /**
   * What a turn the engine is retrying is called, with the attempt it is on.
   *
   * The line replaces the plain verb rather than sitting beside it: the reader's question during a
   * retry is "what is it doing now", and the answer is the attempt.
   */
  retryingLabel: (attempt: number, max: number) => string

  /** The states the conversation itself can be in. */
  conversationLoading: string
  conversationLoadProgress: (loaded: number, total: number) => string
  conversationFailed: string
  openFailed: string
  /** A rail row names a conversation the workspace's own list does not carry. */
  sessionUnknownHint: string
  /**
   * A `task` child's own conversation, opened in the right column's strip.
   *
   * The failure is the one the desktop never named: the child's transcript was looked for beside
   * the conversation that spawned it and was not there, which is the app's own fact to state.
   */
  subagentLoading: string
  subagentNotFound: string
  /** Why a turn ended without an answer, from the engine's own stop reason. */
  /** The one stop reason a reader is shown: the turn was cut off. */
  turnStopped: string
  /** Why a turn failed, when the engine named no reason of its own. */
  turnFailed: string
  /** Why a step answered nothing: its tool call was markup the engine could not parse. */
  turnMiscall: string
  /** What a tool call the engine never parsed states beside the call it named. */
  strayCallNotRun: string
  strayCallBody: string

  /** The transcript's own copy action, wherever it stands: a message's words, or a turn's answer. */
  copyAction: string
  copiedAction: string
  copyFailed: string
  /** Carrying the conversation on from one of its own outputs — the engine's own fork. */
  continueFromHere: string
  /**
   * Taking a user message back out of the conversation: the control under the message, and the
   * confirmation that says what the gesture does and what it does not restore.
   */
  rewindMessage: string
  rewindTitle: string
  rewindBody: string
  rewindConfirm: string
  /**
   * A message longer than the row's five lines keeps that much of it on screen; these two label the
   * control that gives the rest back and puts it away again.
   */
  expandMessage: string
  collapseMessage: string

  /**
   * What a settled turn's footer reads: what it cost, how long it ran, and how fast it wrote.
   *
   * Each is a function of the formatted figure rather than a template with a placeholder, so a
   * language can put the number where its own sentence needs it.
   */
  usageLabel: (total: string) => string
  /** The buckets behind `usageLabel`, where the reader hovers to reconcile the figure. */
  usageDetail: (input: string, output: string) => string
  usageDetailCached: (input: string, output: string, cache: string) => string
  ranForLabel: (duration: string) => string
  tokensPerSecond: (tps: string) => string

  /** A rule reminder's row, as the rail previews the turn it annotates. */
  railReminder: string
  /** Tool rows. */
  toolCalls: (count: number) => string
  /** How many calls of a run settled successfully, beside the run's count once one failed. */
  toolSucceeded: (count: number) => string
  /** How many calls of a run failed, so a mixed run never reads as all failed. */
  toolFailedCount: (count: number) => string
  toolRunning: string
  toolDone: string
  toolIdle: string
  toolFailed: string
  toolArgs: string
  toolResult: string
  toolEmptyResult: string
  /** `Minimized: git 120.4KB → 3.2KB` — the shell output the engine's minimizer rewrote. */
  toolMinimized: (summary: string) => string
  toolImages: string
  /** A picture the agent produced: opening it, and the full-window viewer's own controls. */
  imageOpen: (index: number, total: number) => string
  imageClose: string
  imagePrevious: string
  imageNext: string
  imageFailed: string
  toolSources: string
  /** The neutral count over a `task` call's roster; the rows state their own status. */
  taskAgents: (count: number) => string
  taskAgentDetached: string
  taskAgentTruncated: string
  taskAgentExit: (code: string) => string
  taskAgentOpen: string

  /** The engine's own plan, shown as the task dock. */
  planTitle: string
  /** The blocks above the field, as one group: the plan's phases and the work the turn detached. */
  blocksLabel: string
  /** A phase's own count, for the reader who cannot see the `3/5` the pill draws. */
  planProgress: (completed: number, total: number) => string
  /**
   * The engine's job kinds in the reader's words, keyed by the engine's own ids (`bash`, `eval`,
   * `task`). A kind missing from this table is shown as the engine named it.
   */
  backgroundJobKinds: Record<string, string>
  /** The tab over the field that holds every job still running in the background. */
  backgroundJobs: string
  /** How many jobs that tab holds, for the reader who cannot see the number on it. */
  backgroundJobsCount: (count: number) => string
  /**
   * One background job's own stop, `label` being the engine's description of the job. It is the
   * button's accessible name rather than visible text, because the panel already states the job.
   */
  backgroundJobStop: (label: string) => string

  /** The dialogs the engine asks through. */
  dialogApprove: string
  dialogDeny: string
  dialogSubmit: string
  dialogAnswer: string
  dialogPlaceholder: string
  dialogFromEngine: string
  /** The dismiss control on the engine's one-question dialogs. */
  dialogCancel: string

  /** The composer. */
  composerPlaceholder: string
  composerModelLabel: string
  composerThinkingLabel: string
  composerActions: readonly { value: string; label: string }[]
  /** Prompts the reader sent while the agent was working, waiting for the turn to end. */
  queueTitle: (count: number) => string
  queueRemove: string
  /** The queue's interrupt action, and what the row says while there is no turn to end. */
  queueInterrupt: string
  queueInterruptUnavailable: string
  /** A press that could not queue anything because the queue is already full. */
  queueFull: (max: number) => string
  /** What a press on the send control will do while a turn runs: wait for it, or join it. */
  sendQueue: string
  sendSteer: string

  /** The files a prompt carries: the ➕, its picker, the chips, and the drop the field accepts. */
  addFiles: string
  chooseFiles: string
  attachmentRemove: string
  /** The desktop refused a folder: an attachment is a file, and the chip line says so. */
  droppedDirectory: string
  /** A pasted file past the desktop's own size budget, named as the clipboard named it. */
  attachmentTooLarge: (name: string) => string
  /** What the field says while a dragged file is over it. */
  dropFiles: string
  /**
   * The picture a chip opens: the gesture's name, the overlay's dismiss, and the read on its way.
   *
   * The viewer shows a file's own bytes at the size of the window, because the hover card is a
   * glance and a screenshot's text is not readable in it — the same reason the chip's click opens
   * this rather than the card.
   */
  attachmentView: string
  attachmentClose: string
  attachmentLoading: string
  /**
   * A stop that ended nothing: the control was drawn on a conversation already at rest.
   *
   * Worded here rather than by the store, because the store cannot reach the language the screen is
   * in — every other notice carries the desktop's or the engine's own words, and this one is the
   * app's own.
   */
  stopFoundNothing: string
  /**
   * A stop withdrew the reader's own queued message before aborting, and the composer has it back.
   *
   * The words are the reader's and were never delivered, so the alternative - dropping them with the
   * turn - would lose input nobody sent.
   */
  restoredPrompts: string
  /**
   * The stop a reader pressed is still on its way to the host.
   *
   * The stop waits for the engine to reach idle before it answers, which can be seconds: a control
   * that keeps taking presses in that window sends one stop per press, and every press after the
   * first is answered by work that is already stopping. The label here is what the control says
   * instead of taking another one.
   */
  stopPending: string
  /**
   * A stop that could not end everything: the line naming what is still running, and the button on
   * it that takes the conversation's host session down (the stall row's own `stallReclaim`, at the
   * reader's ask rather than after a silence nobody answered).
   *
   * A turn that ignores its abort is not something a second press can end: the host waits out its
   * window, answers with the turn named in `remaining`, and the engine is still inside the frame it
   * cannot leave. The forced stop is the one lever that reaches it — the host disposes that session,
   * keeps the transcript, and the next open loads the conversation back
   * (`host/src/session-files.ts`).
   */
  stopLeftWork: (count: number) => string
  forceStop: string
  /** What the conversation says once the forced stop has put its history back. */
  forceStopped: string
  forceStopFailed: (reason: string) => string
  /**
   * A conversation whose turn has produced nothing for a long time: the row over the field, and the
   * two controls on it. `minutes` is whole minutes since the last thing the engine said.
   */
  stallTitle: (minutes: number) => string
  stallReclaim: string
  stallKeepWaiting: string
  /** What the conversation says after the reclaim put its history back on screen. */
  stallReclaimed: string
  /** The reclaim itself failed; the engine's own words follow this sentence. */
  stallReclaimFailed: (reason: string) => string
  /**
   * The mode strip at the foot of the field: the group's name, one label and one explanation per
   * mode, and the reports behind their tabs.
   */
  modeStripLabel: string
  goalTitle: string
  goalModeHint: string
  planModeTitle: string
  planModeHint: string
  vibeTitle: string
  vibeModeHint: string
  loopTitle: string
  loopModeHint: string
  loopPrompt: string
  loopLimit: string
  loopCondition: string
  loopNoPrompt: string
  loopPaused: string
  goalObjective: string
  goalStatus: string
  goalTokens: string
  goalTime: string
  /** Appended to the goal's status word while the goal is paused. */
  goalPausedSuffix: string
  goalActionPause: string
  goalActionResume: string
  goalActionDrop: string
  planActionReview: string
  planActionLeave: string
  vibeActionExit: string
  loopActionOff: string
  /** The side question's tab and panel. */
  btwTitle: string
  btwRunning: string
  btwWaiting: string
  btwEmpty: string
  btwCancel: string
  btwClose: string
  btwStatus: (status: string) => string
  planFile: string
  vibeEmpty: string
  vibeWorkerIdle: string
  vibeWorkerTurns: (count: number) => string
  vibeWorkerQueued: (count: number) => string
}

export const COPY: Localized<HomeCopy> = {
  en: {
    appName: "Omp Desktop",
    toggleSidebar: "Toggle sidebar",
    collapseSidebarHint: "Collapse sidebar · Ctrl B",
    expandSidebarHint: "Expand sidebar · Ctrl B",
    menuLabel: "Menu",
    menuFile: "File",
    menuView: "View",
    menuHelp: "Help",
    menuLockedHint: "Available once this conversation has a message",
    menuReload: "Reload",
    menuAbout: "About",
    menuCheckUpdates: "Check for updates",
    menuCheckUpdatesPending: "Updates are not available in this build yet.",
    windowMinimize: "Minimize",
    windowMaximize: "Maximize",
    windowRestore: "Restore",
    windowClose: "Close",
    sessionMenu: {
      label: "Conversation actions",
      rename: "Rename",
      pin: "Pin",
      unpin: "Unpin",
      branch: "Branch conversation",
      copyAll: "Copy the whole conversation as Markdown",
      copySummary: "Copy the final summary only",
      copyId: "Copy session ID",
      export: "Export conversation",
      archive: "Archive",
      unarchive: "Unarchive",
      archivedNotice: "Conversation archived",
      unarchivedNotice: "Conversation restored",
      flagFailed: "Could not update this conversation.",
      copied: "Copied",
      copyFailed: "Could not copy this conversation.",
    },
    sidebarLabel: "Agent workspace",
    actionNewTask: "New conversation",
    actionSettings: "Settings",
    projectsLabel: "Conversations",
    resourcesLabel: "Conversation list",
    newSessionInWorkspace: "New conversation in this workspace",
    expandSessions: "Show more",
    collapseSessions: "Show less",
    showArchived: "Show archived",
    hideArchived: "Hide archived",
    branchPickerLabel: "Switch branch",
    branchFilter: "Find a branch to check out",
    branchesLabel: "Branches",
    branchDetached: "Detached HEAD",
    branchNoMatches: "No matching branch",
    branchCurrent: "Checked out",
    branchSync: (ahead, behind) => `${ahead} ahead, ${behind} behind`,

    addWorkspace: "Open folder",
    chooseWorkspace: "Choose workspace",
    cancel: "Cancel",
    menuRename: "Rename",
    menuRemove: "Remove workspace",
    menuReveal: "Show in file manager",
    menuDeleteSession: "Delete conversation",
    removeWorkspaceTitle: "Remove this workspace?",
    removeWorkspaceBody: (name) =>
      `${name} is removed from this app and its open conversations are closed. The folder itself is left untouched.`,
    renameWorkspaceTitle: (name) => `Rename ${name}`,
    workspaceEmptyTitle: "No workspace yet",
    workspaceEmptyHint: "Open a folder to give the agent something to work in.",
    workspaceLoading: "Loading workspaces",
    workspaceMissing: "Folder not found",
    searchSessions: "Search conversations",
    searchSessionsPlaceholder: "Search titles and messages…",
    searchSessionsEmpty: "No conversation matches.",
    searchSessionsContent: "In messages",
    relativeTime: {
      now: "now",
      minutes: (n) => `${n}m`,
      hours: (n) => `${n}h`,
      days: (n) => `${n}d`,
      months: (n) => `${n}mo`,
      years: (n) => `${n}y`,
    },
    untitledSession: "New conversation",
    sessionListFailed: "Conversations could not be read",
    retryAction: "Retry",

    headerFallback: "No conversation",
    headerUntitled: "New conversation",
    headerStreaming: "Working",
    headerIdle: "Ready",
    headerRetrying: (attempt, max) => `Retrying (${attempt}/${max})`,

    railMessage: "Message",
    railItemLabel: (sender, index, total) => `Go to ${sender} message ${index} of ${total}`,
    scrollToBottom: "Back to the newest",

    youLabel: "You",
    agentLabel: "Agent",
    nowLabel: "Now",
    sentLabel: "Sent",
    thinkingLabel: "Thinking",
    thinkingToggle: "Show the agent's reasoning",
    workingLabel: "Working…",
    retryingLabel: (attempt, max) => `Reconnecting… ${attempt}/${max}`,

    conversationLoading: "Reading the conversation",
    conversationLoadProgress: (loaded, total) => `${loaded} of ${total} messages`,
    conversationFailed: "The conversation could not be read.",
    openFailed: "The conversation could not be opened.",
    sessionUnknownHint:
      "This conversation is not in the workspace's list any more. Refresh the list and try again.",
    subagentLoading: "Reading the subagent's conversation",
    subagentNotFound: "This subagent's transcript was not found.",
    turnStopped: "Stopped.",
    turnFailed: "The turn failed.",
    turnMiscall:
      "The model wrote a tool call the engine could not read, so no tool ran and this step has no answer.",
    strayCallNotRun: "Not run",
    strayCallBody:
      "The model wrote this call as message markup, so the engine did not execute it.",

    copyAction: "Copy",
    copiedAction: "Copied",
    copyFailed: "Copy failed",
    continueFromHere: "Continue from here",
    rewindMessage: "Rewind message",
    rewindTitle: "Rewind",
    rewindBody:
      "This message and everything after it leave this conversation — no copy of it is kept — and the message's text goes back into the input box. Files and code already changed are not restored.",
    rewindConfirm: "Rewind",
    expandMessage: "Show more",
    collapseMessage: "Show less",
    usageLabel: (total) => `Usage ${total} tok`,
    usageDetail: (input, output) => `Input ${input} · Output ${output}`,
    usageDetailCached: (input, output, cache) =>
      `Input ${input} · Output ${output} · ${cache} re-read from cache (not counted)`,
    ranForLabel: (duration) => `Ran for ${duration}`,
    tokensPerSecond: (tps) => `${tps} tok/s`,

    railReminder: "Rule reminder",
    toolCalls: (count) => (count === 1 ? "1 call" : `${count} calls`),
    toolSucceeded: (count) => `${count} succeeded`,
    toolFailedCount: (count) => `${count} failed`,
    toolRunning: "Running",
    toolDone: "Done",
    toolIdle: "Idle",
    toolFailed: "Failed",
    toolArgs: "Arguments",
    toolResult: "Result",
    toolEmptyResult: "No output.",
    toolMinimized: (summary) => `Minimized: ${summary}`,
    toolImages: "Images",
    imageOpen: (index, total) => `View image ${index} of ${total}`,
    imageClose: "Close image",
    imagePrevious: "Previous image",
    imageNext: "Next image",
    imageFailed: "This image could not be displayed.",
    toolSources: "Sources",
    taskAgents: (count) => (count === 1 ? "1 subagent" : `${count} subagents`),
    taskAgentDetached: "Background",
    taskAgentTruncated: "Output truncated",
    taskAgentExit: (code) => `exit ${code}`,
    taskAgentOpen: "Open subagent",

    planTitle: "Plan",
    blocksLabel: "Plan and background work",
    planProgress: (completed, total) => `${completed} of ${total} tasks completed`,
    backgroundJobKinds: { bash: "command", eval: "eval", task: "subagent" },
    backgroundJobs: "Background tasks",
    backgroundJobsCount: (count) =>
      count === 1 ? "1 background task" : `${count} background tasks`,
    backgroundJobStop: (label) => `Stop “${label}”`,

    dialogApprove: "Approve",
    dialogDeny: "Deny",
    dialogSubmit: "Send",
    dialogAnswer: "Answer",
    dialogPlaceholder: "Type an answer…",
    dialogFromEngine: "The agent needs an answer",
    dialogCancel: "Cancel",

    composerPlaceholder: "Ask the agent to continue…",
    composerModelLabel: "Model",
    composerThinkingLabel: "Thinking",
    composerActions: [
      { value: "attach", label: "Attach file" },
      { value: "project", label: "Add project context" },
      { value: "skill", label: "Use a skill" },
    ],
    queueTitle: (count) => (count === 1 ? "1 prompt waiting" : `${count} prompts waiting`),
    queueRemove: "Remove from the queue",
    queueInterrupt: "End the running turn and send this message",
    queueInterruptUnavailable: "Available while a turn is running",
    queueFull: (max) =>
      max === 1
        ? "One message is already waiting; it has to go before another can be queued."
        : `${max} messages are already waiting; one has to go before another can be queued.`,
    sendQueue: "Queue message",
    sendSteer: "Steer message",

    addFiles: "Add files or run commands",
    chooseFiles: "Choose files",
    attachmentRemove: "Remove attachment",
    droppedDirectory: "Folders are not supported as attachments",
    attachmentTooLarge: (name) => `File is too large to attach: ${name}`,
    dropFiles: "Release to attach",
    attachmentView: "View image",
    attachmentClose: "Close image preview",
    attachmentLoading: "Reading the image…",
    stopFoundNothing: "There was nothing left to stop.",
    restoredPrompts: "Unsent messages were returned to the composer.",
    stopPending: "Stopping…",
    stopLeftWork: (count) =>
      count === 1 ? "1 piece of work is still running." : `${count} pieces of work are still running.`,
    forceStop: "Force stop",
    forceStopped: "The conversation was force-stopped. Its history is still here.",
    forceStopFailed: (reason) => `Could not force the stop: ${reason}`,
    stallTitle: (minutes) =>
      minutes === 1 ? "No response for 1 minute" : `No response for ${minutes} minutes`,
    stallReclaim: "Reclaim conversation",
    stallKeepWaiting: "Keep waiting",
    stallReclaimed:
      "The conversation stopped responding and was reclaimed. Its history is still here.",
    stallReclaimFailed: (reason) => `Could not reclaim the conversation: ${reason}`,
    modeStripLabel: "Modes",
    goalTitle: "Goal",
    goalModeHint:
      "Goal mode: the agent keeps working toward one objective across turns. Run /goal to manage it.",
    planModeTitle: "Plan",
    planModeHint:
      "Plan mode: the agent writes a plan file and changes nothing else. Approving the plan starts the work and leaves the mode.",
    vibeTitle: "Vibe",
    vibeModeHint:
      "Vibe mode: you direct fast and good workers; this conversation verifies and coordinates. Run /vibe to exit.",
    goalObjective: "Objective",
    goalStatus: "Status",
    goalTokens: "Tokens",
    goalTime: "Time",
    goalPausedSuffix: " (paused)",
    goalActionPause: "Pause goal",
    goalActionResume: "Resume goal",
    goalActionDrop: "Drop goal",
    planActionReview: "Review plan",
    planActionLeave: "Leave plan mode",
    vibeActionExit: "Stop workers and exit",
    loopActionOff: "Turn off loop",
    btwTitle: "Side question",
    btwRunning: "Answering",
    btwWaiting: "Thinking…",
    btwEmpty: "No answer.",
    btwCancel: "Cancel",
    btwClose: "Close",
    btwStatus: (status) => status,
    loopTitle: "Loop",
    loopModeHint:
      "Loop mode: the prompt repeats after every turn until its bound or condition says stop. Run /loop to disable it.",
    loopPrompt: "Prompt",
    loopLimit: "Bound",
    loopCondition: "Condition",
    loopNoPrompt: "Waiting for the next prompt to repeat.",
    loopPaused: "Paused by a stop. Run /loop to arm it again.",
    planFile: "Plan file",
    vibeEmpty: "No workers yet. Ask the director to start one.",
    vibeWorkerIdle: "Idle",
    vibeWorkerTurns: (count) => `${count} ${count === 1 ? "turn" : "turns"}`,
    vibeWorkerQueued: (count) => `${count} queued`,
  },
  zh: {
    appName: "Omp Desktop",
    toggleSidebar: "折叠侧边栏",
    collapseSidebarHint: "收起侧边栏 · Ctrl B",
    expandSidebarHint: "展开侧边栏 · Ctrl B",
    menuLabel: "菜单",
    menuFile: "文件",
    menuView: "视图",
    menuHelp: "帮助",
    menuLockedHint: "发一条消息后可用",
    menuReload: "刷新",
    menuAbout: "关于",
    menuCheckUpdates: "检查更新",
    menuCheckUpdatesPending: "这个版本还没有更新通道。",
    windowMinimize: "最小化",
    windowMaximize: "最大化",
    windowRestore: "还原",
    windowClose: "关闭",
    sessionMenu: {
      label: "会话操作",
      rename: "重命名",
      pin: "置顶",
      unpin: "取消置顶",
      branch: "分叉会话",
      copyAll: "复制全部对话为 Markdown",
      copySummary: "仅复制最终总结",
      copyId: "复制 Session ID",
      export: "导出会话",
      archive: "归档",
      unarchive: "取消归档",
      archivedNotice: "会话已归档",
      unarchivedNotice: "会话已取消归档",
      flagFailed: "无法更新这个会话。",
      copied: "已复制",
      copyFailed: "无法复制这段对话。",
    },
    sidebarLabel: "智能体工作区",
    actionNewTask: "新建对话",
    actionSettings: "设置",
    projectsLabel: "会话",
    resourcesLabel: "会话列表",
    newSessionInWorkspace: "在此工作区新建会话",
    expandSessions: "展开更多",
    collapseSessions: "收起",
    showArchived: "显示已归档",
    hideArchived: "隐藏已归档",
    branchPickerLabel: "切换分支",
    branchFilter: "选择要签出的分支或标记",
    branchesLabel: "分支",
    branchDetached: "已分离 HEAD",
    branchNoMatches: "没有匹配的分支",
    branchCurrent: "当前分支",
    branchSync: (ahead, behind) => `领先 ${ahead}，落后 ${behind}`,

    addWorkspace: "打开文件夹",
    chooseWorkspace: "选择工作区",
    cancel: "取消",
    menuRename: "重命名",
    menuRemove: "移除工作区",
    menuReveal: "在文件管理器中显示",
    menuDeleteSession: "删除对话",
    removeWorkspaceTitle: "移除这个工作区？",
    removeWorkspaceBody: (name) =>
      `${name} 会从本应用中移除，它已打开的会话会被关闭。文件夹本身不会被改动。`,
    renameWorkspaceTitle: (name) => `重命名 ${name}`,
    workspaceEmptyTitle: "还没有工作区",
    workspaceEmptyHint: "打开一个文件夹，智能体才有可工作的目录。",
    workspaceLoading: "正在加载工作区",
    workspaceMissing: "文件夹不存在",
    searchSessions: "搜索对话",
    searchSessionsPlaceholder: "搜索标题与消息内容…",
    searchSessionsEmpty: "没有匹配的对话。",
    searchSessionsContent: "消息内容",
    relativeTime: {
      // The magnitude buckets read the same in both languages — `29m` / `10h` / `10d` — because a
      // rail's trailing column is narrow and a spelled-out unit wraps under it.
      now: "刚刚",
      minutes: (n) => `${n}m`,
      hours: (n) => `${n}h`,
      days: (n) => `${n}d`,
      months: (n) => `${n}mo`,
      years: (n) => `${n}y`,
    },
    untitledSession: "新对话",
    sessionListFailed: "会话列表读取失败",
    retryAction: "重试",

    headerFallback: "未打开会话",
    headerUntitled: "新对话",
    headerStreaming: "正在工作",
    headerIdle: "就绪",
    headerRetrying: (attempt, max) => `正在重试（${attempt}/${max}）`,

    railMessage: "消息",
    railItemLabel: (sender, index, total) => {
      const from = sender === "user" ? "用户" : sender === "assistant" ? "智能体" : "对话";
      return `前往第 ${index} 条${from}消息，共 ${total} 条`;
    },
    scrollToBottom: "回到底部",

    youLabel: "你",
    agentLabel: "智能体",
    nowLabel: "刚刚",
    sentLabel: "已发送",
    thinkingLabel: "思考",
    thinkingToggle: "查看智能体的推理过程",
    workingLabel: "工作中…",
    retryingLabel: (attempt, max) => `重新连接中… ${attempt}/${max}`,

    conversationLoading: "正在读取会话",
    conversationLoadProgress: (loaded, total) => `已读取 ${loaded} / ${total} 条消息`,
    conversationFailed: "无法读取该会话。",
    openFailed: "无法打开该会话。",
    sessionUnknownHint: "这个会话已经不在该工作区的列表里了，刷新列表后再试。",
    subagentLoading: "正在读取子代理的对话",
    subagentNotFound: "找不到这个子代理的对话记录。",
    turnStopped: "已停止生成。",
    turnFailed: "这一轮失败了。",
    turnMiscall: "模型发出的工具调用格式无效，没有执行任何工具，这一步也就没有正文。",
    strayCallNotRun: "未执行",
    strayCallBody: "模型把这次调用写成了消息标记，引擎没有执行它。",

    copyAction: "复制",
    copiedAction: "已复制",
    copyFailed: "复制失败",
    continueFromHere: "从这里继续",
    rewindMessage: "撤回消息",
    rewindTitle: "撤销",
    rewindBody:
      "撤销后，这条消息及之后的会话内容会从这份会话中移除（不会另存一份），这条消息的原文会放回输入框；已修改的文件和代码不受影响。",
    rewindConfirm: "确认",
    expandMessage: "展开",
    collapseMessage: "收起",
    usageLabel: (total) => `用量 ${total} tok`,
    usageDetail: (input, output) => `输入 ${input} · 输出 ${output}`,
    usageDetailCached: (input, output, cache) =>
      `输入 ${input} · 输出 ${output} · 缓存读取 ${cache}（同一段上下文的重读，不计入用量）`,
    ranForLabel: (duration) => `用时 ${duration}`,
    tokensPerSecond: (tps) => `${tps} tok/s`,

    railReminder: "规则提醒",
    toolCalls: (count) => `${count} 次调用`,
    toolSucceeded: (count) => `${count} 成功`,
    toolFailedCount: (count) => `${count} 失败`,
    toolRunning: "运行中",
    toolDone: "已完成",
    toolIdle: "未运行",
    toolFailed: "失败",
    toolArgs: "参数",
    toolResult: "结果",
    toolEmptyResult: "没有输出。",
    toolMinimized: (summary) => `已压缩：${summary}`,
    toolImages: "图片",
    imageOpen: (index, total) => `查看第 ${index} 张图片，共 ${total} 张`,
    imageClose: "关闭图片",
    imagePrevious: "上一张图片",
    imageNext: "下一张图片",
    imageFailed: "这张图片无法显示。",
    toolSources: "来源",
    taskAgents: (count) => `${count} 个子代理`,
    taskAgentDetached: "后台",
    taskAgentTruncated: "输出被截断",
    taskAgentExit: (code) => `退出 ${code}`,
    taskAgentOpen: "打开子代理",

    planTitle: "计划",
    blocksLabel: "计划与后台工作",
    planProgress: (completed, total) => `已完成 ${completed} / ${total} 个任务`,
    backgroundJobKinds: { bash: "命令", eval: "求值", task: "子代理" },
    backgroundJobs: "后台任务",
    backgroundJobsCount: (count) => `${count} 个后台任务`,
    backgroundJobStop: (label) => `停止「${label}」`,

    dialogApprove: "批准",
    dialogDeny: "拒绝",
    dialogSubmit: "发送",
    dialogAnswer: "回答",
    dialogPlaceholder: "输入回答…",
    dialogFromEngine: "智能体在等待回答",
    dialogCancel: "取消",

    composerPlaceholder: "让智能体继续…",
    composerModelLabel: "模型",
    composerThinkingLabel: "思考",
    composerActions: [
      { value: "attach", label: "添加附件" },
      { value: "project", label: "添加项目上下文" },
      { value: "skill", label: "使用技能" },
    ],
    queueTitle: (count) => `${count} 条消息排队等待发送`,
    queueRemove: "从队列中移除",
    queueInterrupt: "打断当前回合并发送这条消息",
    queueInterruptUnavailable: "仅运行中的回合可打断发送",
    queueFull: (max) => `队列已满（${max} 条），先发走一条再排队。`,
    sendQueue: "排队发送",
    sendSteer: "插话发送",

    addFiles: "添加文件或调用指令",
    chooseFiles: "选择文件",
    attachmentRemove: "移除附件",
    droppedDirectory: "暂不支持将文件夹作为附件",
    attachmentTooLarge: (name) => `文件过大，无法添加：${name}`,
    dropFiles: "松开以添加文件",
    attachmentView: "查看图片",
    attachmentClose: "关闭图片预览",
    attachmentLoading: "正在读取图片…",
    stopFoundNothing: "已经没有可以停止的工作了。",
    restoredPrompts: "未发送的消息已放回输入框。",
    stopPending: "正在停止…",
    stopLeftWork: (count) => `仍有 ${count} 项工作没有停止。`,
    forceStop: "强制停止",
    forceStopped: "已强制停止该对话，历史记录仍然保留。",
    forceStopFailed: (reason) => `强制停止失败：${reason}`,
    stallTitle: (minutes) => `已 ${minutes} 分钟没有响应`,
    stallReclaim: "回收对话",
    stallKeepWaiting: "继续等待",
    stallReclaimed: "对话长时间没有响应，已回收并重新载入，历史记录保留。",
    stallReclaimFailed: (reason) => `回收失败：${reason}`,
    modeStripLabel: "模式",
    goalTitle: "目标",
    goalModeHint: "目标模式：智能体跨轮持续推进同一个目标。用 /goal 管理。",
    planModeTitle: "计划",
    planModeHint:
      "计划模式：智能体只写计划文件，不改动代码。批准计划后开始实施并自动退出该模式。",
    vibeTitle: "Vibe",
    vibeModeHint: "Vibe 模式：你指挥 fast / good 工人，这段对话负责核对与协调。再次输入 /vibe 退出。",
    goalObjective: "目标",
    goalStatus: "状态",
    goalTokens: "Token",
    goalTime: "用时",
    goalPausedSuffix: "（已暂停）",
    goalActionPause: "暂停目标",
    goalActionResume: "继续目标",
    goalActionDrop: "放弃目标",
    planActionReview: "审查计划",
    planActionLeave: "退出计划模式",
    vibeActionExit: "停止工人并退出",
    loopActionOff: "关闭循环",
    btwTitle: "侧问",
    btwRunning: "回答中",
    btwWaiting: "思考中…",
    btwEmpty: "没有回答。",
    btwCancel: "取消",
    btwClose: "关闭",
    btwStatus: (status) => status,
    loopTitle: "循环",
    loopModeHint: "循环模式：这段提示在每轮结束后重复，直到上限或条件叫停。再次输入 /loop 关闭。",
    loopPrompt: "提示",
    loopLimit: "上限",
    loopCondition: "条件",
    loopNoPrompt: "等待下一条提示作为循环内容。",
    loopPaused: "已被停止中断；重新输入 /loop 再次启用。",
    planFile: "计划文件",
    vibeEmpty: "还没有工人。让总监启动一个。",
    vibeWorkerIdle: "空闲",
    vibeWorkerTurns: (count) => `${count} 轮`,
    vibeWorkerQueued: (count) => `${count} 条排队`,
  },
};
