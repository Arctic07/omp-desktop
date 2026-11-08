import type { Localized } from '@/lib/i18n'

/**
 * The terminal panel's wording: the tab, its empty state, and the two things that can go wrong.
 *
 * The shell's own label (`PowerShell`, `cmd`) is not here: it comes from the desktop, which is the
 * only side that knows which executable it started.
 */
export interface TerminalCopy {
  /** The tab's title before the shell has answered, and its accessible name. */
  title: string
  /** The panel's empty state: the row the reader presses to start a shell. */
  open: string
  openHint: string
  /** A new tab's own control. */
  newTab: string
  closeTab: (label: string) => string
  /** The shell exited, with the code the pty reported. */
  exited: (code: number) => string
  /** The desktop refused to start a shell; the message follows on its own line. */
  failed: string
  /** The conversation has no session file or no workspace yet: there is nowhere to start a shell. */
  noWorkspace: string
  opening: string
  attaching: string
  /** The grid's own menu: the reader's right-click on the terminal. */
  menuCopy: string
  menuPaste: string
  menuSelectAll: string
  /** The clipboard would not take the selection, or would not give its text. */
  copyFailed: string
  pasteFailed: string
}

export const TERMINAL_COPY: Localized<TerminalCopy> = {
  en: {
    title: 'Terminal',
    open: 'New terminal',
    openHint: 'Opens a shell in this workspace',
    newTab: 'New terminal tab',
    closeTab: (label) => `Close ${label}`,
    exited: (code) => `[process exited with code ${code}]`,
    failed: 'The terminal could not be started.',
    noWorkspace: 'This conversation has no workspace yet, so there is nowhere to start a shell.',
    opening: 'Starting terminal…',
    attaching: 'Attaching to terminal…',
    menuCopy: 'Copy',
    menuPaste: 'Paste',
    menuSelectAll: 'Select all',
    copyFailed: 'Could not copy the selection.',
    pasteFailed: 'Could not read the clipboard.',
  },
  zh: {
    title: '终端',
    open: '新建终端',
    openHint: '在此工作区打开一个 shell',
    newTab: '新建终端标签页',
    closeTab: (label) => `关闭 ${label}`,
    exited: (code) => `[进程已退出，代码 ${code}]`,
    failed: '终端启动失败。',
    noWorkspace: '这个对话还没有工作区，无法在这里打开 shell。',
    opening: '正在启动终端…',
    attaching: '正在连接终端…',
    menuCopy: '复制',
    menuPaste: '粘贴',
    menuSelectAll: '全选',
    copyFailed: '复制所选内容失败。',
    pasteFailed: '读取剪贴板失败。',
  },
}
