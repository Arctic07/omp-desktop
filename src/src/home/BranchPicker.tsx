import { ArrowDown, ArrowUp, Check, GitBranch, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiError } from "@/api/client";
import {
  checkoutWorkspaceBranch,
  getWorkspaceBranches,
  type RepositoryBranch,
  type WorkspaceBranches,
} from "@/api/git";
import { Input } from "@/components/motion/input";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import { formatRelativeTime } from "@/home/conversation-format";
import { COPY } from "@/home/homeCopy";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { subscribeWorkspaceRefChange, workspaceRefRevision } from "@/state/workspace-watch-store";

export interface BranchPickerProps {
  /** The changes panel's workspace root; `null` hides the row, as does a folder outside a repository. */
  root: string | null;
  /**
   * Whether this row is on screen. A hidden panel keeps the last reading and re-reads when it is
   * shown again: the workspace watch is one process-wide stream, and every mounted-but-hidden
   * conversation would otherwise spend a git process per report on a row nobody is looking at.
   */
  active: boolean;
  className?: string;
}

/**
 * The changes area's branch row: where HEAD is, how far it has drifted from its upstream, and the
 * local branches it can switch to.
 *
 * The repository is the active workspace's, read by the host's own git service
 * (`services/git.rs::get_workspace_branches`). A workspace outside a working tree — or a host
 * where git cannot answer — draws nothing at all: there is no branch to name, and a row that
 * says so would be a permanent error at the head of the changes area.
 *
 * It follows the refs half of the workspace watch (`state/workspace-watch-store.ts`): a commit, a
 * checkout or a `git fetch` from anywhere — the review panel, a terminal, an editor, this row's own
 * fetch — writes `.git/HEAD` or `.git/refs/**`, which the host's watch reports, and only that report
 * re-reads the row. Ahead/behind are git's local up-stream counts, so they are only as fresh as the
 * last fetch: the read that draws the row also asks the upstream's remote for its refs, at most once
 * a minute per repository and on the host's own thread (`services/git.rs::request_upstream_fetch`),
 * so the counts a colleague's push moved arrive a moment after the panel opens. The watch only sees
 * those files when `.git` is inside the workspace root: a workspace opened on a repository
 * subdirectory, or a `git worktree`, keeps its refs elsewhere, and then the row moves only when the
 * reader opens it again (`src/AGENTS.md`).
 */
export function BranchPicker({ root, active, className }: BranchPickerProps) {
  const copy = useCopy(COPY);
  const [data, setData] = useState<WorkspaceBranches | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** When the rows on screen were read, so a relative time is not computed during render. */
  const [loadedAt, setLoadedAt] = useState(0);
  /** The root the answer on screen belongs to; a late answer for another one is dropped. */
  const loadedRoot = useRef<string | null>(null);
  /** The last ref-moving report this row has acted on, so one report is one read. */
  const seenRefRevision = useRef(workspaceRefRevision());

  const load = useCallback(async (target: string | null) => {
    loadedRoot.current = target;
    if (target === null) {
      setData(null);
      setError(null);
      return;
    }
    try {
      const next = await getWorkspaceBranches(target);
      if (loadedRoot.current !== target) return;
      setData(next);
      setLoadedAt(next === null ? 0 : Date.now());
      setError(null);
    } catch (caught) {
      if (loadedRoot.current !== target) return;
      // A failed refresh keeps whatever is already on screen: the row and the list are still the
      // last true reading, and the error says why the new one did not arrive.
      setError((caught as ApiError).message);
    }
  }, []);

  // One instance per changes tab (the panel is mounted per conversation), so the answer on screen
  // is always the repository the row names; a late answer for a previous root is dropped below.
  // A hidden panel defers the read: it starts it when the tab is next on screen.
  useEffect(() => {
    loadedRoot.current = root;
    if (root === null || active) void load(root);
  }, [active, load, root]);

  // Only a report that could have moved `HEAD`, a ref or an up-stream count is one more look: the
  // watch sees the whole working tree, and a file save cannot change a branch (2026-10-22, review:
  // this used to re-read four git processes per save).
  useEffect(() => {
    if (!active) return;
    return subscribeWorkspaceRefChange(() => {
      try {
        const next = workspaceRefRevision();
        if (root === null || next === seenRefRevision.current) return;
        seenRefRevision.current = next;
        void load(root);
      } catch (error) {
        // A refresh that cannot even be scheduled leaves the last true reading on screen, which is
        // the same answer a failed read gives; it must not take the store's fan-out down with it.
        console.error("the branch row could not refresh", error);
      }
    });
  }, [active, load, root]);

  // A branch can move while the changes area is drawn (a commit from the review panel, a checkout
  // in a terminal), so every opening reads it again. Opening is also the moment the reader looks.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next && root !== null) void load(root);
    },
    [load, root],
  );

  const filtered = useMemo(() => {
    const rows = data?.branches ?? [];
    const needle = query.trim().toLowerCase();
    if (needle === "") return rows;
    return rows.filter(
      (branch) =>
        branch.name.toLowerCase().includes(needle) ||
        branch.subject.toLowerCase().includes(needle) ||
        branch.author.toLowerCase().includes(needle),
    );
  }, [data, query]);

  const switchTo = useCallback(
    async (branch: RepositoryBranch) => {
      if (root === null || switching !== null || branch.current) return;
      setSwitching(branch.name);
      setError(null);
      try {
        await checkoutWorkspaceBranch(root, branch.name);
        await load(root);
        setOpen(false);
        setQuery("");
      } catch (caught) {
        setError((caught as ApiError).message);
      } finally {
        setSwitching(null);
      }
    },
    [load, root, switching],
  );

  if (root === null || data === null) return null;

  const checkedOut = data.current ?? data.detachedAt ?? copy.branchDetached;
  const sync = data.sync;
  const label =
    sync === undefined
      ? `${copy.branchPickerLabel}: ${checkedOut}`
      : `${copy.branchPickerLabel}: ${checkedOut} · ${copy.branchSync(sync.ahead, sync.behind)}`;
  return (
    <MorphPopover open={open} onOpenChange={handleOpenChange} className={cn("block w-full", className)}>
      <MorphPopoverTrigger>
        <button
          type="button"
          aria-label={label}
          title={label}
          className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-left text-[11px] text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="max-w-[9.5rem] shrink-0 truncate text-xs font-medium text-foreground">
            {checkedOut}
          </span>
          {sync === undefined ? null : (
            <span className="flex shrink-0 items-center gap-1 tabular-nums">
              <span className="flex items-center gap-px">
                {sync.behind}
                <ArrowDown aria-hidden="true" className="size-3" />
              </span>
              <span className="flex items-center gap-px">
                {sync.ahead}
                <ArrowUp aria-hidden="true" className="size-3" />
              </span>
            </span>
          )}
          <span
            title={data.repoName}
            className="ml-auto min-w-0 flex-1 truncate text-right text-muted-foreground/70"
          >
            {data.repoName}
          </span>
        </button>
      </MorphPopoverTrigger>
      <MorphPopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        radius={12}
        onOpenAutoFocus={(content) => content.querySelector("input")?.focus()}
        className="w-[min(21rem,calc(100vw-1.5rem))] p-2"
      >
        <Input
          value={query}
          onChange={setQuery}
          placeholder={copy.branchFilter}
          aria-label={copy.branchFilter}
          leftIcon={<Search aria-hidden="true" />}
          classNames={{
            field: "h-8 rounded-lg",
            input: "text-xs",
            leftIcon: "[&_svg]:size-3.5",
          }}
        />
        <div className="mt-2 flex items-center justify-between px-2 pb-1 text-[11px] font-medium text-muted-foreground">
          <span>{copy.branchesLabel}</span>
          <span className="truncate pl-2 text-muted-foreground/60">{data.repoName}</span>
        </div>
        <div
          role="listbox"
          aria-label={copy.branchesLabel}
          className="max-h-72 overflow-y-auto scrollbar-hide"
        >
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              {copy.branchNoMatches}
            </p>
          ) : (
            filtered.map((branch) => {
              const current = branch.current || branch.name === data.current;
              const busy = switching === branch.name;
              return (
                <button
                  key={branch.name}
                  type="button"
                  role="option"
                  aria-selected={current}
                  aria-label={`${branch.name}${current ? ` · ${copy.branchCurrent}` : ""}`}
                  aria-busy={busy}
                  disabled={switching !== null}
                  onClick={() => void switchTo(branch)}
                  className={cn(
                    "block w-full rounded-lg px-2 py-1.5 text-left outline-none transition-colors",
                    "hover:bg-muted/70 focus-visible:bg-muted/70 disabled:opacity-60",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-xs">
                    <GitBranch aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate font-medium text-foreground">{branch.name}</span>
                    {current ? (
                      <Check aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
                    ) : null}
                    <span className="ml-auto shrink-0 pl-2 tabular-nums text-[11px] text-muted-foreground">
                      {branch.updatedAt > 0
                        ? formatRelativeTime(branch.updatedAt * 1000, loadedAt, copy.relativeTime)
                        : ""}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate pl-5 text-[11px] text-muted-foreground">
                    {/* The repository is already named by the row and the list header, so the
                        second line carries what the search matches besides the name: who wrote the
                        branch's tip, and what it says. */}
                    {branch.author}
                    {branch.subject === "" ? "" : ` · ${branch.subject}`}
                  </span>
                </button>
              );
            })
          )}
        </div>
        {error === null ? null : (
          <p role="alert" className="px-2 pt-1.5 text-[11px] text-destructive">
            {error}
          </p>
        )}
      </MorphPopoverContent>
    </MorphPopover>
  );
}
