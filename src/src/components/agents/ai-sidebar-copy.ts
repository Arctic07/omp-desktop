import type { Localized } from "@/lib/i18n";

/**
 * The resource tree's wording: the row menu, the controls a row carries, and the live-region
 * announcements a move or a rename leaves behind.
 *
 * It lives beside the component rather than inside it because `ai-sidebar.tsx` is already at the
 * edge of the one-thousand-line ceiling (`rules.md`). The Chinese uses the app's own reading for
 * the shared words (`Rename` / `Move` / `Resources`); the rest is this tree's own.
 */
export interface SidebarCopy {
  /** The tree's accessible name when the caller gives none. */
  resourcesLabel: string
  /** The row menu. */
  rename: string
  moveUp: string
  moveDown: string
  moveInto: (label: string) => string
  moveOut: string
  /** The row's two controls, each named after the row it belongs to. */
  renameField: (label: string) => string
  rowActions: (label: string) => string
  /** What the live region says after a move, a refusal, or a failure. */
  movePending: string
  moved: (label: string, position: "before" | "inside" | "after", target: string) => string
  movedToTop: (label: string) => string
  moveFailed: (label: string) => string
  renameFailed: (label: string) => string
  /** The stand-in a name-less row is announced with (lowercase / sentence-initial). */
  itemFallback: string
  itemFallbackTitle: string
  /** What a row's status mark reads as, one word per state a mark carries. */
  statusRunning: string
  statusUnread: string
  statusCancelled: string
  statusPending: string
  statusError: string
}

export const COPY: Localized<SidebarCopy> = {
  en: {
    resourcesLabel: "Resources",
    rename: "Rename",
    moveUp: "Move up",
    moveDown: "Move down",
    moveInto: (label) => `Move into ${label}`,
    moveOut: "Move out",
    renameField: (label) => `Rename ${label}`,
    rowActions: (label) => `Actions for ${label}`,
    movePending: "Wait for the current move to finish.",
    moved: (label, position, target) => `Moved ${label} ${position} ${target}.`,
    movedToTop: (label) => `Moved ${label} to the top level.`,
    moveFailed: (label) => `Move failed. ${label} was restored.`,
    renameFailed: (label) => `Rename failed. ${label} was restored.`,
    itemFallback: "item",
    itemFallbackTitle: "Item",
    statusRunning: "Running",
    statusUnread: "Unread",
    statusCancelled: "Stopped",
    statusPending: "Unfinished",
    statusError: "Failed",
  },
  zh: {
    resourcesLabel: "资源",
    rename: "重命名",
    moveUp: "上移",
    moveDown: "下移",
    moveInto: (label) => `移入 ${label}`,
    moveOut: "移出",
    renameField: (label) => `重命名 ${label}`,
    rowActions: (label) => `${label} 的操作`,
    movePending: "请等待当前移动完成。",
    moved: (label, position, target) =>
      position === "inside"
        ? `已把 ${label} 移入 ${target}。`
        : `已把 ${label} 移到 ${target} ${position === "before" ? "之前" : "之后"}。`,
    movedToTop: (label) => `已把 ${label} 移到顶层。`,
    moveFailed: (label) => `移动失败，${label} 已恢复。`,
    renameFailed: (label) => `重命名失败，${label} 已恢复。`,
    itemFallback: "项目",
    itemFallbackTitle: "项目",
    statusRunning: "运行中",
    statusUnread: "未读",
    statusCancelled: "已中止",
    statusPending: "未完成",
    statusError: "出错",
  },
};
