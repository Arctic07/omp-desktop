/**
 * What a row is worth in pixels before the window has measured it.
 *
 * The window places a row it has not measured from this number, and corrects it the moment the row
 * is drawn — so the number decides how far the transcript has to move to correct itself, and that
 * movement is what the reader feels as the view fighting their scroll. The flat estimate this
 * started with (48 px) was a third of the smallest row a real conversation has and an eighth of a
 * picture's, so scrolling into unmeasured space was a screenful of layout corrections (2026-11-05,
 * user report: 滚动这个对话会回弹，想上滚动他总会反方向弹一下).
 *
 * A row's height here is its words, so the estimate is the lines those words take at the width they
 * are drawn in, plus what the row costs besides them. The type scale is the transcript's own
 * (`markdown-tags.ts`: the reader's content size — 14 px by default — on a fixed 24 px line) and the
 * chrome is what each shape draws around its words. Markdown's own blocks are read off the line
 * prefixes: a fence is a card with 20 px lines, a heading is its own line at its own size, a list
 * item takes 4 px between items, a table row is a padded row, and a blank line is the gap between
 * blocks rather than a line of its own.
 *
 * Measured against the real rows in a throwaway harness (removed:src/.tmp-estimate-probe.html,
 * removed:src/src/.tmp-estimate-probe.tsx): 18 rows covering the reader's own message, prose,
 * fences, prose around a fence, a list, headings, a table, a quote, a folded run of calls, a `task`
 * roster of one and six children and a `web_search` card of one and three pages were every one of
 * them within 1 px of what the row drew (mean absolute error 0.06 px). The flat estimate this
 * replaced was 40–110 px out on the same shapes.
 */

import type { ChatImage, ChatMessage } from '../api/session-types.ts'
import type { TranscriptRow, TurnTail } from './conversation-rows.ts'
import { imageBox } from './image-box.ts'

/** One line of the transcript's body text: a fixed 24 px (`leading-6`) whatever the reader's size. */
const LINE_PX = 24
/** The advance of one glyph at that size, measured off the drawn rows (`MiSans VF`, 14 px body). */
const LATIN_PX = 8.2
const CJK_PX = 14.3
/** What the row draws besides its words: the bubble and its controls, the speaker line, the call's own line. */
const USER_CHROME_PX = 71
/** One attachment chip, drawn beside the reader's own words: its width joins the paragraph's. */
const CHIP_WIDTH_PX = 84
/** The sender line's own height; its gap to the next part is the parts' own gap. */
const ANSWER_HEADER_PX = 11
/**
 * What an answer's parts cost besides their text, and the gap between two adjacent parts
 * (`AssistantRow`'s `MessageContent className="gap-3"`): the reasoning's closed fold, the turn's
 * footer, a stray-call card. A row drawn from several parts is the parts plus one gap between each
 * neighbouring pair — a fact the first estimate missed, which put 12 px on every answer that had
 * reasoning beside its prose and another 12 on every answer with pictures.
 */
const THINKING_CHROME_PX = 28
const TAIL_PX = 28
const STRAY_PX = 36
/** The line a turn's ending states (`TurnEndingNote`), drawn under the row the turn ended on. */
const ENDING_PX = 17
const ANSWER_PART_GAP_PX = 12
const CALL_CHROME_PX = 36
/** The sender line over a *run* of calls: its own header already carries a row of its own, so the
 *  line lands 19 px on it against 23 px on a lone call's card. */
const RUN_SENDER_PX = 19
/** The pictures a call draws sit outside its fold, in a box with its own `pt-1 pb-1.5`. */
const CALL_IMAGES_PADDING_PX = 10
const RUN_CHROME_PX = 32
/**
 * The reader's own bubble (`MessageBubbleContent`'s `solid` variant): `max-w-[82%]` inside the lane
 * and `px-3.5` either side, so the words wrap at a narrower column than an answer's.
 */
const USER_LANE_SHARE = 0.82
const USER_BUBBLE_PADDING_PX = 28
const NOTE_CHROME_PX = 26
/*
 * The reasoning a settled row shows: a `思考` button (`AssistantRow`'s `ThinkingRow`, `h-7`) over a
 * fold that is closed by default (`THINKING_CHROME_PX`).
 *
 * The reasoning is counted as its *lines* only while it is the live output (`thinkingLive`): a
 * settled row draws a collapsed disclosure whatever the reasoning's length, so counting the text
 * overestimates every answer the engine thought about. Measured against the picture-heavy
 * conversation, whose reasoning runs 910 characters at the median and 23 084 at the longest
 * (2026-11-05): the unfolded reading put ~800 px on a median answer and ~19 000 px on the longest —
 * a total thousands of pixels above what the rows take, corrected row by row under the reader's
 * scroll, which is the second half of the report 「我向上滚动她就会向下抖动」.
 */
/** A picture's box stops at the viewer's own ceiling (`ConversationImages`' `max-h-[26rem]`). */
const IMAGE_CEILING_PX = 416
/**
 * A fenced code block (`code-block.tsx`): 40 px above its lines (the card's header, its rule and its
 * body padding, measured as one number) and 20 px lines (`text-xs leading-5`).
 *
 * The fence is the one block whose type scale is not the body's, and an answer about code is mostly
 * fences: counting a fence's lines at the body's 24 px put ~20 % on every block, which is the row's
 * own correction under the reader's scroll.
 */
const CODE_CHROME_PX = 40
const CODE_LINE_PX = 20
/** The gap between two blocks (`mt-3`), and between two list items (`space-y-1`). */
const BLOCK_GAP_PX = 12
const LIST_ITEM_GAP_PX = 4
/** The gap above a heading (`mt-5` down to `mt-3`) and the line it draws, by depth 1–6. */
const HEADING_GAP_PX = [20, 20, 16, 16, 12, 12]
const HEADING_LINE_PX = [28, 24, 20, 20, 20, 20]
/** A table row: `py-2` cells at the body's line, inside a bordered frame (whose two rules the first
 *  row carries). */
const TABLE_ROW_PX = 40
const TABLE_FRAME_PX = 4
/** A rule (`mt-4 border-t`). */
const RULE_PX = 1
const RULE_GAP_PX = 16
/** One roster row of a `task` call (`TaskAgents`: `min-h-7` rows under a `size-7` header). */
const ROSTER_HEADER_PX = 65
const ROSTER_ROW_PX = 27
/** A search card's own head and one line per page, before its scroll box's ceiling. */
const SEARCH_HEAD_PX = 117
const SEARCH_RESULT_PX = 43
const SEARCH_CEILING_PX = 320
/** The lines a reader's own message is drawn in before it is collapsed (`ConversationPane`). */
const COLLAPSED_LINES = 5
/** The narrowest lane worth dividing by: below this every paragraph is one line. */
const MIN_LANE_PX = 40

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u3000-\u303f]/

/** The kind of block the answer scan has just emitted, for the gap the next one takes. */
type BlockKind = 'none' | 'para' | 'list' | 'table'

/**
 * The lines plain text takes at `lane`: every source line is at least one line, and wraps past the
 * lane. Used where the text is not Markdown — the reader's own bubble and a row's reasoning — so a
 * hard-wrapped line counts as a line, which is how those two draw it.
 */
function linesOf(text: string, lane: number): number {
  const usable = Math.max(MIN_LANE_PX, lane)
  let lines = 0
  for (const paragraph of text.split('\n')) {
    lines += Math.max(1, Math.ceil(lineWidth(paragraph) / usable))
  }
  return lines
}

/** A picture's box when its own header cannot say: a screenshot's shape, drawn inside the lane. */
const IMAGE_FALLBACK_ASPECT = 0.58
/** One cell of a grid of pictures (`ConversationImages`): two to a row, each `aspect-[4/3]`, with
 *  `gap-2` between the cells. */
const GRID_COLUMNS = 2
const GRID_CELL_ASPECT = 0.75
const GRID_GAP_PX = 8

/**
 * What the pictures on a row take, in the lane they are drawn in.
 *
 * One picture is drawn at its own shape, bounded by the viewer's ceiling; a grid of them is two to a
 * row, each cell its own fixed aspect, so only the number of rows matters.
 *
 * A single picture's box is `w-fit` inside the lane (`ConversationImages`): a picture narrower than
 * the lane is drawn at its own width, not stretched to the lane, so the width the estimate divides
 * by is `min(lane, picture width)`. Using the lane for a small picture overestimates its box by the
 * difference — a 400 px screenshot in a 434 px lane is 34 px narrower than the estimate assumes, and
 * the row is corrected under the reader's scroll.
 */
function picturesHeight(images: readonly ChatImage[], lane: number): number {
  if (images.length === 0) return 0
  const usable = Math.max(MIN_LANE_PX, lane)
  if (images.length > 1) {
    const rows = Math.ceil(images.length / GRID_COLUMNS)
    const cell = (usable - GRID_GAP_PX) / GRID_COLUMNS
    return rows * cell * GRID_CELL_ASPECT + (rows - 1) * GRID_GAP_PX
  }
  const box = imageBox(images[0]!)
  if (box === null || box.width === 0) return Math.min(IMAGE_CEILING_PX, usable * IMAGE_FALLBACK_ASPECT)
  const drawn = Math.min(usable, box.width)
  return Math.min(IMAGE_CEILING_PX, drawn * (box.height / box.width))
}

/** A fence marker at the start of a line: the only block whose type scale is not the body's. */
const FENCE_LINE = /^\s{0,3}(?:`{3,}|~{3,})/
const HEADING_LINE = /^\s{0,3}(#{1,6})\s/
const LIST_LINE = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s/
const TABLE_LINE = /^\s{0,3}\|/
const QUOTE_LINE = /^\s{0,3}>[ \t]?/
const RULE_LINE = /^\s{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
/** A table's alignment row (`| --- | :-: |`) is not drawn: it is the table's own syntax. */
const TABLE_SEPARATOR = /^\s{0,3}\|[\s:|-]*\|?\s*$/

/**
 * How many lines one source line's words take at `lane`.
 *
 * The same advance as {@link linesOf}, over a single line: a paragraph's lines are joined and
 * measured together, because Markdown joins them into one paragraph that wraps as a whole.
 */
function lineWidth(text: string): number {
  let width = 0
  for (const glyph of text) width += CJK.test(glyph) ? CJK_PX : LATIN_PX
  return width
}

/**
 * What an answer's own text draws, in the lane it is drawn in.
 *
 * A line scan rather than a parse: the estimate is read for every unmeasured row on every rebuild of
 * the window's measurements (every streamed delta), so it must not walk the Markdown parser — that
 * is the renderer's own work, and doing it here would both double it and evict the parse cache the
 * drawn rows rely on. What the scan needs is the *shape* of each block, and the shape is in the line
 * prefixes: a fence is a card with its own 20 px lines, a heading is its own line at its own size, a
 * list item is a line with 4 px between items, a table row is a padded row, a blank line is the
 * 12 px gap between blocks rather than a line of its own, and everything else is body text joined
 * into paragraphs that wrap together.
 */
function answerTextHeight(text: string, lane: number): number {
  const usable = Math.max(MIN_LANE_PX, lane)
  let height = 0
  /** What has been emitted so far: whether this is the first block, and what kind it was. */
  const state: { first: boolean; kind: BlockKind } = { first: true, kind: 'none' }
  /** A paragraph's accumulated lines, joined the way Markdown joins them. */
  let paragraph: string[] = []
  const emit = (blockPx: number, blockKind: BlockKind, gapPx = BLOCK_GAP_PX): void => {
    height += (state.first ? 0 : gapPx) + blockPx
    state.first = false
    state.kind = blockKind
  }
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const lines = Math.max(1, Math.ceil(lineWidth(paragraph.join(' ')) / usable))
    emit(lines * LINE_PX, 'para')
    paragraph = []
  }
  let code: string[] | null = null
  for (const raw of text.split('\n')) {
    // A quote's own marker is not drawn: the paragraph inside the rule is what the reader sees.
    const line = QUOTE_LINE.test(raw) ? raw.replace(QUOTE_LINE, '') : raw
    if (code !== null) {
      if (FENCE_LINE.test(raw)) {
        emit(CODE_CHROME_PX + Math.max(1, code.length) * CODE_LINE_PX, 'para')
        code = null
      } else {
        code.push(raw)
      }
      continue
    }
    if (FENCE_LINE.test(raw)) {
      flushParagraph()
      code = []
      continue
    }
    if (line.trim() === '') {
      flushParagraph()
      continue
    }
    const heading = HEADING_LINE.exec(line)
    if (heading !== null) {
      flushParagraph()
      const depth = heading[1]!.length - 1
      emit(HEADING_LINE_PX[depth]!, 'para', HEADING_GAP_PX[depth]!)
      continue
    }
    if (RULE_LINE.test(line)) {
      flushParagraph()
      emit(RULE_PX, 'para', RULE_GAP_PX)
      continue
    }
    if (TABLE_LINE.test(line)) {
      flushParagraph()
      if (!TABLE_SEPARATOR.test(line)) emit(TABLE_ROW_PX + (state.kind === 'table' ? 0 : TABLE_FRAME_PX), 'table', state.kind === 'table' ? 0 : BLOCK_GAP_PX)
      continue
    }
    if (LIST_LINE.test(line)) {
      flushParagraph()
      const lines = Math.max(1, Math.ceil(lineWidth(line.replace(LIST_LINE, '')) / usable))
      emit(lines * LINE_PX, 'list', state.kind === 'list' ? LIST_ITEM_GAP_PX : BLOCK_GAP_PX)
      continue
    }
    // Body text: joined with the lines around it into one paragraph.
    if (paragraph.length > 0) paragraph.push(line.trim())
    else paragraph = [line.trim()]
  }
  if (code !== null) emit(CODE_CHROME_PX + Math.max(1, code.length) * CODE_LINE_PX, 'para')
  flushParagraph()
  return height
}

/**
 * The sender line, on whichever row of the turn draws it first — an answer, a lone call, or a run of
 * calls. A turn whose first step is a tool call puts it on that call's row, which the estimate used
 * to treat as a bare card header (23 px short on every such row).
 */
function senderPx(namesSender: boolean): number {
  return namesSender ? ANSWER_HEADER_PX + ANSWER_PART_GAP_PX : 0
}

/**
 * A turn's footer is a part of its own, on whichever row the turn ended on — an answer, a lone call,
 * or a run of calls: its own height plus the gap the column puts between parts.
 */
function tailPx(tail: TurnTail | null): number {
  return tail === null ? 0 : ANSWER_PART_GAP_PX + TAIL_PX
}

/**
 * What a call draws under its own header, when it draws more than the header.
 *
 * A `task` call's roster and a `web_search` call's card are both drawn *outside* the fold
 * (`ConversationToolRow` opens them by default), so a folded-call estimate that stops at the header
 * is short by the whole of them: a three-child roster is ~120 px and a five-page search card its own
 * box. Every other call draws only its header until the reader opens it, which is why the folded
 * number is the one `CALL_CHROME_PX` is measured from.
 */
function toolBodyHeight(
  message: Extract<ChatMessage, { kind: 'tool' }>,
  wrapLane: number,
): number {
  const details = message.details
  if (details === undefined) return 0
  const children = details.subagents?.length ?? 0
  if (children > 0) return ROSTER_HEADER_PX + children * ROSTER_ROW_PX
  const sources = details.sources?.length ?? 0
  const answer = details.answer?.trim() ?? ''
  if (sources === 0 && answer === '') return 0
  return Math.min(
    SEARCH_CEILING_PX,
    SEARCH_HEAD_PX + sources * SEARCH_RESULT_PX + linesOf(answer, wrapLane) * CODE_LINE_PX,
  )
}

/**
 * What one row costs, before it has been drawn.
 *
 * `lane` is the width the row is drawn in, read from a row already on screen: the transcript's rows
 * are one lane wide, so a measured row's own box is the whole of what this needs to know.
 *
 * `fontScale` is the reader's own content size against the 14 px the advances above were measured at
 * (`--omp-content-font-size`): the line *height* is fixed at 24 px (`leading-6`), so a larger reading
 * size only changes how many glyphs fit in the lane. The lane is divided by it for wrapping, and left
 * alone for the boxes that are pixels rather than words (a picture's width).
 */
export function estimateRowHeight(row: TranscriptRow, lane: number, fontScale = 1): number {
  const wrapLane = lane / (fontScale > 0.5 ? fontScale : 1)
  if (row.kind === 'tools') {
    return RUN_CHROME_PX + tailPx(row.tail) + (row.namesSender ? RUN_SENDER_PX : 0)
  }
  if (row.kind === 'reminders') return NOTE_CHROME_PX
  const message = row.message
  if (message.kind === 'notice') return NOTE_CHROME_PX
  if (message.kind === 'user') {
    // The reader's own message: a bubble, collapsed to its first lines, with a chip per file. Its
    // words wrap in the bubble's own column, not the lane's (`USER_LANE_SHARE`), and a chip's width
    // joins the paragraph it stands in.
    const bubbleLane = Math.max(MIN_LANE_PX, (lane * USER_LANE_SHARE - USER_BUBBLE_PADDING_PX) / (fontScale > 0.5 ? fontScale : 1))
    const flow = message.text.replace(/\n/g, ' ')
    const wrapped = Math.ceil(
      (lineWidth(flow) + message.attachments.length * CHIP_WIDTH_PX) / bubbleLane,
    )
    const lines = Math.min(
      COLLAPSED_LINES,
      Math.max(1, wrapped, message.text.split('\n').length),
    )
    return USER_CHROME_PX + lines * LINE_PX + (row.ending === null ? 0 : ANSWER_PART_GAP_PX + ENDING_PX)
  }
  if (message.kind === 'tool') {
    const pictures = picturesHeight(message.images ?? [], lane)
    return (
      CALL_CHROME_PX +
      (pictures === 0 ? 0 : CALL_IMAGES_PADDING_PX + pictures) +
      toolBodyHeight(message, wrapLane) +
      tailPx(row.tail) +
      senderPx(row.namesSender)
    )
  }
  if (message.kind === 'reminder') return NOTE_CHROME_PX
  // An answer is drawn as a column of parts (`AssistantRow`'s `MessageContent className="gap-3"`):
  // the sender line when this row is the one that names the turn's speaker, the reasoning it carries
  // above its words, its prose, the pictures it produced, a stray-call card, and the turn's footer
  // when this is the row that states it. One gap sits between each neighbouring pair.
  const parts: number[] = []
  if (row.namesSender) parts.push(ANSWER_HEADER_PX)
  if (row.thinking.length > 0) {
    parts.push(
      row.thinkingLive ? THINKING_CHROME_PX + linesOf(row.thinking, wrapLane) * LINE_PX : THINKING_CHROME_PX,
    )
  }
  const text = answerTextHeight(message.text, wrapLane)
  if (text > 0) parts.push(text)
  const pictures = picturesHeight(message.images ?? [], lane)
  if (pictures > 0) parts.push(pictures)
  if (row.stray !== null) parts.push(STRAY_PX)
  if (row.ending !== null) parts.push(ENDING_PX)
  if (row.tail !== null) parts.push(TAIL_PX)
  return (
    parts.reduce((total, part) => total + part, 0) +
    ANSWER_PART_GAP_PX * Math.max(0, parts.length - 1)
  )
}
