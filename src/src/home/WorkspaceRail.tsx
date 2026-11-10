import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronUp,
  FolderKanban,
  FolderOpen,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  Settings,
  Store,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AISidebar, ResourceMenuAction, type SidebarResource, type SidebarResourceMenuControls, type SidebarResourceMove } from "@/components/agents/ai-sidebar";
import { LoadingGrid } from "@/components/agents/loading-states/loading-grid";
import { PluginPageIcon } from "@/components/plugins/plugin-page-icon";
import { Button } from "@/components/motion/button";
import { Tooltip } from "@/components/motion/tooltip";
import {
  AnimatedSidebar,
  AnimatedSidebarContent,
  AnimatedSidebarFooter,
  AnimatedSidebarGroup,
  AnimatedSidebarGroupContent,
  AnimatedSidebarGroupLabel,
  AnimatedSidebarRail,
} from "@/components/motion/animated-sidebar";
import {
  AnimatedSidebarMenu,
  AnimatedSidebarMenuButton,
  AnimatedSidebarMenuItem,
} from "@/components/motion/animated-sidebar-menu";
import { useCopy } from "@/lib/i18n";
import { NO_HOVER_GROWTH } from "@/lib/hover-motion";
import { cn } from "@/lib/utils";
import { parseSidebarNodeId, buildSidebarTree, movedList, openSessionsOf, workspaceNodeId, type FinishedTurn } from "@/home/sidebar-tree";
import type { SessionOrderEntry, TurnOutcome } from "@/api/session-types";
import { sessionOrderGet, sessionOrderSet } from "@/api/agent";
import { COPY } from "@/home/homeCopy";
import { ConversationMenuItems } from "@/home/ConversationMenu";
import { ConversationSearchRow } from "@/home/ConversationSearch";
import { formatRelativeTime } from "@/home/conversation-format";
import { workspaceRailBody } from "@/home/workspace-rail-state";
import { loadSessionList, loadSessionLists } from "@/state/session-lists";
import { isListedSession } from "@/state/session-rows";
import { runningSessionsKey } from "@/state/work-readings";
import { renameSessionById } from "@/state/session-actions";
import {
  selectSession,
  sessionStore,
  startNewSession,
  startSessionIn,
} from "@/state/session-store";
import { openPluginTab } from "@/state/panel-store";
import { usePluginPages } from "@/state/plugin-pages";
import { useStoreSelector } from "@/state/store";
import {
  activateWorkspace,
  ensureWorkspacesLoaded,
  pickAndAddWorkspace,
  removeWorkspace,
  renameWorkspace,
  reorderWorkspaces,
  revealWorkspace,
  workspaceStore,
} from "@/state/workspace-store";

/**
 * How many of a workspace's conversations the rail shows at a time.
 *
 * The desktop app's own preview limit. *Show more* adds this many again; *Show less* comes straight
 * back to one page.
 */
const SESSION_PAGE = 5;

/** What a workspace nobody has rearranged reads by: no arrangement at all. */
const NO_ORDER: readonly SessionOrderEntry[] = [];

/**
 * A conversation row's own glyph.
 *
 * The rail's rows are workspaces and the conversations in them, so the leaf is a conversation, not a
 * file: the folder glyph the tree draws by default would name the wrong thing. Workspaces keep it.
 */
function renderSidebarIcon(item: SidebarResource): ReactNode {
  return item.kind === "project" ? (
    <FolderKanban className="size-4" />
  ) : (
    <MessageSquare className="size-3.5" />
  );
}

export interface WorkspaceRailProps {
  /** The rail's own settings entry, at the foot of the sidebar. */
  onOpenSettings?: () => void;
  /** The rail's own door to the plugin marketplace, under conversation search. */
  onOpenMarket?: () => void;
  /** Whether the marketplace is the surface on screen, so its row reads as chosen. */
  marketOpen?: boolean;
  /** A conversation was opened from the rail: the shell leaves the marketplace for it. */
  onOpenConversation?: () => void;
  className?: string;
}

/**
 * The left rail: the workspaces the desktop knows, and the conversations in them.
 *
 * It subscribes to the session store on its own narrow readings — the lists, the read marks, which
 * conversation is on screen and which one is running — rather than to the whole state. A turn
 * streaming into the conversation column replaces the transcript on every frame, and a rail that
 * re-read that state would rebuild the whole tree with it: the rail's own rows change on the
 * moments a conversation is opened or a turn begins, and on nothing in between.
 */
export function WorkspaceRail({
  onOpenSettings,
  onOpenMarket,
  marketOpen = false,
  onOpenConversation,
  className,
}: WorkspaceRailProps) {
  const copy = useCopy(COPY);
  const workspaces = useStoreSelector(workspaceStore, (state) => state);
  const railBody = workspaceRailBody(workspaces);
  const sessions = useStoreSelector(sessionStore, (state) => state.sessions);
  const readMarks = useStoreSelector(sessionStore, (state) => state.readMarks);
  const activeSessionId = useStoreSelector(sessionStore, (state) => state.activeId);
  const pluginPages = usePluginPages();
  const pluginLaunchers = useMemo(
    () => [...pluginPages.sidebar, ...pluginPages.views],
    [pluginPages.sidebar, pluginPages.views],
  );
  // Every conversation whose turn is in flight, not only the one on screen: a turn keeps running
  // after the reader switches away, and its row has to keep saying so. The rule is the turn alone
  // (`state/work-readings.ts::runningSessionsKey`) — not work that outlives the answer, which would
  // leave a spinner on a row for as long as a leftover job lives. The selector returns a joined
  // string because `useStoreSelector` may only return a field or a reference the state already
  // holds; the Set is rebuilt only when the membership actually changes.
  const runningKey = useStoreSelector(sessionStore, (state) => runningSessionsKey(state.records));
  const runningSessionIds = useMemo(
    () => new Set(runningKey === "" ? [] : runningKey.split(",")),
    [runningKey],
  );
  // The endings this process watched, keyed by session, so a row whose workspace list still carries
  // the turn's starting status can draw the ending rather than a stale "unfinished" arc. The
  // selector hands over a string for the same reason the running set does.
  const finishedKey = useStoreSelector(sessionStore, (state) => {
    const parts: string[] = [];
    for (const [id, record] of Object.entries(state.records)) {
      const turn = record.lastTurn;
      if (turn !== null) parts.push(`${id}:${turn.outcome}:${turn.at}:${turn.stopped ? 1 : 0}`);
    }
    return parts.sort().join(",");
  });
  const finishedTurns = useMemo(() => {
    const turns = new Map<string, FinishedTurn>();
    if (finishedKey === "") return turns;
    for (const part of finishedKey.split(",")) {
      const fields = part.split(":");
      const [id, outcome, at, seen] = fields;
      if (id === undefined || at === undefined) continue;
      turns.set(id, {
        outcome: outcome as TurnOutcome,
        at: Number(at),
        seen: seen === "1",
      });
    }
    return turns;
  }, [finishedKey]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  /** How many conversations each workspace shows; absent means one page. */
  const [visibleCounts, setVisibleCounts] = useState<Record<number, number>>({});
  /**
   * The order each workspace's conversations were dragged into, once read.
   *
   * Absent for a workspace the reader has never rearranged: the tree then reads its list by
   * recency, which is the order it has always had. Kept here rather than in the session store
   * because it is one reading of one list's arrangement - every row it names is still the list's
   * own (`state/session-lists.ts`), and nothing outside this rail draws by it.
   */
  const [sessionOrders, setSessionOrders] = useState<Record<number, readonly SessionOrderEntry[]>>({});
  /**
   * Whether the rail also draws the conversations the reader put away.
   *
   * Off to begin with: an archived row left the list on purpose, so drawing it anyway would make
   * archiving a decoration. The switch above the tree turns them on for the whole rail — a reader
   * looking for one archived conversation is looking for the group of them, not for this
   * workspace's.
   */
  const [showArchived, setShowArchived] = useState(false);
  /** How many conversations of every workspace are put away, for the switch's own presence. */
  const archivedTotal = useMemo(() => {
    let count = 0;
    for (const list of Object.values(sessions)) {
      for (const row of list.items) if (row.archived) count += 1;
    }
    return count;
  }, [sessions]);

  useEffect(() => {
    void ensureWorkspacesLoaded();
  }, []);

  // The first workspace the store has is the one to open on: with nothing active the conversation
  // column would have nothing to say and the composer nothing to send to.
  useEffect(() => {
    if (workspaces.status !== "ready" || workspaces.activeId !== null) return;
    const first = workspaces.items[0];
    if (first) void activateWorkspace(first.id);
  }, [workspaces.activeId, workspaces.items, workspaces.status]);

  // Every workspace's conversations, not only the active one's: the rail draws a workspace and what
  // is under it, so a collapsed workspace still has to be able to say how many conversations it has.
  const workspaceIds = workspaces.items.map((item) => item.id).join(",");
  useEffect(() => {
    if (workspaces.status !== "ready" || workspaceIds === "") return;
    void loadSessionLists(workspaceIds.split(",").map(Number));
  }, [workspaces.status, workspaceIds]);

  // Each workspace's arrangement is read once, as the workspace appears. Only the ids that are not
  // known yet are asked for: a drag writes its own entry, and re-reading the stored value would
  // take a drag that landed while the read was out back to the list it replaced.
  useEffect(() => {
    if (workspaces.status !== "ready") return;
    const missing = workspaces.items
      .map((item) => item.id)
      .filter((id) => sessionOrders[id] === undefined);
    if (missing.length === 0) return;
    let live = true;
    void Promise.allSettled(
      missing.map(async (id) => [id, await sessionOrderGet(id)] as const),
    ).then((results) => {
      if (!live) return;
      setSessionOrders((current) => {
        const next = { ...current };
        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          const [id, order] = result.value;
          if (next[id] === undefined) next[id] = order;
        }
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, [sessionOrders, workspaces.items, workspaces.status]);

  const tree = useMemo(
    () =>
      buildSidebarTree(workspaces.items, {
        sessions,
        readMarks,
        runningSessionIds,
        finishedTurns,
        timeLabel: (updatedAt) => formatRelativeTime(updatedAt, Date.now(), copy.relativeTime),
        untitledLabel: copy.untitledSession,
        sessionOrder: (workspaceId) => sessionOrders[workspaceId] ?? NO_ORDER,
        visibleCount: (workspaceId) => visibleCounts[workspaceId] ?? SESSION_PAGE,
        showArchived,
      }),
    [
      copy.relativeTime,
      copy.untitledSession,
      readMarks,
      runningSessionIds,
      finishedTurns,
      sessionOrders,
      sessions,
      showArchived,
      visibleCounts,
      workspaces.items,
    ],
  );

  /**
   * The workspace the user is in starts unfolded, so its conversations are on screen without a click.
   */
  const activeNode =
    workspaces.activeId === null ? null : workspaceNodeId(workspaces.activeId);

  /**
   * Which groups the rail has open.
   *
   * The reader's own toggles, plus the workspace they are in: that one opens itself, and the others
   * stay as they were left. The tree used to be remounted whenever the active workspace changed,
   * which is what closed a group the reader had opened somewhere else.
   */
  const [expandedNodes, setExpandedNodes] = useState<readonly string[]>([]);
  // A layout effect because the tree is on screen before a passive effect runs: expanding there
  // would show a collapsed rail for one frame first.
  useLayoutEffect(() => {
    if (activeNode === null) return;
    setExpandedNodes((current) =>
      current.includes(activeNode) ? current : [...current, activeNode],
    );
  }, [activeNode]);

  /**
   * A workspace opens itself when its first conversation arrives.
   *
   * Opening a folder is two answers that land in different orders: the workspace is added (and
   * becomes active) before its conversation list has been read, so the group can be drawn while it
   * still has nothing under it. Waiting for the list is what makes the row that appears a moment
   * later land inside an open group instead of behind a collapsed one — and a new conversation in
   * an empty workspace is the same transition (0 → 1).
   */
  const sessionCounts = useRef<Record<number, number>>({});
  useEffect(() => {
    const activeId = workspaces.activeId;
    if (activeId === null) return;
    // A row the reader put away does not count: a workspace whose conversations were all archived
    // is a workspace with nothing to open, and the archive box appearing under it must not unfold
    // the group as if a conversation had just arrived.
    const items = sessions[activeId]?.items;
    if (items === undefined) return;
    const count = items.filter((row) => !row.archived && isListedSession(row)).length;
    const previous = sessionCounts.current[activeId];
    sessionCounts.current[activeId] = count;
    if (count === 0 || (previous !== undefined && previous > 0)) return;
    const node = workspaceNodeId(activeId);
    setExpandedNodes((current) =>
      current.includes(node) ? current : [...current, node],
    );
  }, [sessions, workspaces.activeId]);

  // The row the rail draws as chosen follows the conversation that is actually open, so a
  // conversation opened from anywhere else — a new one, or the workspace's own newest on a switch —
  // is the one the rail marks.
  useEffect(() => {
    if (workspaces.activeId === null || activeSessionId === null) return;
    setSelectedNode(`${workspaceNodeId(workspaces.activeId)}:${activeSessionId}`);
  }, [activeSessionId, workspaces.activeId]);

  /**
   * Selecting a conversation opens it, in the workspace it belongs to.
   *
   * A workspace row is routed to its own toggle by the tree, so the only rows that reach here are
   * conversations.
   */
  const handleSelect = useCallback((id: string) => {
    const node = parseSidebarNodeId(id);
    if (!node || node.kind !== "session") return;
    setSelectedNode(id);
    onOpenConversation?.();
    void selectSession(node.workspaceId, node.sessionId);
  }, [onOpenConversation]);

  /** A workspace row's own button: a conversation started in that workspace, from the row itself. */
  const renderRowAction = useCallback(
    (item: SidebarResource) => {
      const node = parseSidebarNodeId(item.id);
      if (node?.kind !== "workspace") return null;
      return (
        <Tooltip content={copy.newSessionInWorkspace}>
          <Button
            {...NO_HOVER_GROWTH}
            type="button"
            variant="ghost"
            size="icon"
            draggable={false}
            aria-label={`${copy.newSessionInWorkspace}: ${item.label}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenConversation?.();
              void startSessionIn(node.workspaceId);
            }}
            className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground"
          >
            <MessageSquarePlus className="size-4" />
          </Button>
        </Tooltip>
      );
    },
    [copy.newSessionInWorkspace, onOpenConversation],
  );

  /** The rail's paging: one more page at a time, and straight back to the first. */
  const renderGroupFooter = useCallback(
    (item: SidebarResource) => {
      const node = parseSidebarNodeId(item.id);
      if (node?.kind !== "workspace") return null;
      // A list the desktop could not read says so, and offers the read again: an empty group
      // otherwise looks exactly like a workspace with no conversations, and a host restart can
      // leave one behind with nothing to click (2026-10-20, met while driving the dev instance).
      const list = sessions[node.workspaceId];
      if (list?.status === "error") {
        return (
          <div className="flex items-center gap-1.5 pr-2 pl-3 text-xs text-destructive">
            <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{copy.sessionListFailed}</span>
            <Button
              {...NO_HOVER_GROWTH}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void loadSessionList(node.workspaceId)}
              className="h-6 shrink-0 rounded-lg px-1.5 text-xs font-normal"
            >
              {copy.retryAction}
            </Button>
          </div>
        );
      }
      // The page counts the rows the rail is drawing: an archived conversation that is not on
      // screen is not one *Show more* has to reach.
      const total = (sessions[node.workspaceId]?.items ?? []).filter(
        (row) => isListedSession(row) && (showArchived || !row.archived),
      ).length;
      const shown = visibleCounts[node.workspaceId] ?? SESSION_PAGE;
      if (total <= SESSION_PAGE && shown <= SESSION_PAGE) return null;
      return (
        <SessionGroupFooter
          total={total}
          shown={shown}
          moreLabel={copy.expandSessions}
          lessLabel={copy.collapseSessions}
          onMore={() =>
            setVisibleCounts((counts) => ({
              ...counts,
              [node.workspaceId]: (counts[node.workspaceId] ?? SESSION_PAGE) + SESSION_PAGE,
            }))
          }
          onLess={() =>
            setVisibleCounts((counts) => ({ ...counts, [node.workspaceId]: SESSION_PAGE }))
          }
        />
      );
    },
    [copy.collapseSessions, copy.expandSessions, copy.retryAction, copy.sessionListFailed, sessions, showArchived, visibleCounts],
  );

  const handleRename = useCallback(async (item: SidebarResource, label: string) => {
    const node = parseSidebarNodeId(item.id);
    if (!node) throw new Error("this row has no name to set");
    if (node.kind === "workspace") await renameWorkspace(node.workspaceId, label);
    else await renameSessionById(node.workspaceId, node.sessionId, label);
  }, []);

  /**
   * Where a dragged row may land.
   *
   * The rail is two lists, not one tree: workspaces stand in their own order, and a conversation
   * belongs to exactly one workspace. So a workspace moves among workspaces, and a conversation
   * moves only within the open list of the workspace it is already in — never into another group,
   * never out to the top level (a conversation has none), and never across the pin line, which
   * sorts a row above the rest whatever the arrangement says.
   */
  const canMove = useCallback(
    (move: SidebarResourceMove) => {
      const source = parseSidebarNodeId(move.itemId);
      if (source === null) return false;
      // The foot-of-tree strip appends at the top level: a workspace is already there, and a
      // conversation has no top level of its own.
      if (move.targetId === null || move.position === "inside") return false;
      const target = parseSidebarNodeId(move.targetId);
      if (target === null) return false;
      if (source.kind === "workspace") return target.kind === "workspace";
      if (target.kind !== "session" || target.workspaceId !== source.workspaceId) return false;
      const items = sessions[source.workspaceId]?.items ?? [];
      const from = items.find((row) => row.id === source.sessionId);
      const to = items.find((row) => row.id === target.sessionId);
      if (from === undefined || to === undefined) return false;
      // Archived rows are drawn after the open list, by recency: the arrangement is the open
      // list's, and a row it does not order cannot be dropped among rows it does.
      if (from.archived || to.archived) return false;
      return from.pinned === to.pinned;
    },
    [sessions],
  );

  /**
   * Keep the place a row was dropped in.
   *
   * The tree has already moved the row on screen; this turns that move into the list the store
   * keeps — the whole arrangement, because an order that named only the moved row could not say
   * where it went. A refused write rejects, which is what rolls the row back and says so in the
   * rail's live region.
   */
  const handleMove = useCallback(
    async (move: SidebarResourceMove) => {
      const source = parseSidebarNodeId(move.itemId);
      if (source === null) throw new Error("this row has no place to keep");
      const target = move.targetId === null ? null : parseSidebarNodeId(move.targetId);
      const after = move.position === "after";
      if (source.kind === "workspace") {
        const next = movedList(
          workspaces.items.map((item) => item.id),
          source.workspaceId,
          target?.kind === "workspace" ? target.workspaceId : null,
          after,
        );
        if (next === null) throw new Error("this workspace has nowhere to go");
        await reorderWorkspaces(next);
        return;
      }
      if (target?.kind !== "session") throw new Error("this conversation has nowhere to go");
      const before = sessionOrders[source.workspaceId] ?? NO_ORDER;
      const rows = openSessionsOf(sessions[source.workspaceId]?.items ?? [], before);
      const from = rows.find((row) => row.id === source.sessionId);
      const to = rows.find((row) => row.id === target.sessionId);
      const next =
        from === undefined || to === undefined
          ? null
          : movedList(rows, from, to, after);
      if (next === null) throw new Error("this conversation has nowhere to go");
      // Each entry keeps the time its row carried when it was placed: a conversation written
      // afterwards is newer than its place and returns to the top by recency.
      const entries = next.map((row) => ({ id: row.id, at: row.updatedAt }));
      setSessionOrders((current) => ({ ...current, [source.workspaceId]: entries }));
      try {
        await sessionOrderSet(source.workspaceId, entries);
      } catch (error) {
        setSessionOrders((current) => ({ ...current, [source.workspaceId]: before }));
        throw error;
      }
    },
    [sessionOrders, sessions, workspaces.items],
  );

  const renderMenu = useCallback(
    (item: SidebarResource, controls: SidebarResourceMenuControls) => {
      const node = parseSidebarNodeId(item.id);
      if (!node) return null;
      if (node.kind === "workspace") {
        return (
          <>
            <ResourceMenuAction
              icon={MessageSquarePlus}
              onSelect={() => {
                controls.close();
                onOpenConversation?.();
                void startSessionIn(node.workspaceId);
              }}
            >
              {copy.actionNewTask}
            </ResourceMenuAction>
            <ResourceMenuAction icon={Pencil} onSelect={() => controls.rename()}>
              {copy.menuRename}
            </ResourceMenuAction>
            <ResourceMenuAction
              icon={FolderOpen}
              onSelect={() => {
                controls.close();
                void revealWorkspace(node.workspaceId);
              }}
            >
              {copy.menuReveal}
            </ResourceMenuAction>
            <ResourceMenuAction
              icon={Trash2}
              destructive
              onSelect={() => {
                controls.close();
                void removeWorkspace(node.workspaceId);
              }}
            >
              {copy.menuRemove}
            </ResourceMenuAction>
          </>
        );
      }
      return (
        <ConversationMenuItems
          sessionId={node.sessionId}
          workspaceId={node.workspaceId}
          onRename={() => controls.rename()}
          close={controls.close}
          announce={controls.announce}
        />
      );
    },
    [copy, onOpenConversation],
  );

  const openPluginPage = useCallback(
    (pageKey: string) => {
      if (activeSessionId === null) return;
      onOpenConversation?.();
      openPluginTab(activeSessionId, pageKey);
    },
    [activeSessionId, onOpenConversation],
  );

  return (
    <AnimatedSidebar
      ariaLabel={copy.sidebarLabel}
      collapsible="offcanvas"
      className={cn("min-h-0", className)}
      panelClassName="h-full bg-background"
    >
      <AnimatedSidebarContent className="gap-0 overflow-hidden p-0">
        {/* The rail's first row is nudged down so its label sits on the conversation header's
            line — the two columns then read as one band, without a rule between the rail's own
            two actions. */}
        <div className="shrink-0 px-3 pt-2.5">
          <AnimatedSidebarGroup className="px-1 py-0">
            <AnimatedSidebarGroupContent>
              <AnimatedSidebarMenu className="gap-1">
                <AnimatedSidebarMenuItem>
                  <AnimatedSidebarMenuButton
                    icon={<MessageSquarePlus className="size-4" />}
                    onSelect={() => {
                      onOpenConversation?.();
                      void startNewSession();
                    }}
                    className="font-normal text-foreground"
                  >
                    {copy.actionNewTask}
                  </AnimatedSidebarMenuButton>
                </AnimatedSidebarMenuItem>
                <AnimatedSidebarMenuItem>
                  <ConversationSearchRow
                    workspaces={workspaces.items}
                    sessions={sessions}
                    onOpenConversation={onOpenConversation}
                  />
                </AnimatedSidebarMenuItem>
                <AnimatedSidebarMenuItem>
                  <AnimatedSidebarMenuButton
                    icon={<Store className="size-4" />}
                    isActive={marketOpen}
                    onSelect={onOpenMarket}
                    className="font-normal text-foreground"
                  >
                    {copy.openMarket}
                  </AnimatedSidebarMenuButton>
                </AnimatedSidebarMenuItem>
              </AnimatedSidebarMenu>
            </AnimatedSidebarGroupContent>
          </AnimatedSidebarGroup>
        </div>

        <AnimatedSidebarGroup className="mt-3 min-h-0 flex-1 px-3 py-0">
          <div className="mb-1 flex h-8 items-center justify-between px-2">
            <AnimatedSidebarGroupLabel className="mb-0 h-auto px-0 text-xs font-medium text-muted-foreground normal-case tracking-normal">
              {copy.projectsLabel}
            </AnimatedSidebarGroupLabel>
            <div className="flex items-center gap-0.5">
              {/* The switch only exists while something is archived: an empty "Show archived" reads
                  as a place that is always there rather than a place the reader's own decision
                  created. Pressed state is the icon's own: the archive box lights up with the rows
                  it reveals. */}
              {archivedTotal === 0 ? null : (
                <Tooltip content={showArchived ? copy.hideArchived : copy.showArchived}>
                  <Button
                    {...NO_HOVER_GROWTH}
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={showArchived ? copy.hideArchived : copy.showArchived}
                    aria-pressed={showArchived}
                    onClick={() => setShowArchived((shown) => !shown)}
                    className={cn(
                      "h-7 w-7 rounded-md",
                      showArchived
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Archive className="size-3.5" />
                  </Button>
                </Tooltip>
              )}
              <AddWorkspaceControl />
            </div>
          </div>
          <AnimatedSidebarGroupContent className="relative min-h-0 flex-1 overflow-hidden">
            <div className="h-full overflow-y-auto overscroll-contain pb-8 [overflow-anchor:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {railBody === "error" ? (
                <p className="px-3 py-2 text-xs text-destructive">{workspaces.error?.message}</p>
              ) : railBody === "loading" ? (
                <WorkspaceLoading />
              ) : railBody === "empty" ? (
                <WorkspaceEmpty />
              ) : (
                <AISidebar
                  items={tree}
                  activeId={selectedNode}
                  ariaLabel={copy.resourcesLabel}
                  movable
                  canMove={canMove}
                  onMove={handleMove}
                  expandedIds={expandedNodes}
                  onExpandedChange={setExpandedNodes}
                  onActiveChange={handleSelect}
                  renderIcon={renderSidebarIcon}
                  onRename={handleRename}
                  renderRowAction={renderRowAction}
                  renderGroupFooter={renderGroupFooter}
                  renderMenu={renderMenu}
                />
              )}
            </div>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background to-transparent"
            />
          </AnimatedSidebarGroupContent>
        </AnimatedSidebarGroup>
        {/* The rail lists the pages a plugin contributes, and nothing else: a work-panel tab is
            opened from the column itself (its "+" menu), so the built-in terminal's row was a
            second door to the same surface. Only settings stands under the conversation list
            (2026-10-24, user request). */}
        {pluginLaunchers.length === 0 ? null : (
          <AnimatedSidebarGroup className="shrink-0 px-3 py-2">
            <AnimatedSidebarGroupContent>
              <AnimatedSidebarMenu className="gap-1">
                {pluginLaunchers.map((page) => (
                  <AnimatedSidebarMenuItem key={page.key}>
                    <AnimatedSidebarMenuButton
                      icon={<PluginPageIcon token={page.icon} className="size-4" />}
                      onSelect={() => openPluginPage(page.key)}
                      className="font-normal"
                    >
                      {page.title}
                    </AnimatedSidebarMenuButton>
                  </AnimatedSidebarMenuItem>
                ))}
              </AnimatedSidebarMenu>
            </AnimatedSidebarGroupContent>
          </AnimatedSidebarGroup>
        )}
       </AnimatedSidebarContent>

      <AnimatedSidebarFooter className="p-3">
        <AnimatedSidebarMenu className="gap-1">
          <AnimatedSidebarMenuItem>
            <AnimatedSidebarMenuButton
              icon={<Settings className="size-4" />}
              onSelect={onOpenSettings}
              className="font-normal"
            >
              {copy.actionSettings}
            </AnimatedSidebarMenuButton>
          </AnimatedSidebarMenuItem>
        </AnimatedSidebarMenu>
      </AnimatedSidebarFooter>

      <AnimatedSidebarRail />
    </AnimatedSidebar>
  );
}

function WorkspaceLoading() {
  const copy = useCopy(COPY);
  return (
    <div className="flex items-center justify-center px-3 py-6">
      <LoadingGrid label={copy.workspaceLoading} />
    </div>
  );
}

function WorkspaceEmpty() {
  const copy = useCopy(COPY);
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-6 text-center">
      <AlertTriangle aria-hidden="true" className="size-4 text-muted-foreground" />
      <p className="text-xs font-medium text-foreground">{copy.workspaceEmptyTitle}</p>
      <p className="text-xs text-muted-foreground">{copy.workspaceEmptyHint}</p>
    </div>
  );
}

/**
 * The one place a workspace is added: the desktop's own folder picker.
 *
 * A path is not something to type by hand, so the button hands the question to the system dialog and
 * adds whatever folder comes back — the desktop app's own flow. A dismissed dialog adds nothing.
 */
function AddWorkspaceControl() {
  const copy = useCopy(COPY);
  const [busy, setBusy] = useState(false);

  const pick = useCallback(async () => {
    setBusy(true);
    try {
      await pickAndAddWorkspace(copy.chooseWorkspace);
    } catch {
      // A picker the desktop refuses, or a folder it will not take, leaves the rail as it was.
    } finally {
      setBusy(false);
    }
  }, [copy.chooseWorkspace]);

  return (
    <Tooltip content={copy.addWorkspace}>
      <Button
        {...NO_HOVER_GROWTH}
        type="button"
        variant="ghost"
        size="icon"
        aria-label={copy.addWorkspace}
        disabled={busy}
        onClick={() => void pick()}
        className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
      >
        <FolderOpen className="size-3.5" />
      </Button>
    </Tooltip>
  );
}

/**
 * The rail's paging control, under the last conversation of a workspace.
 *
 * Two controls rather than one toggle, the way the desktop app draws it: *Show more* is offered
 * while the workspace has more than it shows, *Show less* while it is past its first page. They
 * share a line, and a dot between them keeps the two readings apart.
 */
function SessionGroupFooter({
  total,
  shown,
  moreLabel,
  lessLabel,
  onMore,
  onLess,
}: {
  total: number;
  shown: number;
  moreLabel: string;
  lessLabel: string;
  onMore: () => void;
  onLess: () => void;
}) {
  const pastFirstPage = shown > SESSION_PAGE;
  const moreToShow = shown < total;
  return (
    // One more row of the group, on the group's own grid: 12px of padding, a 20px glyph column and a
    // 10px gap put the chevron exactly where a conversation row's title starts, with the label
    // following it. The column is empty here, the way it is on a conversation row.
    <div className="flex items-center gap-2.5 pl-3">
      <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center" />
      {moreToShow ? (
        <Button
          {...NO_HOVER_GROWTH}
          type="button"
          variant="ghost"
          size="sm"
          onClick={onMore}
          className="h-7 gap-1 rounded-lg pr-2 pl-0 text-xs font-normal text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="size-3.5" />
          {moreLabel}
        </Button>
      ) : null}
      {moreToShow && pastFirstPage ? (
        <span aria-hidden="true" className="text-muted-foreground/50">
          ·
        </span>
      ) : null}
      {pastFirstPage ? (
        <Button
          {...NO_HOVER_GROWTH}
          type="button"
          variant="ghost"
          size="sm"
          onClick={onLess}
          className="h-7 gap-1 rounded-lg pr-2 pl-0 text-xs font-normal text-muted-foreground hover:text-foreground"
        >
          <ChevronUp className="size-3.5" />
          {lessLabel}
        </Button>
      ) : null}
    </div>
  );
}
