import { AlertCircle, PanelRightOpen } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, AlertContent, AlertDescription, AlertIcon } from "@/components/motion/alert";
import { Input } from "@/components/motion/input";
import { LoadingGrid } from "@/components/agents/loading-states/loading-grid";
import { ChatApp } from "@/components/agents/chat-app";
import { AnimatedSidebarInset } from "@/components/motion/animated-sidebar";
import { RightSidebar } from "@/components/workspace/right-sidebar";
import { EASE_IN_OUT, EASE_OUT } from "@/lib/ease";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "@/lib/error-boundary";
import { reportClientError } from "@/lib/client-errors";
import { PluginMarketPage } from "@/market/PluginMarketPage";
import { COPY } from "@/home/homeCopy";
import { ConversationComposer, COMPOSER_ID } from "@/home/ConversationComposer";
import { ConversationMenu } from "@/home/ConversationMenu";
import { ConversationPane, type RewindTarget } from "@/home/ConversationPane";
import { ConversationHero } from "@/home/ConversationHero";
import { OpenInAppButton } from "@/home/OpenInAppButton";
import { WorkspaceRail } from "@/home/WorkspaceRail";
import { prefillComposerDraft } from "@/state/composer-prefill";
import type { WorkspaceScopeTarget } from "@/settings/use-workspace-scope";
import {
  activeRecord,
  isStreaming,
  sessionStore,
  type SessionStoreState,
} from "@/state/session-store";
import { renameSessionById, rewindToEntry } from "@/state/session-actions";
import { useStoreSelector } from "@/state/store";
import {
  forgetSession,
  isPanelExpanded,
  isPanelOpen,
  openSubagentConversation,
  panelOwners,
  setPanelExpanded,
  setPanelOpen,
} from "@/state/panel-store";
import { usePanelState } from "@/state/panel-state";
import { stalePanelOwners } from "@/state/panel-prune";
import { workspaceStore } from "@/state/workspace-store";
import { conversationPhase, type ConversationPhase } from "@/home/conversation-phase";

/** The two surfaces the window body draws; settings is an overlay above whichever is up. */
export type Surface = 'chat' | 'market';

export interface ChatAppHomeProps {
  className?: string;
  /** The rail's own settings entry, at the foot of the sidebar. */
  onOpenSettings?: () => void;
  /** Which surface the body draws: the conversation column, or the plugin marketplace. */
  surface: Surface;
  /** The rail's own door to the marketplace. */
  onOpenMarket: () => void;
  /** The marketplace's Back control: the surface it was opened from. */
  onMarketBack: () => void;
  /** The scope carried into the market from plugin management; `user` from the rail. */
  marketScope: WorkspaceScopeTarget;
  /** Bumped on every open so a market left mounted under Settings applies the carried scope. */
  marketOpenId: number;
  /** The marketplace's door into plugin management. */
  onOpenConversation: () => void;
  onOpenPlugins: () => void;
  /** Start the guided plugin-authoring flow with this prompt in the composer. */
  onCreatePlugin: (prompt: string) => void;
  /**
   * The sidebar's state, owned by the shell rather than by this screen.
   *
   * The window's frame is drawn by the shell (`App.tsx`) because it outlives this screen — the
   * settings page is opened *over* the conversation, and the frame stays up while it is — so the one
   * control that changes the sidebar is the shell's too, and the sidebar follows it.
   */
  sidebarOpen: boolean;
  onSidebarOpenChange: (open: boolean) => void;
}

/**
 * The conversation screen: the rail, and the conversation column beside it.
 *
 * The shell reads only what the frame draws — the workspace's name and the conversation's title —
 * because everything under it subscribes on its own. A turn streaming into the transcript replaces
 * those rows on every frame, and a shell that re-read the whole state would take the rail, the
 * header and the composer down with it each time.
 */
export function ChatAppHome({
  className,
  onOpenSettings,
  surface,
  onOpenMarket,
  onMarketBack,
  marketScope,
  marketOpenId,
  onOpenConversation,
  onOpenPlugins,
  onCreatePlugin,
  sidebarOpen,
  onSidebarOpenChange,
}: ChatAppHomeProps) {
  /**
   * Which state the column is in, read here rather than inside the body.
   *
   * The body is the room above the composer, and the hero is one of the things that room holds
   * (`ConversationHero`), so the surface that draws the column is the one that has to know which
   * column it is drawing — and the one that keeps the hero under an `AnimatePresence` so it can
   * leave instead of vanishing.
   */
  const phase = useStoreSelector(sessionStore, conversationPhase);
  /**
   * Which conversation the column is drawn for.
   *
   * Opening the column, expanding it and its tabs all belong to a conversation
   * (`state/panel-store.ts`), so switching to another one shows *that* conversation's column — closed
   * if the reader never opened it there, and as they left it if they did. `sessionId` is null for the
   * brief no-active-session transition of an open or a workspace switch; the column keeps the last
   * conversation's answer through it rather than folding and reopening on the way, which is what would
   * make every switch look like two gestures. The one exception is an open the reader asked for as a
   * *new* conversation (`openingNew`): that column belongs to no conversation on screen any more, so
   * it folds away — with its own animation, since the reader is the one who asked for it.
   */
  const sessionId = useStoreSelector(sessionStore, selectActiveId);
  const openingNew = useStoreSelector(sessionStore, selectOpeningNew);
  const panel = usePanelState();
  const lastSession = useRef<string | null>(sessionId);
  useEffect(() => {
    if (sessionId !== null) lastSession.current = sessionId;
  }, [sessionId]);
  const panelSession = sessionId ?? lastSession.current;
  const rightSidebarOpen = !openingNew && isPanelOpen(panelSession);
  const panelExpanded = !openingNew && isPanelExpanded(panelSession);
  /** The expand switch: a fact about this conversation's column, remembered with it. */
  const togglePanelExpanded = useCallback(() => {
    if (sessionId === null) return;
    setPanelExpanded(sessionId, !isPanelExpanded(sessionId));
  }, [sessionId]);
  /** The header's door: open it for the conversation on screen. */
  const openPanel = useCallback(() => {
    if (sessionId === null) return;
    setPanelOpen(sessionId, true);
  }, [sessionId]);

  // A conversation that leaves its workspace's list can never come back, so its tabs are dropped
  // with it; a conversation that is merely not on screen keeps them. Every kind of tab counts —
  // reading the terminal tabs alone left a conversation whose only tab was a git / file / subagent
  // one holding its state for the life of the process. A conversation this process holds a
  // record for is alive even before the list carries it (`stalePanelOwners`): a new conversation has
  // its id at once, and its row arrives with a later read.
  const listed = useStoreSelector(sessionStore, selectSessionIds);
  useEffect(() => {
    for (const id of stalePanelOwners(panelOwners(panel), listed, sessionStore.get().records)) {
      forgetSession(id);
    }
  }, [listed, panel]);

  return (
    <div className={cn("flex min-h-0 flex-col bg-window-frame", className)}>
      <ChatApp
        open={sidebarOpen}
        onOpenChange={onSidebarOpenChange}
        sidebarWidth="16.8rem"
        className="min-h-0 flex-1 rounded-none border-0"
      >
        <WorkspaceRail
          onOpenSettings={onOpenSettings}
          onOpenMarket={onOpenMarket}
          marketOpen={surface === "market"}
          onOpenConversation={onOpenConversation}
        />
        <AnimatedSidebarInset className="relative min-h-0 flex-row bg-pane">
          {/* `relative` because the hero's header is taken out of the flow (`ConversationHeader`): it
              is positioned against this column, not against the window. */}
          {/* The conversation column is the flex remainder: it shrinks with the right column instead
              of becoming a fixed-width surface the reader has to pan. Wide material (code blocks,
              tables) scrolls inside its own box; anything else wraps. The work panel expanded is
              this column folding to nothing: the row's width goes to the panel, and the two move
              together on the same animated width (`components/workspace/use-sidebar-width.ts`), so
              nothing remounts — the field and the terminal stay the ones they were. The column is
              left `inert` while out of sight so Tab and the keyboard cannot reach a surface nobody
              sees. */}
          <div
            aria-hidden={panelExpanded || surface === "market"}
            inert={panelExpanded || surface === "market"}
            className={cn(
              "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip transition-opacity duration-200",
              (panelExpanded || surface === "market") && "pointer-events-none opacity-0",
            )}
          >
            <ConversationHeader
              phase={phase}
              folded={panelExpanded}
              resourcesOpen={rightSidebarOpen}
              onOpenResources={openPanel}
            />
            {/* The body is the room above the dock: the transcript under a conversation, the hero's
                welcome when nothing has been said. It is the flex remainder in every state, so the
                composer keeps one height and one seat across them — the field never moves, and a
                draft written on the welcome screen is written into the composer that is already
                there, not into a body of its own. */}
            {/* The transcript is the one surface a bad row can take down with it — a row is engine
                output, drawn by a dozen components — so it is the one that gets a boundary of its
                own: a failure there must leave the composer, the header and the rail in place. */}
            <ErrorBoundary className="flex-col">
              <ConversationBody phase={phase} />
            </ErrorBoundary>
            <ConversationComposer id={COMPOSER_ID} />
          </div>
          <RightSidebar
            sessionId={sessionId}
            open={surface === "chat" && rightSidebarOpen}
            expanded={surface === "chat" && panelExpanded}
            onToggleExpanded={togglePanelExpanded}
            onOpenPanel={onOpenConversation}
            onOpenChange={(open) => {
              if (sessionId === null) return;
              // Closing the column is closing it for this conversation; reopening it later starts at
              // the conversation again rather than at a full-width panel nobody asked for now.
              if (!open) setPanelExpanded(sessionId, false);
              setPanelOpen(sessionId, open);
            }}
          />
          {surface === "market" ? (
            <div className="absolute inset-0 z-20 flex min-h-0 min-w-0 bg-pane">
              <ErrorBoundary className="flex-col">
                <PluginMarketPage
                  key={marketOpenId}
                  onBack={onMarketBack}
                  onOpenPlugins={onOpenPlugins}
                  onCreatePlugin={onCreatePlugin}
                  initialScope={marketScope}
                />
              </ErrorBoundary>
            </div>
          ) : null}
        </AnimatedSidebarInset>
      </ChatApp>
    </div>
  );
}

/**
 * The conversation column's title band: the workspace, the conversation, its menu, the panel's door.
 *
 * The hero draws it as its actions alone — the panel's door, in the place the full header puts it,
 * out of the flow so the hero keeps the whole column to centre in. A window with no workspace at all
 * draws no header: there is nothing on this screen for either the breadcrumb or the menu to act on,
 * and the hero's own row is what asks for a workspace.
 *
 * The door opens the placeholder right column (`components/workspace/right-sidebar.tsx`): the panel
 * surfaces themselves are still to be designed, so the door is the only control the column has.
 */
function ConversationHeader({
  phase,
  folded,
  resourcesOpen,
  onOpenResources,
}: {
  phase: ConversationPhase;
  /**
   * The column this band sits in has folded onto the work panel (`panelExpanded`). It is invisible and
   * inert then, and the controls that own a popover are not drawn: a portalled menu would otherwise
   * keep hovering over the panel, anchored to a button nobody can see, until its morph finished
   * (2026-10-25, user report: the open-app menu stayed over the expanded panel).
   */
  folded: boolean;
  resourcesOpen: boolean;
  onOpenResources: () => void;
}) {
  const copy = useCopy(COPY);
  const reduce = useReducedMotion() ?? false;
  const workspaceName = useStoreSelector(workspaceStore, selectActiveWorkspaceName);
  const workspaceId = useStoreSelector(workspaceStore, selectActiveWorkspaceId);
  const sessionId = useStoreSelector(sessionStore, selectActiveId);
  const title = useStoreSelector(sessionStore, selectActiveTitle);
  const hasWorkspace = useStoreSelector(sessionStore, selectHasWorkspace);
  /** The header's rename: the title becomes a field until it is committed or abandoned. */
  const [titleDraft, setTitleDraft] = useState<string | null>(null);

  // The hero and a conversation being read both hide the title band: the hero has nothing to name
  // yet, and a row that is still loading must not put a stale workspace/title line over the wait.
  const actionsOnly = phase === "hero" || phase === "reading";
  const headerTitle = sessionId ? title?.trim() || copy.headerUntitled : copy.headerFallback;

  const commitTitle = useCallback(() => {
    const name = titleDraft?.trim();
    setTitleDraft(null);
    const workspaceId = workspaceStore.get().activeId;
    const openSessionId = sessionStore.get().activeId;
    if (!name || !openSessionId || workspaceId === null) return;
    void renameSessionById(workspaceId, openSessionId, name);
  }, [titleDraft]);

  if (actionsOnly && !hasWorkspace) return null;

  return (
    <header
      className={cn(
        "z-20 flex h-14 items-center gap-2 px-4",
        actionsOnly ? "absolute top-0 right-0" : "relative shrink-0 border-border border-b",
      )}
    >
      {actionsOnly ? null : (
        // The title band mounts when the column stops being the hero (or stops loading), which is the
        // same frame the welcome starts leaving: it fades in instead of appearing as a cut. It is the
        // one piece of chrome that changes shape at that moment — the field below it does not move.
        <motion.div
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: EASE_OUT }}
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="min-w-0 shrink truncate text-muted-foreground">
              {workspaceName ?? copy.projectsLabel}
            </span>
            <span aria-hidden="true" className="shrink-0 text-muted-foreground/60">
              /
            </span>
            {titleDraft === null ? (
              <span className="min-w-0 truncate text-foreground">{headerTitle}</span>
            ) : (
              <Input
                value={titleDraft}
                onChange={setTitleDraft}
                aria-label={copy.sessionMenu.rename}
                autoFocus
                className="max-w-xs"
                onBlur={commitTitle}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitTitle();
                  if (event.key === "Escape") setTitleDraft(null);
                }}
              />
            )}
          </div>
          {sessionId !== null && titleDraft === null && !folded ? (
            <ConversationMenu
              sessionId={sessionId}
              workspaceId={workspaceId}
              onRename={() => setTitleDraft(headerTitle)}
            />
          ) : null}
          <div className="flex-1" />
        </motion.div>
      )}
      {folded ? null : <OpenInAppButton />}
      <button
        type="button"
        aria-label={copy.resourcesLabel}
        onClick={onOpenResources}
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          resourcesOpen && "lg:hidden",
        )}
      >
        <PanelRightOpen className="size-4" />
      </button>
    </header>
  );
}

/**
 * The conversation column, in whichever of its states it is actually in.
 *
 * The phase is decided in the shell (`conversationPhase`), because the hero owns the composer; what
 * is left here is drawing the column's body in each state. The hero draws its welcome in the room
 * above the dock, a conversation being read says so with the shimmer, and one the desktop refused
 * says why with beUI's own `Alert` — the same surface the composer reports its failures with, so a
 * failure reads the same wherever it lands.
 */
function ConversationBody({ phase }: { phase: ConversationPhase }) {
  const copy = useCopy(COPY);
  const openError = useStoreSelector(sessionStore, selectOpenError);
  const record = useStoreSelector(sessionStore, activeRecord);

  /**
   * Show one `task` child's own conversation in the right column: a tab in the strip, and the read
   * behind it.
   *
   * A conversation with a `task` call has a file — the child's transcript is written beside it — so
   * the guard is the one case where there is nothing to address: a conversation the engine has not
   * written yet has spawned nothing.
   */
  const openSubagent = useCallback(
    (childId: string, label: string) => {
      if (record === null) return;
      openSubagentConversation(record.id, record.filePath, childId, label);
    },
    [record],
  );

  /**
   * Take one of the reader's own messages back.
   *
   * The rewrite is the engine's own leaf move at that message — in place, so the conversation keeps
   * its row — and it belongs to the store; what this surface adds is the other half of the gesture:
   * the message's words and files go back into the composer, so the reader can say it differently
   * without retyping it. The draft is put back only after the rewrite landed: a refusal leaves the
   * transcript where it was, and a field holding a message the conversation still contains would be
   * a copy, not a rewind.
   */
  const rewind = useCallback(
    async (target: RewindTarget) => {
      if (record === null) return false;
      const ok = await rewindToEntry(record.id, { entryId: target.entryId, at: target.at });
      if (ok) {
        // The conversation the message came from, not the one on screen now: the rewrite is several
        // round trips and the reader may have moved on in the meantime.
        try {
          prefillComposerDraft(record.id, target.text, target.attachments);
        } catch (error) {
          // The message was taken back and the rows are gone: a hand-off that fails has to say so in
          // the application's log, not only in a console nobody reads after the window closes.
          reportClientError("rewind: the taken-back message could not be put back in the composer", error);
        }
      }
      return ok;
    },
    [record],
  );

  const reduce = useReducedMotion() ?? false;

  if (phase === "failed") {
    const open = record === null;
    return (
      <ConversationFailure
        title={open ? copy.openFailed : copy.conversationFailed}
        hint={
          open
            ? openError?.code === "session_unknown"
              ? copy.sessionUnknownHint
              : (openError?.message ?? copy.conversationFailed)
            : (record?.historyError?.message ?? "")
        }
      />
    );
  }
  const waiting = phase === "reading";
  const progress =
    record !== null && record.historyStatus === "loading" && record.historyTotal > 0
      ? copy.conversationLoadProgress(record.historyLoaded, record.historyTotal)
      : copy.conversationLoading;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/*
        The welcome and the wait share one presence, so each fades out *under* the surface that
        replaces it. The welcome is the hero column's body (`conversationPhase`): the room above the
        dock, which is the room the transcript takes once there is one. It is drawn here rather than
        in the composer so that the field below it keeps its own place in the tree and its position
        on screen — the block fills space the column already had, and takes none when it leaves.
      */}
      <AnimatePresence>
        {phase === "hero" ? <ConversationHero key="hero" /> : null}
        {/*
          The wait is a state of this column, not a modal that has to be dismissed before the rows can
          appear. It is kept mounted for its own exit, so the loading mark fades out *under* the
          conversation that replaces it instead of blinking away the frame the first page lands - and
          a conversation kept warm never enters this branch at all (`conversationPhase` draws a record
          with rows straight away), so coming back to it shows no spinner, not even for a frame.

          It is drawn at full weight from its first frame on purpose (`initial={false}`). Arriving at
          0 opacity meant the column went blank between the transcript leaving and the mark appearing
          — measured 2026-10-27: `pane 0.05` + `mark 0.02` on the same frame, which is the white
          flash the reader reported. Two surfaces must never fade through each other; the one that
          arrives is simply there, and only the one that leaves fades.
        */}
        {waiting ? (
          <motion.div
            key="reading"
            initial={false}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
            transition={{ duration: reduce ? 0.1 : 0.18, ease: EASE_IN_OUT }}
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
          >
            <LoadingGrid label={progress} />
          </motion.div>
        ) : null}
      </AnimatePresence>
      {/*
        The transcript arrives, and a conversation the reader leaves does not linger.

        There is one presence for a transcript rather than a hand-over between two: an exit
        animation keeps the conversation that is leaving mounted — every row of it, with its own
        exit — for the length of the fade, and gates its removal on the last of those animations
        finishing. That is the expensive half of a switch, and it is also the reason a transcript
        could be left unpainted: the reader had asked for another conversation and got a body with
        neither of them drawn. The pane that is arriving is what matters, so it is drawn in the
        frame the conversation becomes the active one, at full weight (its rows are text, and text
        is never gated behind an animation), and the whole gesture is the few pixels it rises.
      */}
      {record !== null && !waiting && phase !== "hero" ? (
        <ConversationEntrance key={record.id}>
          <ConversationPane
            sessionId={record.id}
            messages={record.messages}
            subagents={record.subagents}
            backgroundJobs={record.runtime?.backgroundJobs}
            streaming={isStreaming(record)}
            retry={record.runtime?.retry ?? null}
            lastTurn={record.lastTurn}
            tipEntryId={record.runtime?.tipEntryId ?? null}
            onOpenSubagent={openSubagent}
            onRewind={rewind}
          />
        </ConversationEntrance>
      ) : null}
    </div>
  );
}

/**
 * A conversation the desktop refused, said with beUI's own `Alert`.
 *
 * The hint is the desktop's answer where there is one — a session the workspace's list no longer
 * carries is named in this side's words (`sessionUnknownHint`), because the reader can act on that
 * one and cannot act on the host's own sentence.
 */
function ConversationFailure({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <Alert
        variant="destructive"
        className="max-w-md items-start gap-2 py-2 pr-2 pl-3 text-xs"
      >
        <AlertIcon>
          <AlertCircle aria-hidden="true" className="size-3.5" />
        </AlertIcon>
        <AlertContent>
          <AlertDescription className="text-xs">
            <span className="block font-medium">{title}</span>
            {hint ? <span className="mt-0.5 block text-muted-foreground">{hint}</span> : null}
          </AlertDescription>
        </AlertContent>
      </Alert>
    </div>
  );
}

/**
 * A conversation arriving on screen: it is drawn at full weight and rises the last few pixels.
 *
 * The rows of a conversation that arrives *while* the pane is up pop in on their own
 * (`ConversationPane`'s `animateIn`), and a windowed one draws no row animation at all — so the
 * surface is what carries the entrance. That is the difference between a conversation restored at
 * startup *arriving* and one that is simply there when the window opens.
 *
 * It has no exit: a conversation the reader is done with is replaced in the same frame, because the
 * surface that matters is the one arriving, and a transcript kept in the document for the length of
 * its fade is a whole second copy of the rows in the tree.
 */
function ConversationEntrance({
  children,
}: {
  children: ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.div
      // An arriving surface is *drawn*, not faded in: it lands at full weight on its first frame and
      // only rises the last few pixels into place. The reader's own message is the thing this pane
      // exists to show, and a message that fades up out of the background while the welcome above it
      // is still fading down reads as two translucent surfaces crossing — the complaint this fixes
      // (2026-10-27: 「用户输入放上去动画还不够连贯」).
      initial={reduce ? false : { y: 8 }}
      animate={{ y: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.22, ease: EASE_OUT }}
      className="flex min-h-0 flex-1 flex-col"
    >
      {children}
    </motion.div>
  );
}

const selectHasWorkspace = (state: SessionStoreState) => state.workspaceId !== null;
const selectOpenError = (state: SessionStoreState) => state.openError;
const selectActiveId = (state: SessionStoreState) => state.activeId;
const selectOpeningNew = (state: SessionStoreState) => state.openingNew;
const selectActiveTitle = (state: SessionStoreState) =>
  state.activeId === null ? null : (state.records[state.activeId]?.title ?? null);


/**
 * Every conversation the rail's lists still carry, as one set.
 *
 * `useStoreSelector` caches on the state object, so a plain rebuild here would produce a new `Set`
 * on every write — and the session store is written once per streamed token. A new object is also a
 * new snapshot to `useSyncExternalStore`, so the whole shell (rail, header, the right column) would
 * re-render for every token of a turn. The cache below is keyed on `sessions` itself, which is the
 * only field this derivation reads: a list load or a delete replaces it, and nothing else does.
 */
let listedCache: { sessions: SessionStoreState['sessions']; ids: Set<string> } | null = null;

function selectSessionIds(state: SessionStoreState): Set<string> {
  const cached = listedCache;
  if (cached !== null && cached.sessions === state.sessions) return cached.ids;
  const ids = new Set<string>();
  for (const list of Object.values(state.sessions)) {
    for (const session of list.items) ids.add(session.id);
  }
  listedCache = { sessions: state.sessions, ids };
  return ids;
}

/**
 * The active workspace's id, for a menu that may have to read a conversation's file.
 *
 * Module-level rather than inline: `useStoreSelector` keys its snapshot on the selector's own
 * identity, so a function made during render would rebuild it every time.
 */
const selectActiveWorkspaceId = (state: { activeId: number | null }): number | null =>
  state.activeId;

/** The active workspace's name, or null while there is none. */
function selectActiveWorkspaceName(state: {
  items: { id: number; name: string }[];
  activeId: number | null;
}): string | null {
  if (state.activeId === null) return null;
  return state.items.find((item) => item.id === state.activeId)?.name ?? null;
}
