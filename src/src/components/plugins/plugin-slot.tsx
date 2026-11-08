/**
 * What a plugin's renderer draws inside this application's own window.
 *
 * Six mount points ask this module for the entries registered on their slot and render whatever is
 * there — nothing at all when nothing is, with no wrapper box to shift a flex row. Each entry is
 * drawn inside its own boundary, so a component that throws costs its own block and nothing else:
 * the surrounding row, transcript and window carry on.
 *
 * The components come from a plugin's module in this document's realm (`state/plugin-slots.ts`) and
 * are only ever *mounted*; this side passes data props and never reaches into them. The one
 * exception is the composer suggestion's accept gesture: Tab is pressed in the composer field, so
 * the registry keeps the plugin's own accept callback and this module is where the keystroke reaches
 * it.
 */

import { X } from 'lucide-react'
import {
  Component,
  createContext,
  useContext,
  useMemo,
  type ErrorInfo,
  type ReactNode,
} from 'react'

import { reportClientError } from '@/lib/client-errors'
import { useCopy, type Localized } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  codeBlockEntryFor,
  parsePluginFenceLanguage,
  pluginSlotStore,
  slotEntriesFor,
  toolCardEntryFor,
  type PluginSlotEntry,
  type PluginSlotToken,
  type PluginSlotsState,
} from '@/state/plugin-slot-rules'
import { useStoreSelector, createStore } from '@/state/store'

/** The slots that mount a component chosen by the mount point itself. */
export type PluginSlotName = Exclude<PluginSlotToken, 'tool.card' | 'code.block'>

interface PluginSlotCopy {
  dismissSuggestion: string
}

const COPY: Localized<PluginSlotCopy> = {
  en: { dismissSuggestion: 'Dismiss suggestion' },
  zh: { dismissSuggestion: '忽略这条建议' },
}

/** Each slot's own box; the class names carry the `omp-` prefix this app's styles expect. */
const SLOT_CLASS: Record<PluginSlotName, string> = {
  'composer.toolbar': 'omp-plugin-slot-inline flex min-w-0 items-center gap-1',
  'composer.suggestion': 'omp-plugin-slot-line flex w-full min-w-0 flex-col gap-1',
  'message.actions.user': 'omp-plugin-slot-inline flex min-w-0 items-center gap-1',
  'message.actions.assistant': 'omp-plugin-slot-inline flex min-w-0 items-center gap-1',
  'message.extra': 'omp-plugin-slot-block flex w-full min-w-0 flex-col gap-2',
}

/* -------------------------------------------------------------- session scope */

/**
 * The conversation whose rows are being drawn.
 *
 * The pane is mounted per conversation (a subagent's transcript is one too), so a slot's report of
 * "which conversation is this message in" has to come from the pane rather than from whichever
 * conversation happens to be on top. One provider per pane keeps that explicit without threading a
 * session id through every row component.
 */
const SessionIdContext = createContext<string | null>(null)

export function PluginSlotSessionProvider({
  sessionId,
  children,
}: {
  sessionId: string
  children: ReactNode
}) {
  return <SessionIdContext.Provider value={sessionId}>{children}</SessionIdContext.Provider>
}

export function usePluginSlotSessionId(): string | null {
  return useContext(SessionIdContext)
}

/* ------------------------------------------------------------------ the boundary */

interface SlotBoundaryState {
  failed: boolean
}

/**
 * One slot's own failure containment.
 *
 * A class, because only a class is an error boundary. It renders nothing once its block has thrown:
 * the block is plugin code this application cannot repair, and the row it stood in keeps its own
 * content. The failure is written to `app.log` once, with the component stack that says which slot
 * threw (`lib/client-errors.ts`).
 */
class SlotBoundary extends Component<{ children: ReactNode }, SlotBoundaryState> {
  state: SlotBoundaryState = { failed: false }

  static getDerivedStateFromError(): SlotBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportClientError('a plugin slot failed to render', error, info.componentStack)
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/* --------------------------------------------------------------------- mounting */

/** One plugin component, mounted with the props its mount point supplies. */
function SlotComponent({
  entry,
  props,
}: {
  entry: PluginSlotEntry
  props: Record<string, unknown>
}) {
  const Component = entry.component
  return <Component {...props} />
}

export interface PluginSlotProps {
  slot: PluginSlotName
  /** `composer.toolbar` only: the side this mount point is asking for. */
  position?: 'left' | 'right'
  /** Data props handed to every component registered on this slot. */
  props?: Record<string, unknown>
  className?: string
}

/**
 * One slot's entries, or nothing.
 *
 * A slot with no registrations renders `null` — no wrapper element, so an empty toolbar or action
 * row is byte-for-byte the layout it was before plugins could draw there.
 */
export function PluginSlot({ slot, position, props = {}, className }: PluginSlotProps) {
  const entries = useStoreSelector(pluginSlotStore, selectEntries)
  const mine = useMemo(
    () => slotEntriesFor(entries, slot, position),
    [entries, slot, position],
  )
  if (mine.length === 0) return null
  return (
    <div data-omp-slot={slot} className={cn('omp-plugin-slot', SLOT_CLASS[slot], className)}>
      {mine.map((entry) => (
        <SlotBoundary key={entry.id}>
          <SlotComponent entry={entry} props={props} />
        </SlotBoundary>
      ))}
    </div>
  )
}

/**
 * The renderer for one fenced block, or the block this application would draw itself.
 *
 * `tag` is the fence's raw language tag (`omp.charts:timeline`); a tag that is not one's own
 * returns `fallback` unchanged. A matched entry replaces the code block — that is what the slot
 * means — and its throw costs the block, not the answer around it.
 */
export function PluginCodeBlock({
  tag,
  source,
  fallback,
  streaming,
}: {
  tag: string
  source: string
  fallback: ReactNode
  streaming: boolean
}) {
  const entries = useStoreSelector(pluginSlotStore, selectEntries)
  const entry = useMemo(() => codeBlockEntryFor(entries, tag), [entries, tag])
  if (entry === null) return <>{fallback}</>
  const parsed = parsePluginFenceLanguage(tag)
  const Component = entry.component
  return (
    <div className="omp-plugin-code-block mt-3 w-full min-w-0" data-omp-slot="code.block">
      <SlotBoundary key={entry.id}>
        <Component language={parsed === null ? tag : parsed.language} source={source} streaming={streaming} />
      </SlotBoundary>
    </div>
  )
}

/**
 * The card for one tool call, or the row this application would draw itself.
 *
 * Only a call whose tool name a plugin owns reaches its renderer (`state/plugin-slots.ts` settles
 * that at registration), so a built-in call and another plugin's call both keep the default card.
 */
export function PluginToolCard({
  toolName,
  props,
  fallback,
}: {
  toolName: string
  props: Record<string, unknown>
  fallback: ReactNode
}) {
  const entries = useStoreSelector(pluginSlotStore, selectEntries)
  const entry = useMemo(() => toolCardEntryFor(entries, toolName), [entries, toolName])
  if (entry === null) return <>{fallback}</>
  const Component = entry.component
  return (
    <div className="omp-plugin-tool-card w-full min-w-0" data-omp-slot="tool.card">
      <SlotBoundary key={entry.id}>
        <Component {...props} />
      </SlotBoundary>
    </div>
  )
}

/* -------------------------------------------------------- composer suggestions */

/** The lines the reader has folded away, by registration id (a new registration shows again). */
interface SuggestionState {
  hidden: readonly number[]
}

const suggestionStore = createStore<SuggestionState>({ hidden: [] })

/**
 * The selectors are module constants, as `useStoreSelector` requires: an inline arrow would be a new
 * function on every render, and the subscription would be torn down and rebuilt with it.
 */
const selectEntries = (state: PluginSlotsState) => state.entries
const selectHidden = (state: SuggestionState) => state.hidden

function hiddenSuggestions(): readonly number[] {
  return suggestionStore.get().hidden
}

function visibleSuggestionEntries(): readonly PluginSlotEntry[] {
  const hidden = hiddenSuggestions()
  return slotEntriesFor(pluginSlotStore.get().entries, 'composer.suggestion').filter(
    (entry) => !hidden.includes(entry.id),
  )
}

/** The suggestion lines on screen; also what tells the composer a Tab is spoken for. */
export function usePluginSuggestions(): readonly PluginSlotEntry[] {
  const entries = useStoreSelector(pluginSlotStore, selectEntries)
  const hidden = useStoreSelector(suggestionStore, selectHidden)
  return useMemo(
    () =>
      slotEntriesFor(entries, 'composer.suggestion').filter(
        (entry) => !hidden.includes(entry.id),
      ),
    [entries, hidden],
  )
}

/**
 * Tab's accept gesture.
 *
 * The composer field owns the keystroke, so it calls this instead of the component: the plugin's own
 * accept act runs (it may dispatch an insert), then the line folds away for that registration. A
 * throw is the plugin's and stays with it — one line in the log, the rest of the window untouched.
 */
export function acceptComposerSuggestion(): void {
  const entries = visibleSuggestionEntries()
  for (const entry of entries) {
    try {
      entry.onAccept?.()
    } catch (error) {
      reportClientError('a plugin suggestion failed to accept', error, entry.pluginKey)
    }
  }
  if (entries.length > 0) suggestionStore.set({ hidden: entries.map((entry) => entry.id) })
}

/** Escape, and the line's own ✕: the suggestion folds away without its accept act running. */
export function dismissComposerSuggestion(): void {
  const entries = visibleSuggestionEntries()
  if (entries.length > 0) suggestionStore.set({ hidden: entries.map((entry) => entry.id) })
}

/** The dismissible line above the composer field: the plugin draws it, this is its frame. */
export function PluginSuggestionLine() {
  const copy = useCopy(COPY)
  const entries = usePluginSuggestions()
  if (entries.length === 0) return null
  return (
    <div
      className="omp-plugin-suggestion flex w-full min-w-0 items-start gap-2 px-1"
      data-omp-slot="composer.suggestion"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {entries.map((entry) => (
          <SlotBoundary key={entry.id}>
            <SlotComponent
              entry={entry}
              props={{ items: entry.items, accept: acceptComposerSuggestion, dismiss: dismissComposerSuggestion }}
            />
          </SlotBoundary>
        ))}
      </div>
      <button
        type="button"
        aria-label={copy.dismissSuggestion}
        title={copy.dismissSuggestion}
        onClick={dismissComposerSuggestion}
        className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  )
}
