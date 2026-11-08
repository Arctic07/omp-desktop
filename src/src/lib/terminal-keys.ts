/**
 * What one key event means to a terminal grid.
 *
 * `Ctrl+C` is both the shell's interrupt and the platform's copy chord; which one the reader meant
 * is decided by whether the grid has a selection. That decision lives here rather than inside the
 * view because getting it wrong is silent: the reader copies a prompt and kills the command with it.
 */
export type TerminalKeyAction = 'copy' | 'pass' | 'swallow'

/** The fields of a keyboard event this rule reads. */
export interface TerminalKeyEvent {
  type: string
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/**
 * `copy`: put the selection on the clipboard and keep the chord away from the pty.
 * `pass`: let xterm encode it (a bare `Ctrl+C` with nothing selected becomes the interrupt).
 * `swallow`: a copy chord with nothing to copy — do nothing rather than interrupt.
 */
export function terminalKeyAction(event: TerminalKeyEvent, hasSelection: boolean): TerminalKeyAction {
  // xterm answers keydown, keypress and keyup through the same handler; only one of them acts.
  if (event.type !== 'keydown') return 'pass'
  const letter = event.key === 'c' || event.key === 'C'
  const copiesWithCtrl =
    event.ctrlKey && !event.altKey && !event.metaKey && (letter || event.key === 'Insert')
  const copiesWithMeta = event.metaKey && !event.ctrlKey && !event.altKey && letter
  if (!copiesWithCtrl && !copiesWithMeta) return 'pass'
  if (hasSelection) return 'copy'
  return event.ctrlKey && !event.shiftKey && letter ? 'pass' : 'swallow'
}
