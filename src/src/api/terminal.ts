/**
 * The terminal panel's commands: one pty per tab, its output streamed as frames.
 *
 * The desktop owns the shell (`terminal_open` resolves PowerShell 7, then Windows PowerShell, then
 * `cmd`), so this module never names an executable. Output travels as base64 because a pty read is
 * arbitrary bytes and the channel is JSON: one frame is one read, appended in order.
 */

import { Channel } from '@tauri-apps/api/core'

import { call } from '@/api/client'
import { COMMANDS } from '@/api/types'

/** What `terminal_open` answers: the id every later call names, and the shell's own label. */
export interface TerminalOpened {
  id: string
  /**
   * The shell's own name (`PowerShell`, `cmd`, …). The tab draws it with its own number appended
   * (`PowerShell-2`) and hands that name back through `terminalLabelSet`.
   */
  shell: string
  ownerSessionId: string
  workspaceKey: string
  cwd: string
}

/**
 * One frame of a terminal's stream.
 *
 * `data` is base64 because a pty read is bytes, not text: decoding to a string before xterm sees it
 * would split a multi-byte character across two frames.
 */
export type TerminalFrame = { kind: 'data'; data: string } | { kind: 'exit'; code: number }

/** Start one shell in `cwd`, streaming what it prints to `onFrame`. */
export interface TerminalSummary {
  id: string
  shell: string
  cwd: string
  ownerSessionId: string
  ownerSessionFile: string
  workspaceKey: string
}

export function terminalListLive(
  ownerSessionFile: string,
  workspaceKey: string,
): Promise<TerminalSummary[]> {
  return call<TerminalSummary[]>(COMMANDS.terminalListLive, { ownerSessionFile, workspaceKey })
}

export async function terminalAttach(
  id: string,
  onFrame: (frame: TerminalFrame) => void,
): Promise<TerminalOpened> {
  const channel = new Channel<TerminalFrame>(onFrame)
  return call<TerminalOpened>(COMMANDS.terminalAttach, { id, onFrame: channel })
}

/**
 * The raw tail of one shell's output, base64 — for a view whose xterm lost its buffer.
 *
 * It reads the pty's ring and subscribes to nothing, so a view that repairs itself this way keeps
 * exactly one live channel: subscribing again would deliver every following frame twice.
 */
export function terminalTail(id: string): Promise<string> {
  return call<string>(COMMANDS.terminalTail, { id })
}

/**
 * Start one shell in `cwd`, or attach to the one this conversation already has.
 *
 * `show` is false: the page is the one asking, so it already knows which tab this belongs to. The
 * broadcast exists for a pty the *agent* started, which the page has to be told about.
 */
export async function terminalOpen(
  cwd: string,
  cols: number,
  rows: number,
  ownerSessionId: string,
  ownerSessionFile: string,
  workspaceKey: string,
  onFrame: (frame: TerminalFrame) => void,
): Promise<TerminalOpened> {
  const channel = new Channel<TerminalFrame>(onFrame)
  return call<TerminalOpened>(COMMANDS.terminalOpen, {
    cwd,
    cols,
    rows,
    ownerSessionId,
    ownerSessionFile,
    workspaceKey,
    show: false,
    onFrame: channel,
  })
}

/** Send one batch of input — a keystroke or a paste — into a shell. */
export function terminalWrite(id: string, data: string): Promise<void> {
  return call<void>(COMMANDS.terminalWrite, { id, data })
}

/** Tell one shell's pty how much room the panel has, in character cells. */
export function terminalResize(id: string, cols: number, rows: number): Promise<void> {
  return call<void>(COMMANDS.terminalResize, { id, cols, rows })
}

/**
 * Name one shell what its tab reads as (`PowerShell-2`), so the agent's own `list` shows the name
 * the reader says out loud beside the pty id it addresses. The tab is the one that owns the number;
 * this only passes it across.
 */
export function terminalLabelSet(id: string, label: string): Promise<void> {
  return call<void>(COMMANDS.terminalLabelSet, { id, label })
}

/** End one shell and release its pty. */
export function terminalClose(id: string): Promise<void> {
  return call<void>(COMMANDS.terminalClose, { id })
}

/** End every shell owned by one conversation. */
export function terminalCloseSession(sessionId: string): Promise<void> {
  return call<void>(COMMANDS.terminalCloseSession, { sessionId })
}

/** End every shell owned by one workspace. */
export function terminalCloseWorkspace(workspaceKey: string): Promise<void> {
  return call<void>(COMMANDS.terminalCloseWorkspace, { workspaceKey })
}
