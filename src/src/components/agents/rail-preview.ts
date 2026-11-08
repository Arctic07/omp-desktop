/**
 * What a navigation-rail card says, whichever side built its list.
 *
 * A turn's card is two readings, not one paragraph: the prompt stands on a single line, and the
 * answer it drew gets the lines below it. The budgets are the ones the card's clamps fit (one 13px
 * prompt line, up to three 12px answer lines at the rail's 300px width) and the two surfaces that
 * hand the rail its rows — the conversation's own model (`home/rail-rows.ts`) and the DOM-derived
 * fallback the scroller builds when a caller has no model (`components/agents/message-scroller.tsx`)
 * — read them here so both cards say the same thing.
 *
 * The prompt is cut at its own budget and never continued into the body: a long prompt loses its
 * tail rather than taking the answer's place, because the card answers two questions and the second
 * one is the answer.
 */

/** Characters of a prompt that fit the card's single title line. */
export const RAIL_PREVIEW_TITLE_LENGTH = 50;

/** Characters of an answer that fit the card's three content lines. */
export const RAIL_PREVIEW_DESCRIPTION_LENGTH = 120;

/**
 * `text` cut to `limit` characters, with the ellipsis the cut earns.
 *
 * A cut inside a word is deliberate: the budget is characters, and a card that hunted for a word
 * boundary would show less than the line it has room for (a Chinese prompt has no spaces to find).
 */
export function truncatePreview(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

/**
 * A card's two readings: its title, and the answer under it when there is one.
 *
 * `fallback` names the card when the prompt is empty — a turn read from the middle of itself — the
 * same wording the transcript's own rows use for a row with no words.
 */
export function railPreview(
  text: string,
  response: string,
  fallback: string,
): { label: string; description?: string } {
  return {
    label: text === "" ? fallback : truncatePreview(text, RAIL_PREVIEW_TITLE_LENGTH),
    description: response === "" ? undefined : truncatePreview(response, RAIL_PREVIEW_DESCRIPTION_LENGTH),
  };
}
