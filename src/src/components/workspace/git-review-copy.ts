import type { Localized } from "@/lib/i18n";

/** The git review panel's wording, shared by the list and the diff view. */
export interface GitReviewCopy {
  /** The panel's accessible name and its header title. */
  title: string
  refresh: string
  refreshing: string
  /** The states the panel reports. */
  noWorkspace: string
  noWorkspaceHint: string
  noRepository: string
  loading: string
  empty: string
  clean: string
  filesChanged: (count: number) => string
  truncated: string
  readFailed: string
  retry: string
  /** The commit box. */
  commitMessage: string
  commitPlaceholder: string
  draft: string
  drafting: string
  commit: string
  committing: string
  sync: string
  syncing: string
  syncCount: (count: number) => string
  syncHint: (upstream: string) => string
  /** The two sections. */
  staged: string
  unstaged: string
  stageAll: string
  unstageAll: string
  stage: string
  unstage: string
  /** Discard is two-step: the second press performs what the first named. */
  discard: string
  discardAll: string
  /** The second press's wording for the whole-side button, which has no path to name. */
  discardAllConfirm: string
  discardConfirm: (target: string) => string
  /** One file row. */
  expandFile: (path: string) => string
  collapseFile: (path: string) => string
  openDiff: (path: string) => string
  binary: string
  tooLarge: string
  noLineDetails: string
  /** The diff view opened from a file row. */
  diffBack: string
  diffClose: string
  diffOld: string
  diffNew: string
  diffBinary: string
  diffTooLarge: string
  diffEmpty: string
  diffError: string
  hunk: string
  /** The status letters, for the row's aria label. */
  statusLabel: Record<string, string>
}

export const GIT_REVIEW_COPY: Localized<GitReviewCopy> = {
  en: {
    title: "Changes",
    refresh: "Refresh",
    refreshing: "Reading git status",
    noWorkspace: "No workspace",
    noWorkspaceHint: "Open a folder to see its changes here.",
    noRepository: "This folder is not a git repository.",
    loading: "Reading git status",
    empty: "No changes",
    clean: "Working tree clean",
    filesChanged: (count) => (count === 1 ? "1 file changed" : `${count} files changed`),
    truncated: "Some diffs were too large to read; those rows say so.",
    readFailed: "Could not read git status.",
    retry: "Retry",
    commitMessage: "Commit message",
    commitPlaceholder: "Describe the change…",
    draft: "Draft with agent",
    drafting: "Drafting…",
    commit: "Commit",
    committing: "Committing…",
    sync: "Sync",
    syncing: "Syncing…",
    syncCount: (count) => `Sync (${count})`,
    syncHint: (upstream) => `Pull, then push · ${upstream}`,
    staged: "Staged changes",
    unstaged: "Changes",
    stageAll: "Stage all",
    unstageAll: "Unstage all",
    stage: "Stage",
    unstage: "Unstage",
    discard: "Discard changes",
    discardAll: "Discard all changes",
    discardAllConfirm: "Press again to discard every unstaged change",
    discardConfirm: (target) => `Press again to discard ${target}`,
    expandFile: (path) => `Expand ${path}`,
    collapseFile: (path) => `Collapse ${path}`,
    openDiff: (path) => `View diff of ${path}`,
    binary: "Binary file",
    tooLarge: "Diff too large to display",
    noLineDetails: "No line changes to display",
    diffBack: "Back",
    diffClose: "Close",
    diffOld: "Old",
    diffNew: "New",
    diffBinary: "Binary file — no line diff",
    diffTooLarge: "The diff is too large to display",
    diffEmpty: "No line changes",
    diffError: "The diff could not be read.",
    hunk: "Hunk",
    statusLabel: {
      added: "Added",
      modified: "Modified",
      deleted: "Deleted",
      renamed: "Renamed",
      untracked: "Untracked",
    },
  },
  zh: {
    title: "改动",
    refresh: "刷新",
    refreshing: "正在读取 git 状态",
    noWorkspace: "没有工作区",
    noWorkspaceHint: "打开一个文件夹后，这里会显示它的改动。",
    noRepository: "这个文件夹不是 git 仓库。",
    loading: "正在读取 git 状态",
    empty: "没有改动",
    clean: "工作区干净",
    filesChanged: (count) => `${count} 个文件有改动`,
    truncated: "部分文件的 diff 过大未读取，对应行会说明。",
    readFailed: "无法读取 git 状态。",
    retry: "重试",
    commitMessage: "提交信息",
    commitPlaceholder: "描述这次改动…",
    draft: "让智能体起草",
    drafting: "起草中…",
    commit: "提交",
    committing: "提交中…",
    sync: "同步",
    syncing: "同步中…",
    syncCount: (count) => `同步（${count}）`,
    syncHint: (upstream) => `先拉取后推送 · ${upstream}`,
    staged: "已暂存",
    unstaged: "未暂存",
    stageAll: "全部暂存",
    unstageAll: "全部取消暂存",
    stage: "暂存",
    unstage: "取消暂存",
    discard: "放弃改动",
    discardAll: "放弃全部改动",
    discardAllConfirm: "再次点击放弃全部未暂存改动",
    discardConfirm: (target) => `再次点击以放弃${target}`,
    expandFile: (path) => `展开 ${path}`,
    collapseFile: (path) => `收起 ${path}`,
    openDiff: (path) => `查看 ${path} 的 diff`,
    binary: "二进制文件",
    tooLarge: "diff 过大，无法显示",
    noLineDetails: "没有可显示的行改动",
    diffBack: "返回",
    diffClose: "关闭",
    diffOld: "旧",
    diffNew: "新",
    diffBinary: "二进制文件，没有行级 diff",
    diffTooLarge: "diff 过大，无法显示",
    diffEmpty: "没有行改动",
    diffError: "无法读取 diff。",
    hunk: "代码块",
    statusLabel: {
      added: "新增",
      modified: "修改",
      deleted: "删除",
      renamed: "重命名",
      untracked: "未跟踪",
    },
  },
};
