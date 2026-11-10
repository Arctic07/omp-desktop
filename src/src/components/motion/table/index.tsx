"use client";
// beui.dev/components/motion/table

import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { TableHeader } from "./table-header";
import type { TableProps } from "./types";
import { alignText, readCell } from "./utils";

export type { TableColumn, TableProps } from "./types";

/** The root font size Tailwind's rem scale assumes, and the pre-measure guess. */
const DEFAULT_ROOT_FONT_SIZE = 16;
/** Narrowest a column with no absolute width is worth in the floor. */
const MIN_COLUMN_WIDTH = 64;

/**
 * What one `rem` is worth here, in px. The default until the first client
 * layout, so the server and the hydrating client emit the same floor; measured
 * once after that, because a document that sets its own `html { font-size }`
 * lays a rem column out against that size and a floor computed from 16 would
 * fall short by the same factor.
 */
function useRootFontSize() {
  const [size, setSize] = useState(DEFAULT_ROOT_FONT_SIZE);
  useEffect(() => {
    const measured = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    if (measured > 0) setSize(measured);
  }, []);
  return size;
}

/**
 * The absolute width a column declared, in px, or null when it declared a share
 * of the remainder instead (`fr`, `%`, `auto`, `calc()`, nothing at all) — those
 * are worth whatever is left over, which is not a width this can add up.
 */
function resolveColumnWidth(
  width: string | undefined,
  rootFontSize: number,
): number | null {
  if (!width) return null;
  const value = Number.parseFloat(width);
  if (!Number.isFinite(value)) return null;
  if (width.endsWith("px")) return value;
  // rem is the other absolute length the repo writes.
  if (width.endsWith("rem")) return value * rootFontSize;
  return null;
}

export function Table<T>({
  data,
  columns,
  getRowId,
  rowHeight = 48,
  headerHeight = rowHeight,
  height = 440,
  emptyState = "No data",
  className,
}: TableProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () =>
      data.map((row, index) => ({
        row,
        id: getRowId ? getRowId(row, index) : String(index),
      })),
    [data, getRowId],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom =
    virtualItems.length > 0
      ? totalSize - virtualItems[virtualItems.length - 1].end
      : 0;

  const rootFontSize = useRootFontSize();
  // In a container narrower than the columns, `table-layout: fixed` shrinks
  // every column toward zero instead of scrolling. Floor the table at what the
  // columns actually asked for, then let the viewport scroll past it.
  const minTableWidth = useMemo(
    () =>
      Math.round(
        columns.reduce(
          (sum, column) =>
            sum +
            (resolveColumnWidth(column.width, rootFontSize) ??
              MIN_COLUMN_WIDTH),
          0,
        ),
      ),
    [columns, rootFontSize],
  );

  // Real columns + the trailing spacer.
  const leadColumns = columns.length;

  return (
    <div
      className={cn(
        "w-full overflow-hidden border border-border bg-background text-sm",
        className,
      )}
    >
      <div
        ref={scrollRef}
        className="overflow-auto"
        style={{ height }}
      >
        <table
          className="border-collapse"
          style={{
            tableLayout: "fixed",
            minWidth: `max(100%, ${minTableWidth}px)`,
          }}
        >
          <colgroup>
            {columns.map((column) => (
              <col
                key={column.key}
                style={column.width ? { width: column.width } : undefined}
              />
            ))}
            {/* Empty filler owns the leftover space — no gap, content unpinned. */}
            <col />
          </colgroup>

          <TableHeader columns={columns} headerHeight={headerHeight} />

          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={leadColumns + 1}
                  className="p-10 text-center text-muted-foreground"
                >
                  {emptyState}
                </td>
              </tr>
            ) : (
              <>
                {paddingTop > 0 ? (
                  <tr aria-hidden style={{ height: paddingTop }}>
                    <td colSpan={leadColumns + 1} />
                  </tr>
                ) : null}
                {virtualItems.map((vItem) => {
                  const entry = rows[vItem.index];
                  return (
                    <tr
                      key={entry.id}
                      style={{ height: rowHeight }}
                      className="border-border/60 border-b transition-colors hover:bg-muted/50"
                    >
                      {columns.map((column) => (
                        <td
                          key={column.key}
                          className={cn(
                            "truncate px-4 text-foreground",
                            alignText(column.align),
                          )}
                        >
                          {readCell(entry.row, column)}
                        </td>
                      ))}
                      <td aria-hidden />
                    </tr>
                  );
                })}
                {paddingBottom > 0 ? (
                  <tr aria-hidden style={{ height: paddingBottom }}>
                    <td colSpan={leadColumns + 1} />
                  </tr>
                ) : null}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
