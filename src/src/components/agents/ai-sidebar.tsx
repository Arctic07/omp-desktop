"use client";
// beui.dev/components/agents/chat-app

import { AnimatePresence, Reorder, motion, useReducedMotion } from "motion/react";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useCopy } from "@/lib/i18n";
import { EASE_IN_OUT, SPRING_LAYOUT } from "@/lib/ease";
import { cn } from "@/lib/utils";
import { COPY } from "./ai-sidebar-copy";
import {
  type RowActionRenderer,
  type RowIconRenderer,
  type RowMenuRenderer,
  ResourceRow,
} from "./ai-sidebar-row";

import {
  canContain,
  findResource,
  flattenResources,
  moveResource,
  renameResource,
  type FlatResource,
  type SidebarResource,
  type SidebarResourceMove,
  type SidebarResourceMoveCommands,
} from "./ai-sidebar-tree";

export type {
  SidebarResource,
  SidebarResourceDropPosition,
  SidebarResourceKind,
  SidebarResourceMenuControls,
  SidebarResourceMove,
  SidebarResourceMoveCommands,
  SidebarResourceStatus,
} from "./ai-sidebar-tree";

export { ResourceMenuAction } from "./ai-sidebar-row";
export type {
  RowActionRenderer,
  RowIconRenderer,
  RowMenuRenderer,
} from "./ai-sidebar-row";

/**
 * The move that puts `itemId` where `after` has it, expressed against `before`.
 *
 * One row moves at a time, so the row's own index change is the whole placement: it lands after
 * the row above it when it moved down and before the row below it when it moved up, which is the
 * before/after pair `moveResource` already understands.
 */
function dragMove(
  before: readonly string[],
  after: readonly string[],
  itemId: string,
): SidebarResourceMove | null {
  const from = before.indexOf(itemId);
  const to = after.indexOf(itemId);
  if (from === -1 || to === -1 || from === to) return null;
  const targetId = to > from ? after[to - 1] : after[to + 1];
  if (targetId === undefined) return null;
  return { itemId, targetId, position: to > from ? "after" : "before" };
}

/** One parent's reorderable rows, in the order they are drawn. */
function sortableIdsOf(
  items: SidebarResource[],
  parentId: string | null,
): string[] {
  const list = parentId === null ? items : (findResource(items, parentId)?.children ?? []);
  return list.filter((item) => item.sortable !== false).map((item) => item.id);
}

export interface AISidebarProps {
  items?: SidebarResource[];
  defaultItems?: SidebarResource[];
  onItemsChange?: (items: SidebarResource[]) => void;
  /** Reject the promise to roll the optimistic move back. */
  onMove?: (move: SidebarResourceMove) => void | Promise<void>;
  onMoveError?: (error: unknown, move: SidebarResourceMove) => void;
  onRename?: (item: SidebarResource, label: string) => void | Promise<void>;
  activeId?: string | null;
  defaultActiveId?: string | null;
  onActiveChange?: (id: string) => void;
  defaultExpandedIds?: string[];
  /**
   * The ids whose children are shown, when the caller wants to own them.
   *
   * The rail keeps the workspace it is in open and leaves the others as the reader left them, which
   * `defaultExpandedIds` cannot do on its own: those are read once, so opening one group later means
   * remounting the tree, and a remount closes every other group.
   */
  expandedIds?: readonly string[];
  /**
   * The ids whose children are shown, after every change.
   *
   * A tree whose children arrive on demand cannot be read back from `items` — the caller has no
   * other way to learn which folder the user just opened, so the component reports it.
   */
  onExpandedChange?: (expandedIds: readonly string[]) => void;
  /**
   * Whether rows may be reordered.
   *
   * A tree that mirrors a real filesystem has no reorder to offer, and the component's moves are
   * optimistic: with no `onMove` to reject them a drag would silently rewrite the view without
   * touching what it shows. `false` takes the drag and the four moves off every row.
   */
  movable?: boolean;
  /**
   * Whether a move may land where it was aimed.
   *
   * The tree's moves are generic - a row can go above or below any other, or inside a group - and
   * a caller whose data is one level deep, or whose groups cannot exchange children, has nowhere
   * to put half of them. A drop refused after the fact has already drawn a target line under the
   * pointer, so this is asked *before* the drop is shown: the row does not highlight, the
   * top-level strip does not appear, and a menu or keyboard move that would cross the line is not
   * offered. The tree still accepts the drag itself, so a refused destination reads as a missing
   * line rather than as the system's forbidden mark. `performMove` asks again, which is what keeps
   * a drag from writing a move the caller just refused.
   */
  canMove?: (move: SidebarResourceMove) => boolean;
  renderIcon?: RowIconRenderer;
  renderMenu?: RowMenuRenderer;
  /**
   * A button drawn on the row itself, before its menu, revealed with it.
   *
   * A row's menu holds the verbs that need a panel; this is for the one verb a row should offer
   * without one — a workspace's *new conversation*, say.
   */
  renderRowAction?: RowActionRenderer;
  /**
   * What to draw after the last row of a group.
   *
   * A group that shows a page of its children needs somewhere to say so, and the tree has no row of
   * its own for it: the caller draws the control, this component puts it where the group ends.
   */
  renderGroupFooter?: (item: SidebarResource) => ReactNode;
  ariaLabel?: string;
  className?: string;
}

export function AISidebar({
  items,
  defaultItems = [],
  onItemsChange,
  onMove,
  onMoveError,
  onRename,
  activeId,
  defaultActiveId = null,
  onActiveChange,
  defaultExpandedIds = [],
  expandedIds,
  onExpandedChange,
  movable = true,
  canMove,
  renderIcon,
  renderMenu,
  renderRowAction,
  renderGroupFooter,
  ariaLabel,
  className,
}: AISidebarProps) {
  const copy = useCopy(COPY);
  const [internalItems, setInternalItems] = useState(items ?? defaultItems);
  const [internalActiveId, setInternalActiveId] = useState(defaultActiveId);
  const [internalExpandedIds, setInternalExpandedIds] = useState(
    () => new Set(defaultExpandedIds),
  );
  /**
   * The ids whose children are shown.
   *
   * Controlled when the caller passes them, so a group can be opened from outside as well as
   * reported outward: a rail that keeps the workspace it is in open — and the others as the reader
   * left them — needs both directions, and an uncontrolled tree that is remounted to force one open
   * loses the other.
   */
  const expanded = useMemo(
    () => (expandedIds ? new Set(expandedIds) : internalExpandedIds),
    [expandedIds, internalExpandedIds],
  );
  const [focusedId, setFocusedId] = useState<string | null>(
    activeId ?? defaultActiveId,
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /**
   * The row whose drag is in flight, as the reorder callback reads it.
   *
   * A list reports its new order inside the drag's own end handler, before React has rendered the
   * cleared state, so the callback has to know which row moved: the id lives in a ref as well.
   */
  const draggingIdRef = useRef<string | null>(null);
  /**
   * Where the drag started: the row, the list it belongs to, that list's order, and the tree as it
   * stood. The move written at the end is the difference between this and the dropped order.
   */
  const dragOriginRef = useRef<{
    itemId: string;
    parentId: string | null;
    ids: readonly string[];
    tree: SidebarResource[];
  } | null>(null);
  /** Whether the pointer crossed a row during this drag; a drag that never did writes nothing. */
  const dragMovedRef = useRef(false);
  /** Whether the last gesture moved a row, so the click that follows it does not open the row. */
  const draggedRef = useRef(false);
  const reduce = useReducedMotion() ?? false;
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const movePendingRef = useRef(false);
  const renderedItems = internalItems;
  const selectedId = activeId ?? internalActiveId;

  useEffect(() => {
    if (items) setInternalItems(items);
  }, [items]);

  const flat = useMemo(
    () => flattenResources(renderedItems, expanded),
    [expanded, renderedItems],
  );

  // Which row carries the roving tabindex is resolved during render, never in
  // a passive effect: an effect lands after the browser paints, so the first
  // commit — and, on a server-rendered page, the markup itself — would have no
  // tabbable row and Tab would skip the whole tree. The same hole opens again
  // whenever a collapse or a rolled-back move takes the focused row out of it.
  const focusedRow =
    focusedId !== null && flat.some((row) => row.item.id === focusedId)
      ? focusedId
      : (flat[0]?.item.id ?? null);
  if (focusedId !== focusedRow) setFocusedId(focusedRow);

  useEffect(() => {
    if (!menuOpenId) return;
    const frame = requestAnimationFrame(() => {
      const menus = Array.from(
        document.querySelectorAll<HTMLElement>("[data-sidebar-resource-menu]"),
      );
      menus
        .find((menu) => menu.dataset.sidebarResourceMenu === menuOpenId)
        ?.querySelector<HTMLElement>("button, a[href]")
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [menuOpenId]);

  const updateItems = useCallback(
    (next: SidebarResource[]) => {
      setInternalItems(next);
      onItemsChange?.(next);
    },
    [onItemsChange],
  );

  const performMove = useCallback(
    async (move: SidebarResourceMove) => {
      if (movePendingRef.current) {
        setAnnouncement(copy.movePending);
        return;
      }
      // The menu and keyboard moves ask first: a destination the caller cannot take is not offered
      // there, and one that slips through changes nothing.
      if (canMove !== undefined && !canMove(move)) return;
      const before = renderedItems;
      const next = moveResource(before, move);
      if (!next || next === before) return;

      movePendingRef.current = true;
      updateItems(next);
      const moved = findResource(before, move.itemId);
      const target = move.targetId ? findResource(before, move.targetId) : null;
      setAnnouncement(
        target
          ? copy.moved(moved?.label ?? copy.itemFallback, move.position, target.label)
          : copy.movedToTop(moved?.label ?? copy.itemFallback),
      );

      try {
        await onMove?.(move);
      } catch (error) {
        updateItems(before);
        setAnnouncement(copy.moveFailed(moved?.label ?? copy.itemFallbackTitle));
        onMoveError?.(error, move);
      } finally {
        movePendingRef.current = false;
      }
    },
    [canMove, copy, onMove, onMoveError, renderedItems, updateItems],
  );

  /** The drag is over, however it ended: no row is dragged any more. */
  const clearDrag = useCallback(() => {
    draggingIdRef.current = null;
    dragOriginRef.current = null;
    dragMovedRef.current = false;
    setDraggingId(null);
    // The click that follows a drop lands after this handler: it must not also open the row the
    // reader just moved.
    requestAnimationFrame(() => {
      draggedRef.current = false;
    });
  }, []);

  /**
   * One crossing of the pointer during a drag.
   *
   * The list reports its new order while the pointer is still down, every time the dragged row
   * passes another one. The tree is rearranged here so the rows make room, and nothing is written
   * until the drag ends: a drag that crosses ten rows is one move, not ten.
   */
  const applyReorder = useCallback(
    (list: readonly SidebarResource[], nextIds: readonly string[]) => {
      const itemId = draggingIdRef.current;
      if (itemId === null) return;
      const move = dragMove(
        list.filter((item) => item.sortable !== false).map((item) => item.id),
        nextIds,
        itemId,
      );
      if (move === null) return;
      const next = moveResource(renderedItems, move);
      if (next === null || next === renderedItems) return;
      dragMovedRef.current = true;
      updateItems(next);
    },
    [renderedItems, updateItems],
  );

  /**
   * The drag is over: keep the place the row was dropped in, once.
   *
   * The tree has already been rearranged crossing by crossing, so the move written here is the
   * whole journey — from the place the row started to the place it ended — expressed as the
   * before/after pair the caller persists. A move the caller refuses puts the tree back where the
   * drag started.
   */
  const finishDrag = useCallback(
    (itemId: string) => {
      const origin = dragOriginRef.current;
      const moved = dragMovedRef.current;
      clearDrag();
      if (!moved || origin === null || origin.itemId !== itemId) return;
      const move = dragMove(origin.ids, sortableIdsOf(renderedItems, origin.parentId), itemId);
      if (move === null) return;
      if (canMove !== undefined && !canMove(move)) {
        updateItems(origin.tree);
        return;
      }
      if (movePendingRef.current) {
        updateItems(origin.tree);
        setAnnouncement(copy.movePending);
        return;
      }
      const movedItem = findResource(origin.tree, itemId);
      const target = move.targetId ? findResource(origin.tree, move.targetId) : null;
      movePendingRef.current = true;
      setAnnouncement(
        target
          ? copy.moved(movedItem?.label ?? copy.itemFallback, move.position, target.label)
          : copy.movedToTop(movedItem?.label ?? copy.itemFallback),
      );
      void Promise.resolve(onMove?.(move))
        .catch((error) => {
          updateItems(origin.tree);
          setAnnouncement(copy.moveFailed(movedItem?.label ?? copy.itemFallbackTitle));
          onMoveError?.(error, move);
        })
        .finally(() => {
          movePendingRef.current = false;
        });
    },
    [canMove, clearDrag, copy, onMove, onMoveError, renderedItems, updateItems],
  );

  const focusRow = useCallback((id: string) => {
    setFocusedId(id);
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  }, []);

  const select = useCallback(
    (id: string) => {
      if (activeId === undefined) setInternalActiveId(id);
      onActiveChange?.(id);
    },
    [activeId, onActiveChange],
  );

  /**
   * Open or close one group.
   *
   * The caller owns the set when it passed one, so every write reports outward and the internal set
   * is only what an uncontrolled tree reads back. Reporting here rather than from an effect on the
   * set is what makes the controlled case work at all: with a controlled prop the internal set no
   * longer reaches the tree, so an effect watching it would report nothing.
   */
  const writeExpanded = useCallback(
    (next: Set<string>) => {
      setInternalExpandedIds(next);
      onExpandedChange?.([...next]);
    },
    [onExpandedChange],
  );

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(expanded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeExpanded(next);
    },
    [expanded, writeExpanded],
  );

  const openGroup = useCallback(
    (id: string) => {
      if (expanded.has(id)) return;
      const next = new Set(expanded);
      next.add(id);
      writeExpanded(next);
    },
    [expanded, writeExpanded],
  );

  // The same four moves `Alt+Shift+Arrow` performs, handed to the row menu so
  // they survive on a device with no drag and no modifier keys.
  const moveCommands = useCallback(
    (row: FlatResource): SidebarResourceMoveCommands => {
      if (!movable || row.item.disabled) return {};
      const index = flat.findIndex(({ item }) => item.id === row.item.id);
      const previous = flat[index - 1];
      const next = flat[index + 1];
      const parentId = row.parentId;
      const commands: SidebarResourceMoveCommands = {};
      // The menu is where a move is offered without a pointer, so a destination this caller
      // cannot take is left out rather than drawn as a row that does nothing.
      const allowed = (targetId: string, position: SidebarResourceMove["position"]) =>
        canMove === undefined ||
        canMove({ itemId: row.item.id, targetId, position });

      if (previous && allowed(previous.item.id, "before")) {
        commands.up = () =>
          void performMove({
            itemId: row.item.id,
            targetId: previous.item.id,
            position: "before",
          });
      }
      if (next && allowed(next.item.id, "after")) {
        commands.down = () =>
          void performMove({
            itemId: row.item.id,
            targetId: next.item.id,
            position: "after",
          });
      }
      // Only offer the reparent when it lands somewhere new — the row above a
      // folder's first child is the folder it already lives in.
      if (
        previous &&
        canContain(previous.item) &&
        previous.item.id !== parentId &&
        allowed(previous.item.id, "inside")
      ) {
        commands.into = {
          label: previous.item.label,
          run: () => {
            openGroup(previous.item.id);
            void performMove({
              itemId: row.item.id,
              targetId: previous.item.id,
              position: "inside",
            });
          },
        };
      }
      if (parentId && allowed(parentId, "after")) {
        commands.out = () =>
          void performMove({
            itemId: row.item.id,
            targetId: parentId,
            position: "after",
          });
      }

      return commands;
    },
    [canMove, flat, movable, performMove],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, row: FlatResource) => {
      const index = flat.findIndex(({ item }) => item.id === row.item.id);
      const previous = flat[index - 1];
      const next = flat[index + 1];
      const moveModifier = movable && event.altKey && event.shiftKey;

      if (event.key === "ArrowDown" && !moveModifier && next) {
        event.preventDefault();
        focusRow(next.item.id);
        return;
      }
      if (event.key === "ArrowUp" && !moveModifier && previous) {
        event.preventDefault();
        focusRow(previous.item.id);
        return;
      }
      if (event.key === "Home" && flat[0]) {
        event.preventDefault();
        focusRow(flat[0].item.id);
        return;
      }
      if (event.key === "End" && flat.at(-1)) {
        event.preventDefault();
        focusRow(flat.at(-1)?.item.id ?? row.item.id);
        return;
      }

      if (row.item.disabled) {
        if (event.key === "ArrowLeft" && row.parentId) {
          event.preventDefault();
          focusRow(row.parentId);
        } else if (
          moveModifier ||
          ["ArrowRight", "Enter", " ", "F2", "ContextMenu"].includes(
            event.key,
          ) ||
          (event.shiftKey && event.key === "F10")
        ) {
          event.preventDefault();
        }
        return;
      }

      if (moveModifier && event.key === "ArrowUp" && previous) {
        event.preventDefault();
        void performMove({ itemId: row.item.id, targetId: previous.item.id, position: "before" });
        return;
      }
      if (moveModifier && event.key === "ArrowDown" && next) {
        event.preventDefault();
        void performMove({ itemId: row.item.id, targetId: next.item.id, position: "after" });
        return;
      }
      if (moveModifier && event.key === "ArrowRight" && previous && canContain(previous.item)) {
        event.preventDefault();
        openGroup(previous.item.id);
        void performMove({ itemId: row.item.id, targetId: previous.item.id, position: "inside" });
        return;
      }
      if (moveModifier && event.key === "ArrowLeft" && row.parentId) {
        event.preventDefault();
        void performMove({ itemId: row.item.id, targetId: row.parentId, position: "after" });
        return;
      }

      if (event.key === "ArrowRight" && canContain(row.item)) {
        event.preventDefault();
        if (!expanded.has(row.item.id)) toggle(row.item.id);
        else if (next?.parentId === row.item.id) focusRow(next.item.id);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (expanded.has(row.item.id)) toggle(row.item.id);
        else if (row.parentId) focusRow(row.parentId);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (canContain(row.item)) toggle(row.item.id);
        else select(row.item.id);
      } else if (event.key === "F2") {
        event.preventDefault();
        setRenamingId(row.item.id);
      } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        setMenuOpenId(row.item.id);
      }
    },
    [expanded, flat, focusRow, movable, performMove, openGroup, select, toggle],
  );

  /**
   * One row of the tree, with the actions every row shares.
   *
   * The row is the same at both levels; what differs is the list it belongs to.
   */
  const renderRow = (row: FlatResource): ReactNode => (
    <ResourceRow
      row={row}
      active={selectedId === row.item.id}
      expanded={expanded.has(row.item.id)}
      focused={focusedRow === row.item.id}
      menuOpen={menuOpenId === row.item.id}
      moves={moveCommands(row)}
      renaming={renamingId === row.item.id}
      movable={movable}
      dragging={draggingId === row.item.id}
      draggedRef={draggedRef}
      onFocus={() => setFocusedId(row.item.id)}
      onSelect={() => select(row.item.id)}
      onToggle={() => toggle(row.item.id)}
      onKeyDown={(event) => handleKeyDown(event, row)}
      onRenameStart={() => setRenamingId(row.item.id)}
      onRenameCancel={() => setRenamingId(null)}
      onRenameCommit={(label) => {
        const trimmed = label.trim();
        setRenamingId(null);
        if (!trimmed || trimmed === row.item.label) return;
        const before = renderedItems;
        updateItems(renameResource(before, row.item.id, trimmed));
        void Promise.resolve(onRename?.(row.item, trimmed)).catch(() => {
          updateItems(before);
          setAnnouncement(copy.renameFailed(row.item.label));
        });
      }}
      onMenuOpenChange={(open) => {
        setMenuOpenId(open ? row.item.id : null);
        if (!open) focusRow(row.item.id);
      }}
      onAnnounce={setAnnouncement}
      renderIcon={renderIcon}
      renderMenu={renderMenu}
      renderRowAction={renderRowAction}
      setRef={(node) => {
        if (node) rowRefs.current.set(row.item.id, node);
        else rowRefs.current.delete(row.item.id);
      }}
    />
  );

  /**
   * One list of rows, reorderable on its own.
   *
   * The rail is two levels, so each level is its own list: a workspace moves among workspaces, and
   * a workspace's conversations among themselves. `Reorder.Group` drags with the pointer, never the
   * browser's own drag-and-drop, which is what keeps the pointer from turning into the system's
   * "forbidden" mark over a row that is not a drop target. A row marked `sortable: false` (an
   * archived conversation) is drawn in place and takes no part in the list.
   */
  const renderList = (
    list: readonly SidebarResource[],
    depth: number,
    parentId: string | null,
  ): ReactNode => (
    <Reorder.Group
      as="div"
      axis="y"
      values={list.filter((item) => item.sortable !== false).map((item) => item.id)}
      onReorder={(next) => applyReorder(list, next)}
      className="flex min-w-0 flex-col gap-0.5"
    >
      {list.map((item) => {
        const row: FlatResource = { item, depth, parentId };
        const content = renderRow(row);
        return (
          <Fragment key={item.id}>
            {item.sortable === false || !movable ? (
              content
            ) : (
              <Reorder.Item
                as="div"
                value={item.id}
                layout={reduce ? undefined : "position"}
                transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
                whileDrag={reduce ? undefined : { scale: 1.02 }}
                onDragStart={() => {
                  draggingIdRef.current = item.id;
                  dragOriginRef.current = {
                    itemId: item.id,
                    parentId,
                    ids: list
                      .filter((entry) => entry.sortable !== false)
                      .map((entry) => entry.id),
                    tree: renderedItems,
                  };
                  dragMovedRef.current = false;
                  draggedRef.current = true;
                  setDraggingId(item.id);
                }}
                onDragEnd={() => finishDrag(item.id)}
                className="relative"
              >
                {content}
              </Reorder.Item>
            )}
            {item.children && item.children.length > 0 ? (
              <AnimatePresence initial={false}>
                {expanded.has(item.id) ? (
                  <motion.div
                    key="group"
                    initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                    animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
                    exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                    transition={
                      reduce ? { duration: 0.12 } : { duration: 0.2, ease: EASE_IN_OUT }
                    }
                    // The clip is what makes the height read as the list folding away; it is
                    // dropped while a row is being dragged, or a row moved past the group's edge
                    // would be cut off.
                    style={{ overflow: draggingId === null ? "hidden" : "visible" }}
                    data-slot="sidebar-resource-group"
                    className="min-w-0"
                  >
                    {renderList(item.children, depth + 1, item.id)}
                    {renderGroupFooter?.(item)}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            ) : null}
          </Fragment>
        );
      })}
    </Reorder.Group>
  );

  return (
    <>
      <div
        role="tree"
        aria-label={ariaLabel ?? copy.resourcesLabel}
        aria-multiselectable="false"
        className={cn(
          "relative flex min-w-0 flex-col gap-0.5 [overflow-anchor:none] group-data-[state=collapsed]/sidebar:hidden",
          draggingId !== null && "select-none",
          className,
        )}
      >
        {renderList(renderedItems, 0, null)}
      </div>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}

/**
 * The mark a conversation row carries in place of its age.
 *
 * Running is beUI's `spinner` in this application's running blue (`--omp-running`): a turning ring
 * reads as work, and the other states keep distinct shapes, so a stopped conversation can no longer
 * be mistaken for a live one at a glance. Every ring reads one shared clock, so rows that started
 * at different moments still turn together instead of leaning at scattered angles.
 */
