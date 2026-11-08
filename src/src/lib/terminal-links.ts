/**
 * What one click on an address the shell printed means to this application.
 *
 * The address itself is found by the `@xterm/addon-web-links` provider: it joins a wrapped line back
 * into one address and maps the match onto the buffer's cells, which is what makes the underline and
 * the pointer under the reader's own hover appear. What xterm does **not** decide is the gesture —
 * its linkifier hands every click that presses and releases on the same link to the link's own
 * `activate`, and in a grid a bare click is how a selection is started and how a full-screen program
 * with mouse reporting on receives its click. So the modifier is this application's rule: `Ctrl` or
 * `Cmd` hands the address to the machine's own browser, exactly as a modified click on a transcript
 * link does (`lib/links.ts`), and every other click stays xterm's.
 */
export type TerminalLinkAction = 'open' | 'pass'

/** The fields of a mouse event this rule reads. */
export interface TerminalLinkEvent {
  ctrlKey: boolean
  metaKey: boolean
}

/** `open`: the reader asked for the address; `pass`: the click belongs to the grid. */
export function terminalLinkAction(event: TerminalLinkEvent): TerminalLinkAction {
  return event.ctrlKey || event.metaKey ? 'open' : 'pass'
}
