/**
 * The pane's palette, and the signal that it changed.
 *
 * xterm takes colours as values, not as CSS variables, so a view has to be handed the resolved
 * palette and handed it again whenever the palette moves. Nothing here invents a colour: the surface
 * is the pane and the ink is the app's own foreground (`src/index.css`).
 *
 * **Why the document is watched instead of the theme name.** The palette has more than one author —
 * `next-themes` flips `.dark` on `<html>`, and a plugin theme (`state/plugin-theme.ts`) writes its
 * tokens as a `<style>` element in the head — and neither of them changes `resolvedTheme` when it is
 * a switch between two themes of the same mode. Keying a repaint on `resolvedTheme` therefore misses
 * exactly the reported case ("changed theme, the terminal keeps its old colours, a new terminal gets
 * the new ones"), and reading the tokens inside the child's own effect misses the other one: the
 * provider applies the class in *its* effect, which React runs after its children's, so the panel
 * would read the palette that is still one commit old. Observing the document removes both races:
 * whatever wrote the tokens, the observer fires after the write has landed.
 */

export interface TerminalPalette {
  background: string
  foreground: string
}

/** What a page with no readable tokens falls back to (the dark chrome, `index.css`). */
const FALLBACK: TerminalPalette = { background: '#121212', foreground: '#d3d3d3' }

/** The palette as the document computes it right now. */
export function readTerminalPalette(): TerminalPalette {
  const styles = getComputedStyle(document.documentElement)
  const pane = styles.getPropertyValue('--omp-pane').trim()
  const ink = styles.getPropertyValue('--foreground').trim()
  return {
    // The chrome palette behind the token, not `--color-pane` itself: that one is Tailwind's
    // mapping and resolves to this value through `var()`, which is not what xterm can take.
    background: pane || FALLBACK.background,
    foreground: ink || FALLBACK.foreground,
  }
}

type PaletteListener = (palette: TerminalPalette) => void

const listeners = new Set<PaletteListener>()
let observer: MutationObserver | null = null
/** The palette the listeners were last told about, or null while nobody is listening. */
let announced: TerminalPalette | null = null

function announce(): void {
  const palette = readTerminalPalette()
  const previous = announced
  announced = palette
  if (
    previous !== null &&
    previous.background === palette.background &&
    previous.foreground === palette.foreground
  ) {
    return
  }
  // One view throwing must not keep the others from repainting: the observer fires once for the
  // whole application, and a single bad subscriber would leave every other terminal with the old
  // colours until the next theme change.
  for (const listener of [...listeners]) {
    try {
      listener(palette)
    } catch (error) {
      console.error('a terminal palette listener failed', error)
    }
  }
}

/**
 * Call `listener` whenever the computed palette differs from the last one announced.
 *
 * One observer serves every view: a terminal panel mounts per tab and hidden tabs stay mounted, so a
 * per-view observer would put a dozen of them on the head. The callback runs only on an actual
 * change, so unrelated head churn (a Vite style swap, a nonce'd script) is filtered by value.
 */
export function subscribeTerminalPalette(listener: PaletteListener): () => void {
  listeners.add(listener)
  if (observer === null) {
    announced = readTerminalPalette()
    observer = new MutationObserver(announce)
    // The theme name (`class`), an inline palette (`style`) and anything else a future palette
    // source parks on the root.
    observer.observe(document.documentElement, { attributes: true })
    // A plugin theme is the head's `<style>` element being added, rewritten or removed.
    observer.observe(document.head, { childList: true, characterData: true, subtree: true })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0 || observer === null) return
    observer.disconnect()
    observer = null
    announced = null
  }
}
