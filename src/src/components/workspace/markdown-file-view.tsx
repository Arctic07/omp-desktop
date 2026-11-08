/**
 * A markdown file as the document it describes, not as its source.
 *
 * The transcript has its own renderer (`components/agents/markdown.tsx`) over the engine's
 * streaming-safe parser; a workspace file is a different input — arbitrary repository markdown with
 * GFM tables, task lists and images — so this surface uses `react-markdown` + `remark-gfm` instead
 * of growing that parser. Raw HTML is not enabled: repository content is untrusted and
 * `react-markdown` escapes it by default.
 *
 * A fence is drawn with the app's own `CodeBlock`, so a README's snippets get the same shiki
 * highlighting (and grammar table) as the conversation. The header's pencil still opens the raw
 * source in the textarea when the reader wants it.
 */

import { isValidElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { CodeBlock } from '@/components/agents/code-block'
import { resolveCodeLanguage } from '@/components/agents/code-language'
import {
  MARKDOWN_BULLET_LIST,
  MARKDOWN_HEADINGS,
  MARKDOWN_INLINE_CODE,
  MARKDOWN_LINK,
  MARKDOWN_ORDERED_LIST,
  MARKDOWN_PARAGRAPH,
  MARKDOWN_PREFORMATTED,
  MARKDOWN_QUOTE,
  MARKDOWN_ROOT,
  MARKDOWN_RULE,
  MARKDOWN_TABLE,
  MARKDOWN_TABLE_CELL,
  MARKDOWN_TABLE_FRAME,
  MARKDOWN_TABLE_HEAD_CELL,
} from '@/components/agents/markdown-tags'
import { cn } from '@/lib/utils'

function fenceLanguage(className: string | undefined): string | null {
  const match = /(?:^|\s)language-([\w+#.-]+)/.exec(className ?? '')
  return match === null ? null : match[1]
}

/** The tags are the transcript's (`components/agents/markdown-tags.ts`), so a README and an answer
 *  are drawn with one vocabulary: this surface has no styling of its own left to drift. */
const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className={MARKDOWN_HEADINGS[1].className}>{children}</h1>,
  h2: ({ children }) => <h2 className={MARKDOWN_HEADINGS[2].className}>{children}</h2>,
  h3: ({ children }) => <h3 className={MARKDOWN_HEADINGS[3].className}>{children}</h3>,
  h4: ({ children }) => <h4 className={MARKDOWN_HEADINGS[4].className}>{children}</h4>,
  h5: ({ children }) => <h5 className={MARKDOWN_HEADINGS[5].className}>{children}</h5>,
  h6: ({ children }) => <h6 className={MARKDOWN_HEADINGS[6].className}>{children}</h6>,
  p: ({ children }) => <p className={MARKDOWN_PARAGRAPH}>{children}</p>,
  ul: ({ children }) => <ul className={MARKDOWN_BULLET_LIST}>{children}</ul>,
  ol: ({ children }) => <ol className={MARKDOWN_ORDERED_LIST}>{children}</ol>,
  blockquote: ({ children }) => <blockquote className={MARKDOWN_QUOTE}>{children}</blockquote>,
  hr: () => <hr className={MARKDOWN_RULE} />,
  table: ({ children }) => (
    <div className={MARKDOWN_TABLE_FRAME}>
      <table className={MARKDOWN_TABLE}>{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th className={MARKDOWN_TABLE_HEAD_CELL} style={style}>
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className={MARKDOWN_TABLE_CELL} style={style}>
      {children}
    </td>
  ),
  a: ({ href, children, title }) => (
    // The webview never follows an anchor itself; `lib/links.ts` turns `target="_blank"` into the
    // host's own open (`components/agents/markdown.tsx` explains the same choice for the transcript).
    <a
      href={href}
      title={title ?? href}
      target="_blank"
      rel="noreferrer"
      className={MARKDOWN_LINK}
    >
      {children}
    </a>
  ),
  // A fence's own `code` is drawn by `pre` below, which owns the card around it; an inline span has
  // no language class and is the chip.
  code: ({ children, className }) =>
    className === undefined ? (
      <code className={MARKDOWN_INLINE_CODE}>{children}</code>
    ) : (
      <code className={className}>{children}</code>
    ),
  img: ({ src, alt }) => (
    <img
      src={typeof src === 'string' ? src : undefined}
      alt={alt ?? ''}
      className={cn(MARKDOWN_PARAGRAPH, 'max-w-full rounded-md')}
    />
  ),
  pre: ({ children }) => {
    const child = Array.isArray(children) ? children[0] : children
    if (isValidElement<{ className?: string; children?: ReactNode }>(child) && child.type === 'code') {
      const language = fenceLanguage(child.props.className)
      const body = String(child.props.children).replace(/\n$/, '')
      if (language !== null) {
        return (
          <div className={MARKDOWN_PARAGRAPH}>
            <CodeBlock
              code={body}
              language={resolveCodeLanguage(language) ?? 'text'}
              languageLabel={language}
              showLineNumbers={false}
              maxHeight={480}
            />
          </div>
        )
      }
      // No grammar claims this fence: its text is drawn by the box below, not by the inline chip
      // the `code` mapping would put inside it.
      return <pre className={MARKDOWN_PREFORMATTED}>{body}</pre>
    }
    return <pre className={MARKDOWN_PREFORMATTED}>{children}</pre>
  },
}

export function MarkdownFileView({ text }: { text: string }) {
  return (
    <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3', MARKDOWN_ROOT)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
