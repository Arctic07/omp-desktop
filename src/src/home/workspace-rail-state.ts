/**
 * Which body the rail's workspace group draws.
 *
 * `idle` and `loading` are waits, not an answer: drawing the empty state while the first
 * `workspace_list` is out is what showed "还没有工作区" for the frames before the list arrived. Only a
 * ready, empty list is the reader's own empty state; an error is its own reading.
 *
 * The rule is declared here rather than inline in `WorkspaceRail.tsx` so `node --test` can decide it
 * without a DOM.
 */
export type WorkspaceRailBody = 'loading' | 'empty' | 'error' | 'list'

export interface WorkspaceRailListState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly error: unknown
  readonly items: readonly unknown[]
}

export function workspaceRailBody(state: WorkspaceRailListState): WorkspaceRailBody {
  if (state.status === 'error' && state.error !== null) return 'error'
  if (state.items.length > 0) return 'list'
  return state.status === 'ready' ? 'empty' : 'loading'
}
