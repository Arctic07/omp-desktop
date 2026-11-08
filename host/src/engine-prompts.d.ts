/**
 * The engine ships its prompts as Markdown and exports them by path
 * (`package.json` exports `./prompts/*` → `./src/prompts/*.md`). Bun loads one with
 * `import text from '…' with { type: 'text' }`; TypeScript has no declaration for that pair, and
 * the package's export entry carries none either, so the one prompt this host reads is declared
 * here at the specifier it uses.
 */
declare module '@oh-my-pi/pi-coding-agent/prompts/system/title-system' {
  const text: string
  export default text
}

/** `/tan`'s two prompts, read as text the same way. */
declare module '@oh-my-pi/pi-coding-agent/prompts/system/tan-context-switch' {
  const text: string
  export default text
}

declare module '@oh-my-pi/pi-coding-agent/prompts/system/background-tan-dispatch' {
  const text: string
  export default text
}

/** `/guided-goal`'s interview kickoff, read as text the same way. */
declare module '@oh-my-pi/pi-coding-agent/prompts/goals/guided-goal-interview' {
  const text: string
  export default text
}

/** The engine's own auto-continue nudge, sent after a compaction whose turn was interrupted. */
declare module '@oh-my-pi/pi-coding-agent/prompts/system/auto-continue' {
  const text: string
  export default text
}
