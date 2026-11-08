/**
 * The file editor: one text file in a plain textarea.
 *
 * A textarea rather than the preview's highlighted rows, because a highlighted line is a rendering
 * of the file and the reader has to be able to put the caret in it. It deliberately does not
 * virtualise: the draft is the whole text either way, and a textarea is the platform's own editor
 * (undo, selection, input methods, spellcheck off).
 *
 * The draft arrives line-feed normalised (`state/file-panel-store.ts`), so the field never sees
 * the file's own line ending; the save puts it back.
 */

import { useLayoutEffect, useRef, type KeyboardEvent } from 'react'

import { lineOfOffset } from '@/lib/file-find'

export interface TextFileEditorProps {
  /** The workspace-relative path, for the field's accessible name. */
  path: string
  text: string
  onChange: (text: string) => void
  /**
   * A match the find bar jumped to: its text is selected and the field is scrolled to it.
   *
   * `token` is what makes two jumps to the same offset two events; the field only ever reads the
   * selection it is given, and the file's own text is read through a ref so typing after a jump
   * does not put the caret back.
   */
  reveal?: { start: number; end: number; token: number } | null
}

export function TextFileEditor({ path, text, onChange, reveal = null }: TextFileEditorProps) {
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const caretRef = useRef<{ start: number; end: number } | null>(null)
  const textRef = useRef(text)
  // The reveal effect reads the text through a ref so that typing after a jump does not re-run
  // it; this keeps the ref true without touching it during render.
  useLayoutEffect(() => {
    textRef.current = text
  }, [text])

  // Tab indents instead of leaving the field. The caret it should land on is applied after React
  // has written the new value, because the controlled value resets the selection.
  useLayoutEffect(() => {
    const caret = caretRef.current
    const field = fieldRef.current
    if (caret === null || field === null) return
    caretRef.current = null
    field.setSelectionRange(caret.start, caret.end)
  }, [text])

  // A find jump: the matched text is what the reader asked to see, and an unfocused textarea draws
  // no selection at all — so the field takes the caret, and the scroll is computed from the line
  // the match starts on rather than from the caret, which browsers only follow on their own moves.
  useLayoutEffect(() => {
    const field = fieldRef.current
    if (field === null || reveal === null) return
    const source = textRef.current
    const start = Math.min(Math.max(reveal.start, 0), source.length)
    const end = Math.min(Math.max(reveal.end, start), source.length)
    field.focus()
    field.setSelectionRange(start, end)
    const lineHeight = Number.parseFloat(window.getComputedStyle(field).lineHeight)
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return
    field.scrollTop = Math.max(
      0,
      lineOfOffset(source, start) * lineHeight - field.clientHeight / 2,
    )
  }, [reveal])

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== 'Tab' ||
      event.shiftKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    ) {
      return
    }
    event.preventDefault()
    const start = event.currentTarget.selectionStart
    const end = event.currentTarget.selectionEnd
    const indent = '  '
    onChange(`${text.slice(0, start)}${indent}${text.slice(end)}`)
    caretRef.current = { start: start + indent.length, end: start + indent.length }
  }

  return (
    <textarea
      ref={fieldRef}
      value={text}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={handleKeyDown}
      aria-label={path}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      wrap="soft"
      className="min-h-0 w-full flex-1 resize-none overflow-auto bg-transparent px-3 py-2 font-mono text-xs leading-5 text-foreground outline-none"
      style={{ tabSize: 2 }}
    />
  )
}
