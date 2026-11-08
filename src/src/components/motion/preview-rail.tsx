"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  memo,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { EASE_OUT, SPRING_LAYOUT } from "@/lib/ease";
import { useDismiss } from "@/lib/hooks/use-dismiss";
import { useHoverGesture } from "@/lib/hooks/use-hover-gesture";
import { useTapGesture } from "@/lib/hooks/use-tap-gesture";
import { cn } from "@/lib/utils";

export interface PreviewRailItem {
  id: string;
  label: string;
  /**
   * The row's accessible name, as a string or as a function of where the row sits.
   *
   * The function form exists for a caller whose list is long and mostly unchanged: a name spelled
   * out per row would carry the row's position in it, and a position changes for every row the
   * moment one is appended — so a caller keeping its items by identity would have every one of them
   * new again on each append. The rail knows the position it is drawing at, so it composes the name
   * there and the caller's item stays the item it was.
   */
  ariaLabel?: string | ((index: number, total: number) => string);
  description?: ReactNode;
  href?: string;
  target?: "_blank" | "_self" | "_parent" | "_top";
  rel?: string;
}

export interface PreviewRailProps {
  items: PreviewRailItem[];
  label?: string;
  orientation?: "vertical" | "horizontal";
  activeId?: string;
  defaultActiveId?: string;
  onActiveChange?: (id: string) => void;
  onItemSelect?: (item: PreviewRailItem) => void;
  renderPreview?: (item: PreviewRailItem) => ReactNode;
  showPreview?: boolean;
  previewSide?: "before" | "after";
  highlightActive?: boolean;
  itemSize?: number;
  children?: ReactNode;
  className?: string;
  railClassName?: string;
  previewContainerClassName?: string;
  previewClassName?: string;
}

function DefaultPreview({ item }: { item: PreviewRailItem }) {
  return (
    <div
      data-slot="preview-rail-card"
      className="rounded-2xl border border-border bg-card p-4 shadow-sm"
    >
      <p
        data-slot="preview-rail-title"
        className="font-medium text-card-foreground"
      >
        {item.label}
      </p>
      {item.description ? (
        <div
          data-slot="preview-rail-description"
          className="mt-1 text-sm leading-6 text-muted-foreground"
        >
          {item.description}
        </div>
      ) : null}
    </div>
  );
}

interface RailTickListProps {
  items: PreviewRailItem[];
  isHorizontal: boolean;
  itemSize: number;
  selectedId: string;
  highlightedId: string;
  displayedIndex: number;
  reduce: boolean | null;
  onEnter: (item: PreviewRailItem, event: PointerEvent<HTMLElement>) => void;
  onDown: (item: PreviewRailItem, event: PointerEvent<HTMLElement>) => void;
  onCancel: () => void;
  onFocus: (item: PreviewRailItem, element: HTMLElement) => void;
  onSelect: (item: PreviewRailItem, event: MouseEvent<HTMLElement>) => void;
}

/**
 * The rail's ticks.
 *
 * Memoized because a caller can hand its items over by identity — a long transcript whose rows are
 * almost all unchanged offers the very same list again — and a re-render of whatever surrounds the
 * rail, which a scrolling transcript causes many times a frame, must not walk every tick again. The
 * props that are left are the ones a tick is actually drawn from: the list, the highlight, and the
 * size it is drawn at.
 */
const RailTicks = memo(function RailTicks({
  items,
  isHorizontal,
  itemSize,
  selectedId,
  highlightedId,
  displayedIndex,
  reduce,
  onEnter,
  onDown,
  onCancel,
  onFocus,
  onSelect,
}: RailTickListProps) {
  return (
    <>
      {items.map((item, index) => (
        <RailTick
          key={item.id}
          item={item}
          index={index}
          total={items.length}
          selected={item.id === selectedId}
          highlighted={item.id === highlightedId}
          scale={tickScale(index, displayedIndex)}
          isHorizontal={isHorizontal}
          itemSize={itemSize}
          reduce={reduce}
          onEnter={onEnter}
          onDown={onDown}
          onCancel={onCancel}
          onFocus={onFocus}
          onSelect={onSelect}
        />
      ))}
    </>
  );
});

/** How tall a tick stands, from how far it is from the highlighted one. */
function tickScale(index: number, displayedIndex: number): number {
  if (displayedIndex < 0) return 0.25;
  const distance = Math.abs(index - displayedIndex);
  if (distance === 0) return 1;
  if (distance === 1) return 0.68;
  if (distance === 2) return 0.44;
  return 0.25;
}

interface RailTickProps {
  item: PreviewRailItem;
  index: number;
  total: number;
  selected: boolean;
  highlighted: boolean;
  scale: number;
  isHorizontal: boolean;
  itemSize: number;
  reduce: boolean | null;
  onEnter: (item: PreviewRailItem, event: PointerEvent<HTMLElement>) => void;
  onDown: (item: PreviewRailItem, event: PointerEvent<HTMLElement>) => void;
  onCancel: () => void;
  onFocus: (item: PreviewRailItem, element: HTMLElement) => void;
  onSelect: (item: PreviewRailItem, event: MouseEvent<HTMLElement>) => void;
}

/**
 * One tick, memoized on the readings it is drawn from.
 *
 * The list is handed over again whenever one row of it changes — a streamed answer is one row
 * changing, many times a second — and a tick that nothing changed about must not be drawn again for
 * it. So the props are the readings themselves: the entry (which the caller re-uses for the rows it
 * did not touch), where it sits, whether it is the selected or the highlighted one, and the scale
 * that follows from where the highlight is. A delta therefore repaints one tick, not every tick.
 */
const RailTick = memo(function RailTick({
  item,
  index,
  total,
  selected,
  highlighted,
  scale,
  isHorizontal,
  itemSize,
  reduce,
  onEnter,
  onDown,
  onCancel,
  onFocus,
  onSelect,
}: RailTickProps) {
  const accessibleName =
    typeof item.ariaLabel === "function"
      ? item.ariaLabel(index + 1, total)
      : (item.ariaLabel ?? item.label);

  const sharedClassName = cn(
    "relative flex text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    isHorizontal ? "h-12 w-6 items-end justify-center" : "h-6 w-12 items-center",
  );
  const sharedStyle = isHorizontal ? { width: itemSize } : { height: itemSize };

  const tick = (
    <motion.span
      data-slot="preview-rail-tick"
      aria-hidden="true"
      animate={isHorizontal ? { scaleY: scale } : { scaleX: scale }}
      transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
      className={cn(
        "block bg-current",
        isHorizontal ? "h-12 w-0.5 origin-bottom" : "h-0.5 w-12 origin-left",
        highlighted ? "text-foreground" : undefined,
      )}
    />
  );

  return item.href ? (
    <a
      data-slot="preview-rail-item"
      href={item.href}
      target={item.target}
      rel={item.rel ?? (item.target === "_blank" ? "noreferrer noopener" : undefined)}
      aria-label={accessibleName}
      aria-current={selected ? "page" : undefined}
      onPointerEnter={(event) => onEnter(item, event)}
      onPointerDown={(event) => onDown(item, event)}
      onPointerCancel={onCancel}
      onKeyDown={onCancel}
      onFocus={(event) => onFocus(item, event.currentTarget)}
      onClick={(event) => onSelect(item, event)}
      style={sharedStyle}
      className={sharedClassName}
    >
      {tick}
    </a>
  ) : (
    <button
      data-slot="preview-rail-item"
      type="button"
      aria-label={accessibleName}
      aria-current={selected ? "location" : undefined}
      onPointerEnter={(event) => onEnter(item, event)}
      onPointerDown={(event) => onDown(item, event)}
      onPointerCancel={onCancel}
      onKeyDown={onCancel}
      onFocus={(event) => onFocus(item, event.currentTarget)}
      onClick={(event) => onSelect(item, event)}
      style={sharedStyle}
      className={sharedClassName}
    >
      {tick}
    </button>
  );
});

interface RailPreviewListProps {
  items: PreviewRailItem[];
  isHorizontal: boolean;
  itemSize: number;
  displayedId: string;
  previewSide: "before" | "after";
  previewClassName?: string;
  uid: string;
  reduce: boolean | null;
  renderPreview?: (item: PreviewRailItem) => ReactNode;
}

/** The rail's preview cards, memoized for the same reason its ticks are. */
const RailPreviews = memo(function RailPreviews({
  items,
  isHorizontal,
  itemSize,
  displayedId,
  previewSide,
  previewClassName,
  uid,
  reduce,
  renderPreview,
}: RailPreviewListProps) {
  return (
    <>
      {items.map((item) => (
        <RailPreview
          key={item.id}
          item={item}
          displayed={item.id === displayedId}
          isHorizontal={isHorizontal}
          itemSize={itemSize}
          previewSide={previewSide}
          previewClassName={previewClassName}
          uid={uid}
          reduce={reduce}
          renderPreview={renderPreview}
        />
      ))}
    </>
  );
});

interface RailPreviewProps {
  item: PreviewRailItem;
  displayed: boolean;
  isHorizontal: boolean;
  itemSize: number;
  previewSide: "before" | "after";
  previewClassName?: string;
  uid: string;
  reduce: boolean | null;
  renderPreview?: (item: PreviewRailItem) => ReactNode;
}

/** One preview slot, memoized on the same readings its tick is: only the card that is up changes. */
const RailPreview = memo(function RailPreview({
  item,
  displayed,
  isHorizontal,
  itemSize,
  previewSide,
  previewClassName,
  uid,
  reduce,
  renderPreview,
}: RailPreviewProps) {
  return (
    <div
      style={isHorizontal ? { width: itemSize } : { height: itemSize }}
      className={cn(
        "relative flex items-center",
        isHorizontal ? "justify-center" : undefined,
      )}
    >
      {displayed ? (
        <div
          className={cn(
            isHorizontal
              ? "absolute bottom-12 left-1/2 w-72 -translate-x-1/2"
              : cn("w-full max-w-sm", previewSide === "before" && "ml-auto"),
            previewClassName,
          )}
        >
          <motion.div
            layoutId={`preview-rail-card-${uid}`}
            transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={item.id}
                initial={
                  reduce ? { opacity: 0 } : { opacity: 0, y: 4, filter: "blur(6px)" }
                }
                animate={
                  reduce ? { opacity: 1 } : { opacity: 1, y: 0, filter: "blur(0px)" }
                }
                exit={
                  reduce
                    ? { opacity: 0 }
                    : {
                        opacity: 0,
                        y: -2,
                        filter: "blur(4px)",
                        transition: { duration: 0.12, ease: EASE_OUT },
                      }
                }
                transition={{ duration: reduce ? 0 : 0.18, ease: EASE_OUT }}
              >
                {renderPreview ? renderPreview(item) : <DefaultPreview item={item} />}
              </motion.div>
            </AnimatePresence>
          </motion.div>
        </div>
      ) : null}
    </div>
  );
});

export function PreviewRail({
  items,
  label = "Section navigation",
  orientation = "vertical",
  activeId,
  defaultActiveId,
  onActiveChange,
  onItemSelect,
  renderPreview,
  showPreview = true,
  previewSide = "after",
  highlightActive = false,
  itemSize = 24,
  children,
  className,
  railClassName,
  previewContainerClassName,
  previewClassName,
}: PreviewRailProps) {
  const uid = useId();
  const reduce = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const [internalActiveId, setInternalActiveId] = useState(
    defaultActiveId ?? items[0]?.id ?? "",
  );
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // A finger cannot hover, so a tap lights the tick instead. Kept apart from
  // the hovered one: they end in different ways, and a stray mouse move must
  // not clear a tick the keyboard or a tap chose.
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // A click carries no pointerType, so the pointerdown before it is what says
  // whether the activation was a tap. Keyboard activation has none at all.
  const tap = useTapGesture<boolean>();
  const hover = useHoverGesture();

  const clearPinned = useCallback(() => setPinnedId(null), []);

  // The next tap outside the rail stands in for the pointer leaving it. The
  // card is a preview, so that tap passes through to whatever it landed on.
  useDismiss(pinnedId !== null, clearPinned, rootRef);

  const requestedActiveId = activeId ?? internalActiveId;
  const selectedId = items.some((item) => item.id === requestedActiveId)
    ? requestedActiveId
    : (items[0]?.id ?? "");
  const displayedId = hoveredId ?? pinnedId ?? focusedId ?? "";
  const highlightedId = displayedId || (highlightActive ? selectedId : "");
  const displayedIndex = items.findIndex((item) => item.id === highlightedId);
  const rowTemplate = items.length
    ? `repeat(${items.length}, ${itemSize}px)`
    : undefined;
  const isHorizontal = orientation === "horizontal";

  const selectItem = useCallback(
    (id: string) => {
      if (activeId === undefined) setInternalActiveId(id);
      onActiveChange?.(id);
    },
    [activeId, onActiveChange],
  );

  /**
   * What the per-item handlers act on, kept where their identity cannot reach the ticks.
   *
   * A tick is drawn from the item it stands for and from its own readings, and it is left alone when
   * none of them changed — which is what keeps a list that only grows at one end from drawing every
   * tick on it again. A handler closed over anything that changes (the caller's own callback, the
   * pinned tick, the selection) would be a new prop for every tick on every change, and the whole
   * list would be drawn again for it. So the changing readings are read at the moment the gesture
   * happens, out of a ref the commit has already written.
   */
  const latest = useRef({
    selectItem: (_id: string) => undefined as void,
    onItemSelect,
    pinnedId,
  });
  useLayoutEffect(() => {
    latest.current = { selectItem, onItemSelect, pinnedId };
  });

  // The per-item handlers are the rail's own, and they take the item they were
  // drawn for: a handler closed over one item would be a new one every time the
  // list was handed over.
  const handleItemEnter = useCallback(
    (item: PreviewRailItem, event: PointerEvent<HTMLElement>) => {
      if (hover.enter(event)) setHoveredId(item.id);
    },
    [hover],
  );

  const handleItemDown = useCallback(
    (item: PreviewRailItem, event: PointerEvent<HTMLElement>) => {
      tap.start(event, latest.current.pinnedId === item.id);
      setFocusedId(null);
    },
    [tap],
  );

  // A gesture the platform takes away sends no click, and a key press starts an
  // activation that never had a pointer behind it: either one leaves a record
  // the next click would read as a tap of its own.
  const handleItemCancel = useCallback(() => {
    tap.drop();
  }, [tap]);

  const handleItemFocus = useCallback((item: PreviewRailItem, element: HTMLElement) => {
    if (element.matches(":focus-visible")) {
      setFocusedId(item.id);
    }
  }, []);

  const handleItemSelect = useCallback(
    (item: PreviewRailItem, event: MouseEvent<HTMLElement>) => {
      const gesture = tap.take();
      const tapped = gesture !== null && gesture.pointerType !== "mouse";

      if (tapped) {
        // A link would otherwise show its preview and leave the page in the
        // same tap, so the card is never read: the first tap lights the tick,
        // the second follows the link.
        if (item.href && !gesture.state) {
          event.preventDefault();
          setPinnedId(item.id);
          return;
        }
        setPinnedId(item.id);
      }

      latest.current.selectItem(item.id);
      latest.current.onItemSelect?.(item);
    },
    [tap],
  );

  return (
    <motion.div
      layoutRoot
      ref={rootRef}
      onBlur={(event) => {
        // Both tick sources leave with the focus: a tap does not always land
        // focus, but when it does, tabbing away must not strand the card.
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocusedId(null);
          setPinnedId(null);
        }
      }}
      className={cn(
        "isolate relative flex w-full overflow-visible",
        isHorizontal
          ? "min-h-64 flex-col items-center justify-center"
          : "min-h-80",
        className,
      )}
    >
      <nav
        aria-label={label}
        onPointerLeave={(event) => {
          // A touch pointer leaves on lift, which would clear the tick the tap
          // just chose — that one is cleared by the outside tap instead.
          if (hover.leave(event)) setHoveredId(null);
        }}
        style={
          isHorizontal
            ? { gridTemplateColumns: rowTemplate }
            : { gridTemplateRows: rowTemplate }
        }
        className={cn(
          "relative z-10 grid shrink-0",
          isHorizontal
            ? "h-12 w-fit max-w-full self-center justify-center"
            : "w-12 content-center",
          railClassName,
        )}
      >
        <RailTicks
          items={items}
          isHorizontal={isHorizontal}
          itemSize={itemSize}
          selectedId={selectedId}
          highlightedId={highlightedId}
          displayedIndex={displayedIndex}
          reduce={reduce}
          onEnter={handleItemEnter}
          onDown={handleItemDown}
          onCancel={handleItemCancel}
          onFocus={handleItemFocus}
          onSelect={handleItemSelect}
        />
      </nav>

      {showPreview ? (
        <div
          aria-hidden="true"
          style={
            isHorizontal
              ? { gridTemplateColumns: rowTemplate }
              : { gridTemplateRows: rowTemplate }
          }
          className={cn(
            "pointer-events-none absolute z-50 grid",
            isHorizontal
              ? "top-1/2 left-1/2 h-5 w-fit max-w-full -translate-x-1/2 -translate-y-1/2 justify-center"
              : previewSide === "before"
                ? "inset-y-0 right-16 left-4 content-center"
                : "inset-y-0 right-4 left-16 content-center",
            previewContainerClassName,
          )}
        >
          <RailPreviews
            items={items}
            isHorizontal={isHorizontal}
            itemSize={itemSize}
            displayedId={displayedId}
            previewSide={previewSide}
            previewClassName={previewClassName}
            uid={uid}
            reduce={reduce}
            renderPreview={renderPreview}
          />
        </div>
      ) : null}

      {children ? (
        <div className="min-h-0 min-w-0 flex-1">{children}</div>
      ) : null}
    </motion.div>
  );
}
