/**
 * The reminder the harness injected into a turn, read back into the facts it carries.
 *
 * A rule check writes a `<system-reminder reason="rule_violation" rule="ts-no-any"
 * path="builtin-defaults:ts-no-any.md">` block into a developer message, and that message is the only
 * place where the reader can see why a tool call was refused or altered. The block is one row of the
 * transcript (`components/agents/reminder-row.tsx`); this module reads it and decides nothing else:
 * no React, no styling.
 *
 * What is read is only what the engine wrote. A block whose attributes are missing keeps a null in
 * its place rather than a guess — an older harness, or a reminder about something other than a rule,
 * still draws, with the body it came with.
 */

/** One reminder, as its opening tag and body spell it. */
export interface ParsedReminder {
  /** The engine's reason word (`rule_violation`), or null when the tag carried none. */
  reason: string | null
  /** The rule that fired (`ts-no-any`), or null when the reminder names no rule. */
  rule: string | null
  /** The rule's file, as the engine wrote it (`builtin-defaults:ts-no-any.md`). */
  path: string | null
  /** The body the reader sees when the row is opened. */
  text: string
}

/** One reminder's opening tag, and the body up to its closer. */
const REMINDER_BLOCK = /<system-reminder\b([^>]*)>([\s\S]*?)<\/system-reminder>/i

/** An attribute, as the engine writes it: double-quoted, escaped by the prompt renderer. */
const ATTRIBUTE = /([a-zA-Z][\w-]*)="([^"]*)"/g

/**
 * The reminder this text is, or null when it is not one.
 *
 * A message that merely *quotes* a reminder is not a reminder: the tag has to open the text, which
 * is where the engine writes it (the same rule `splitSystemNotices` applies to every wrapper).
 */
export function parseReminder(text: string): ParsedReminder | null {
  const match = REMINDER_BLOCK.exec(text.trim())
  if (match === null || match.index !== 0) return null
  const attributes = readAttributes(match[1] ?? '')
  const body = (match[2] ?? '').trim()
  return {
    reason: field(attributes.reason),
    rule: field(attributes.rule),
    path: field(attributes.path),
    text: body,
  }
}

/** One attribute value, or null when it is absent or blank. */
function field(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value.trim()
}

/** The attributes of one opening tag, keyed by name; absent ones read as `undefined`. */
function readAttributes(source: string): Record<string, string | undefined> {
  const attributes: Record<string, string | undefined> = {}
  // `exec` on a `g` pattern carries `lastIndex` between calls, so it is reset before the walk.
  ATTRIBUTE.lastIndex = 0
  let match = ATTRIBUTE.exec(source)
  while (match !== null) {
    attributes[match[1]!] = match[2]
    match = ATTRIBUTE.exec(source)
  }
  return attributes
}

/**
 * Two reminders are the same reminder when they name the same rule.
 *
 * Consecutive ones fold into a single row with a count: a turn that trips one rule three times is
 * one thing that happened to the reader, not three.
 */
export function sameReminder(left: ParsedReminder, right: ParsedReminder): boolean {
  return left.reason === right.reason && left.rule === right.rule
}
