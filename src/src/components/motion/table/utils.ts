import type { ReactNode } from "react";
import type { TableColumn } from "./types";

export function alignFlex(align: TableColumn<unknown>["align"]) {
  if (align === "right") return "justify-end";
  if (align === "center") return "justify-center";
  return "justify-start";
}

export function alignText(align: TableColumn<unknown>["align"]) {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}

export function readCell<T>(row: T, column: TableColumn<T>): ReactNode {
  if (column.cell) return column.cell(row);
  return (row as Record<string, ReactNode>)[column.key];
}
