/**
 * The React renderer for the transcript parser in `home/markdown.ts`, ported from the Vue front
 * end's `SourceMarkdown.vue` and `SourceMarkdownInline.vue`: same block-to-element mapping, the same
 * inline mapping. A fence is a `CodeBlock` whatever grammar it names (see `fence-language.ts`) —
 * except a diff, which is the diff card: the same surface a tool row's file change draws, with its
 * own old/new numbers and row colours.
 *
 * Every element is styled with the app's own vocabulary — the classes `StreamingResponse` puts on
 * its content column and the tokens in `index.css` — so a rendered answer reads exactly like the
 * plain text it replaces. Nothing here is painted with a literal colour.
 *
 * There is no `COPY` record because there is no wording to translate: the renderer draws the
 * engine's own text and nothing of its own.
 */

import { useMemo } from "react";

import { CodeBlock } from "@/components/agents/code-block";
import { parseUnifiedDiff, unifiedDiffFile } from "@/components/agents/diff-lines";
import { FileDiff } from "@/components/agents/file-diff";
import { resolveFenceLanguage } from "@/components/agents/fence-language";
import {
  MARKDOWN_BULLET_LIST,
  MARKDOWN_FILE_CODE,
  MARKDOWN_HEADINGS,
  MARKDOWN_INLINE_CODE,
  MARKDOWN_LINK,
  MARKDOWN_NESTED,
  MARKDOWN_ORDERED_LIST,
  MARKDOWN_PARAGRAPH,
  MARKDOWN_QUOTE,
  MARKDOWN_ROOT,
  MARKDOWN_RULE,
  MARKDOWN_TABLE,
  MARKDOWN_TABLE_CELL,
  MARKDOWN_TABLE_FRAME,
  MARKDOWN_TABLE_HEAD_CELL,
  markdownListCardOutdent,
} from "@/components/agents/markdown-tags";
import {
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownInline as MarkdownInlineNode,
} from "@/home/markdown";
import { filePathInText } from "@/lib/file-reference";
import { cn } from "@/lib/utils";

export function Markdown({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  // The parse, memoised on the text.
  //
  // A delta of a streaming answer is a new string and therefore a new parse — there is no way
  // around that — but every row already in the transcript keeps its own memo, so the deltas of the
  // row being written never re-parse the history above it. `retain` says whether the tree may be
  // kept for the next caller and never what the tree is, so a streaming tail is parsed but not
  // stored, and a settled row keeps the module cache in `home/markdown.ts` for its remounts. The
  // flag is a dependency only because it decides that retention; the tree is the same either way.
  const blocks = useMemo(
    () => parseMarkdown(text, { retain: !streaming }),
    [text, streaming],
  );

  return (
    <div className={cn(MARKDOWN_ROOT, className)}>
      <Blocks blocks={blocks} streaming={streaming} />
    </div>
  );
}

/** One run of inline nodes. Exported because a caller that has already parsed a line — a row's
 *  summary, say — has the nodes but not the source they came from. */
export function MarkdownInline({ nodes }: { nodes: readonly MarkdownInlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => (
        <Inline key={index} node={node} />
      ))}
    </>
  );
}

function Inline({ node }: { node: MarkdownInlineNode }) {
  switch (node.kind) {
    case "text":
      return <>{node.text}</>;
    case "strong":
      return (
        <strong className="font-semibold">
          <MarkdownInline nodes={node.children} />
        </strong>
      );
    case "emphasis":
      return (
        <em className="italic">
          <MarkdownInline nodes={node.children} />
        </em>
      );
    case "delete":
      return (
        <del className="line-through">
          <MarkdownInline nodes={node.children} />
        </del>
      );
    case "code": {
      const path = filePathInText(node.text);
      if (path === null)
        return <code className={MARKDOWN_INLINE_CODE}>{node.text}</code>;
      return (
        <code
          className={MARKDOWN_FILE_CODE}
          data-omp-file={path}
          role="link"
          tabIndex={0}
        >
          {node.text}
        </code>
      );
    }
    // The label and the destination.
    //
    // The anchor is drawn but never followed by this webview: `target="_blank"` is the click that
    // goes nowhere on its own (WebView2 asks the application for a window, and the application
    // refuses every one it owns), and `lib/links.ts` is the document-level listener that turns it
    // into the host's own open. So the href is here for the reader's pointer, their copy and their
    // right-click, and the navigation is prevented where the click lands.
    case "link":
      return (
        <a
          href={node.href}
          target="_blank"
          rel="noreferrer"
          title={node.href}
          className={MARKDOWN_LINK}
        >
          <MarkdownInline nodes={node.children} />
        </a>
      );
  }
}

function Blocks({
  blocks,
  streaming,
  listDepth = 0,
}: {
  blocks: readonly MarkdownBlock[];
  streaming: boolean;
  /** How many list items this run of blocks sits inside; `0` at the top of the answer. */
  listDepth?: number;
}) {
  return (
    <>
      {blocks.map((block, index) => (
        <Block
          key={index}
          block={block}
          listDepth={listDepth}
          // Only the last block of a growing answer is still being written: a fence followed by a
          // paragraph has stopped receiving text, and a code block that keeps saying "writing" is a
          // status that never lands. The flag walks down the block the same way — the list's last
          // item, then its last block.
          streaming={streaming && index === blocks.length - 1}
        />
      ))}
    </>
  );
}

function Block({
  block,
  streaming,
  listDepth,
}: {
  block: MarkdownBlock;
  streaming: boolean;
  listDepth: number;
}) {
  // A card is a box of the whole column, so it cancels the bullet gutters it sits in; text does not.
  const cardOutdent = listDepth > 0 ? markdownListCardOutdent(listDepth) : "";
  switch (block.kind) {
    case "paragraph":
      return (
        <p className={MARKDOWN_PARAGRAPH}>
          <MarkdownInline nodes={block.children} />
        </p>
      );
    case "heading": {
      const { tag: Heading, className } = MARKDOWN_HEADINGS[block.depth];
      return (
        <Heading className={className}>
          <MarkdownInline nodes={block.children} />
        </Heading>
      );
    }
    case "code": {
      const { language, label } = resolveFenceLanguage(block.language);
      // A diff is not code to read line by line, it is a change to read as a change: the diff card
      // says which lines went, which arrived, and from which side of the file, and a code block
      // says the same rows in one colour with a `-` a reader has to parse themselves.
      if (language === "diff") {
        return (
          <FileDiff
            file={unifiedDiffFile(block.text) ?? label}
            lines={parseUnifiedDiff(block.text)}
            status={streaming ? "streaming" : "complete"}
            // A fence in an answer is text the reader is reading, not a step's collapsed summary:
            // it stays open after the row settles.
            defaultOpen
            collapseOnComplete={false}
            copyText={block.text}
            className={cn("mt-3", cardOutdent)}
          />
        );
      }
      return (
        <CodeBlock
          code={block.text}
          language={language}
          languageLabel={label}
          status={streaming ? "streaming" : "complete"}
          className={cn("mt-3", cardOutdent)}
        />
      );
    }
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <div className={MARKDOWN_NESTED}>
            <Blocks
              blocks={item}
              listDepth={listDepth + 1}
              streaming={streaming && index === block.items.length - 1}
            />
          </div>
        </li>
      ));
      // `start` is dropped when the list starts at 1, so the common case carries no attribute.
      return block.ordered ? (
        <ol
          className={MARKDOWN_ORDERED_LIST}
          start={block.start === 1 ? undefined : block.start}
        >
          {items}
        </ol>
      ) : (
        <ul className={MARKDOWN_BULLET_LIST}>{items}</ul>
      );
    }
    case "quote":
      return (
        <blockquote className={MARKDOWN_QUOTE}>
          <div className={MARKDOWN_NESTED}>
            {/* A quote is a box with a rule of its own, and its blocks stay inside that rule: a
                card does not outdent past the border it was quoted behind. */}
            <Blocks blocks={block.blocks} streaming={streaming} />
          </div>
        </blockquote>
      );
    case "table":
      return (
        <div className={cn(MARKDOWN_TABLE_FRAME, cardOutdent)}>
          <table className={MARKDOWN_TABLE}>
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th
                    key={index}
                    style={{ textAlign: block.align[index] }}
                    className={MARKDOWN_TABLE_HEAD_CELL}
                  >
                    <MarkdownInline nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      style={{ textAlign: block.align[cellIndex] }}
                      className={MARKDOWN_TABLE_CELL}
                    >
                      <MarkdownInline nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr className={MARKDOWN_RULE} />;
  }
}
