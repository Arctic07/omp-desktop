import { Check, Download, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/motion/button";
import { Checkbox } from "@/components/motion/checkbox";
import type { ImportApplyResult } from "@/api/types";
import { OMP_IMPORT_COPY, type OmpImportCopy } from "@/home/omp-import-copy";
import { useCopy } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useBlockingOverlayWhile } from "@/state/overlay-depth";
import {
  applyOmpImport,
  closeOmpImport,
  loadScan,
  ompImportStore,
  toggleOmpImportCategory,
  type OmpImportCategory,
} from "@/state/omp-import-store";
import { useStoreSelector } from "@/state/store";

/**
 * The local-configuration import, in one card.
 *
 * The dialog is the whole feature's surface: it is raised by the first-run check (once) and by the
 * models page's button (any time), and both entries render the same read. Everything it shows comes
 * from the desktop's scan - names, counts and the per-item status - and the apply's answer replaces
 * the scan with what actually landed, because a preview is a different moment from a copy.
 *
 * Rendered in a portal because the settings page and the conversation both mount their own stacking
 * contexts: a fixed layer inside either would sit under the other surface's header.
 */
export function OmpImportDialog() {
  const copy = useCopy(OMP_IMPORT_COPY);
  const open = useStoreSelector(ompImportStore, (state) => state.open);
  useBlockingOverlayWhile(open);
  return createPortal(
    <AnimatePresence>
      {open ? (
        <Sheet copy={copy} />
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

/** The card itself, mounted only while the dialog is open. */
function Sheet({ copy }: { copy: OmpImportCopy }) {
  const reduce = useReducedMotion() ?? false;
  const status = useStoreSelector(ompImportStore, (state) => state.status);
  const entry = useStoreSelector(ompImportStore, (state) => state.entry);
  const scan = useStoreSelector(ompImportStore, (state) => state.scan);
  const result = useStoreSelector(ompImportStore, (state) => state.result);
  const error = useStoreSelector(ompImportStore, (state) => state.error);
  const selection = useStoreSelector(ompImportStore, (state) => state.selection);
  const primary = useRef<HTMLButtonElement>(null);

  const dismiss = useCallback(() => {
    if (status === "applying") return;
    void closeOmpImport();
  }, [status]);

  // A first-run question has no close button and no click-outside dismissal - its two answers are
  // the point - but Escape is the keyboard's way out of any card, and it means "not now" as surely
  // as the button does. The apply button takes focus there, so a keyboard reader answers at once.
  useEffect(() => {
    if (entry === "first-run") primary.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [entry, dismiss]);

  const busy = status === "applying";
  const categories: OmpImportCategory[] = ["models", "mcp", "skills"];
  const offered = scan === null ? 0 : scan.models.roles.length + scan.models.credentials.length + scan.models.providers.length + scan.mcp.servers.length + scan.skills.skills.length;
  const selected = categories.some((category) => selection[category]);

  return (
    <motion.div
      className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-[2px]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0.12 : 0.16 }}
      onPointerDown={(event) => {
        if (entry === "manual" && event.target === event.currentTarget) dismiss();
      }}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="omp-import-title"
        className="flex max-h-[min(46rem,90vh)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-xl"
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
            <h2 id="omp-import-title" className="text-sm font-semibold leading-7">
              {copy.title}
            </h2>
          </div>
          {entry === "manual" ? (
            <button
              type="button"
              aria-label={copy.close}
              onClick={dismiss}
              disabled={busy}
              className={cn(
                "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:pointer-events-none disabled:opacity-50",
              )}
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          {status === "loading" ? (
            <p className="py-6 text-xs text-muted-foreground">{copy.loading}</p>
          ) : null}

          {status === "error" ? (
            <div className="flex flex-col gap-2 py-4 text-xs text-muted-foreground">
              {/* A failed read has nothing to show and offers the retry; a failed apply keeps the
                  preview it was made from, so only its sentence is new. */}
              <p>{scan === null ? copy.loadFailed : copy.doneFailed}</p>
              {error === null ? null : (
                <p className="break-words text-[11px] text-muted-foreground/80">{error.message}</p>
              )}
              {scan === null ? (
                <div>
                  <Button size="sm" variant="outline" onClick={() => void loadScan()}>
                    {copy.retry}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {scan !== null && !scan.found ? (
            <p className="py-6 text-xs text-muted-foreground">{copy.notFound(scan.source)}</p>
          ) : null}

          {scan !== null && scan.found ? (
            <div className="flex flex-col gap-4 pt-1">
              <p className="text-xs leading-relaxed text-muted-foreground">{copy.lead(scan.source)}</p>

              {offered === 0 ? (
                <p className="text-xs text-muted-foreground">{copy.nothingToImport}</p>
              ) : (
                <div className="flex flex-col gap-3">
                  <Category
                    copy={copy}
                    category="models"
                    label={copy.modelsCategory}
                    count={
                      scan.models.roles.length + scan.models.credentials.length + scan.models.providers.length
                    }
                    selected={selection.models}
                    busy={busy}
                    rows={[
                      copy.rolesCount(scan.models.roles.length),
                      copy.credentialsCount(scan.models.credentials.length),
                      copy.providersCount(scan.models.providers.length),
                    ]}
                    items={[
                      ...scan.models.roles.map((row) => ({
                        name: row.role,
                        detail: row.selector,
                        status: row.status,
                      })),
                      ...scan.models.credentials.map((row) => ({
                        name: row.provider,
                        detail: row.kind === "api_key" ? copy.credentialApiKey : copy.credentialOauth,
                        status: row.status,
                      })),
                      ...scan.models.providers.map((row) => ({
                        name: row.name,
                        detail: row.hasKey ? copy.inlineKeyNote : null,
                        status: "importable",
                      })),
                    ]}
                  />
                  <Category
                    copy={copy}
                    category="mcp"
                    label={copy.mcpCategory}
                    count={scan.mcp.servers.length}
                    selected={selection.mcp}
                    busy={busy}
                    items={scan.mcp.servers.map((row) => ({
                      name: row.name,
                      detail: row.target,
                      status: row.status,
                    }))}
                  />
                  <Category
                    copy={copy}
                    category="skills"
                    label={copy.skillsCategory}
                    count={scan.skills.skills.length}
                    selected={selection.skills}
                    busy={busy}
                    items={scan.skills.skills.map((row) => ({
                      name: row.name,
                      detail: row.description,
                      status: row.status,
                    }))}
                  />
                </div>
              )}

              {scan.warnings.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="text-[11px] font-medium text-muted-foreground">{copy.warningsTitle}</p>
                  <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] leading-relaxed text-muted-foreground/80">
                    {scan.warnings.map((warning) => (
                      <li key={warning} className="break-words">
                        {warning}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {result === null ? null : <Result copy={copy} result={result} />}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
          {status === "done" ? (
            <Button size="sm" onClick={dismiss}>
              {copy.close}
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={dismiss}>
                {copy.close}
              </Button>
              <Button
                ref={primary}
                size="sm"
                disabled={busy || scan === null || !scan.found || offered === 0 || !selected}
                title={selected ? undefined : copy.nothingSelected}
                onClick={() => void applyOmpImport()}
              >
                {busy ? copy.applying : copy.apply}
              </Button>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

interface CategoryItem {
  name: string
  detail: string | null
  /** `importable` | `configured` | `unsupported` | `unresolved`. */
  status: string;
}

/** One category: its switch, how many items the source offers, and the items themselves. */
function Category({
  copy,
  category,
  label,
  count,
  selected,
  busy,
  items,
  rows,
}: {
  copy: OmpImportCopy;
  category: OmpImportCategory;
  label: string;
  count: number;
  selected: boolean;
  busy: boolean;
  items: readonly CategoryItem[];
  rows?: readonly string[];
}) {
  return (
    <section className="rounded-xl border border-border/70 bg-background/40 px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <Checkbox
          checked={selected}
          onCheckedChange={(next) => toggleOmpImportCategory(category, next)}
          disabled={busy || count === 0}
          label={label}
          description={rows?.join(" · ")}
        />
        <span className="pt-0.5 text-[11px] tabular-nums text-muted-foreground">
          {copy.categoryCount(count)}
        </span>
      </div>
      {items.length === 0 ? null : (
        <ul className="mt-2 flex flex-col gap-1 border-t border-border/50 pt-2">
          {items.map((item, index) => (
            <li
              key={`${item.name}\u0000${index}`}
              className="flex min-w-0 items-baseline justify-between gap-3 text-[11px]"
            >
              <span className="min-w-0 break-words text-foreground/85">{item.name}</span>
              <span className="flex shrink-0 items-center gap-2">
                {item.detail === null || item.detail === "" ? null : (
                  <span
                    className="max-w-40 truncate text-muted-foreground/70"
                    title={item.detail}
                  >
                    {item.detail}
                  </span>
                )}
                <StatusMark copy={copy} status={item.status} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One item's status, as the tick the question is really asking: is it already here?
 *
 * A green `Check` answers "yes, this machine has it"; a grey one answers "no, so it will be copied";
 * and the two states that cannot be copied keep the mark that says so - an amber warning, with the
 * reason on the title. The word each mark stands for stays as its accessible name, so the status is
 * never colour alone.
 */
function StatusMark({ copy, status }: { copy: OmpImportCopy; status: string }) {
  if (status === "configured") {
    return (
      <span
        className="grid size-4 place-items-center rounded-full text-emerald-600 dark:text-emerald-400"
        role="img"
        aria-label={copy.statusConfigured}
        title={copy.statusConfigured}
      >
        <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
      </span>
    );
  }
  if (status === "unresolved" || status === "unsupported") {
    const word = status === "unresolved" ? copy.statusUnresolved : copy.statusUnsupported;
    return (
      <span
        className="grid size-4 place-items-center text-amber-600 dark:text-amber-400"
        role="img"
        aria-label={word}
        title={status === "unsupported" ? copy.oauthNote : word}
      >
        <TriangleAlert aria-hidden="true" className="size-3.5" />
      </span>
    );
  }
  if (status === "importable") {
    return (
      <span
        className="grid size-4 place-items-center rounded-full text-muted-foreground/50"
        role="img"
        aria-label={copy.statusMissing}
        title={copy.statusMissing}
      >
        <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
      </span>
    );
  }
  return null;
}

/** What an apply did, per category, with the skip count that states the whole rule. */
function Result({ copy, result }: { copy: OmpImportCopy; result: ImportApplyResult }) {
  const imported =
    result.models.rolesImported.length +
    result.models.credentialsImported.length +
    result.providersImported.length +
    result.mcp.imported.length +
    result.skills.imported.length;
  const skipped =
    result.models.rolesSkipped.length +
    result.models.credentialsSkipped.length +
    result.providersSkipped.length +
    result.mcp.skipped.length +
    result.skills.skipped.length;
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border/70 bg-muted/20 px-3.5 py-2.5">
      <p className="text-xs text-foreground/85">{copy.doneSummary(imported, skipped)}</p>
      {result.keysStored.length === 0 ? null : (
        <p className="text-[11px] text-muted-foreground">{result.keysStored.join(" · ")}</p>
      )}
      {result.warnings.length === 0 ? null : (
        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] leading-relaxed text-muted-foreground/80">
          {result.warnings.map((warning) => (
            <li key={warning} className="break-words">
              {warning}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
