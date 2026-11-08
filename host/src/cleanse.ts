/**
 * Cleanse: the body of the engine's terminal-only `/cleanse`, run by this host.
 *
 * The engine owns the whole run (`cleanse/index.ts` `runCleanse`): checker discovery, the bounded
 * repair batch, verification, and the report. What the terminal adds is a live board overlay; a
 * non-terminal host supplies the same `CleanseStatusBoard` seam with lines instead of rows, which
 * is what makes this command implementable here without re-implementing any of the work.
 *
 * The run is long (it spawns repair subagents), so the command answers immediately and its
 * progress arrives as notices. A stop aborts it through the same signal the engine's UI uses.
 */

import type { AgentSession } from '@oh-my-pi/pi-coding-agent'
import { runCleanse } from '@oh-my-pi/pi-coding-agent/cleanse/index'
import type { CleanseRunUi } from '@oh-my-pi/pi-coding-agent/cleanse/index'

/** One command result line, on the engine's own notice channel. */
export type CleanseOutput = (text: string) => void

/** One in-flight cleanse per conversation; a second one is refused rather than raced. */
interface CleanseRun {
  readonly abort: AbortController
}

const runs = new WeakMap<AgentSession, CleanseRun>()

/** Whether a cleanse is running in this conversation. */
export function cleanseRunning(session: AgentSession): boolean {
  return runs.has(session)
}

/** Aborts the running cleanse, for a stop that has to end background work as well as the turn. */
export function abortCleanse(session: AgentSession): void {
  const run = runs.get(session)
  if (run === undefined) return
  runs.delete(session)
  run.abort.abort(new Error('Cleanse interrupted'))
}

/** The flags `/cleanse` accepts, parsed the way the CLI's own command parses them. */
export interface CleanseArgs {
  readonly all: boolean
  readonly maxAgents?: number
  readonly model?: string
  readonly includeTests: boolean
  readonly request?: string
}

/** `[request]`, `--all`, `--agents N`, `--model X`, `--tests`: the CLI's flags minus its shortcuts. */
export function parseCleanseArgs(args: string): CleanseArgs | string {
  const words = args.trim().split(/\s+/).filter(Boolean)
  let all = false
  let includeTests = false
  let maxAgents: number | undefined
  let model: string | undefined
  const rest: string[] = []
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!
    if (word === '--all' || word === '-a') {
      all = true
    } else if (word === '--tests' || word === '-t') {
      includeTests = true
    } else if (word === '--agents' || word === '-n') {
      const value = Number.parseInt(words[++index] ?? '', 10)
      if (!Number.isInteger(value) || value <= 0) return '--agents must be a positive integer.'
      maxAgents = value
    } else if (word.startsWith('--agents=')) {
      const value = Number.parseInt(word.slice('--agents='.length), 10)
      if (!Number.isInteger(value) || value <= 0) return '--agents must be a positive integer.'
      maxAgents = value
    } else if (word === '--model' || word === '-m') {
      const value = words[++index]
      if (value === undefined || value.length === 0) return '--model needs a model name.'
      model = value
    } else if (word.startsWith('--model=')) {
      model = word.slice('--model='.length)
    } else {
      rest.push(word)
    }
  }
  const request = unquote(rest.join(' '))
  return {
    all,
    maxAgents,
    model,
    includeTests,
    request: request.length === 0 ? undefined : request,
  }
}

/** A command line keeps the quotes a shell would have stripped; a quoted request loses them here. */
function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text[0]
    if ((first === '"' || first === "'") && text.endsWith(first)) return text.slice(1, -1).trim()
  }
  return text
}

/**
 * Starts a cleanse run and answers with the line the reader sees first.
 *
 * `all` defaults to on here: the terminal's picker has no equivalent in a notice, and a command
 * that waited for a choice nobody can make would simply look stuck. A request runs the discovery
 * path instead, exactly as `/cleanse "<request>"` does in the CLI.
 */
export function startCleanse(
  session: AgentSession,
  args: CleanseArgs,
  output: CleanseOutput,
): { readonly started: true } | { readonly started: false; readonly reason: string } {
  if (runs.has(session)) return { started: false, reason: 'A cleanse is already running in this conversation.' }
  const abort = new AbortController()
  runs.set(session, { abort })
  /** The permanent lines the terminal's board prints; transient rows have no reader here. */
  const print = (text: string) => output(text)
  const ui: CleanseRunUi = {
    board: {
      interactive: false,
      log: print,
      phase: () => {},
      checkerStarted: () => {},
      checkerFinished: () => {},
      repairFinished: () => {},
      agentStarted: () => {},
      agentProgress: () => {},
      agentFinished: () => {},
      close: () => {},
    },
    print,
    printError: (text) => output(text),
    // No picker and no request box in a notice: `all` is the documented default for a headless run.
  }
  output(
    args.request === undefined
      ? 'Cleanse started. Running every discovered check…'
      : `Cleanse started. Discovering checks for “${args.request}”…`,
  )
  void runCleanse(
    {
      all: args.all || args.request === undefined,
      maxAgents: args.maxAgents,
      model: args.model,
      includeTests: args.includeTests,
      request: args.request,
    },
    ui,
    abort.signal,
  )
    .then((result) => {
      const checks = result.report.checks.length
      const diagnostics = result.report.diagnostics.length
      output(`Cleanse ${result.status}: ${checks} check(s), ${diagnostics} diagnostic(s).`)
    })
    .catch((error: unknown) => {
      output(`Cleanse stopped: ${error instanceof Error ? error.message : String(error)}`)
    })
    .finally(() => {
      if (runs.get(session)?.abort === abort) runs.delete(session)
    })
  return { started: true }
}
