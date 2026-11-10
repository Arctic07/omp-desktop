import type { ReactNode } from "react";

export type TableColumn<T> = {
  /** Stable key; also the default object property read for the cell. */
  key: string;
  /** Header content. */
  header: ReactNode;
  /** Cell text alignment. */
  align?: "left" | "center" | "right";
  /** Column width as a CSS length, e.g. "160px" or "20%". Omit to share remaining space equally. */
  width?: string;
  /** Custom cell renderer. Falls back to `row[key]`. */
  cell?: (row: T) => ReactNode;
};

export interface TableProps<T> {
  data: readonly T[];
  columns: readonly TableColumn<T>[];
  /** Stable id per row. Defaults to the row index. */
  getRowId?: (row: T, index: number) => string;
  /** Fixed row height in px — required for virtualization. */
  rowHeight?: number;
  /** Header row height in px; defaults to `rowHeight`. */
  headerHeight?: number;
  /** Scroll viewport height in px. */
  height?: number;
  emptyState?: ReactNode;
  className?: string;
}
