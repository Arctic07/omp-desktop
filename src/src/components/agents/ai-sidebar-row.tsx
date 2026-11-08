"use client";
// beui.dev/components/agents/chat-app
//
// A tree row: its glyph, the marquee on its name, its menu and its status mark. Split out of
// `ai-sidebar.tsx` so neither file outgrows the project's file-length limit (`rules.md#single-file-line-limit`).

import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  CornerDownRight,
  CornerLeftUp,
  FileText,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  type LucideIcon,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import { EASE_OUT } from "@/lib/ease";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { COPY } from "./ai-sidebar-copy";
import {
  canContain,
  type FlatResource,
  type SidebarResource,
  type SidebarResourceMenuControls,
  type SidebarResourceMoveCommands,
} from "./ai-sidebar-tree";
import { StatusMark } from "./status-mark";

/** A row's menu, given the item and the controls that close it, rename it, and move it. */
export type RowMenuRenderer = (
  item: SidebarResource,
  controls: SidebarResourceMenuControls,
) => ReactNode;

/** The one verb a row offers without opening its menu. */
export type RowActionRenderer = (item: SidebarResource) => ReactNode;

/** A row's own glyph, when the caller has one to give. */
export type RowIconRenderer = (item: SidebarResource) => ReactNode;

const ROW_REVEAL = {
  duration: 0.16,
  ease: EASE_OUT,
} as const;

function defaultIcon(item: SidebarResource, expanded: boolean) {
  const Icon =
    item.kind === "folder" || item.kind === "project"
      ? expanded
        ? FolderOpen
        : Folder
      : item.kind === "bookmark"
          ? Bookmark
          : FileText;
  return <Icon className="size-4" />;
}

function MarqueeLabel({ active, children }: { active: boolean; children: string }) {
  const reduce = useReducedMotion() ?? false;
  const viewportRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

  useEffect(() => {
    const measure = () => {
      const viewport = viewportRef.current;
      const label = labelRef.current;
      if (!viewport || !label) return;
      setDistance(label.scrollWidth > viewport.clientWidth ? label.scrollWidth + 24 : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (viewportRef.current) observer.observe(viewportRef.current);
    if (labelRef.current) observer.observe(labelRef.current);
    return () => observer.disconnect();
  }, []);

  const clipped = distance > 0;
  const running = active && clipped && !reduce;

  return (
    <span
      ref={viewportRef}
      className={cn(
        "block min-w-0 flex-1 overflow-hidden",
        // A name longer than the row is cut at the viewport's own edge, and a glyph sliced
        // mid-stroke beside the time reads as a rendering fault rather than an ellipsis
        // (2026-10-23, user report: titles ran into the time with no transition). The last 24px
        // fade out instead; the viewport already ends short of the time column (the row action's
        // slot sits between them), so the fade finishes in that gap. Only while the name actually
        // overflows: a name that fits would otherwise have its own last glyphs dimmed by a fade
        // nothing needed.
        clipped &&
          "[mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)]",
      )}
    >
      <motion.span
        className="flex w-max items-center gap-6 whitespace-nowrap"
        animate={{ x: running ? [0, -distance] : 0 }}
        transition={
          running
            ? {
                duration: Math.max(2.4, distance / 34),
                ease: "linear",
                repeat: Number.POSITIVE_INFINITY,
                repeatDelay: 2,
              }
            : ROW_REVEAL
        }
      >
        <span ref={labelRef}>{children}</span>
        {running ? <span aria-hidden="true">{children}</span> : null}
      </motion.span>
    </span>
  );
}

export function ResourceMenuAction({
  icon: Icon,
  onSelect,
  children,
  destructive = false,
  disabled = false,
}: {
  icon: LucideIcon;
  onSelect: () => void;
  children: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        destructive ? "text-destructive" : "text-foreground",
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

export interface ResourceRowProps {
  row: FlatResource;
  active: boolean;
  expanded: boolean;
  focused: boolean;
  /** Whether this row is the one being dragged right now. */
  dragging: boolean;
  /**
   * Whether the gesture in flight has moved the row, read at click time.
   *
   * The click that follows a drop arrives after the drag has ended, so a state flag has already
   * been cleared by then: the row asks this ref instead, and the click that would otherwise open
   * the conversation it just moved does nothing.
   */
  draggedRef: React.RefObject<boolean>;
  menuOpen: boolean;
  moves: SidebarResourceMoveCommands;
  renaming: boolean;
  /** False when the caller's tree is not one this component may reorder. */
  movable: boolean;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onMenuOpenChange: (open: boolean) => void;
  onAnnounce: (message: string) => void;
  onRenameCancel: () => void;
  onRenameCommit: (label: string) => void;
  onRenameStart: () => void;
  onSelect: () => void;
  onToggle: () => void;
  renderIcon?: RowIconRenderer;
  renderMenu?: RowMenuRenderer;
  renderRowAction?: RowActionRenderer;
  setRef: (node: HTMLDivElement | null) => void;
}

export function ResourceRow({
  row,
  active,
  expanded,
  focused,
  dragging,
  draggedRef,
  menuOpen,
  moves,
  renaming,
  movable,
  onFocus,
  onKeyDown,
  onMenuOpenChange,
  onAnnounce,
  onRenameCancel,
  onRenameCommit,
  onRenameStart,
  onSelect,
  onToggle,
  renderIcon,
  renderMenu,
  renderRowAction,
  setRef,
}: ResourceRowProps) {
  const copy = useCopy(COPY);
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipRenameBlurRef = useRef(false);
  const [draft, setDraft] = useState(row.item.label);
  const acceptsChildren = canContain(row.item);
  const rowAction = renderRowAction?.(row.item);
  /**
   * Whether this row's state is drawn as a mark instead of its time.
   *
   * The two are alternatives, not companions: a row that carries a mark is saying something about
   * the conversation's state, and the clock beside it would only be a second, quieter answer to the
   * same question. `completed` carries no mark, so a settled row reads as its time.
   */
  const marked =
    row.item.status === "running" ||
    row.item.status === "unread" ||
    row.item.status === "cancelled" ||
    row.item.status === "pending" ||
    row.item.status === "error";
  // The word the mark is announced with. `completed` carries none: a settled row has nothing to say.
  const statusWord =
    row.item.status === "running"
      ? copy.statusRunning
      : row.item.status === "unread"
        ? copy.statusUnread
        : row.item.status === "cancelled"
          ? copy.statusCancelled
          : row.item.status === "pending"
            ? copy.statusPending
            : row.item.status === "error"
              ? copy.statusError
              : null;

  useEffect(() => {
    if (!renaming) return;
    skipRenameBlurRef.current = false;
    setDraft(row.item.label);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [renaming, row.item.label]);

  const runFromMenu = (action: () => void) => () => {
    onMenuOpenChange(false);
    action();
  };

  // Only actions this component can actually perform: a rename and, when the tree may be
  // reordered, the four moves. A caller with its own verbs passes `renderMenu`.
  const menu = renderMenu?.(row.item, {
    close: () => onMenuOpenChange(false),
    rename: () => {
      onMenuOpenChange(false);
      onRenameStart();
    },
    moves,
    announce: onAnnounce,
  }) ?? (
    <>
      <ResourceMenuAction icon={Pencil} onSelect={runFromMenu(onRenameStart)}>
        {copy.rename}
      </ResourceMenuAction>
      {movable && (moves.up || moves.down || moves.into || moves.out) ? (
        <>
          <div aria-hidden="true" className="my-1 h-px bg-border" />
          {moves.up ? (
            <ResourceMenuAction icon={ArrowUp} onSelect={runFromMenu(moves.up)}>
              {copy.moveUp}
            </ResourceMenuAction>
          ) : null}
          {moves.down ? (
            <ResourceMenuAction icon={ArrowDown} onSelect={runFromMenu(moves.down)}>
              {copy.moveDown}
            </ResourceMenuAction>
          ) : null}
          {moves.into ? (
            <ResourceMenuAction icon={CornerDownRight} onSelect={runFromMenu(moves.into.run)}>
              {copy.moveInto(moves.into.label)}
            </ResourceMenuAction>
          ) : null}
          {moves.out ? (
            <ResourceMenuAction icon={CornerLeftUp} onSelect={runFromMenu(moves.out)}>
              {copy.moveOut}
            </ResourceMenuAction>
          ) : null}
        </>
      ) : null}
    </>
  );

  return (
    <motion.div
      ref={setRef}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={acceptsChildren ? undefined : active}
      aria-expanded={acceptsChildren ? expanded : undefined}
      aria-disabled={row.item.disabled || undefined}
      tabIndex={focused ? 0 : -1}
      data-menu-open={menuOpen || undefined}
      data-dragging={dragging || undefined}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        // The same menu the row's "…" opens, from anywhere on the row. Preventing the default is
        // what keeps the webview's own page menu (back, reload, print) off a conversation row.
        if (renaming || row.item.disabled) return;
        event.preventDefault();
        if (!menuOpen) onMenuOpenChange(true);
      }}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          draggedRef.current ||
          renaming ||
          row.item.disabled
        )
          return;
        // The row's menu is portalled to the body but still an ancestor of this handler in the React
        // tree, so its clicks arrive here too. Without this guard, choosing *Archive* or *Delete*
        // also opened the conversation it was putting away (2026-10-24, user report): the row acts
        // only on clicks that land on its own surface.
        const target = event.target;
        if (target instanceof Node && !event.currentTarget.contains(target)) return;
        if (acceptsChildren) onToggle();
        else onSelect();
      }}
      onDoubleClick={(event) => {
        if (acceptsChildren || row.item.disabled) return;
        event.preventDefault();
        onRenameStart();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        "group/resource relative isolate flex min-h-9 min-w-0 cursor-pointer items-center gap-2.5 rounded-xl pr-3 text-xs outline-none",
        "text-muted-foreground transition-colors duration-200 ease-out hover:text-foreground",
        "focus-visible:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        "data-[menu-open=true]:text-foreground",
        "data-[dragging=true]:cursor-grabbing data-[dragging=true]:opacity-40",
        !acceptsChildren && active && "bg-muted text-foreground",
        row.item.disabled && "cursor-not-allowed opacity-45",
      )}
      style={{ paddingLeft: `${12 + (acceptsChildren ? row.depth : Math.max(0, row.depth - 1)) * 16}px` }}
    >
      {/* Hover is an opacity veil rather than a background swap: the tint fades in and out over the
          row's own surface instead of being switched on under the pointer (2026-10-22, user
          report). The row is isolated so the veil paints under the label and not over it. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 rounded-xl bg-muted opacity-0 transition-opacity duration-200 ease-out group-hover/resource:opacity-100 group-data-[menu-open=true]/resource:opacity-100"
      />

      <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center">
        {acceptsChildren ? renderIcon?.(row.item) ?? defaultIcon(row.item, expanded) : null}
      </span>

      {renaming ? (
        <input
          ref={inputRef}
          value={draft}
          aria-label={copy.renameField(row.item.label)}
          onChange={(event) => setDraft(event.target.value)}
          draggable={false}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onBlur={() => {
            if (!skipRenameBlurRef.current) onRenameCommit(draft);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              skipRenameBlurRef.current = true;
              onRenameCommit(draft);
            }
            if (event.key === "Escape") {
              skipRenameBlurRef.current = true;
              onRenameCancel();
            }
          }}
          className="mx-1 h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <span
          className={cn(
            // A conversation's name reads in the content colour — it is what the reader is looking
            // for — while its age is a footnote. A workspace is a heading over those names, so it
            // stays in the muted one the row already carries and only brightens under the pointer.
            "flex min-w-0 flex-1",
            !acceptsChildren && "text-foreground",
            // The trailing column is drawn over the row rather than beside the label, so the label
            // has to stop where that column starts — otherwise its last characters run underneath
            // the time and read as one string. The reserve is the few pixels left of the time's
            // own glyphs, not the whole column: the column is right-aligned and only its rightmost
            // ~20px ever hold text, so `pr-5` clipped names a full 16px before the time began
            // (2026-10-22, user report: titles read too narrow).
            !acceptsChildren && (marked || row.item.lastActive) && "pr-1",
          )}
        >
          <MarqueeLabel active={hovered || menuOpen}>{row.item.label}</MarqueeLabel>
        </span>
      )}

      {!acceptsChildren && (marked || row.item.lastActive) ? (
        <span
          aria-label={statusWord ?? row.item.lastActive}
          className={cn(
            // One fixed column for every row, wide enough for the longest reading (`29m`) and
            // never allowed to wrap: a slot that grew with its text would move the row's action
            // button from row to row, and a slot too narrow wraps the time onto a second line.
            "pointer-events-none absolute right-3 flex w-12 items-center justify-end whitespace-nowrap text-xs tabular-nums text-muted-foreground transition-opacity duration-200 ease-out group-hover/resource:opacity-0 group-data-[menu-open=true]/resource:opacity-0",
            row.item.status === "running" && "text-blue-600 dark:text-blue-400",
            row.item.status === "unread" && "text-emerald-500",
            (row.item.status === "cancelled" || row.item.status === "pending") &&
              "text-amber-500",
            row.item.status === "error" && "text-destructive",
          )}
        >
          {marked ? (
            <StatusMark status={row.item.status} />
          ) : (
            <span>{row.item.lastActive}</span>
          )}
        </span>
      ) : null}

      {!renaming && !row.item.disabled ? (
        // One cluster: the "…" menu first, then the row's own action (a workspace's "new
        // conversation"). They were the other way round and a row apart (2026-10-17).
        <span
          className="flex shrink-0 items-center gap-1"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <MorphPopover open={menuOpen} onOpenChange={onMenuOpenChange}>
          <MorphPopoverTrigger>
            <button
              type="button"
              draggable={false}
              tabIndex={-1}
              aria-label={copy.rowActions(row.item.label)}
              onClick={(event) => event.stopPropagation()}
              className="grid size-7 shrink-0 place-items-center rounded-lg opacity-0 outline-none transition-opacity duration-200 ease-out hover:bg-foreground/5 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/resource:opacity-100 group-data-[menu-open=true]/resource:opacity-100"
            >
              <MoreHorizontal aria-hidden="true" className="size-4" />
            </button>
          </MorphPopoverTrigger>
          <MorphPopoverContent
            side="bottom"
            align="end"
            sideOffset={8}
            radius={12}
            className="min-w-40 max-w-72 p-1.5"
          >
            <div data-sidebar-resource-menu={row.item.id}>{menu}</div>
          </MorphPopoverContent>
          </MorphPopover>
          {rowAction ? (
            <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-200 ease-out focus-within:opacity-100 group-hover/resource:opacity-100 group-data-[menu-open=true]/resource:opacity-100">
              {rowAction}
            </span>
          ) : null}
        </span>
      ) : null}
    </motion.div>
  );
}

