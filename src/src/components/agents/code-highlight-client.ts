/**
 * The main-thread half of the highlighting worker.
 *
 * One worker serves every code block and file preview. Each hook owns a slot; a slot keeps only its
 * newest request, so a streaming tool result replaces the queued frame instead of queueing one
 * token pass per frame. While a request is in flight the worker cannot be interrupted (shiki is
 * synchronous once it starts), so the newest request waits for the current one to finish — the UI
 * thread stays free either way.
 *
 * A response is delivered to the callback that sent it, never to whatever the slot points at when
 * it lands: a newer request may already have replaced the slot, and its caller must not be handed
 * an older file's token lines.
 *
 * A worker that cannot be constructed, has crashed, or stops answering is written off permanently
 * for this process: retrying would post the same request into a broken channel, and a file is never
 * truncated by a missing colour pass. Each failure mode is logged once, and every waiting slot is
 * answered with "plain text" so no caller is left waiting on an id that will not come back.
 */

import type {
  AgentCodeLanguage,
  AgentCodeTokenLines,
  CodeHighlightJob,
  CodeHighlightResponse,
} from './code-language'

export type CodeHighlightSlot = symbol

type OnResult = (lines: AgentCodeTokenLines | null) => void
type PendingRequest = Extract<CodeHighlightJob, { kind: 'highlight' }>

interface Pending {
  request: PendingRequest
  onResult: OnResult
}

interface Slot {
  /** The request to send as soon as the worker is free; replaced, never queued. */
  latest: Pending | null
}

const slots = new Map<CodeHighlightSlot, Slot>()
let worker: Worker | null = null
let workerFailed = false
let requestSeq = 0
let active: { id: number; slot: CodeHighlightSlot; onResult: OnResult } | null = null
let activeTimer: number | null = null

/**
 * How long one answer may take before the worker is written off.
 *
 * The worker tokenizes one request at a time and a 96 KiB file takes it a second or two, so this is
 * a wedge detector, not a performance bound: without it an answer that never arrives leaves the
 * queue waiting forever (the scheduler only moves on a message) and every later block stays plain
 * with no signal anywhere.
 */
const RESPONSE_TIMEOUT_MS = 15_000

function stopWatchdog(): void {
  if (activeTimer === null) return
  clearTimeout(activeTimer)
  activeTimer = null
}

/** Hands one answer to the caller that posted it; a throwing consumer does not wedge the queue. */
function answer(onResult: OnResult, lines: AgentCodeTokenLines | null): void {
  try {
    onResult(lines)
  } catch (error) {
    console.error('a code highlight consumer failed', error)
  }
}

function failEverything(): void {
  if (!workerFailed) console.error('the highlighter worker is unusable; highlighting is plain text')
  workerFailed = true
  stopWatchdog()
  try {
    worker?.terminate()
  } catch {
    // A terminate that throws has already left nothing worth reusing; the flag above is the answer.
  }
  worker = null
  const running = active
  active = null
  if (running !== null && slots.has(running.slot)) answer(running.onResult, null)
  for (const slot of slots.values()) slot.latest = null
}

function getWorker(): Worker | null {
  if (worker !== null) return worker
  if (workerFailed) return null
  try {
    worker = new Worker(new URL('./code-highlight.worker.ts', import.meta.url), {
      type: 'module',
      name: 'omp-code-highlight',
    })
    worker.onmessage = (event: MessageEvent<CodeHighlightResponse>) => {
      const response = event.data
      if (active === null || response === null || typeof response !== 'object' || active.id !== response.id) return
      const done = active
      active = null
      stopWatchdog()
      if (slots.has(done.slot)) answer(done.onResult, response.lines ?? null)
      pump()
    }
    worker.onerror = () => {
      failEverything()
    }
    // A message that cannot be deserialized is a broken channel for this request; there is no event
    // to match it against, so the worker is written off exactly as a crash would.
    worker.onmessageerror = () => {
      failEverything()
    }
  } catch (error) {
    workerFailed = true
    console.error('the highlighter worker could not be created; highlighting is plain text', error)
    return null
  }
  return worker
}

function pump(): void {
  if (active !== null) return
  const worker = getWorker()
  for (const [slotId, slot] of slots) {
    const pending = slot.latest
    if (pending === null) continue
    slot.latest = null
    if (worker === null) {
      answer(pending.onResult, null)
      continue
    }
    const id = ++requestSeq
    active = { id, slot: slotId, onResult: pending.onResult }
    try {
      worker.postMessage({ id, ...pending.request })
    } catch (error) {
      active = null
      console.error('a code highlight request could not be posted', error)
      answer(pending.onResult, null)
      continue
    }
    stopWatchdog()
    activeTimer = setTimeout(() => {
      activeTimer = null
      failEverything()
    }, RESPONSE_TIMEOUT_MS)
    return
  }
}

export function acquireCodeHighlightSlot(): CodeHighlightSlot {
  const slot = Symbol('code-highlight')
  slots.set(slot, { latest: null })
  return slot
}

export function releaseCodeHighlightSlot(slot: CodeHighlightSlot): void {
  slots.delete(slot)
}

export function cancelCodeHighlightRequest(slot: CodeHighlightSlot): void {
  const entry = slots.get(slot)
  if (entry !== undefined) entry.latest = null
}

/**
 * Posts a job nobody waits for.
 *
 * The worker serializes every job on one chain, so a warm-up or a grammar preload ahead of the
 * file's own request only ever moves work earlier — it cannot interleave with a tokenize. Its
 * answer carries an id no slot owns and is dropped by `onmessage`.
 */
function postJob(job: CodeHighlightJob): void {
  if (workerFailed) return
  const worker = getWorker()
  if (worker === null) return
  try {
    worker.postMessage({ id: ++requestSeq, ...job })
  } catch (error) {
    console.error('a code highlight request could not be posted', error)
  }
}

/**
 * Builds the highlighter (both themes and the oniguruma wasm) before anything is highlighted.
 *
 * The wasm is the one part of a cold highlight that is neither per-file nor per-grammar, and it is
 * what makes a freshly opened file sit uncoloured for the first few hundred milliseconds. The file
 * panel calls this when its tab opens, while the reader is still on the tree.
 */
export function warmUpCodeHighlight(): void {
  postJob({ kind: 'warm' })
}

/** Fetches one grammar ahead of the text, so opening the file only costs a tokenize. */
export function prefetchCodeLanguage(language: AgentCodeLanguage): void {
  if (language === 'text') return
  postJob({ kind: 'prefetch', language })
}

export function requestCodeHighlight(
  slot: CodeHighlightSlot,
  request: Omit<PendingRequest, 'kind'>,
  onResult: OnResult,
): void {
  const entry = slots.get(slot)
  if (entry === undefined) return
  if (workerFailed) {
    entry.latest = null
    onResult(null)
    return
  }
  entry.latest = { request: { kind: 'highlight', ...request }, onResult }
  pump()
}
