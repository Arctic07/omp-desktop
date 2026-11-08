"use client";
// beui.dev/components/agents/chat-app

import { useReducedMotion } from "motion/react";
import {
  type ComponentPropsWithRef,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { railPreview } from "@/components/agents/rail-preview";
import {
  PreviewRail,
  type PreviewRailItem,
} from "@/components/motion/preview-rail";
import { followFloor, stopFollowing } from "@/lib/follow-scroll";
import { useCopy, type Localized } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** The transcript's own wording: its accessible name, its rail and the rows the rail announces. */
interface MessageScrollerCopy {
  conversation: string
  messageNavigation: string
  /** The rail's title for a row whose text is empty. */
  message: string
  /** A rail row's accessible name; the row's own sender, position and total. */
  railItemLabel: (sender: string, index: number, total: number) => string
}

const COPY: Localized<MessageScrollerCopy> = {
  en: {
    conversation: "Conversation",
    messageNavigation: "Message navigation",
    message: "Message",
    railItemLabel: (sender, index, total) =>
      `Go to ${sender} message ${index} of ${total}`,
  },
  zh: {
    conversation: "对话",
    messageNavigation: "消息导航",
    message: "消息",
    railItemLabel: (sender, index, total) => {
      const from =
        sender === "user" ? "用户" : sender === "assistant" ? "智能体" : "对话";
      return `前往第 ${index} 条${from}消息，共 ${total} 条`;
    },
  },
};

/** How long after the reader's last input a scroll is still read as theirs. */
const USER_INTENT_TTL_MS = 500;

function getMessageText(message: HTMLElement) {
  const surface =
    message.querySelector<HTMLElement>('[data-slot="message-bubble-content"]') ??
    message.querySelector<HTMLElement>('[data-slot="message-content"]') ??
    message;
  return (surface.textContent ?? "").replace(/\s+/g, " ").trim();
}

function getMessagePreview(
  copy: MessageScrollerCopy,
  message: HTMLElement,
  assistantResponse?: HTMLElement,
) {
  // The same two readings the conversation's own rail builds (`rail-preview.ts`): the row's words
  // on the title line, the answer it drew under them. A caller with no model of its rows gets the
  // card the model would have built.
  return railPreview(
    getMessageText(message),
    assistantResponse ? getMessageText(assistantResponse) : "",
    copy.message,
  );
}

/**
 * The transcript's own rows, when the caller has a model of them.
 *
 * A windowed transcript draws a few rows around the reader and keeps the rest out of the document,
 * so a rail enumerated from the DOM would offer only what happens to be drawn — and it would re-read
 * every drawn row's text on every frame that arrived. The caller is the side that owns the rows, so
 * it hands them over here, together with the row the reading line falls in and what to do when the
 * reader picks one: a row that is not drawn cannot be scrolled to by the rail itself, so the caller
 * places the view.
 */
export interface MessageScrollerRail {
  /** Every row of the conversation, in order — the model's list, not the drawn window. */
  items: PreviewRailItem[]
  /** The row under the reading line, as the caller reads it. */
  activeId?: string
  /** The reader picked a row. */
  onSelect?: (item: PreviewRailItem) => void
}

/**
 * The height one tick of the navigation rail is drawn at, in pixels.
 *
 * A caller that decides how many ticks the rail may draw needs it: how many fit is that caller's own
 * arithmetic — `home/ConversationFeed` caps the list to a share of the scrollport — and it has to be
 * the number the rail is actually drawn at.
 */
export const RAIL_TICK_SIZE_PX = 14;

export interface MessageScrollerProps extends ComponentPropsWithRef<"div"> {
  /** Keep streamed output pinned while the reader remains near the end. */
  followOutput?: boolean;
  /** Distance from the end that still counts as following the output. */
  followThreshold?: number;
  /**
   * Animate the rail's own jumps (`behavior: "smooth"`).
   *
   * The follow of growing content is never smooth: it is pinned in the frame the content grew
   * (see the resize observer below).
   */
  smooth?: boolean;
  /** Reports when the reader leaves or returns to the live edge. */
  onFollowChange?: (following: boolean) => void;
  /**
   * The reader moved the transcript themselves.
   *
   * Called after the follow has been decided, for a scroll the scroller can attribute to the
   * reader rather than to its own writes or the layout's measurements. It is the caller's cue to
   * remember where they are — a layout-driven scroll must not overwrite that record.
   */
  onUserScroll?: () => void;
  /** Accessible label for the scrollable transcript. */
  label?: string;
  /** Marks the transcript as waiting for more streamed content. */
  busy?: boolean;
  /** Adds a compact rail for navigating between rendered Message rows. */
  navigation?: "rail";
  /** Accessible label for the optional message navigation rail. */
  navigationLabel?: string;
  /**
   * The rail's rows, when the caller has the conversation's own row model. Given this, the rail is
   * drawn from it and the document is never walked for rows.
   */
  rail?: MessageScrollerRail;
  /**
   * Take the transcript to its live edge, when the caller's own list is what knows where that is: a
   * windowed transcript's floor is a row of its model, not this scroller's own bottom.
   */
  onTakeBottom?: (behavior: ScrollBehavior) => void;
  viewportClassName?: string;
  contentClassName?: string;
  railClassName?: string;
  viewportRef?: Ref<HTMLElement>;
  viewportProps?: Omit<
    ComponentPropsWithRef<"section">,
    "children" | "className" | "ref"
  >;
  contentProps?: Omit<
    ComponentPropsWithRef<"div">,
    "children" | "className" | "ref"
  >;
}

export function MessageScroller({
  followOutput = true,
  followThreshold = 56,
  smooth = true,
  onFollowChange,
  onUserScroll,
  label,
  busy,
  navigation,
  navigationLabel,
  rail,
  onTakeBottom,
  viewportClassName,
  contentClassName,
  railClassName,
  viewportRef: externalViewportRef,
  viewportProps,
  contentProps,
  className,
  children,
  ...props
}: MessageScrollerProps) {
  const reduce = useReducedMotion() ?? false;
  const copy = useCopy(COPY);
  const viewportRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(followOutput);
  /**
   * What the reader's last input said about where they are going, and when.
   *
   * `following` is the reader's scrolling right, not a snapshot of the geometry: only input can
   * take it away or give it back. Scroll events the scroller did not cause — a virtual row being
   * measured, a disclosure folding, a width change re-wrapping the transcript — arrive with no
   * intent here, and are left to update the view's geometry without touching the follow.
   */
  const userIntentRef = useRef<{ intent: "none" | "awayFromBottom" | "towardBottom" | "unknown"; at: number }>({
    intent: "none",
    at: 0,
  });
  const touchYRef = useRef<number | null>(null);
  const scrollbarPointerIdRef = useRef<number | null>(null);
  const frameRef = useRef<number | undefined>(undefined);
  const railFrameRef = useRef<number | undefined>(undefined);
  const railIdRef = useRef(new WeakMap<HTMLElement, string>());
  const railIdCounterRef = useRef(0);
  const railTargetsRef = useRef(new Map<string, HTMLElement>());
  /** Whether the rail's rows are the caller's, in which case this scroller never walks the DOM. */
  const modelledRail = rail !== undefined;
  const [domRailItems, setDomRailItems] = useState<PreviewRailItem[]>([]);
  const [domActiveRailId, setDomActiveRailId] = useState("");
  const [railOverflowing, setRailOverflowing] = useState(false);
  const railItems = modelledRail ? rail.items : domRailItems;
  const activeRailId = modelledRail ? (rail.activeId ?? "") : domActiveRailId;
  /**
   * How many rows the rail is offering, read through a ref rather than closed over: the sync is
   * scheduled from observers, and a callback that changed identity every time a row arrived would
   * take those observers down and put them back up with it.
   */
  const railCountRef = useRef(railItems.length);
  useEffect(() => {
    railCountRef.current = railItems.length;
  }, [railItems.length]);
  const {
    onScroll: onViewportScroll,
    onWheel: onViewportWheel,
    onTouchStart: onViewportTouchStart,
    onTouchMove: onViewportTouchMove,
    onTouchEnd: onViewportTouchEnd,
    onTouchCancel: onViewportTouchCancel,
    onKeyDown: onViewportKeyDown,
    onPointerDown: onViewportPointerDown,
    onPointerUp: onViewportPointerUp,
    onPointerCancel: onViewportPointerCancel,
    ...restViewportProps
  } = viewportProps ?? {};

  const setViewportRef = useCallback(
    (node: HTMLElement | null) => {
      // A scrollport that leaves the document takes its follow with it: the glide writes the
      // element it was started on, and a transcript that has been unmounted must leave nothing
      // running behind it.
      if (node === null) stopFollowing(viewportRef.current);
      viewportRef.current = node;
      if (typeof externalViewportRef === "function") {
        externalViewportRef(node);
      } else if (externalViewportRef) {
        externalViewportRef.current = node;
      }
    },
    [externalViewportRef],
  );

  const setFollowing = useCallback(
    (next: boolean) => {
      if (followingRef.current === next) return;
      followingRef.current = next;
      // A follow that has been given up stops writing the scrollport at once: the reader's own
      // gesture owns the viewport from here, and a glide still running would fight it for the floor.
      if (!next) stopFollowing(viewportRef.current);
      onFollowChange?.(next);
    },
    [onFollowChange],
  );

  const getActiveUserIntent = useCallback(() => {
    const current = userIntentRef.current;
    const interactionActive =
      touchYRef.current !== null || scrollbarPointerIdRef.current !== null;
    if (interactionActive) {
      return current.intent === "none" ? "unknown" : current.intent;
    }
    return performance.now() - current.at <= USER_INTENT_TTL_MS
      ? current.intent
      : "none";
  }, []);

  /**
   * Take the reader's scrolling right at the input that expresses it.
   *
   * This is deliberately earlier than the scroll event: a streamed delta, a disclosure or a
   * virtualizer measurement can commit in the same frame as the wheel and still see the old
   * `following`, and pinning the reader back to the floor is exactly what that stale read does.
   */
  const markUserScrollIntent = useCallback(
    (intent: "none" | "awayFromBottom" | "towardBottom" | "unknown") => {
      if (intent === "none") return;
      userIntentRef.current = { intent, at: performance.now() };
      if (intent === "awayFromBottom") {
        const viewport = viewportRef.current;
        if (viewport && viewport.scrollHeight > viewport.clientHeight) {
          setFollowing(false);
        }
      }
    },
    [setFollowing],
  );

  /**
   * Whether a wheel or touch over `target` is for the transcript rather than a box inside it.
   *
   * A code block has its own vertical box; scrolling it must not take the conversation's follow
   * away. Only a nested box that can still move in this direction owns the gesture — at its edge the
   * scroll chains to the transcript, and the intent is the reader's after all.
   */
  const scrollsTranscript = useCallback((target: EventTarget | null, deltaY: number) => {
    const viewport = viewportRef.current;
    if (!viewport || !(target instanceof Element)) return true;
    let node: Element | null = target;
    while (node && node !== viewport) {
      if (node instanceof HTMLElement) {
        const style = getComputedStyle(node);
        const scrollable =
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          node.scrollHeight > node.clientHeight + 1;
        if (scrollable) {
          const canScroll =
            deltaY < 0
              ? node.scrollTop > 0
              : node.scrollTop + node.clientHeight < node.scrollHeight - 1;
          if (canScroll) return false;
        }
      }
      node = node.parentElement;
    }
    return true;
  }, []);

  const updateActiveRailItem = useCallback(() => {
    if (navigation !== "rail" || modelledRail) return;
    const viewport = viewportRef.current;
    const targets = [...railTargetsRef.current.entries()];
    if (!viewport || targets.length === 0) return;

    const viewportRect = viewport.getBoundingClientRect();
    if (viewport.scrollTop <= followThreshold) {
      const firstId = targets[0]?.[0] ?? "";
        setDomActiveRailId((current) => (current === firstId ? current : firstId));
      return;
    }

    const distanceFromEnd =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromEnd <= followThreshold) {
      const lastId = targets.at(-1)?.[0] ?? "";
      setDomActiveRailId((current) => (current === lastId ? current : lastId));
      return;
    }

    const viewportCenter = viewportRect.top + viewportRect.height / 2;
    let nearestId = targets[0]?.[0] ?? "";
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const [id, element] of targets) {
      const rect = element.getBoundingClientRect();
      const messageCenter = rect.top + rect.height / 2;
      const distance = Math.abs(messageCenter - viewportCenter);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestId = id;
      }
    }

    setDomActiveRailId((current) =>
      current === nearestId ? current : nearestId,
    );
  }, [followThreshold, modelledRail, navigation]);

  const syncRailItems = useCallback(() => {
    if (navigation !== "rail") return;
    const viewport = viewportRef.current;
    if (modelledRail) {
      // The rail's rows are the caller's, so there is nothing to read out of the document and
      // nothing to derive: only whether the transcript is longer than the box it is read through.
      if (viewport) {
        setRailOverflowing(
          viewport.scrollHeight > viewport.clientHeight + 1 && railCountRef.current > 1,
        );
      }
      return;
    }
    const content = contentRef.current;
    if (!content || !viewport) return;

    const messages = Array.from(
      content.querySelectorAll<HTMLElement>('[data-slot="message"]'),
    );
    const targets = new Map<string, HTMLElement>();
    const nextItems = messages.map((message, index) => {
      let id = railIdRef.current.get(message);
      if (!id) {
        railIdCounterRef.current += 1;
        id = `message-rail-${railIdCounterRef.current}`;
        railIdRef.current.set(message, id);
      }
      targets.set(id, message);
      const sender = message.dataset.from ?? "conversation";
      const assistantResponse =
        sender === "user"
          ? messages
              .slice(index + 1)
              .find((candidate) => candidate.dataset.from === "assistant")
          : undefined;
      const preview = getMessagePreview(copy, message, assistantResponse);

      return {
        id,
        label: preview.label,
        description: preview.description,
        ariaLabel: copy.railItemLabel(sender, index + 1, messages.length),
      };
    });

    railTargetsRef.current = targets;
    setDomRailItems((current) => {
      const unchanged =
        current.length === nextItems.length &&
        current.every(
          (item, index) =>
            item.id === nextItems[index]?.id &&
            item.label === nextItems[index]?.label &&
            item.description === nextItems[index]?.description &&
            item.ariaLabel === nextItems[index]?.ariaLabel,
        );
      return unchanged ? current : nextItems;
    });
    setRailOverflowing(
      viewport.scrollHeight > viewport.clientHeight + 1 && messages.length > 1,
    );
  }, [copy, modelledRail, navigation]);

  const scheduleRailSync = useCallback(() => {
    if (navigation !== "rail") return;
    if (railFrameRef.current) cancelAnimationFrame(railFrameRef.current);
    railFrameRef.current = requestAnimationFrame(() => {
      syncRailItems();
      updateActiveRailItem();
    });
  }, [navigation, syncRailItems, updateActiveRailItem]);

  // The follow is one animation of this module's own (`lib/follow-scroll`): content that grows on
  // every revealed frame would otherwise restart a native smooth scroll per frame, and a restarted
  // animation is a viewport that lags by a variable amount and then lurches to catch up.
  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    if (onTakeBottom) {
      onTakeBottom(behavior);
      return;
    }
    followFloor(viewport, { instant: behavior === "auto" || reduce });
  }, [onTakeBottom, reduce]);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    // The rail follows every scroll, including the layout's own: it says what the reader can see,
    // not who moved them.
    updateActiveRailItem();

    // A scroll nobody asked for — a row measured, a fold, a width change — has no user intent and
    // must leave the follow exactly where the reader put it. The scrollbar and assistive input are
    // the reader's without a wheel or key to announce them, so a pointer down on the scrollport
    // itself registers the intent that this branch then reads.
    const intent = getActiveUserIntent();
    if (intent === "none") return;

    const distance =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    setFollowing(distance <= followThreshold);
    onUserScroll?.();
  }, [
    followThreshold,
    getActiveUserIntent,
    onUserScroll,
    setFollowing,
    updateActiveRailItem,
  ]);

  useLayoutEffect(() => {
    followingRef.current = followOutput;
    if (!followOutput) return;

    frameRef.current = requestAnimationFrame(() => scrollToEnd("auto"));
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [followOutput, scrollToEnd]);

  /**
   * A content box that grew or shrank under a following reader: take the floor in this frame.
   *
   * This is the only observer that sees the *revealed* growth. `useSmoothText` paces the answer out
   * of its own state, inside the row, so the commit that wraps a line never re-renders the feed —
   * the feed's own layout effect stays where it was, and nothing else would answer that frame.
   *
   * It has to be an instant write, not the glide: a resize observer delivers after layout and
   * before paint, so an instant write here lands in the very frame the row grew and the reader sees
   * the foot holding still while the rows above it move up. The glide was measured as the opposite
   * of that (2026-10-25, user report: 思考内容会挤压运行中到下方，输出完一行又会上浮，如此循环):
   * it starts a frame later and then advances a pixel per frame, so every wrapped line pushed the
   * running row down by one line and floated it back over the next quarter second — the exact
   * bounce the earlier `mt-auto` change was meant to end. A glide is still what a *jump* wants
   * (`takeFloor` from the rail), and that path does not come through here.
   */
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      scheduleRailSync();
      if (!followOutput || !followingRef.current) return;
      scrollToEnd("auto");
    });
    observer.observe(content);

    return () => observer.disconnect();
  }, [followOutput, scheduleRailSync, scrollToEnd]);

  useEffect(() => {
    if (navigation !== "rail") {
      railTargetsRef.current.clear();
      setDomRailItems([]);
      setRailOverflowing(false);
      return;
    }

    const content = contentRef.current;
    const viewport = viewportRef.current;
    if (!content || !viewport) return;

    scheduleRailSync();
    // A caller's own rows are read from its model, so nothing here has to watch the document: the
    // observers below exist to notice that the rows it would enumerate have changed, and there are
    // none. What is left is whether the transcript is longer than its box, which the scroll handler
    // and the content observer already cover.
    const mutationObserver =
      modelledRail || typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(scheduleRailSync);
    mutationObserver?.observe(content, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleRailSync);
    resizeObserver?.observe(content);
    resizeObserver?.observe(viewport);

    return () => {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
    };
  }, [modelledRail, navigation, scheduleRailSync]);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      if (railFrameRef.current) cancelAnimationFrame(railFrameRef.current);
    },
    [],
  );

  const scrollToRailItem = useCallback(
    (item: PreviewRailItem) => {
      const viewport = viewportRef.current;
      const target = modelledRail ? viewport : railTargetsRef.current.get(item.id);
      if (!viewport || !target) return;

      const lastItem = railItems.at(-1)?.id === item.id;
      if (!modelledRail) setDomActiveRailId(item.id);
      if (lastItem) {
        setFollowing(true);
        scrollToEnd(reduce || !smooth ? "auto" : "smooth");
        // The caller is told about this one as well: the floor is the scroller's to take, but a
        // windowed transcript's caller may want to know that the reader asked for its foot.
        rail?.onSelect?.(item);
        return;
      }

      setFollowing(false);
      if (modelledRail) {
        // The row the reader picked may be nowhere near the drawn window, so where to put it is the
        // caller's to say — it is the side that knows where the row actually is.
        rail.onSelect?.(item);
        return;
      }
      const viewportRect = viewport.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const top =
        viewport.scrollTop +
        targetRect.top -
        viewportRect.top -
        (viewport.clientHeight - targetRect.height) / 2;
      const behavior = reduce || !smooth ? "auto" : "smooth";

      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({ top, behavior });
      } else {
        viewport.scrollTop = top;
      }
    },
    [modelledRail, rail, railItems, reduce, scrollToEnd, setFollowing, smooth],
  );

  const viewport = (
    <section
      ref={setViewportRef}
      aria-label={label ?? copy.conversation}
      {...restViewportProps}
      onScroll={(event) => {
        handleScroll();
        onViewportScroll?.(event);
      }}
      onWheel={(event) => {
        if (scrollsTranscript(event.target, event.deltaY)) {
          markUserScrollIntent(
            event.deltaY < 0
              ? "awayFromBottom"
              : event.deltaY > 0
                ? "towardBottom"
                : "none",
          );
        }
        onViewportWheel?.(event);
      }}
      onTouchStart={(event) => {
        touchYRef.current = event.touches[0]?.clientY ?? null;
        onViewportTouchStart?.(event);
      }}
      onTouchMove={(event) => {
        const nextY = event.touches[0]?.clientY;
        const previousY = touchYRef.current;
        if (nextY !== undefined && previousY !== null) {
          const deltaY = previousY - nextY;
          if (scrollsTranscript(event.target, deltaY)) {
            markUserScrollIntent(
              nextY > previousY
                ? "awayFromBottom"
                : nextY < previousY
                  ? "towardBottom"
                  : "none",
            );
          }
          touchYRef.current = nextY;
        }
        onViewportTouchMove?.(event);
      }}
      onTouchEnd={(event) => {
        touchYRef.current = null;
        onViewportTouchEnd?.(event);
      }}
      onTouchCancel={(event) => {
        touchYRef.current = null;
        onViewportTouchCancel?.(event);
      }}
      onKeyDown={(event) => {
        const target = event.target;
        const editing =
          target instanceof HTMLElement &&
          (target.isContentEditable ||
            target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT");
        if (!editing) {
          markUserScrollIntent(
            ["ArrowUp", "PageUp", "Home"].includes(event.key)
              ? "awayFromBottom"
              : ["ArrowDown", "PageDown", "End", " "].includes(event.key)
                ? "towardBottom"
                : "none",
          );
        }
        onViewportKeyDown?.(event);
      }}
      onPointerDown={(event) => {
        // A press that lands on the scrollport itself is the scrollbar or its empty track: there
        // is no wheel or key to name the direction, so the intent is unknown until it moves.
        if (event.target === event.currentTarget) {
          scrollbarPointerIdRef.current = event.pointerId;
          markUserScrollIntent("unknown");
        }
        onViewportPointerDown?.(event);
      }}
      onPointerUp={(event) => {
        if (scrollbarPointerIdRef.current === event.pointerId) {
          scrollbarPointerIdRef.current = null;
        }
        onViewportPointerUp?.(event);
      }}
      onPointerCancel={(event) => {
        if (scrollbarPointerIdRef.current === event.pointerId) {
          scrollbarPointerIdRef.current = null;
        }
        onViewportPointerCancel?.(event);
      }}
      className={cn(
        "h-full overflow-y-auto overflow-x-hidden overscroll-contain outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        navigation === "rail"
          ? "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          : "[scrollbar-gutter:stable]",
        // The rail is drawn inside the caller's own side padding — its marks stand beside the
        // content lane rather than over it — so reserving room here would move the lane's centre
        // and put the transcript a few pixels out of line with whatever the surface puts under it
        // (the composer's field). A caller whose padding is narrower than the rail owns that
        // decision, not this scroller (2026-10-21).
        viewportClassName,
      )}
    >
      <div
        ref={contentRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-busy={busy}
        className={contentClassName}
        {...contentProps}
      >
        {children}
      </div>
    </section>
  );

  return (
    <div
      data-slot="message-scroller"
      className={cn("min-h-0", className)}
      {...props}
    >
      {navigation === "rail" ? (
        <PreviewRail
          items={railOverflowing ? railItems : []}
          label={navigationLabel ?? copy.messageNavigation}
          activeId={activeRailId}
          onItemSelect={scrollToRailItem}
          previewSide="before"
          highlightActive
          itemSize={RAIL_TICK_SIZE_PX}
          className="h-full min-h-0 overflow-hidden"
          previewContainerClassName="right-8 left-3"
          // The card's two readings, at the sizes the reference rail uses (its
          // `TurnNavigator`): the prompt is one 13px line whatever its length, and the answer under
          // it gets three 12px lines — the emphasis is the answer, so the prompt is cut rather than
          // continued, and 120 characters is what those three lines can hold at this width.
          previewClassName="mr-1 w-75 max-w-full [&_[data-slot=preview-rail-card]]:rounded-lg [&_[data-slot=preview-rail-card]]:px-3 [&_[data-slot=preview-rail-card]]:py-2.5 [&_[data-slot=preview-rail-title]]:line-clamp-1 [&_[data-slot=preview-rail-title]]:text-[13px] [&_[data-slot=preview-rail-title]]:leading-5 [&_[data-slot=preview-rail-title]]:font-medium [&_[data-slot=preview-rail-description]]:mt-1 [&_[data-slot=preview-rail-description]]:line-clamp-3 [&_[data-slot=preview-rail-description]]:text-xs [&_[data-slot=preview-rail-description]]:leading-[18px]"
          railClassName={cn(
            "absolute inset-y-3 right-1 w-7 content-center py-1 [&_[data-slot=preview-rail-item]]:w-7 [&_[data-slot=preview-rail-item]]:justify-end [&_[data-slot=preview-rail-tick]]:h-px [&_[data-slot=preview-rail-tick]]:w-4 [&_[data-slot=preview-rail-tick]]:origin-right",
            railOverflowing
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0",
            railClassName,
          )}
        >
          {viewport}
        </PreviewRail>
      ) : (
        viewport
      )}
    </div>
  );
}
