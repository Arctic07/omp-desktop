/**
 * The rail's conversation search: one row that opens a panel, one field, and what it found.
 *
 * It reads the lists the rail is already drawing (`state/session-lists.ts`) through
 * `conversation-search.ts`, so there is no second index and no extra round trip: a conversation the
 * rail shows is findable at once, and one it does not show (an archived one) is not offered.
 *
 * The panel is beUI's morph popover (`components/motion/popover-morph.tsx`) — the same surface the
 * branch picker opens over its own field — because it portals and closes on Escape or an outside
 * pointer without this file doing any of it. The field is beUI's `Input`; the row is the sidebar's
 * own menu button.
 */

import { Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { WorkspaceSummary } from "@/api/types";
import { AnimatedSidebarMenuButton } from "@/components/motion/animated-sidebar-menu";
import { Input } from "@/components/motion/input";
import { MorphPopover, MorphPopoverContent } from "@/components/motion/popover-morph";
import { sessionSearch } from "@/api/agent";
import type { SessionSearchHit } from "@/api/session-types";
import {
  searchConversations,
  snippetSegments,
  type ConversationMatch,
} from "@/home/conversation-search";
import { COPY, type HomeCopy } from "@/home/homeCopy";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { WorkspaceSessions } from "@/state/session-lists";
import { selectSession } from "@/state/session-store";

/**
 * How many rows the panel draws.
 *
 * A reader with a hundred conversations and an empty field gets the recent ones, not a list that
 * costs a hundred buttons: the field is how the rest are reached.
 */
const MAX_RESULTS = 50;

/** How many conversations a content search answers. A field asks for a list to pick from. */
const MAX_CONTENT_HITS = 8;

/** How long the field has to be still before the content search runs. */
const CONTENT_SEARCH_DEBOUNCE_MS = 180;

/** The shortest query the content search is asked about: one character matches too much to rank. */
const CONTENT_SEARCH_MIN_CHARS = 2;

/**
 * One row of the panel: a conversation the rail's own list matched by title, or one the desktop's
 * search matched by something that was said in it.
 *
 * Both kinds are rows of one listbox, so the keyboard walks them as one answer - a reader pressing
 * Down is not asked to know which half a row came from.
 */
type PanelRow =
  | { kind: "title"; match: ConversationMatch }
  | { kind: "content"; hit: SessionSearchHit };

export interface ConversationSearchRowProps {
  /** The workspaces the rail draws, in its own order. */
  workspaces: readonly WorkspaceSummary[];
  /** Every workspace's conversation list, keyed by workspace id. */
  sessions: Readonly<Record<number, WorkspaceSessions>>;
}

/**
 * The rail's search row and the panel it opens. The caller draws it inside one
 * `AnimatedSidebarMenuItem`.
 */
export function ConversationSearchRow({ workspaces, sessions }: ConversationSearchRowProps) {
  const copy = useCopy(COPY);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** Which row Up/Down has landed on, as an index into `matches`. */
  const [activeIndex, setActiveIndex] = useState(0);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const matches = useMemo(
    () => searchConversations(workspaces, sessions, query, MAX_RESULTS),
    [query, sessions, workspaces],
  );
  /**
   * What the desktop's own search answered, and which query that answer belongs to.
   *
   * The title matches above are the rail's own lists, filtered in place - instant, and only as good
   * as what the rail is drawing. These come from the desktop, which indexed what each conversation
   * *said*: a conversation the reader never opened, whose title says nothing about the thing they
   * half remember, is found here and nowhere else.
   */
  const [contentHits, setContentHits] = useState<SessionSearchHit[]>([]);
  const contentToken = useRef(0);

  useEffect(() => {
    const text = query.trim();
    if (text.length < CONTENT_SEARCH_MIN_CHARS) {
      // Too short to rank: nothing is asked, and the answer to the previous query is dropped so a
      // shorter field never shows a longer field's rows.
      contentToken.current += 1;
      setContentHits([]);
      return;
    }
    const token = ++contentToken.current;
    const timer = window.setTimeout(() => {
      void sessionSearch(text, MAX_CONTENT_HITS)
        .then((hits) => {
          // A late answer to an older query must not replace a newer one's.
          if (contentToken.current === token) setContentHits(hits);
        })
        .catch(() => {
          // A search that cannot run is an empty second half, not a broken panel: the title
          // matches above are still what the rail knows.
          if (contentToken.current === token) setContentHits([]);
        });
    }, CONTENT_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const rows = useMemo<PanelRow[]>(() => {
    const titles: PanelRow[] = matches.map((match) => ({ kind: "title", match }));
    const offered = new Set(matches.map((match) => match.sessionId));
    // A conversation already offered by its title is not offered a second time for its words.
    const contents: PanelRow[] = contentHits
      .filter((hit) => !offered.has(hit.sessionId))
      .map((hit) => ({ kind: "content", hit }));
    return [...titles, ...contents];
  }, [contentHits, matches]);

  /** Which row is lit. An empty answer is no row at all, whatever index was left behind. */
  const active = rows.length === 0 ? undefined : rows[Math.min(activeIndex, rows.length - 1)];

  // The keyboard walks the list, and a row that walked off the panel has to come back into view.
  useEffect(() => {
    if (active === undefined) return;
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = useCallback((row: PanelRow) => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
    // Opening crosses workspaces on its own (`selectSession` activates the row's workspace first),
    // so a conversation found here opens exactly as it would from its row in the tree.
    if (row.kind === "title") {
      void selectSession(row.match.workspaceId, row.match.sessionId);
      return;
    }
    // A hit the registry cannot name a workspace for has no way in; the row is drawn without an
    // action for that reason (`aria-disabled` below) rather than pretending to open something.
    const workspaceId = row.hit.workspaceId;
    if (workspaceId === undefined) return;
    void selectSession(workspaceId, row.hit.sessionId);
  }, []);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) return;
    // A dismissal starts the panel over: the next opening shows the recent conversations, not the
    // last search's leftovers.
    setQuery("");
    setActiveIndex(0);
    // A dismissal strands the focus: on the field inside the panel that is about to go inert
    // (Escape), or on `body` once it has (an outside pointer that landed on nothing focusable).
    // Both are handed back to the row that opened the panel; a pointer that landed on something
    // focusable keeps its own focus. Deferred, because the panel is only inert after the close has
    // rendered — and which of the two states `activeElement` is in depends on that timing.
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      const stranded =
        !(focused instanceof HTMLElement) ||
        focused === document.body ||
        focused.closest("[data-morph-popover-portal]") !== null;
      if (!stranded) return;
      rowRef.current?.querySelector("button")?.focus();
    });
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (rows.length === 0) return;
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((current) => {
          const from = Math.min(current, rows.length - 1);
          return (from + step + rows.length) % rows.length;
        });
        return;
      }
      if (event.key !== "Enter") return;
      const row = rows[Math.min(activeIndex, rows.length - 1)];
      if (row === undefined) return;
      event.preventDefault();
      choose(row);
    },
    [activeIndex, choose, rows],
  );

  return (
    <MorphPopover open={open} onOpenChange={handleOpenChange} className="block w-full">
      <div ref={rowRef} className="w-full">
        <AnimatedSidebarMenuButton
          icon={<Search className="size-4" />}
          onSelect={() => handleOpenChange(!open)}
          className="font-normal text-foreground"
        >
          {copy.searchSessions}
        </AnimatedSidebarMenuButton>
      </div>
      <MorphPopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        radius={12}
        onOpenAutoFocus={(content) => content.querySelector("input")?.focus()}
        matchTriggerWidth
        className="min-w-56 p-2"
      >
        <div onKeyDown={handleKeyDown}>
          <Input
            value={query}
            onChange={(value) => {
              setQuery(value);
              setActiveIndex(0);
            }}
            placeholder={copy.searchSessionsPlaceholder}
            aria-label={copy.searchSessionsPlaceholder}
            leftIcon={<Search aria-hidden="true" />}
            classNames={{
              field: "h-8 rounded-lg",
              input: "text-xs",
              leftIcon: "[&_svg]:size-3.5",
            }}
          />
          <div
            role="listbox"
            aria-label={copy.searchSessions}
            className="mt-2 max-h-64 overflow-y-auto scrollbar-hide"
          >
            {rows.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                {copy.searchSessionsEmpty}
              </p>
            ) : (
              rows.map((row, index) => (
                <button
                  key={
                    row.kind === "title"
                      ? `t:${row.match.workspaceId}:${row.match.sessionId}`
                      : `c:${row.hit.sessionId}`
                  }
                  ref={row === active ? activeRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={row === active}
                  aria-disabled={row.kind === "content" && row.hit.workspaceId === undefined}
                  onClick={() => choose(row)}
                  className={cn(
                    "block w-full rounded-lg px-2 py-1.5 text-left text-xs outline-none transition-colors",
                    row === active
                      ? "bg-muted/70 text-foreground"
                      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                  )}
                >
                  {index === matches.length && matches.length > 0 ? (
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                      {copy.searchSessionsContent}
                    </span>
                  ) : null}
                  <PanelRowBody row={row} copy={copy} />
                </button>
              ))
            )}
          </div>
        </div>
      </MorphPopoverContent>
    </MorphPopover>
  );
}

/**
 * What one row draws: a title, or a title with the line that matched under it.
 *
 * The matched span is drawn as `<mark>` inside the snippet's own text, from the two markers the
 * desktop put there (`snippetSegments`) - nothing is inserted into the DOM as markup, so a
 * transcript's own angle brackets are just characters.
 */
function PanelRowBody({ row, copy }: { row: PanelRow; copy: HomeCopy }) {
  if (row.kind === "title") {
    return (
      <span className="block truncate">
        {row.match.title.trim() === "" ? copy.untitledSession : row.match.title}
      </span>
    );
  }
  const snippet = row.hit.snippets[0];
  return (
    <>
      <span className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate">
          {row.hit.title.trim() === "" ? copy.untitledSession : row.hit.title}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
          {row.hit.matchCount}
        </span>
      </span>
      {snippet === undefined ? null : (
        <span className="mt-0.5 block line-clamp-2 text-[11px] text-muted-foreground/80">
          {snippetSegments(snippet.text).map((segment, index) =>
            segment.match ? (
              <mark
                key={index}
                className="bg-transparent font-medium text-foreground underline decoration-dotted"
              >
                {segment.text}
              </mark>
            ) : (
              <span key={index}>{segment.text}</span>
            ),
          )}
        </span>
      )}
    </>
  );
}
