import { Download, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { Checkbox } from "@/components/motion/checkbox";
import { applyMcpSources, scanMcpSources } from "@/api/capabilities";
import { toApiError, type ApiError } from "@/api/client";
import type { McpSourceApply, McpSourceRow, McpSourceScan } from "@/api/types";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useBlockingOverlayWhile } from "@/state/overlay-depth";
import { MCP_COPY, type McpCopy } from "@/settings/sections/mcp-copy";

/**
 * The MCP import: the definitions the other coding agents on this machine already hold.
 *
 * Four agents are known - Claude Code, Codex, omp and the legacy pi layout - and the scan says
 * which of them this machine actually has, because the engine's own discovery cannot: every
 * provider resolves its user path from the home it runs under, and this host's home is pinned into
 * the application's data root. The dialog therefore lists the found agents only, states what each
 * one holds (importable, already here, or nothing at all), and names the missing ones in one line.
 * An agent that is not on this machine has nothing to copy, so it is not a choice.
 *
 * Reading and writing belong to the desktop (`mcp_import_scan` / `mcp_import_apply`); this card only
 * chooses. Copying is additive: a server this application already defines is skipped by name, and
 * the imported ones are connected immediately by the host.
 */
export function McpSourceImport({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after an import that wrote something, so the list reloads with live status. */
  onImported: () => void;
}) {
  const copy = useCopy(MCP_COPY);
  useBlockingOverlayWhile(open);
  return createPortal(
    <AnimatePresence>{open ? <Sheet copy={copy} onClose={onClose} onImported={onImported} /> : null}</AnimatePresence>,
    document.body,
  );
}

function Sheet({
  copy,
  onClose,
  onImported,
}: {
  copy: McpCopy;
  onClose: () => void;
  onImported: () => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const [status, setStatus] = useState<"loading" | "ready" | "applying" | "done" | "error">("loading");
  const [scan, setScan] = useState<McpSourceScan | null>(null);
  const [result, setResult] = useState<McpSourceApply | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    setResult(null);
    try {
      const answer = await scanMcpSources();
      setScan(answer);
      // Everything importable is chosen up front: the reader asked to bring their servers over, and
      // a source with nothing to add should not need a second decision.
      setChosen(
        new Set(
          answer.sources
            .filter((source) => source.present && source.servers.some((row) => row.status === "importable"))
            .map((source) => source.id),
        ),
      );
      setStatus("ready");
    } catch (failure) {
      setError(toApiError(failure));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const busy = status === "applying";
  const close = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  const apply = useCallback(async () => {
    if (busy || chosen.size === 0) return;
    setStatus("applying");
    setError(null);
    try {
      const answer = await applyMcpSources([...chosen]);
      setResult(answer);
      setStatus("done");
      if (answer.imported.length > 0) onImported();
      // The rows are a preview, and the copy just changed it: re-read so a copied server reads
      // "already here" instead of promising again what has already landed.
      try {
        setScan(await scanMcpSources());
        setChosen(new Set());
      } catch {
        // The result line already says what landed; an unreadable re-scan must not turn a
        // successful import into a failure.
      }
    } catch (failure) {
      setError(toApiError(failure));
      setStatus("error");
    }
  }, [busy, chosen, onImported]);

  // Only an agent this machine has something from is a choice; the rest is one line of text.
  const found = scan === null ? [] : scan.sources.filter((source) => source.present);
  const absent = scan === null ? [] : scan.sources.filter((source) => !source.present);
  const importable = found.reduce(
    (total, source) => total + source.servers.filter((row) => row.status === "importable").length,
    0,
  );

  return (
    <motion.div
      className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-[2px]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0.12 : 0.16 }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-source-import-title"
        className="flex max-h-[min(40rem,88vh)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-xl"
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 4 }}
        transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.7 }}
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-2">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-foreground/80">
              <Download aria-hidden="true" className="size-4" />
            </span>
            <h2 id="mcp-source-import-title" className="text-sm font-semibold leading-7">
              {copy.sourceImportTitle}
            </h2>
          </div>
          <button
            type="button"
            aria-label={copy.close}
            onClick={close}
            disabled={busy}
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          {status === "loading" ? (
            <p className="py-6 text-xs text-muted-foreground">{copy.sourceImportLoading}</p>
          ) : null}

          {status === "error" && scan === null ? (
            <div className="flex flex-col gap-2 py-4 text-xs text-muted-foreground">
              <p>{copy.sourceImportFailed}</p>
              {error === null ? null : (
                <p className="break-words text-[11px] text-muted-foreground/80">{error.message}</p>
              )}
              <div>
                <Button size="sm" variant="outline" onClick={() => void load()}>
                  {copy.sourceImportRescan}
                </Button>
              </div>
            </div>
          ) : null}

          {scan === null ? null : (
            <div className="flex flex-col gap-3 pt-1">
              <p className="text-xs leading-relaxed text-muted-foreground">{copy.sourceImportLead}</p>

              {found.length === 0 ? (
                <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border px-4 py-6 text-center">
                  <strong className="text-sm font-medium text-foreground">{copy.sourceImportNoneFound}</strong>
                  <p className="text-xs leading-relaxed text-muted-foreground">{copy.sourceImportNoneFoundHint}</p>
                </div>
              ) : (
                <>
                  <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background/40">
                    {found.map((source) => (
                      <SourceRow
                        key={source.id}
                        copy={copy}
                        source={source}
                        home={scan.home}
                        busy={busy}
                        checked={chosen.has(source.id)}
                        onCheckedChange={(next) =>
                          setChosen((current) => {
                            const updated = new Set(current);
                            if (next) updated.add(source.id);
                            else updated.delete(source.id);
                            return updated;
                          })
                        }
                      />
                    ))}
                  </ul>

                  {absent.length === 0 ? null : (
                    <p className="text-[11px] text-muted-foreground">
                      {copy.sourceImportAbsent(
                        absent.map((source) => copy.sourceNames[source.id as keyof McpCopy["sourceNames"]] ?? source.id),
                      )}
                    </p>
                  )}

                  {importable === 0 && found.some((source) => source.servers.length > 0) ? (
                    <p className="text-[11px] text-muted-foreground">{copy.sourceImportAllHere}</p>
                  ) : null}
                </>
              )}

              {result === null ? null : (
                <div className="flex flex-col gap-1 rounded-xl border border-border/70 bg-muted/20 px-3.5 py-2.5">
                  <p className="text-xs text-foreground/85">
                    {copy.sourceImportDone(result.imported.length, result.skipped.length)}
                  </p>
                  {result.imported.length === 0 ? null : (
                    <p className="break-words text-[11px] text-muted-foreground">{result.imported.join(" · ")}</p>
                  )}
                </div>
              )}

              {scan.warnings.length === 0 && (result?.warnings.length ?? 0) === 0 ? null : (
                <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] leading-relaxed text-muted-foreground/80">
                  {[...scan.warnings, ...(result?.warnings ?? [])].map((warning) => (
                    <li key={warning} className="break-words">
                      {warning}
                    </li>
                  ))}
                </ul>
              )}

              {status === "error" && scan !== null ? (
                <p className="text-xs text-destructive">
                  {copy.sourceImportFailed}
                  {error === null ? "" : ` ${error.message}`}
                </p>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/30 px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || status === "loading" || scan === null}
            onClick={() => void load()}
          >
            {copy.sourceImportRescan}
          </Button>
          <div className="flex items-center gap-2">
            {result === null ? (
              <>
                <Button variant="outline" size="sm" disabled={busy} onClick={close}>
                  {copy.cancel}
                </Button>
                {importable === 0 ? null : (
                  <Button size="sm" disabled={busy || chosen.size === 0} onClick={() => void apply()}>
                    {busy ? copy.sourceImportApplying : copy.sourceImportApply(importable)}
                  </Button>
                )}
              </>
            ) : (
              <Button size="sm" onClick={close}>
                {copy.close}
              </Button>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** One found agent: what it holds, and whether to copy it. */
function SourceRow({
  copy,
  source,
  home,
  checked,
  busy,
  onCheckedChange,
}: {
  copy: McpCopy;
  source: McpSourceRow;
  home: string;
  checked: boolean;
  busy: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  const importable = source.servers.filter((row) => row.status === "importable").length;
  const shortPath =
    home !== "" && source.path.toLowerCase().startsWith(home.toLowerCase())
      ? `~${source.path.slice(home.length)}`
      : source.path;
  const badge =
    importable > 0
      ? { status: "success" as const, text: copy.sourceBadgeImportable(importable) }
      : source.servers.length === 0
        ? { status: "neutral" as const, text: copy.sourceBadgeEmpty }
        : { status: "neutral" as const, text: copy.sourceBadgeConfigured };

  return (
    <li className="flex flex-col gap-2 px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <Checkbox
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={busy || importable === 0}
          label={copy.sourceNames[source.id as keyof McpCopy["sourceNames"]] ?? source.id}
          description={shortPath}
        />
        <span className="pt-0.5">
          <AnimatedBadge animated={false} size="sm" status={badge.status} showIcon={badge.status === "success"}>
            {badge.text}
          </AnimatedBadge>
        </span>
      </div>
      {source.servers.length === 0 ? null : (
        <ul className="ml-8 flex flex-col gap-0.5">
          {source.servers.map((row) => (
            <li key={row.name} className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4">
              <span className="truncate text-foreground/85" title={row.target}>
                {row.name}
              </span>
              {row.note === null ? null : (
                <span
                  role="img"
                  aria-label={row.note === "environment-reference" ? copy.sourceNoteReference : copy.sourceNoteForwarded}
                  title={row.note === "environment-reference" ? copy.sourceNoteReference : copy.sourceNoteForwarded}
                  className="grid size-3.5 shrink-0 place-items-center text-amber-600 dark:text-amber-400"
                >
                  <TriangleAlert aria-hidden="true" className="size-3" />
                </span>
              )}
              <span
                className={cn(
                  "ml-auto shrink-0",
                  row.status === "configured" ? "text-muted-foreground/70" : "text-foreground",
                )}
              >
                {row.status === "configured" ? copy.sourceServerConfigured : copy.sourceServerImportable}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
