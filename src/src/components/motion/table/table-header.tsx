import type { TableColumn } from "./types";
import { cn } from "@/lib/utils";
import { alignFlex, alignText } from "./utils";

export interface TableHeaderProps<T> {
  columns: readonly TableColumn<T>[];
  headerHeight: number;
}

/** The table's one header row: fixed height, sticky against the scroll viewport. */
export function TableHeader<T>({
  columns,
  headerHeight,
}: TableHeaderProps<T>) {
  return (
    <thead>
      <tr style={{ height: headerHeight }}>
        {columns.map((column) => (
          <th
            key={column.key}
            className="sticky top-0 z-10 border-border border-b bg-muted p-0 font-medium text-muted-foreground"
          >
            <div
              className={cn("flex h-full items-center", alignFlex(column.align))}
              style={{ height: headerHeight }}
            >
              <span
                className={cn(
                  "min-w-0 flex-1 truncate px-4",
                  alignText(column.align),
                )}
              >
                {column.header}
              </span>
            </div>
          </th>
        ))}
        <th
          aria-hidden
          className="sticky top-0 z-10 border-border border-b bg-muted"
        />
      </tr>
    </thead>
  );
}
