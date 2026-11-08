/**
 * The blank conversation's welcome: which greeting the clock calls for, and the four starters.
 *
 * Pure, so `node --test` can decide it (`new-chat.test.ts`). The surface that draws it is
 * `home/ConversationWelcome.tsx`, and the words — the greeting, the starters' labels and the
 * prompts they write into the field — live there, in the reader's language.
 *
 * The starters are this application's own suggestions, not engine state: nothing here claims to be
 * a skill the engine advertised or a conversation that exists. Clicking one writes its prompt into
 * the composer; it is the reader who sends it.
 */

/** The starters, in the order the grid draws them: broad, then narrow. */
export const NEW_CHAT_STARTERS = ['explore', 'fix', 'review', 'plugin'] as const

export type NewChatStarterId = (typeof NEW_CHAT_STARTERS)[number]

/**
 * The four moments a day reads as, as far as a greeting is concerned.
 *
 * The night bucket wraps around midnight (`23` through `4`), which is why the rule below is written
 * as two ranges rather than one.
 */
export type GreetingSlot = 'morning' | 'afternoon' | 'evening' | 'night'

/**
 * Which greeting an hour of the day calls for.
 *
 * The hour is wrapped into a day first (`24` is midnight, `-1` is 23:00), so a caller that hands in
 * an already-offset clock still gets a bucket rather than falling through. A value that is not a
 * number at all is read as midnight: a greeting is not worth an exception.
 */
export function greetingSlot(hour: number): GreetingSlot {
  const h = Number.isFinite(hour) ? ((Math.trunc(hour) % 24) + 24) % 24 : 0
  if (h >= 5 && h < 12) return 'morning'
  if (h >= 12 && h < 18) return 'afternoon'
  if (h >= 18 && h < 23) return 'evening'
  return 'night'
}
