/**
 * File paths drawn in a transcript, answered as clicks.
 *
 * A path is inline code that `components/agents/markdown.tsx` marks with `data-omp-file`
 * (`lib/file-reference.ts` is the test that put the mark there). The click is answered here, at the
 * document, for the same reason `lib/links.ts` answers anchors there: every rendered answer, a
 * notice, a tool body and anything a later surface adds share one listener, and none of them can
 * forget to bind a handler to a span it drew.
 *
 * A modified click is left alone — the browser's own conventions own those — and the keyboard
 * reaches the same span through the role and tab stop the renderer puts on it.
 */

import { useEffect } from 'react'

import { openPrintedPath } from '@/state/file-open'

/** The path of the file span a click or key landed on, if it landed on one. */
function fileSpanOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  return target.closest('code[data-omp-file]')?.getAttribute('data-omp-file') ?? null
}

export function useDocumentFileLinks(): void {
  useEffect(() => {
    function onClick(event: MouseEvent): void {
      if (event.defaultPrevented || event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const path = fileSpanOf(event.target)
      if (path !== null) openPrintedPath(path)
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Enter' || event.altKey) return
      const path = fileSpanOf(event.target)
      if (path === null) return
      event.preventDefault()
      openPrintedPath(path)
    }

    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])
}
