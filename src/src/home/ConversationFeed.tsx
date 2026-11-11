import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ClipboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MessageGroup } from "@/components/agents/message";
import { Button } from "@/components/motion/button";
import {
  MessageScroller,
  RAIL_TICK_SIZE_PX,
  type MessageScrollerRail,
} from "@/components/agents/message-scroller";
import type { PreviewRailItem } from "@/components/motion/preview-rail";
import type { SessionRetry } from "@/api/session-types";
import { followFloor, stopFollowing } from "@/lib/follow-scroll";
import { useCopy } from "@/lib/i18n";
import { copyTextWithFiles } from "@/lib/clipboard";
import { textWithFileMentions } from "@/lib/file-mention";
import { selectionCopy } from "@/lib/selection-words";
import { cn } from "@/lib/utils";
import { COPY } from "@/home/homeCopy";
import { ConversationFootRow } from "@/home/ConversationFootRow";
import {
  createRailCache,
  railItems as buildRailItems,
  selectRailItems,
  type RailCache,
} from "@/home/rail-rows";
import { RUNNING_ROW_ID, isUserRow, type TranscriptRow } from "@/home/conversation-rows";
import { standRowsOnBoxes } from "@/home/feed-placement";
import { estimateRowHeight } from "@/home/row-height";
import { landReader } from "@/home/feed-landing";
import { startOfTurn } from "@/home/turn-elapsed";
import { readerPlace, setReaderPlace } from "@/state/reader-place";
import { sessionStore, type SessionStoreState } from "@/state/session-store";
import { useStoreSelector } from "@/state/store";

/**
 * The transcript, windowed.
 *
 * A short conversation is drawn as the flow of rows it is: every row is real DOM, the list's height
 * *is* its content, and no estimate stands between a streaming answer and the space it draws itself
 * into. Past the threshold below, only the rows around the reader are drawn, and the rest are a
 * height in a row model — the same rows, in the same order, measured one at a time as they appear.
 *
 * The threshold and the numbers around it are the ones the desktop app's own feed uses
 * (`SourceConversationFeed.vue`), because they were chosen against the same problem: rows of wildly
 * different heights, a turn that grows at the foot, and a reader who may be anywhere in between.
 */
export const FEED_VIRTUALIZATION_THRESHOLD = 60;
/**
 * A row's height when the row itself cannot say (`home/row-height.ts` estimates every other one):
 * the running row, which is not a row of the conversation yet.
 */
const FEED_ROW_ESTIMATE_PX = 48;
/** The viewport the model assumes before the pane's own box is measured. */
const FEED_INITIAL_VIEWPORT_HEIGHT_PX = 720;
/** Rows drawn past each edge of the window, so a scroll step meets rendered rows. */
const FEED_OVERSCAN_ROWS = 6;
/** How close to the floor the list counts as the end: within this, an append is followed. */
const FEED_SCROLL_END_THRESHOLD_PX = 2;
/** The gap between two rows, which the window supplies itself (`MessageGroup`'s `gap-4`). */
const FEED_ROW_GAP_PX = 16;
/** The reading line sits one pixel below the top edge: a row ending exactly there is behind it. */
const FEED_TOP_LINE_OFFSET_PX = 1;
/**
 * The distance from an edge at which the rail calls the first or the last row active, mirroring the
 * scroller's own `followThreshold`: the highlight should agree with the answer to "is the reader
 * still at the edge", and the scroller is the side that decides it.
 */
const FEED_EDGE_THRESHOLD_PX = 56;
/**
 * The share of the transcript's height the rail's marks may take.
 *
 * The marks are drawn over the scrollport, and a conversation longer than that box used to be a
 * stack taller than it — centred and clipped, so both ends went off the screen, the newest mark
 * among them. This is the room the marks are given instead; which rows earn a place in it is
 * `rail-rows.ts`.
 */
const RAIL_VIEWPORT_SHARE = 0.7;

export interface ConversationFeedProps {
  /** The conversation these rows belong to; the feed is mounted per conversation. */
  sessionId: string
  /** The conversation's rows, in order — the whole model, not the drawn window. */
  rows: TranscriptRow[]
  /** The turn in flight, if any: it is a row of its own at the foot. */
  streaming: boolean
  /**
   * The engine is rewriting the context (a compaction or a handoff), with no turn over it.
   *
   * A model call the reader is waiting on — `/compact` spends one this way — which the foot row
   * states; beside a live turn, that turn's own row already says what the wait is.
   */
  compacting?: boolean
  /**
   * The retry the engine is waiting out, when it is waiting on one.
   *
   * It is the turn's own state rather than a notice: the waiting line says what is happening while
   * the request is retried, and the reader is not asked to dismiss anything. Read by the pane, like
   * the rows themselves.
   */
  retry?: SessionRetry | null
  /** What the turn in flight says while it works; the conversation says "working", a child says "running". */
  runningLabel?: string
  /** Draws one row. The feed places it; what it looks like is the pane's. */
  renderRow: (row: TranscriptRow, index: number) => ReactNode
  className?: string
  viewportClassName?: string
}

/**
 * The rows already on disk and the turn arriving, in the window the reader is looking through.
 *
 * The pane is mounted once per conversation and where the reader was is read from the session
 * store's own record of it at that moment — so coming back to a conversation lands where it was
 * left rather than at its foot, and a conversation that was being followed comes back following. The
 * place is written back as the reader scrolls, on the animation frame rather than per event, and it
 * is written to a map rather than into the store's state: the position changes on every pixel of a
 * scroll, and a state write per pixel would redraw the transcript the reader is scrolling.
 *
 * A windowed transcript needs more than the offset: a freshly mounted window has measured none of
 * its rows, so its offsets are estimates and the offset alone would land the reader on whatever the
 * estimates happen to put there. The row under the reading line and that row's own edge are recorded
 * with it, and the landing is corrected against them for the frames the window needs to measure the
 * row it is aiming at.
 */
export function ConversationFeed({
  sessionId,
  rows,
  streaming,
  compacting = false,
  retry = null,
  runningLabel,
  renderRow,
  className,
  viewportClassName,
}: ConversationFeedProps) {
  const copy = useCopy(COPY);
  const reduceMotion = useReducedMotion() ?? false;
  const [following, setFollowing] = useState(() => readerPlace(sessionId).following);
  // Read by the layout effects that decide whether a commit may take the floor. A wheel or key
  // reaches `onFollowChange` before its scroll event does, and a content commit in between must
  // already see the reader's decision rather than the state update's next render.
  const followingRef = useRef(following);
  const [activeRailId, setActiveRailId] = useState("");
  const [scrollMargin, setScrollMargin] = useState(0);
  const viewportRef = useRef<HTMLElement | null>(null);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const reportFrame = useRef<number | undefined>(undefined);
  const landingRelease = useRef<(() => void) | null>(null);
  /**
   * How tall the transcript's floor was when the reader's place was last put back, or last taken.
   *
   * It is what tells "the conversation has moved on" from "the pane has only just drawn it". A
   * conversation whose whole length is barely more than one scrollport leaves a reader who is looking
   * at its end within the follow threshold of the floor, and the scroller asks for the floor on the
   * frame the pane mounts as well as on every frame the content moves — so the frame the reader's own
   * place is put back on is the one frame where that ask must not be answered. Growth answers it.
   *
   * It follows the floor *down* as well as up (`takeFloor`): a disclosure that folds moves the floor
   * up, and a mark left at the old height would read the next growth as no growth at all — which is
   * how a reader watching a turn lost the bottom the moment a block folded and had to scroll after
   * their own output.
   */
  const restoredFloor = useRef(0);
  const railCacheRef = useRef<RailCache | null>(null);
  if (railCacheRef.current === null) railCacheRef.current = createRailCache();

  // The turn in flight is counted from the host's own stamp for it, which the conversation's record
  // holds: the running row is drawn here, and a clock read off the row's own mount would be counting
  // the reader's visit rather than the turn.
  const selectTurnStart = useCallback(
    (state: SessionStoreState) => state.records[sessionId]?.turnStartedAt ?? null,
    [sessionId],
  );
  const hostTurnStart = useStoreSelector(sessionStore, selectTurnStart);
  // Read from the rows on every frame they change, which is cheap and keeps the value a primitive:
  // the clock below is keyed on *that*, so a streamed delta cannot restart the counter.
  const startedAt = useMemo(() => startOfTurn(rows, hostTurnStart), [hostTurnStart, rows]);

  // The foot row's two cases live in the component: a turn in flight, or an engine-side rewrite.
  const footLive = streaming || compacting;
  const rowCount = rows.length + (footLive ? 1 : 0);
  const footRow = (
    <ConversationFootRow
      streaming={streaming}
      compacting={compacting}
      retry={retry}
      startedAt={startedAt}
      runningLabel={runningLabel}
    />
  );
  const virtualized = rows.length > FEED_VIRTUALIZATION_THRESHOLD;
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  /**
   * The width the rows are drawn in, read off a row that is on screen.
   *
   * An estimate needs the lane to know how many lines a paragraph takes, and the rows are the only
   * place that width exists: it is the conversation lane when the column is wide enough for it, the
   * column itself when it is not. Read here rather than from a constant, so the two cannot drift.
   */
  const laneRef = useRef(0);
  /** The reader's content size against the 14 px the estimate's advances were measured at. */
  const fontScaleRef = useRef(1);
  // The model reads a row's key through this and *holds* what it read, so its identity has to change
  // when the rows do: a row whose id changed in place — the sent message the engine claims with its
  // own id — would otherwise keep the size that was measured for the row that used to be there.
  const rowKeyAt = useCallback(
    (index: number) => (index < rowIds.length ? (rowIds[index] ?? String(index)) : RUNNING_ROW_ID),
    [rowIds],
  );

  /**
   * The rail's entry for each row: the turn that row belongs to.
   *
   * The rail draws one mark per turn, and the reader's position is still a row — the one nearest
   * the middle of the scrollport. This is the bridge between the two: every row of a turn names the
   * row its turn starts on, so a reader halfway through the answer highlights that turn's mark.
   */
  const turnIdOfRow = useMemo(() => {
    const byRow = new Map<string, string>();
    if (rows.length === 0) return byRow;
    let turn = rows[0]!.id;
    for (const row of rows) {
      if (isUserRow(row)) turn = row.id;
      byRow.set(row.id, turn);
    }
    if (footLive) byRow.set(RUNNING_ROW_ID, turn);
    return byRow;
  }, [footLive, rows]);

  // oxlint-disable-next-line react/incompatible-library -- the row model is `@tanstack/react-virtual`,
  // the same library and version the desktop front end's own feed uses; the compiler skips this
  // component rather than optimizing it, which is the price of the window.
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: virtualized ? rowCount : 0,
    enabled: virtualized,
    getScrollElement: () => viewportRef.current,
    getItemKey: rowKeyAt,
    // What an unmeasured row is worth, from the row itself (`home/row-height.ts`): the flat number
    // this started with was a third of a real row, so every scroll into unmeasured space was a
    // screenful of corrections. The lane is the one a drawn row reports, which is the width these
    // rows are laid out in.
    estimateSize: (index: number) => {
      const row = rows[index];
      return row === undefined ? FEED_ROW_ESTIMATE_PX : estimateRowHeight(row, laneRef.current, fontScaleRef.current);
    },
    gap: FEED_ROW_GAP_PX,
    scrollMargin,
    overscan: FEED_OVERSCAN_ROWS,
    initialRect: { width: 0, height: FEED_INITIAL_VIEWPORT_HEIGHT_PX },
    // An end anchor is what keeps an append from moving a reader who is not at the end, and what
    // keeps the view pinned on a row that grows while the reader is at it.
    anchorTo: "end",
    followOnAppend: "auto",
    scrollEndThreshold: FEED_SCROLL_END_THRESHOLD_PX,
    useAnimationFrameWithResizeObserver: true,
  });

  /** The row's own box, without interpolating a selector out of an id the engine chose. */
  const rowElement = useCallback((id: string): HTMLElement | null => {
    const nodes = spacerRef.current?.children;
    if (nodes === undefined) return null;
    for (const node of Array.from(nodes)) {
      if (node instanceof HTMLElement && node.dataset.rowKey === id) return node;
    }
    return null;
  }, []);

  /**
   * The windowed row under one offset, read without trusting the model's own lookup.
   *
   * `getVirtualItemForOffset` indexes into the measurement cache, and that cache is rebuilt whenever
   * a row's measured height changes — which is exactly what opening a disclosure does. Inside that
   * rebuild the lookup can answer with a hole (`notUndefined` in `@tanstack/virtual-core` throws
   * `Unexpected undefined`), and this call is made from a layout effect and a scroll frame: a throw
   * there takes the whole React root down, which is the reader's "clicking a tool call blacked the
   * page out". The lookup is therefore guarded, and the answer falls back to the row the offset
   * plainly falls in.
   */
  const virtualItemAt = useCallback(
    (offset: number) => {
      try {
        const item = virtualizer.getVirtualItemForOffset(offset);
        if (item !== undefined) return item;
      } catch {
        // The cache was mid-rebuild; the fallback below is the same answer by another road.
      }
      const items = virtualizer.getVirtualItems();
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item !== undefined && item.start <= offset) return item;
      }
      return undefined;
    },
    [virtualizer],
  );

  /**
   * The row under the reading line, and that row's top edge below the scrollport's.
   *
   * A windowed transcript reads it from the model rather than from the rows it has rendered: the
   * rendered range answers a scroll event one turn late, so on the turn the reader's offset lands,
   * asking it which row contains that offset answers with a row from the range they just left.
   *
   * A short transcript reads it from the rows themselves, which is the same answer by another road —
   * every row it has is drawn. It is read there too, and not only where a window needs it: a
   * conversation that grows past the threshold while the reader is in it is remounted into a window
   * drawn from estimates, and the place recorded on the last frame they scrolled on is what that
   * window has to be aimed at.
   */
  const readAnchor = useCallback(
    (viewport: HTMLElement): { anchorId: string; anchorTop: number } | null => {
      const viewportTop = viewport.getBoundingClientRect().top;
      const line = viewportTop + FEED_TOP_LINE_OFFSET_PX;
      if (!virtualized) {
        const nodes = viewport.querySelectorAll<HTMLElement>('[data-slot="message"]');
        for (let index = 0; index < nodes.length; index += 1) {
          const rect = nodes[index].getBoundingClientRect();
          if (rect.bottom > line) {
            return { anchorId: rows[index]?.id ?? RUNNING_ROW_ID, anchorTop: rect.top - viewportTop };
          }
        }
        return null;
      }
      const item = virtualItemAt(viewport.scrollTop + FEED_TOP_LINE_OFFSET_PX);
      const row = item === undefined ? undefined : rows[item.index];
      const spacer = spacerRef.current;
      if (item === undefined || row === undefined || spacer === null) return null;
      return {
        anchorId: row.id,
        anchorTop: spacer.getBoundingClientRect().top + (item.start - scrollMargin) - viewportTop,
      };
    },
    [rows, scrollMargin, virtualItemAt, virtualized],
  );

  /**
   * The rows the reader can actually see, in order, with their boxes.
   *
   * A windowed transcript names them from its own wrappers, because the rows drawn are not the rows
   * at those indexes; a short one has no wrappers at all and names them by position, since every row
   * it has is drawn.
   */
  const rowsOnScreen = useCallback(
    (viewport: HTMLElement): { id: string; top: number; height: number }[] => {
      if (virtualized) {
        const nodes = spacerRef.current?.children;
        if (nodes === undefined) return [];
        const found: { id: string; top: number; height: number }[] = [];
        for (const node of Array.from(nodes)) {
          if (!(node instanceof HTMLElement) || node.dataset.rowKey === undefined) continue;
          const rect = node.getBoundingClientRect();
          found.push({ id: node.dataset.rowKey, top: rect.top, height: rect.height });
        }
        return found;
      }
      return Array.from(viewport.querySelectorAll<HTMLElement>('[data-slot="message"]')).map(
        (node, index) => {
          const rect = node.getBoundingClientRect();
          return { id: rows[index]?.id ?? RUNNING_ROW_ID, top: rect.top, height: rect.height };
        },
      );
    },
    [rows, virtualized],
  );

  /**
   * The rail's active row.
   *
   * The reading is the one the rail has always made — the row nearest the middle of the scrollport,
   * or the first or last of them at either edge — but over the rows on screen instead of over every
   * row of the conversation: a windowed transcript has no other rows in the document, and a reader
   * looking at the middle of a long conversation is looking at rows that are all on screen.
   */
  const readActiveRailId = useCallback(
    (viewport: HTMLElement): string => {
      const onScreen = rowsOnScreen(viewport);
      if (onScreen.length === 0) return "";
      if (viewport.scrollTop <= FEED_EDGE_THRESHOLD_PX) return onScreen[0].id;
      const distanceFromEnd = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      if (distanceFromEnd <= FEED_EDGE_THRESHOLD_PX) return onScreen[onScreen.length - 1].id;
      const viewportRect = viewport.getBoundingClientRect();
      const center = viewportRect.top + viewportRect.height / 2;
      let nearest = onScreen[0].id;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const row of onScreen) {
        const distance = Math.abs(row.top + row.height / 2 - center);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = row.id;
        }
      }
      return nearest;
    },
    [rowsOnScreen],
  );

  /**
   * Record where the reader is.
   *
   * The offset alone is not the place in a windowed transcript: the rows it is an offset *into* are
   * being measured as they are drawn, and a window that has just corrected itself for a row's real
   * height has moved every offset below it. The row under the reading line and that row's own edge
   * are what a rebuilt window can be put back on, and they are read from the model, which is the side
   * that knows where its rows are.
   */
  const writePlace = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const anchor = readAnchor(viewport);
    setReaderPlace(
      sessionId,
      anchor === null
        ? { scrollTop: viewport.scrollTop }
        : { scrollTop: viewport.scrollTop, ...anchor },
    );
  }, [readAnchor, sessionId]);

  /** The reader's own scroll is the only one that writes where they are; see `onUserScroll`. */
  const saveReaderPlace = useCallback(() => {
    // Their input also ends a landing still trying to put their old line back: they have just said
    // where they want to be, and that is the place worth keeping.
    landingRelease.current?.();
    writePlace();
  }, [writePlace]);

  const handleScroll = useCallback(() => {
    if (reportFrame.current !== undefined) return;
    reportFrame.current = requestAnimationFrame(() => {
      reportFrame.current = undefined;
      const viewport = viewportRef.current;
      if (viewport === null) return;
      const activeRow = readActiveRailId(viewport);
      const active = turnIdOfRow.get(activeRow) ?? activeRow;
      setActiveRailId((current) => (current === active ? current : active));
    });
  }, [readActiveRailId, turnIdOfRow]);

  const handleFollowChange = useCallback(
    (next: boolean) => {
      followingRef.current = next;
      setFollowing(next);
      setReaderPlace(sessionId, { following: next });
    },
    [sessionId],
  );

  /**
   * A copy that has a message chip in its selection copies the file too.
   *
   * The browser writes what is visible — the chip's elided name — and the file behind it is lost.
   * The selected chips are found in the range itself, so a copy of half a message carries only the
   * files whose chips the reader actually selected, and the files travel as mention lines in the
   * text plus a real file list on the clipboard (where the platform publishes one). The labels
   * themselves leave the text (`lib/selection-words.ts`): the name already travels as an address,
   * and a label pasted back into a composer would be that name written as prose beside its chip.
   */
  const handleCopy = useCallback((event: ClipboardEvent<HTMLElement>) => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!viewport.contains(range.commonAncestorContainer)) return;
    const selected = selectionCopy(range);
    if (selected.files.length === 0) return;
    event.preventDefault();
    event.clipboardData?.setData(
      "text/plain",
      textWithFileMentions(selected.words, selected.files),
    );
    // The event's own write is the text; the files can only go through the desktop, whose command
    // repeats the text beside them so the clipboard is replaced once rather than twice. The offsets
    // ride beside the copy rather than in its text, so a paste of this copy puts the chips back
    // where they stood.
    void copyTextWithFiles(selected.words, selected.files, selected.placements).catch(
      () => undefined,
    );
  }, []);

  /**
   * Take the transcript to its live edge.
   *
   * `forced` is the reader asking for the floor — a jump from the rail — which is not the follow and
   * is not weighed against what the content has done since.
   *
   * Growing content is taken *instantly*, and in the frame it grew: the scroller's resize observer
   * asks for exactly this before the frame is painted, so the rows above the foot move and the foot
   * holds still (see `message-scroller.tsx`). A glide belongs to the asks that are jumps — the
   * rail's last mark, a smooth seek — where the distance is large and an instant write would read as
   * a lurch.
   */
  const takeFloor = useCallback(
    (behavior: ScrollBehavior, forced = false) => {
      const viewport = viewportRef.current;
      if (viewport === null) return;
      const floor = viewport.scrollHeight;
      if (!forced && floor <= restoredFloor.current) {
        // The content shrank — a disclosure folded, a row collapsed — so the floor moved *up*. The
        // mark comes down with it: left at the old height it would read every later growth as no
        // growth, and a reader watching a turn would lose the bottom the moment a block folded.
        restoredFloor.current = floor;
        return;
      }
      restoredFloor.current = floor;
      const instant = behavior === "auto" || reduceMotion;
      if (virtualized) {
        // A windowed transcript's floor is its last row, so a jump is asked for through the model.
        // The spacer's height is the floor, and the model reads the scrollport it moves.
        if (instant) {
          stopFollowing(viewport);
          virtualizer.scrollToEnd({ behavior: "auto" });
        } else {
          followFloor(viewport);
        }
        return;
      }
      followFloor(viewport, { instant });
    },
    [reduceMotion, virtualized, virtualizer],
  );

  /** The floor, as the scroller's own follow asks for it. */
  const takeBottom = useCallback(
    (behavior: ScrollBehavior) => takeFloor(behavior),
    [takeFloor],
  );

  /**
   * The reader asking for the newest row.
   *
   * The follow is turned back on before the write, so the frame after this one answers the content
   * that arrives next while the write itself lands on the floor as it is now. It is an instant
   * write rather than a smooth one: the distance may be a whole transcript, and an animation over
   * that many unmeasured rows is a fling the reader did not ask for. A windowed list takes the
   * same road the follow does (`takeFloor`), which aims at its last row rather than at an offset
   * the model has only estimated.
   */
  const returnToBottom = useCallback(() => {
    followingRef.current = true;
    setFollowing(true);
    setReaderPlace(sessionId, { following: true });
    takeFloor("auto", true);
  }, [sessionId, takeFloor]);

  // The reader's place, put back the moment the rows are on screen.
  //
  // Two moments need this and they are the same moment: the pane mounting for a conversation the
  // reader is coming back to, and a conversation that grows past the threshold while they are in it —
  // there the rows are remounted into a window drawn from flat estimates, the offset they had is an
  // offset into a conversation whose rows are no longer all there, and the browser clamps it to
  // whatever the shorter content allows. Both are answered by the place recorded on the last frame
  // the reader scrolled on, which is why it is read from the store here rather than taken from the
  // mount-time snapshot.
  //
  // A reader who was at the live edge needs nothing put back: their place *is* the floor, and the
  // floor is taken on this frame. A conversation being opened for the first time has no place
  // recorded at all, which `readerPlace` answers as a followed one — so this branch is also what
  // opens an old conversation on its newest rows rather than on the first line of a transcript the
  // reader has never seen.
  //
  // `restoredFloor` is cleared before the ask, and that is what makes the ask land: it is the height
  // `takeFloor` weighs a follow against, and seeding it with the height the transcript already has
  // would make every ask on this frame a no-op — the scroller's own request included, which is why a
  // followed pane used to mount at whatever offset it was handed and stay there.
  useLayoutEffect(() => {
    const recorded = readerPlace(sessionId);
    const viewport = viewportRef.current;
    if (viewport === null) return;
    if (recorded.following) {
      restoredFloor.current = 0;
      takeBottom("auto");
      return;
    }
    // A reader who was parked gets their place back: the offset, and for a window the row their
    // reading line fell in.
    viewport.scrollTop = recorded.scrollTop;
    restoredFloor.current = viewport.scrollHeight;
    if (!virtualized || recorded.anchorId === null) return;
    const anchorId = recorded.anchorId;
    const index = rows.findIndex((row) => row.id === anchorId);
    landingRelease.current?.();
    const stopLanding = landReader({
      viewport,
      rowElement,
      anchorId,
      index,
      anchorTop: recorded.anchorTop,
      aim: (at) => virtualizer.scrollToIndex(at, { align: "start" }),
      onRelease: () => {
        if (landingRelease.current === stopLanding) landingRelease.current = null;
      },
    });
    landingRelease.current = stopLanding;
    return () => {
      landingRelease.current?.();
      landingRelease.current = null;
    };
    // The place is read once, at the moment this runs: on mount, and on the crossing that rebuilds
    // the rows into a window. Nothing later re-reads it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualized]);

  /**
   * Put the drawn rows back on their own boxes before the frame is painted.
   *
   * The model applies a resize on the animation frame *after* the one that resized the row
   * (`useAnimationFrameWithResizeObserver`), and its synchronous `measureElement` answers with the
   * size it already holds instead of reading the DOM. A row that shrank is therefore still at its
   * old height for that frame, and the row after it is painted that much lower than it belongs —
   * one gap above the newest row, unrelated to what either row says. The newest assistant row is
   * the row this happens to on every step: its reasoning is expanded while it is the live output
   * and folds the moment the step hands over to its answer (`conversation-rows.ts` clears
   * `thinkingLive`), so the fold and the answer that follows it land in the same commit.
   *
   * Reading the boxes here is the read the model would make one frame later, taken at the commit
   * that changed them, so the gap never reaches the screen. Only drawn rows are read, and only a
   * whole-pixel difference is applied: the model's sizes are whole numbers too.
   *
   * The resize is handed to a microtask rather than applied here because the model's notify raises
   * a flush, and React refuses a flush asked for from inside a layout effect — it is still in the
   * commit it was asked to flush, and says so on the console. A microtask runs after this commit
   * and before the browser paints, so the correction is still in time for the frame, and the flush
   * it asks for is the ordinary one.
   */
  const syncDrawnRowSizes = useCallback(() => {
    if (!virtualized) return;
    const spacer = spacerRef.current;
    if (spacer === null) return;
    const cache = virtualizer.measurementsCache;
    const stale: [number, number][] = [];
    for (const node of Array.from(spacer.children)) {
      if (!(node instanceof HTMLElement)) continue;
      const index = Number(node.dataset.index);
      const item = cache[index];
      if (item === undefined) continue;
      const height = node.offsetHeight;
      // The lane, for the estimate of every row that has not been drawn yet.
      if (node.clientWidth > 0) laneRef.current = node.clientWidth;
      if (Math.round(item.size) !== height) stale.push([index, height]);
    }
    // The reader's own content size, for the same estimate: the advances it divides by were measured
    // at 14 px, and the line height does not move with the setting.
    const contentSize = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--omp-content-font-size'),
    );
    if (Number.isFinite(contentSize) && contentSize > 0) fontScaleRef.current = contentSize / 14;
    if (stale.length === 0) return;
    queueMicrotask(() => {
      // The pane may have been unmounted, or the window rebuilt, between this commit and the
      // microtask: the rows it names are the ones this window drew, so a changed spacer means the
      // read is stale and the sizes are left to the model's own observer.
      if (spacerRef.current !== spacer) return;
      for (const [index, height] of stale) virtualizer.resizeItem(index, height);
    });
  }, [virtualized, virtualizer]);

  useLayoutEffect(() => {
    syncDrawnRowSizes();
  });

  /**
   * A width change is the one resize no commit answers — no state moved, only the box.
   *
   * The rows are stood on the boxes they have from the observer that runs after layout and before
   * paint, which is what keeps a narrowed window from painting one frame on the heights of the
   * frame before.
   *
   * The model is given those same boxes *before* the frame is painted, through the pass a commit
   * already runs (`syncDrawnRowSizes`): it applies a resize on its own next animation frame
   * (`useAnimationFrameWithResizeObserver`), and a followed transcript's floor is read from the
   * model, so a frame painted with the model's previous heights is a frame whose foot sits lower
   * than the rows and is pulled back on the next one — the transcript bouncing up and down for as
   * long as the column moves (2026-11-03, user report: 打开侧边栏时对话内容上下抽搐). With the
   * sizes in the model, the flush that answers this frame's reflow also takes the floor, and the
   * foot does not move; measured over a 458 px widen and the same shrink, the foot holds its place
   * on every frame in both directions.
   */
  useLayoutEffect(() => {
    if (!virtualized) return;
    const viewport = viewportRef.current;
    if (viewport === null || typeof ResizeObserver === "undefined") return;
    let width = viewport.clientWidth;
    const observer = new ResizeObserver(() => {
      const next = viewport.clientWidth;
      if (next === width) return;
      width = next;
      const spacer = spacerRef.current;
      if (spacer !== null) standRowsOnBoxes(spacer, FEED_ROW_GAP_PX);
      syncDrawnRowSizes();
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [virtualized, syncDrawnRowSizes]);

  // What a frame owes the reader, whichever side of the transcript they are on.
  //
  // A followed pane owes the floor: a row that grows changes the scroller's height before the model
  // hears about it, and a row that has just been appended is measured on the frame after it mounts,
  // so the new line would be painted below the fold and pulled back on the next frame — the
  // conversation stuttering while the engine streams. A pane the reader has parked owes them
  // nothing: their place is written when they scroll (`onUserScroll`), and re-recording it on every
  // layout commit would replace their anchor with a virtualizer measurement's offset.
  useLayoutEffect(() => {
    if (followingRef.current) takeBottom("auto");
  });

  // Where the window's rows start, in the scroller's own offsets: the scrollport pads its top, and
  // the model counts from the content's edge while the scroll offset counts from the padded one.
  useLayoutEffect(() => {
    if (!virtualized) return;
    const viewport = viewportRef.current;
    const spacer = spacerRef.current;
    if (viewport === null || spacer === null) return;
    const margin = Math.round(
      spacer.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop,
    );
    setScrollMargin((current) => (current === margin ? current : margin));
  }, [virtualized]);

  useEffect(
    () => () => {
      if (reportFrame.current !== undefined) cancelAnimationFrame(reportFrame.current);
      landingRelease.current?.();
    },
    [],
  );

  const railCopy = useMemo(
    () => ({
      message: copy.railMessage,
      thinking: copy.thinkingLabel,
      working: copy.workingLabel,
      reminder: copy.railReminder,
      toolCalls: copy.toolCalls,
      toolSucceeded: copy.toolSucceeded,
      toolFailedCount: copy.toolFailedCount,
      railItemLabel: copy.railItemLabel,
    }),
    [copy],
  );
  // The rail's rows come from the conversation's own model rather than from the document: only the
  // model holds the rows a window is not drawing, and only the model can answer for them without
  // reading the ones that are.
  const railEntries = useMemo(
    () => buildRailItems(rows, streaming, railCopy, railCacheRef.current as RailCache),
    [railCopy, rows, streaming],
  );

  // How many marks the rail's box can hold. The rail is drawn over the scrollport, so that box is
  // the scrollport's own height, and the height moves with the window, with the composer below it and
  // with the panel beside it. The list the marks are drawn from is built here, so the reading is
  // taken here; the scroller observes the same box for its own readings (whether the rail is drawn
  // at all) and reports none of them.
  const [railHeight, setRailHeight] = useState(0);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null || typeof ResizeObserver === "undefined") return;
    setRailHeight(viewport.clientHeight);
    const observer = new ResizeObserver(() => setRailHeight(viewport.clientHeight));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  const railCapacity = useMemo(
    () => Math.max(1, Math.floor((railHeight * RAIL_VIEWPORT_SHARE) / RAIL_TICK_SIZE_PX)),
    [railHeight],
  );
  // A conversation the rail can draw whole is handed over as it is; a longer one is described by the
  // rows that matter most (`rail-rows.ts`), so what the reader gets is a rail rather than a stack of
  // marks taller than the transcript.
  const railRows = useMemo(
    () => selectRailItems(railEntries, railCapacity),
    [railCapacity, railEntries],
  );

  const selectRailRow = useCallback(
    (item: PreviewRailItem) => {
      const viewport = viewportRef.current;
      if (viewport === null) return;
      // The rail's last row is the foot of the transcript, and asking for it is asking for the floor
      // rather than for a row to be centred — which the scroller's own follow has already asked for.
      if (item.id === railRows.at(-1)?.id) {
        takeFloor("smooth", true);
        return;
      }
      const index = item.id === RUNNING_ROW_ID ? rows.length : rows.findIndex((row) => row.id === item.id);
      if (index < 0) return;
      if (!virtualized) {
        const nodes = Array.from(viewport.querySelectorAll<HTMLElement>('[data-slot="message"]'));
        const target = nodes[index];
        if (target === undefined) return;
        const viewportRect = viewport.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        viewport.scrollTo({
          top:
            viewport.scrollTop +
            targetRect.top -
            viewportRect.top -
            (viewport.clientHeight - targetRect.height) / 2,
          behavior: "smooth",
        });
        return;
      }
      virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
    },
    [railRows, rows, takeFloor, virtualized, virtualizer],
  );

  const rail = useMemo<MessageScrollerRail>(
    () => ({ items: railRows, activeId: activeRailId, onSelect: selectRailRow }),
    [activeRailId, railRows, selectRailRow],
  );

  const setRowElement = useCallback(
    (node: HTMLDivElement | null) => {
      // Handing the element over is what replaces its estimate with a real box, and what has the
      // model watch it from then on. A departure is announced as null, which the model reads as
      // "sweep the elements that have left the document".
      virtualizer.measureElement(node);
    },
    [virtualizer],
  );

  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col", className)}>
      <MessageScroller
        busy={streaming}
        navigation="rail"
        followOutput={following}
        onFollowChange={handleFollowChange}
        onUserScroll={saveReaderPlace}
        rail={rail}
        onTakeBottom={takeBottom}
        viewportRef={viewportRef}
        viewportProps={{ onScroll: handleScroll, onCopy: handleCopy }}
        className="min-h-0 flex-1"
        // The transcript's own foot: the rows end well above the composer rather than against it, and
        // that room is part of the content — it scrolls with it, so a long conversation still reaches
        // its own last line. The composer is a dock, not an overlay, so without this the newest row
        // sits jammed against the field.
        //
        // The lane and the padding are the composer's own (`index.css`, `--omp-conversation-lane`):
        // a row's content has to end where the field ends, and the rail is drawn inside the same
        // side padding, so it never moves the text.
        viewportClassName={cn("px-3 pt-5 pb-24", viewportClassName)}
        // A transcript shorter than its scrollport hangs from the bottom edge rather than from the
        // top: its foot — the running line while a turn is in flight — then keeps its place while
        // the content above it grows and folds, and the older rows are what move. Without this the
        // foot drifted down by a line whenever a live reasoning block wrapped, and sprang back up
        // when the block folded at its answer (2026-10-24, user report: 输出一行就会挤压运行中，
        // 输出完毕又回弹，一直抖动). `mt-auto` on the one child, rather than `justify-end`: a flex
        // line that overflows toward the start is unreachable by scrolling, and this transcript is
        // a scrollport before it is a column of rows.
        //
        // A transcript *longer* than its scrollport is the scroller's resize observer's case
        // instead: it pins the floor in the frame a row grew, which is the same rule by another
        // road (2026-10-25 — the same report came back for tall conversations, where `mt-auto` has
        // collapsed to zero and the follow was gliding instead of pinning).
        contentClassName="mx-auto flex min-h-full w-full max-w-(--omp-conversation-lane) flex-col"
      >
      {virtualized ? (
        // One box, two shapes: a short conversation renders every row as the flow DOM it is, and a
        // long one becomes the model's spacer — a box whose height is the total, holding the absolute
        // rows the model places inside it.
        <div ref={spacerRef} className="relative mt-auto w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            return (
              <div
                key={item.key}
                ref={setRowElement}
                data-index={item.index}
                data-row-key={row?.id ?? RUNNING_ROW_ID}
                className="absolute inset-x-0"
                style={{ top: item.start - scrollMargin }}
              >
                {row === undefined ? footRow : renderRow(row, item.index)}
              </div>
            );
          })}
        </div>
      ) : (
        <MessageGroup spacing="default" className="mt-auto">
          {rows.map((row, index) => renderRow(row, index))}
          {footLive ? footRow : null}
        </MessageGroup>
      )}
      </MessageScroller>
      {/* The transcript fades into the composer instead of being cut off by it: the composer is a
          dock, not a scroller child, so the last rows end at a hard edge — and a line of text that
          stops mid-glyph against the composer's surface is the thing this covers. The fade is the
          pane's own colour coming up over the rows, drawn over the scrollport rather than inside it:
          nothing here scrolls with the content, and a pointer goes straight through to the rows the
          reader is aiming at. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-12 bg-gradient-to-t from-pane to-transparent"
      />
      {/* The way home, offered while the reader is away from the newest row: a corner control
          rather than a bar, so it never covers a line of the transcript for longer than it is
          used. The arrow is drawn at 12px inside a 28px target — the smallest circle the pointer
          can still hit without the bead taking a row's attention. */}
      <AnimatePresence initial={false}>
        {following ? null : (
          <motion.div
            key="scroll-to-bottom"
            className="absolute right-3 bottom-3 z-20"
            initial={{ opacity: 0, y: reduceMotion ? 0 : 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : 4 }}
            transition={{ duration: reduceMotion ? 0 : 0.16 }}
          >
            <Button
              variant="secondary"
              size="icon"
              aria-label={copy.scrollToBottom}
              onClick={returnToBottom}
              className="size-7 rounded-full p-0 text-muted-foreground shadow-md hover:text-foreground"
            >
              <ArrowDown aria-hidden="true" className="size-3" />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
