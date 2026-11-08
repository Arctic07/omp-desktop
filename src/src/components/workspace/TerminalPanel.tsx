/**
 * One terminal tab's body: the xterm view and the pty behind it.
 *
 * The desktop owns the shell and the pty (`api/terminal.ts`); this owns what the reader sees and
 * types. Five rules shape it:
 *
 * ① **Nothing is started until the box can be measured.** A shell started at a guessed grid draws
 * its banner at the wrong width and re-wraps it, which reads as a shell that started mid-sentence —
 * and a box that cannot be measured at all (the column is opening, or closed) used to end the tab in
 * a failure banner that nothing retried, which is the black terminal in the reports. The fit is
 * retried on every resize tick instead; the first one that produces a grid is the one the shell is
 * started with.
 * ② **Bytes stay bytes.** Frames are base64 and are written to xterm as `Uint8Array`, never as a
 * decoded string: a multi-byte character split across two pty reads would otherwise arrive as two
 * replacement characters. Input goes the other way as base64 (`terminal_write` decodes it).
 * ③ **One pty per tab, closed by the tab, not by this view.** The shell belongs to the tab
 * (`state/panel-store.ts::closeTerminalTab` is the one place that ends one the reader owns), because
 * a view can be remounted without anything closing: the window shrinking past the layout breakpoint
 * rebuilds the column, and closing the pty there left a tab that came back empty (the reader's
 * "minimize and restore and the terminal is gone"). A remount therefore **attaches** to the pty the
 * tab already names and replays its tail; only a tab that has no pty yet starts one.
 * ④ **Resizes are queued, not fired.** The panel and the window both resize continuously, and every
 * request is a pty ioctl across IPC. Only one is in flight at a time, only the newest pending one is
 * kept, and a hidden tab sends none.
 * ⑤ **A printed address is a link, and the reader asks for it.** `@xterm/addon-web-links` finds the
 * address in the grid; `Ctrl`/`Cmd` + click hands it to the machine's own browser
 * (`lib/terminal-links.ts`), so a bare click stays the selection's, the shell's, or the program
 * under the cursor's.
 */

import { getCurrentWindow } from '@tauri-apps/api/window'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal as XTerm } from '@xterm/xterm'
import { ClipboardPaste, Copy, TextCursorInput } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'

import {
  terminalAttach,
  terminalClose,
  terminalOpen,
  terminalResize,
  terminalTail,
  terminalWrite,
  type TerminalFrame,
} from '@/api/terminal'
import { reportTerminalFace } from '@/api/diagnostics'
import { openExternal } from '@/api/system'
import { ResourceMenuAction } from '@/components/agents/ai-sidebar'
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from '@/components/motion/popover-morph'
import { copyText, readText } from '@/lib/clipboard'
import { readTerminalPalette, subscribeTerminalPalette } from '@/lib/palette'
import { terminalKeyAction } from '@/lib/terminal-keys'
import { terminalLinkAction } from '@/lib/terminal-links'
import { cn } from '@/lib/utils'
import { useCopy } from '@/lib/i18n'
import { TERMINAL_COPY } from '@/home/terminal-copy'
import { bindTerminalTab, exitTerminalTab, failTerminalTab } from '@/state/terminal-tabs'

/** Decoded once: base64 → the pty's own bytes. */
function decodeFrame(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** The pty's input direction: text → the base64 `terminal_write` decodes. */
function encodeInput(data: string): string {
  const bytes = new TextEncoder().encode(data)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * The viewport width below which the reader is not actually looking at the document.
 *
 * A minimized window is laid out by WebView2 at a few dozen pixels wide (146×20 in the reports),
 * while this application's own minimum window width is 960. A terminal fitted to that grid is a pty
 * resized to a handful of columns, and the shell answers by reprinting its prompt — the duplicated
 * prompt and the changed scrollback the reader saw after bringing the window back. So a document
 * this narrow is left unfitted; the layout that comes back is measured again on the next tick.
 */
const MIN_MEASURABLE_WIDTH = 400

/**
 * Fit one view to its box, or say why it could not.
 *
 * The two refusals are the same fact seen twice: a box with no size (the column is animating open,
 * or the tab is out of sight) and a document the window has laid out at a size nobody can read (the
 * window is minimized, see `MIN_MEASURABLE_WIDTH`). Neither is a failure — the next resize tick
 * measures again.
 */
function fitIfMeasurable(host: HTMLElement | null, term: XTerm | null, fit: FitAddon | null): boolean {
  if (host === null || term === null || fit === null) return false
  if (host.clientWidth <= 0 || host.clientHeight <= 0) return false
  if (window.innerWidth < MIN_MEASURABLE_WIDTH) return false
  try {
    fit.fit()
  } catch {
    return false
  }
  return term.cols > 0 && term.rows > 0
}

/** The size every cell is drawn at, and the size the pty's grid is computed from. */
const TERMINAL_FONT_SIZE = 12

/** The face a terminal falls back to when the app's own token cannot be drawn as a grid. */
const TERMINAL_FALLBACK_FACE = "Consolas, 'Cascadia Mono', 'Courier New', monospace"

/** Logged once per page: which face the panels took, and what the token said. */
let faceReported = false

/** Whether one face gives every character the same advance, measured at the panel's size. */
function isMonospaced(face: string): boolean {
  const context = document.createElement('canvas').getContext('2d')
  if (context === null) return false
  // An unparsable value is dropped by the canvas, which then measures the *previous* font: a
  // proportional sample, which is the answer this returns for a value that cannot be drawn.
  context.font = `${TERMINAL_FONT_SIZE}px ${face}`
  const wide = context.measureText('W').width
  if (wide <= 0) return false
  return ['i', 'l', 'm', '0', '.'].every((sample) => Math.abs(context.measureText(sample).width - wide) <= 0.01)
}

/**
 * The face the terminal draws with: the app's `--font-mono`, when it is a face a grid can use.
 *
 * xterm takes the cell width *and* the glyphs from one face, so a proportional face makes every
 * column drift from the width the shell was told and the panel then wraps where the shell did not
 * — the terminal reads as text in the page's own font rather than as a grid. The token is the
 * app's own, but what a page computes for it is whatever the browser could match on that machine:
 * a chain whose mono families are missing lands on a UI/CJK face, which is proportional. The value
 * is therefore measured before it is used, and the panel reports what it took (one line per page).
 */
function terminalFace(): string {
  const token = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
  const usable = token !== '' && isMonospaced(token)
  const face = usable ? token : TERMINAL_FALLBACK_FACE
  if (!faceReported) {
    faceReported = true
    void reportTerminalFace(face, token).catch(() => undefined)
  }
  return face
}

export interface TerminalPanelProps {
  /** The session this tab belongs to. */
  ownerSessionId: string
  tabId: number
  /** The pty this tab shows, once it has one. */
  terminalId?: string
  mode?: 'open' | 'attach'
  /** The shell exited on its own: this panel starts nothing until the tab is opened again. */
  exited?: boolean
  /** The last start attempt failed. The tab keeps the message; the column replaces it on the next open. */
  failed?: boolean
  /**
   * The conversation's session file, as the desktop's owner key. Empty for a conversation nothing
   * has been sent in yet: the engine writes its file with the first message, and the shell is owned
   * by the conversation id and the workspace until then.
   */
  ownerSessionFile: string
  /** Where the shell is started. Resolved when the tab was created, never at mount. */
  cwd: string
  /** False for a tab that is not the active one: the shell keeps running, the box stays hidden. */
  visible?: boolean
  /** The shell the desktop started, so the tab can carry its own name (`PowerShell`, `cmd`, …). */
  onShellLabel?: (label: string) => void
  className?: string
}

export function TerminalPanel({
  ownerSessionId,
  tabId,
  terminalId,
  mode = 'open',
  exited = false,
  failed = false,
  ownerSessionFile,
  cwd,
  visible = true,
  onShellLabel,
  className,
}: TerminalPanelProps) {
  const copy = useCopy(TERMINAL_COPY)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const idRef = useRef<string | null>(null)
  /** The size the shell was last told about, so a fit that changes nothing sends nothing. */
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const resizeInFlightRef = useRef(false)
  const disposedRef = useRef(false)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const requestResizeRef = useRef<((size: { cols: number; rows: number }) => void) | null>(null)
  /** Starts the shell if it has not been started yet; set by the mount effect. */
  const maybeStartRef = useRef<(() => void) | null>(null)
  /** Rebuilds a view whose buffer has gone from the pty's own tail; set by the mount effect. */
  const maybeSeedRef = useRef<(() => void) | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /**
   * The grid's own menu: where the reader right-clicked, and what was selected at that moment.
   * The selection is taken when the menu opens because the press that picks a row lands outside the
   * grid; the copy row has to mean what the reader saw, not what is left afterwards.
   */
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string } | null>(null)
  /** The last clipboard action the desktop refused, said above the grid. */
  const [menuNotice, setMenuNotice] = useState<string | null>(null)

  // The words are read once per mount: they are the same record for the shell's whole life, and a
  // language switch mid-session is not a reason to restart a pty.
  const copyRef = useRef(copy)
  copyRef.current = copy
  const shellLabelRef = useRef(onShellLabel)
  shellLabelRef.current = onShellLabel
  const fitRef = useRef<FitAddon | null>(null)
  // Everything the pty needs is fixed for the tab's life: where it stands, whether it is ours to
  // close, and the id the agent started it under. Read through refs so the mount effect never needs
  // them as dependencies (a dependency would restart a live shell). `failed` is read at mount only:
  // the column replaces a failed tab rather than mutating it, so this panel never starts a shell for
  // one.
  const startRef = useRef({ ownerSessionId, tabId, ownerSessionFile, cwd, mode, terminalId, exited, failed })
  startRef.current = { ownerSessionId, tabId, ownerSessionFile, cwd, mode, terminalId, exited, failed }

  useEffect(() => {
    let disposed = false
    disposedRef.current = false
    const host = hostRef.current
    if (host === null) return
    const box = host
    const start = startRef.current

    const palette = readTerminalPalette()
    const term = new XTerm({
      fontSize: TERMINAL_FONT_SIZE,
      fontFamily: terminalFace(),
      theme: {
        background: palette.background,
        foreground: palette.foreground,
        cursor: palette.foreground,
      },
      cursorBlink: true,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // An address the shell printed — a dev server's own banner, a report's URL — is a link the
    // reader can act on: the addon finds it (joining a wrapped line back into one address) and
    // `Ctrl`/`Cmd` + click hands it to the machine's browser through the same command the
    // transcript's links use. Letting the click decide is `terminalLinkAction`'s rule.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (terminalLinkAction(event) !== 'open') return
        void openExternal(uri).catch(() => undefined)
      }),
    )
    // `Ctrl Tab` is the column's tab walk (`right-sidebar.tsx`), not the shell's: xterm would
    // otherwise turn it into a tab on its way to the pty. Everything else is xterm's to handle,
    // except the copy chords — `terminalKeyAction` owns that rule.
    term.attachCustomKeyEventHandler((event) => {
      if (event.ctrlKey && event.key === 'Tab') return false
      const selection = term.getSelection()
      const action = terminalKeyAction(event, selection !== '')
      if (action === 'pass') return true
      if (action === 'copy') {
        // The browser's own copy would fire on xterm's hidden textarea (which xterm fills on
        // right-click) and could put stale text over the selection being copied here.
        event.preventDefault()
        copyTerminalSelection(selection)
      }
      return false
    })
    // Defer the open by one frame: the host's `clientWidth` is 0 the moment the effect runs, so
    // xterm would draw on a 0-sized canvas. The rAF after this paint pass has the layout done.
    let raf = 0
    const queuedFrames: TerminalFrame[] = []
    let xtermReady = false
    /** True once a pty was asked for; the answer may still be in flight. */
    let started = false

    raf = requestAnimationFrame(() => {
      if (disposed) return
      term.open(host)
      termRef.current = term
      fitRef.current = fit
      xtermReady = true
      // A tab that is already on screen when it mounts takes this branch with nothing focused: the
      // `visible` effect below ran before this frame, found no view to focus, and a tab only becomes
      // visible again when another one is chosen. An unfocused xterm draws **no cursor** and drops
      // every keystroke, which is the reader's "the terminal started but typing does nothing" — so
      // the view that mounts on screen takes the focus here, once it exists.
      if (visibleRef.current) term.focus()
      for (const frame of queuedFrames.splice(0)) writeFrame(frame)
      // The pty is started by the first fit that produces a grid (see `maybeStart`), which may be
      // this tick or a later resize tick while the column is still opening.
      maybeStart()
    })

    /**
     * Fit to the box and report the grid it produced, or null while the box is unmeasurable.
     *
     * An unmeasurable box is a normal state, not a failure: the column animates open, so the first
     * ticks after a tab is created genuinely have no width. Returning null keeps the tab waiting
     * instead of drawing a failure nothing would clear.
     */
    function applyFit(): { cols: number; rows: number } | null {
      if (!fitIfMeasurable(box, term, fit)) return null
      return { cols: term.cols, rows: term.rows }
    }

    /** Start the shell with the grid the box produced, once. */
    function maybeStart(): void {
      if (disposed || started) return
      if (!xtermReady) return
      // A tab whose shell exited, or whose start already failed, shows what it has and starts
      // nothing: the column replaces it the next time the reader asks for the terminal.
      if (start.exited || start.failed) {
        setLoading(false)
        return
      }
      const size = applyFit()
      if (size === null) return
      started = true
      setLoading(true)
      setFailure(null)
      const attachTo = start.terminalId
      // A tab that already names a pty attaches to it — whether the reader opened that shell or the
      // agent did — because the shell now lives with the tab, not with this view (see ③ above). The
      // attach already knows the pty's id, so it is set before the command is sent: the replay this
      // call delivers can contain a question xterm answers immediately (PowerShell's cursor report),
      // and that answer has to be able to reach the shell. A shell this panel starts has no id until
      // the command answers, which is what `flushQueuedInput` covers.
      if (attachTo !== undefined) idRef.current = attachTo
      const opening = attachTo !== undefined
        ? terminalAttach(attachTo, onFrame)
        : start.cwd === ''
          ? Promise.reject(new Error(copyRef.current.noWorkspace))
          : terminalOpen(
              start.cwd,
              size.cols,
              size.rows,
              start.ownerSessionId,
              start.ownerSessionFile,
              start.cwd,
              onFrame,
            )
      void opening
        .then((opened) => {
          if (disposed) {
            // A pty this dead view started has no tab that names it, so nothing else can ever reach
            // it; an attach is the tab's own shell and is left alone.
            if (attachTo === undefined) void terminalClose(opened.id).catch(() => {})
            return
          }
          // An attach already named the pty; only a shell this panel started needs the answer's id.
          if (attachTo === undefined) idRef.current = opened.id
          if (attachTo === undefined) bindTerminalTab(start.ownerSessionId, start.tabId, opened.id, opened.shell)
          shellLabelRef.current?.(opened.shell)
          setLoading(false)
          // The shell may have asked its terminal a question (PowerShell's cursor report) and be
          // blocked on the answer xterm already produced; it goes out before the resize so the
          // prompt is laid out at the width the reader sees.
          flushQueuedInput()
          // The shell was started at the size the box had when it became measurable; the panel may
          // have kept growing since, so the real grid is sent now.
          requestResizeRef.current?.(size)
          const current = applyFit()
          if (current !== null) requestResizeRef.current?.(current)
        })
        .catch((error: unknown) => {
          if (disposed) return
          const message = error instanceof Error ? error.message : String(error)
          setLoading(false)
          setFailure(message)
          term.write(`\r\n${copyRef.current.failed}\r\n${message}\r\n`)
          // The tab stays (the message is what the reader has to see), but the next "open the
          // terminal" starts a fresh shell instead of showing this failure again.
          failTerminalTab(start.ownerSessionId, start.tabId)
        })
    }
    maybeStartRef.current = maybeStart

    /**
     * Write the pty's own tail back when this view has nothing to draw.
     *
     * A window that was put away can come back with the view's buffer gone while the shell is still
     * alive — the panel then has a tab and a pty and a black box. The pty keeps the last 128 KiB for
     * exactly this kind of reader, and `terminal_tail` delivers it without subscribing again, so the
     * live channel stays single and the view is rebuilt from the shell's own output.
     */
    let seeding = false
    function maybeSeed(): void {
      const id = idRef.current
      const term = termRef.current
      if (id === null || term === null || seeding || !xtermReady) return
      // A view that starts from an id the tab already carried is rebuilt by `terminal_attach`'s own
      // replay; writing the tail beside it would print the shell's last screen twice.
      if (start.terminalId !== undefined) return
      // A view that still has something to draw is never repaired: writing the tail into it would
      // print every line a second time.
      const first = term.buffer.active.getLine(0)?.translateToString(true).trim() ?? ''
      if (term.buffer.active.length > 1 || first !== '') return
      seeding = true
      void terminalTail(id)
        .then((data) => {
          if (disposed) return
          const bytes = decodeFrame(data)
          if (bytes.length > 0) term.write(bytes)
          term.scrollToBottom()
        })
        .catch(() => undefined)
        .finally(() => {
          seeding = false
        })
    }
    maybeSeedRef.current = maybeSeed

    // Input: xterm's own translation (arrows, Ctrl-C, paste) goes to the pty as it arrives.
    //
    // **A reply xterm produces before the pty has an id is kept, not dropped.** PowerShell asks its
    // terminal where the cursor is (`ESC[6n`) before it prints a prompt and blocks until the answer
    // arrives; a shell the agent started has been waiting on that question since it was created, so
    // the replay `terminal_attach` sends back carries the question and xterm answers immediately —
    // which is *before* the command's promise has resolved and given this panel an id. Dropping that
    // answer left the shell waiting forever and the tab black, while a shell started by the reader
    // itself happened to answer after the id was known (this was the "agent's terminal is black,
    // mine is fine" report).
    const queuedInput: string[] = []
    const inputDisposable = term.onData((data) => {
      const id = idRef.current
      if (id === null) {
        // Bounded: only a terminal's own query answers can arrive this early, and a runaway
        // producer must not grow this without end.
        if (queuedInput.length < 32) queuedInput.push(data)
        return
      }
      void terminalWrite(id, encodeInput(data)).catch(() => {
        // A write the desktop refused (a shell that just exited) needs no message: the exit frame
        // that follows is the one the reader sees.
      })
    })

    /** Send whatever xterm answered before the pty was named. */
    function flushQueuedInput(): void {
      const id = idRef.current
      if (id === null) return
      for (const data of queuedInput.splice(0)) {
        void terminalWrite(id, encodeInput(data)).catch(() => {})
      }
    }

    /** Put the grid's selection on the clipboard; a refusal is said above the grid. */
    function copyTerminalSelection(text: string): void {
      if (text === '') return
      void copyText(text).then((ok) => {
        if (!ok && !disposed) setMenuNotice(copyRef.current.copyFailed)
      })
    }

    function writeFrame(frame: TerminalFrame): void {
      if (frame.kind === 'data') {
        term.write(decodeFrame(frame.data))
        return
      }
      term.write(`\r\n${copyRef.current.exited(frame.code)}\r\n`)
      const id = idRef.current
      idRef.current = null
      setLoading(false)
      if (id !== null) exitTerminalTab(start.ownerSessionId, id)
    }

    const onFrame = (frame: TerminalFrame) => {
      if (disposed) return
      if (!xtermReady) {
        queuedFrames.push(frame)
        return
      }
      writeFrame(frame)
    }

    function flushResize(): void {
      if (disposedRef.current || resizeInFlightRef.current) return
      const id = idRef.current
      const size = pendingResizeRef.current
      if (id === null || size === null || !visibleRef.current) return
      pendingResizeRef.current = null
      resizeInFlightRef.current = true
      void terminalResize(id, size.cols, size.rows)
        .then(() => {
          sizeRef.current = size
        })
        .catch(() => {})
        .finally(() => {
          resizeInFlightRef.current = false
          if (!disposedRef.current) flushResize()
        })
    }

    function requestResize(size: { cols: number; rows: number }): void {
      if (disposedRef.current || !visibleRef.current) return
      const last = sizeRef.current
      const pending = pendingResizeRef.current
      if (last !== null && last.cols === size.cols && last.rows === size.rows && pending === null) return
      if (pending !== null && pending.cols === size.cols && pending.rows === size.rows) return
      pendingResizeRef.current = size
      flushResize()
    }
    requestResizeRef.current = requestResize

    // The panel is resizable, the window is resizable, and the window coming back from minimized
    // changes the *viewport* without necessarily changing this box: the layout breakpoint flips and
    // the column is rebuilt at the width it already had. The observer covers the box; the window's
    // own resize is the other half of the same tick. A hidden or still-zero box is retried on the
    // next tick, which is also how a tab that was created before its column finished opening gets
    // started, and how a view that refused to fit a minimized window measures again.
    let frame = 0
    const measure = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (disposed) return
        if (!visibleRef.current) {
          // A tab out of sight is `invisible`, so its box is still laid out and can be measured —
          // but the pty is not resized from here, and a shell that has not started yet is not
          // started: a conversation the reader is not looking at must not open a terminal. When it
          // becomes visible again, the `visible` effect below fits it and starts it then.
          return
        }
        if (!started) {
          maybeStart()
          return
        }
        const size = applyFit()
        if (size !== null) requestResize(size)
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    window.addEventListener('resize', measure)

    return () => {
      disposed = true
      disposedRef.current = true
      requestResizeRef.current = null
      maybeStartRef.current = null
      maybeSeedRef.current = null
      pendingResizeRef.current = null
      if (raf !== 0) cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener('resize', measure)
      if (frame !== 0) cancelAnimationFrame(frame)
      inputDisposable.dispose()
      // The pty is not closed here: it belongs to the tab, and this view can be unmounted without
      // the tab going anywhere (a layout change remounts the whole column). `closeTerminalTab` is
      // the one place that ends a shell the reader owns.
      idRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // One mount, one view. `cwd`, the owner file and the tab's mode are deliberately not
    // dependencies: they name where the shell was started and who owns it, and a shell is restarted
    // by closing its tab and opening it again, not by the reader looking elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // xterm was handed the palette's values, not its variables (`readTerminalPalette`), so a change of
  // the palette has to be pushed into the view: without this the box keeps the surface and the ink
  // it was opened with (the reader's "changed the theme, the terminals opened under the old one kept
  // their colours, a new terminal gets the new ones"). The signal is the document's own palette, not
  // `resolvedTheme`: two themes of the same mode swap tokens without changing the mode, and the
  // provider applies `.dark` in an effect React runs *after* its children's, so a panel reading the
  // tokens in its own `resolvedTheme` effect would read the palette one commit too early.
  useEffect(
    () =>
      subscribeTerminalPalette((palette) => {
        const term = termRef.current
        if (term === null) return
        term.options.theme = {
          background: palette.background,
          foreground: palette.foreground,
          cursor: palette.foreground,
        }
      }),
    [],
  )

  // A hidden tab keeps its pty and its scrollback; only the box is taken out of the layout. Coming
  // back is a refit, because the panel's width may have changed while this one was hidden — and a
  // tab that became visible before it ever started (the column was still animating open) starts
  // here.
  useEffect(() => {
    visibleRef.current = visible
    if (!visible) return
    maybeStartRef.current?.()
    const term = termRef.current
    const host = hostRef.current
    if (!fitIfMeasurable(host, term, fitRef.current) || term === null) return
    const size = { cols: term.cols, rows: term.rows }
    requestResizeRef.current?.(size)
    maybeSeedRef.current?.()
    term.focus()
  }, [visible])

  // A window that was put away — the tray, or a second launch folded into the running app — comes
  // back with what it painted while it was off screen thrown away: the shell and xterm's buffer are
  // untouched, but nothing asks the view to draw again, which is the reader's report of a terminal
  // that is black after the app is hidden and brought back. `refresh` re-reads the buffer onto the
  // current rows, and the refit covers a panel that was resized while it was away.
  useEffect(() => {
    const repaint = () => {
      if (document.visibilityState === 'hidden' || !visibleRef.current) return
      const term = termRef.current
      if (term === null) return
      // Fit first so the redraw covers the rows the panel has now, then redraw the buffer and put
      // the reader back at the prompt: a window that was off screen can come back with its viewport
      // parked at the top of the scrollback, which reads as an empty terminal just as a dropped
      // paint does.
      fitIfMeasurable(hostRef.current, term, fitRef.current)
      term.refresh(0, Math.max(0, term.rows - 1))
      term.scrollToBottom()
      maybeSeedRef.current?.()
      maybeStartRef.current?.()
      requestResizeRef.current?.({ cols: term.cols, rows: term.rows })
    }
    // The document's own focus is not enough on a hidden native window: WebView2 can bring the
    // window back without ever telling the page it lost focus, so the desktop's own window event is
    // the one that knows it is on screen again.
    let disposed = false
    let stopWindow: (() => void) | undefined
    void getCurrentWindow()
      .onFocusChanged(({ payload }) => {
        if (payload) repaint()
      })
      .then((unlisten) => {
        if (disposed) unlisten()
        else stopWindow = unlisten
      })
      .catch(() => undefined)
    window.addEventListener('focus', repaint)
    document.addEventListener('visibilitychange', repaint)
    return () => {
      disposed = true
      stopWindow?.()
      window.removeEventListener('focus', repaint)
      document.removeEventListener('visibilitychange', repaint)
    }
  }, [])

  return (
    // Every tab stacks in the same box (`absolute inset-0`); only the one with `visible=true`
    // receives pointer events and is painted. `display: none` would collapse the host to 0×0 and
    // break xterm's measurement, so a tab that was merely out of sight would lose its grid on the
    // way back (this was the "切回来终端异常" bug: a hidden panel's canvas was torn down).
    <div
      className={cn(
        'absolute inset-0 min-h-0 flex-col bg-pane',
        visible ? 'z-10 flex' : 'invisible',
        className,
      )}
      aria-hidden={!visible}
    >
      {loading && failure === null ? (
        <p className="shrink-0 border-border border-b px-3 py-1.5 text-muted-foreground text-xs">
          {mode === 'attach' ? copy.attaching : copy.opening}
        </p>
      ) : null}
      {failure === null ? null : (
        <p className="shrink-0 border-border border-b px-3 py-1.5 text-destructive text-xs">
          {copy.failed} {failure}
        </p>
      )}
      {menuNotice === null ? null : (
        <p className="shrink-0 border-border border-b px-3 py-1.5 text-destructive text-xs">
          {menuNotice}
        </p>
      )}
      <div
        ref={hostRef}
        className="omp-terminal-host min-h-0 flex-1 overflow-hidden px-2 py-1"
        // The reader's clicks belong to the terminal, not to a text selection in the shell.
        onMouseDown={() => termRef.current?.focus()}
        // The grid replaces the webview's own context menu: its entries (reload, save page,
        // inspect) belong to a browser, not to a shell. The menu is the same beUI popover and rows
        // the rail and the file tree use, anchored to the pointer.
        onContextMenu={(event) => {
          event.preventDefault()
          const term = termRef.current
          if (term === null) return
          setMenuNotice(null)
          setMenu({ x: event.clientX, y: event.clientY, selection: term.getSelection() })
        }}
      />
      {menu !== null ? (
        <MorphPopover
          key={`${menu.x}:${menu.y}`}
          open
          onOpenChange={(open) => {
            if (!open) setMenu(null)
          }}
          className="fixed size-0"
        >
          <MorphPopoverTrigger>
            <span
              className="pointer-events-none fixed size-0"
              style={{ left: menu.x, top: menu.y }}
            />
          </MorphPopoverTrigger>
          <MorphPopoverContent
            side="bottom"
            align="start"
            sideOffset={2}
            radius={12}
            className="min-w-40 max-w-72 p-1.5"
            onOpenAutoFocus={(content) => content.querySelector<HTMLElement>('button')?.focus()}
          >
            <ResourceMenuAction
              icon={Copy}
              disabled={menu.selection === ''}
              onSelect={() => {
                const selection = menu.selection
                setMenu(null)
                termRef.current?.focus()
                if (selection === '') return
                void copyText(selection).then((ok) => {
                  setMenuNotice(ok ? null : copy.copyFailed)
                })
              }}
            >
              {copy.menuCopy}
            </ResourceMenuAction>
            <ResourceMenuAction
              icon={ClipboardPaste}
              onSelect={() => {
                setMenu(null)
                void readText().then((text) => {
                  const term = termRef.current
                  if (term === null) return
                  term.focus()
                  if (text === null) {
                    setMenuNotice(copy.pasteFailed)
                    return
                  }
                  // xterm's own paste applies bracketed-paste mode and goes out through `onData`
                  // like typed input, so the shell sees a paste rather than a burst of keys.
                  if (text !== '') term.paste(text)
                })
              }}
            >
              {copy.menuPaste}
            </ResourceMenuAction>
            <div aria-hidden="true" className="my-1 h-px bg-border" />
            <ResourceMenuAction
              icon={TextCursorInput}
              onSelect={() => {
                setMenu(null)
                termRef.current?.selectAll()
                termRef.current?.focus()
              }}
            >
              {copy.menuSelectAll}
            </ResourceMenuAction>
          </MorphPopoverContent>
        </MorphPopover>
      ) : null}
    </div>
  )
}
