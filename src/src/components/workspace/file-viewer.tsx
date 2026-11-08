/**
 * The file preview: one file, in whatever shape the desktop read it.
 *
 * A text file is drawn one line per row in a measured virtual list (`@tanstack/react-virtual`), so
 * a 512 KiB file costs the same DOM as a 200-line one. The lines wrap rather than scroll sideways,
 * which is what makes a narrow panel readable; the reader's place is the scroll container's own.
 *
 * Highlighting is bounded twice: the source must be under `FILE_HIGHLIGHT_MAX_CHARS` and the
 * grammar is loaded on demand by the highlighting worker (`code-highlight.worker.ts`); tokenizing
 * runs off the UI thread. Past the bound the text is still drawn whole, just uncoloured — a file is
 * never truncated by the preview.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Check,
  CircleAlert,
  Copy,
  Eye,
  FileText,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Save,
} from 'lucide-react'

import {
  AgentCodeLine,
  useAgentCodeTokens,
} from '@/components/agents/agent-code'
import { Button } from '@/components/motion/button'
import { FileFindBar } from '@/components/workspace/file-find-bar'
import { TextFileEditor } from '@/components/workspace/file-editor'
import { ImageViewer } from '@/components/workspace/image-viewer'
import { MarkdownFileView } from '@/components/workspace/markdown-file-view'
import { FILE_PANEL_COPY } from '@/components/workspace/file-panel-copy'
import { describeFile } from '@/components/workspace/file-language'
import { formatBytes } from '@/lib/bytes'
import { findLineSpans, findTextMatches, type FileFindSpan } from '@/lib/file-find'
import { fileLeafName, fileParentPath } from '@/lib/file-path'
import { useCopy } from '@/lib/i18n'
import type { FileContentState, FileSaveState } from '@/state/file-panel-store'

/**
 * The longest text this viewer will ask shiki to tokenize.
 *
 * The conversation's code blocks stop at 24 KiB because a tool row is highlighted twice and its
 * result changes every frame. A file preview is one stable read and one row per line, so it can
 * afford more — but still not the desktop's full 512 KiB read: the token tree is several times the
 * source, and the reader of a 300 KiB generated file wants the text, not a colour pass.
 */
const FILE_HIGHLIGHT_MAX_CHARS = 96 * 1024

export interface FileViewerProps {
  content: FileContentState
  /** The last save attempt, drawn in the header and as a failure line. */
  save: FileSaveState
  /** The draft differs from what the file holds. */
  dirty: boolean
  /** The tab is on screen: the Ctrl+S binding belongs to the surface it would save. */
  active: boolean
  /** Editing is absent for a read-only file (one read from outside every workspace root). */
  onDraftChange?: (text: string) => void
  onToggleEditing?: () => void
  onSave?: () => void
  onRetry: () => void
  /** Shown only for a file outside every workspace root. */
  onReveal?: () => void
  /** Opens a path that turned out to be a folder; absent where the surface shows it another way. */
  onOpenFolder?: () => void
  revealFailed?: boolean
}

export function FileViewer({
  content,
  save,
  dirty,
  active,
  onDraftChange,
  onToggleEditing,
  onSave,
  onRetry,
  onReveal,
  onOpenFolder,
  revealFailed = false,
}: FileViewerProps) {
  const copy = useCopy(FILE_PANEL_COPY)
  const path = content.path
  const read = content.read
  const editable = content.draft !== null && onSave !== undefined
  const folder = read?.kind === 'directory'

  // Ctrl+S saves the open text file wherever the focus is inside the panel — the preview toggle and
  // the header's own save button are the same call. The listener lives on the window so the reader
  // does not have to click into the field first, and only while this tab is the one on screen.
  const saveRef = useRef(onSave)
  useEffect(() => {
    saveRef.current = onSave
  }, [onSave])
  useEffect(() => {
    if (!active || !editable) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 's') return
      // The webview's own "save this page" is not what Ctrl+S means in a file.
      event.preventDefault()
      saveRef.current?.()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [active, editable])

  // The find bar: `Ctrl+F` over the open text, and `Escape` to leave it. The key is answered here
  // and nowhere else — the webview's own find dialog was switched off for the application window
  // (`services::webview_keys`), so this bar is the only find the app has, and it only exists over a
  // file's text. What the query matched is kept as offsets so both modes can act on the same
  // answer: the preview marks the lines, the editor selects the text.
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(0)
  const [findFocus, setFindFocus] = useState(0)
  // The match the last step landed on, as the editor needs it. Held apart from the query's own
  // answer on purpose: it is written when the reader steps, not when the query or the text changes,
  // so a keystroke in the bar (or in the file) never drags the caret back to an earlier match.
  const [findReveal, setFindReveal] = useState<{
    start: number
    end: number
    token: number
  } | null>(null)
  const searchable = read?.kind === 'text' ? (content.draft ?? read.content ?? '') : null
  const search = findOpen ? findQuery : ''
  const found = useMemo(() => findTextMatches(searchable ?? '', search), [search, searchable])
  const current =
    found.matches.length === 0 ? -1 : Math.min(findIndex, found.matches.length - 1)
  const currentMatch = current < 0 ? null : found.matches[current]

  useEffect(() => {
    if (!active) return
    const handleKeyDown = (event: KeyboardEvent) => {
      const modified = event.ctrlKey || event.metaKey
      if (modified && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        // Prevented even when there is nothing to search: the key means this bar or nothing, never
        // a find over the application's own interface.
        event.preventDefault()
        if (searchable === null) return
        setFindOpen(true)
        setFindFocus((signal) => signal + 1)
        return
      }
      if (findOpen && event.key === 'Escape') setFindOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [active, findOpen, searchable])

  const stepMatch = (step: 1 | -1) => {
    const total = found.matches.length
    if (total === 0) return
    const next = (Math.min(Math.max(findIndex, 0), total - 1) + step + total) % total
    const match = found.matches[next]
    setFindIndex(next)
    if (match === undefined) return
    setFindReveal((previous) => ({
      start: match.start,
      end: match.end,
      token: (previous?.token ?? 0) + 1,
    }))
  }

  if (path === null) {
    return (
      <ViewerNotice
        icon={<FileText aria-hidden="true" className="size-7" />}
        title={copy.previewEmpty}
        description={copy.previewEmptyHint}
      />
    )
  }

  const display = describeFile(path)
  const name = fileLeafName(path)
  const parent = fileParentPath(path)
  // A folder has no language: it names itself, so the header says what the path is.
  const subtitle = folder ? copy.folderLabel : display.languageLabel

  return (
    <section aria-label={name} className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-border border-b px-2.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs font-medium">{name}</span>
          <span className="truncate font-mono text-[10px] leading-3 text-muted-foreground">
            {parent === null ? subtitle : `${parent} · ${subtitle}`}
          </span>
        </div>
        {content.phase === 'loading' ? (
          <LoaderCircle
            aria-label={copy.refreshing}
            className="size-3.5 shrink-0 animate-spin text-muted-foreground"
          />
        ) : null}
        {read !== null && !folder ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {formatBytes(read.size)}
          </span>
        ) : null}
        {dirty ? (
          <span
            role="status"
            aria-label={copy.unsaved}
            title={copy.unsaved}
            className="size-1.5 shrink-0 rounded-full bg-amber-500"
          />
        ) : save.phase === 'saved' ? (
          <Check aria-label={copy.saved} className="size-3.5 shrink-0 text-emerald-500" />
        ) : null}
        {editable ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={
                save.phase === 'saving' ? copy.saving : dirty ? copy.save : copy.saved
              }
              title={
                save.phase === 'saving' ? copy.saving : dirty ? copy.saveHint : copy.saved
              }
              onClick={onSave}
              disabled={!dirty || save.phase === 'saving'}
              className="size-7 shrink-0 rounded-md"
            >
              {save.phase === 'saving' ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={content.editing ? copy.preview : copy.edit}
              title={content.editing ? copy.preview : copy.edit}
              onClick={onToggleEditing}
              className="size-7 shrink-0 rounded-md"
            >
              {content.editing ? (
                <Eye className="size-3.5" />
              ) : (
                <Pencil className="size-3.5" />
              )}
            </Button>
          </>
        ) : null}
        {read?.kind === 'text' && !content.editing ? (
          <CopyButton text={content.draft ?? read.content ?? ''} />
        ) : null}
        {onReveal !== undefined && !folder ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={copy.reveal}
            title={copy.reveal}
            onClick={onReveal}
            className="size-7 shrink-0 rounded-md"
          >
            <FolderOpen className="size-3.5" />
          </Button>
        ) : null}
      </header>

      {findOpen && searchable !== null ? (
        <FileFindBar
          query={findQuery}
          onQueryChange={(value) => {
            setFindQuery(value)
            setFindIndex(0)
          }}
          current={current}
          total={found.matches.length}
          truncated={found.truncated}
          focusSignal={findFocus}
          onStep={stepMatch}
          onClose={() => setFindOpen(false)}
        />
      ) : null}

      {revealFailed ? (
        <p
          role="alert"
          className="mx-2 mt-1 rounded-md border border-destructive/40 px-2 py-1 text-[11px] text-destructive"
        >
          {folder ? copy.openFolderFailed : copy.revealFailed}
        </p>
      ) : null}

      {content.error !== null && read !== null ? (
        <p
          role="alert"
          className="mx-2 mt-1 flex items-center gap-1.5 rounded-md border border-destructive/40 px-2 py-1 text-[11px] text-destructive"
        >
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={content.error}>
            {copy.fileFailed}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 font-medium underline-offset-2 hover:underline"
          >
            {copy.retry}
          </button>
        </p>
      ) : null}

      {save.phase === 'error' && save.error !== null ? (
        <p
          role="alert"
          className="mx-2 mt-1 flex items-center gap-1.5 rounded-md border border-destructive/40 px-2 py-1 text-[11px] text-destructive"
        >
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={save.error}>
            {copy.saveFailed}
          </span>
          <button
            type="button"
            onClick={onSave}
            className="shrink-0 font-medium underline-offset-2 hover:underline"
          >
            {copy.retry}
          </button>
        </p>
      ) : null}

      {read === null ? (
        content.phase === 'error' ? (
          <ViewerNotice
            icon={<CircleAlert aria-hidden="true" className="size-7 text-destructive" />}
            title={copy.fileFailed}
            description={content.error}
            action={
              <Button variant="outline" size="sm" onClick={onRetry}>
                {copy.retry}
              </Button>
            }
          />
        ) : (
          <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            <span role="status">{copy.loading}</span>
          </div>
        )
      ) : read.kind === 'image' && read.dataUrl !== undefined ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="grid min-h-full place-items-center rounded-lg border border-border/60 bg-muted/20 p-3">
            <ImageViewer
              src={read.dataUrl}
              alt={copy.imageAlt(name)}
              label={name}
            />
          </div>
        </div>
      ) : read.kind === 'text' ? (
        content.editing && content.draft !== null && onDraftChange !== undefined ? (
          <TextFileEditor
            path={path}
            text={content.draft}
            onChange={onDraftChange}
            reveal={findReveal}
          />
        ) : display.language === 'markdown' && search === '' ? (
          <MarkdownFileView text={content.draft ?? read.content ?? ''} />
        ) : (
          // A query is read off the file's own lines. Rendered markdown has no line map to point
          // an arrow at, so a search over it shows the source — which is what the match's offset
          // is written against.
          <TextFileView
            path={path}
            code={content.draft ?? read.content ?? ''}
            language={display.language}
            find={
              search === ''
                ? null
                : {
                    query: search,
                    activeLine: currentMatch?.line ?? -1,
                    activeColumn: currentMatch?.column ?? -1,
                  }
            }
          />
        )
      ) : read.kind === 'tooLarge' ? (
        <ViewerNotice
          icon={<FileText aria-hidden="true" className="size-7" />}
          title={copy.tooLarge}
          description={formatBytes(read.size)}
        />
      ) : read.kind === 'binary' ? (
        <ViewerNotice
          icon={<FileText aria-hidden="true" className="size-7" />}
          title={copy.binary}
          description={formatBytes(read.size)}
        />
      ) : read.kind === 'directory' ? (
        <ViewerNotice
          icon={<FolderOpen aria-hidden="true" className="size-7" />}
          title={copy.folder}
          description={copy.folderHint}
          action={
            onOpenFolder === undefined ? undefined : (
              <Button variant="outline" size="sm" onClick={onOpenFolder}>
                {copy.openFolder}
              </Button>
            )
          }
        />
      ) : (
        <ViewerNotice
          icon={<FileText aria-hidden="true" className="size-7" />}
          title={copy.fileFailed}
          description={content.error}
          action={
            <Button variant="outline" size="sm" onClick={onRetry}>
              {copy.retry}
            </Button>
          }
        />
      )}
    </section>
  )
}

function TextFileView({
  path,
  code,
  language,
  find = null,
}: {
  path: string
  code: string
  language: ReturnType<typeof describeFile>['language']
  /** The query and the match on screen; a mark on every occurrence, a band on the match's line. */
  find?: { query: string; activeLine: number; activeColumn: number } | null
}) {
  const copy = useCopy(FILE_PANEL_COPY)
  const scrollRef = useRef<HTMLDivElement>(null)
  const tokens = useAgentCodeTokens(code, language, FILE_HIGHLIGHT_MAX_CHARS)
  const query = find?.query ?? ''
  const activeLine = find?.activeLine ?? -1
  const activeColumn = find?.activeColumn ?? -1
  const lines = useMemo(() => {
    const split = code.split('\n')
    return split.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  }, [code])

  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => index,
    estimateSize: () => 20,
    overscan: 20,
    initialRect: { width: 480, height: 720 },
    useAnimationFrameWithResizeObserver: true,
  })

  // A quiet refresh can replace the text under a reader who has scrolled; measurements from the
  // old text must not decide where the new rows land. The scroll offset itself is left alone.
  useLayoutEffect(() => {
    virtualizer.measure()
  }, [code, virtualizer])

  // A find step moves the view to the match; the row heights are measured, so the virtualizer is
  // the one that knows where that line starts.
  useLayoutEffect(() => {
    if (activeLine < 0 || activeLine >= lines.length) return
    virtualizer.scrollToIndex(activeLine, { align: 'center' })
  }, [activeColumn, activeLine, lines.length, query, virtualizer])

  if (code.length === 0) {
    return (
      <ViewerNotice
        icon={<FileText aria-hidden="true" className="size-7" />}
        title={copy.emptyFile}
      />
    )
  }

  return (
    <div
      ref={scrollRef}
      role="region"
      aria-label={path}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain font-mono text-xs leading-5"
      style={{ tabSize: 2 }}
    >
      <div
        className="relative min-w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const index = virtualRow.index
          const line = lines[index] ?? ''
          // Only the rows that are on screen are scanned for marks: a query can match on a day's
          // worth of lines, and the reader can only see twenty of them.
          const spans = query === '' ? null : findLineSpans(line, query)
          const marked = spans !== null && spans.length > 0
          return (
            <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={index}
              className={`absolute inset-x-0 top-0 flex items-start ${
                index === activeLine
                  ? 'bg-amber-400/15'
                  : marked
                    ? 'bg-amber-400/5'
                    : ''
              }`}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <span
                aria-hidden="true"
                className="w-11 shrink-0 pr-2 text-right tabular-nums text-muted-foreground/35 select-none"
              >
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 pr-3 whitespace-pre-wrap break-words">
                {line.length === 0 ? (
                  '\u200b'
                ) : marked ? (
                  // The match is what the reader is looking for, so the row is drawn as its text
                  // with the marks in it rather than as coloured tokens: a highlighted span inside
                  // a token tree would have to be cut out of it, and the find answer would then
                  // disagree with the offsets the editor selects.
                  <MarkedLine
                    line={line}
                    spans={spans}
                    activeColumn={index === activeLine ? activeColumn : -1}
                  />
                ) : (
                  <AgentCodeLine code={line} tokens={tokens?.[index]} />
                )}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** One line of text with the query's occurrences marked, the one on screen the strongest. */
function MarkedLine({
  line,
  spans,
  activeColumn,
}: {
  line: string
  spans: FileFindSpan[]
  /** Start of the match on screen in this line, or -1 when the match is on another line. */
  activeColumn: number
}) {
  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) parts.push(line.slice(cursor, span.start))
    parts.push(
      <mark
        key={`${span.start}-${span.end}`}
        className={
          span.start === activeColumn
            ? 'rounded-sm bg-amber-400/70 text-foreground'
            : 'rounded-sm bg-amber-400/30 text-foreground'
        }
      >
        {line.slice(span.start, span.end)}
      </mark>,
    )
    cursor = span.end
  }
  if (cursor < line.length) parts.push(line.slice(cursor))
  return <>{parts}</>
}

function CopyButton({ text }: { text: string }) {
  const copy = useCopy(FILE_PANEL_COPY)
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    },
    [],
  )

  const handleCopy = () => {
    void navigator.clipboard?.writeText(text).catch(() => undefined)
    setCopied(true)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setCopied(false)
    }, 1600)
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={copied ? copy.copied : copy.copy}
      title={copied ? copy.copied : copy.copy}
      onClick={handleCopy}
      className="size-7 shrink-0 rounded-md"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  )
}

function ViewerNotice({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode
  title: string
  description?: string | null
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center text-muted-foreground">
      {icon}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? (
        <p className="max-w-full text-xs leading-5 break-words">{description}</p>
      ) : null}
      {action}
    </div>
  )
}
