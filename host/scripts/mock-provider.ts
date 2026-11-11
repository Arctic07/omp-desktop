/**
 * A deterministic OpenAI-compatible endpoint for the host smoke.
 *
 * The default smoke scenarios never dial a provider: the fixture model's endpoint is a dead port,
 * which is what makes a credential-free run green. The `write-guard` scenario is different - it
 * needs a real engine turn that calls real tools - so this server answers just enough of the
 * `chat/completions` protocol to drive one tool call per prompt:
 *
 * - a prompt `read-range <file>`, `read-whole <file>` or `write-file <file> <marker>` becomes a
 *   `read`/`write` tool call;
 * - `vibe-spawn <fast|good>` becomes a `vibe_spawn` call whose worker brief is `hold`;
 * - `hold` is never answered: the request stays open, which is how a turn (a worker's, usually)
 *   stays in flight for a scenario that has to end or exit a running mode;
 * - once the request carries the tool result (the last message is `tool`), the turn finishes with a
 *   short answer.
 *
 * It is a *test* provider: no authentication, no streaming text beyond `done`, and the prompt text
 * is interpreted as a command. The host under test is the real one, with the real engine, the real
 * tools and the real write guard.
 */

import * as fs from 'node:fs'
import * as http from 'node:http'

/** One running provider. */
export interface MockProvider {
  /** Base URL to write into the fixture's `models.yml` (already ends in `/v1`). */
  readonly url: string
  /**
   * The command text of every request answered, in order.
   *
   * A scenario that has to prove *what the host sent next* - the continuation after an adopted
   * compaction, say - reads it here rather than inferring it from an end state.
   */
  readonly seen: readonly string[]
  stop(): void
}

interface ChatMessage {
  readonly role?: string
  readonly content?: unknown
}

interface ChatRequest {
  readonly messages?: ChatMessage[]
  readonly model?: string
  readonly stream?: boolean
}

/**
 * The prompt inside the engine's user envelope.
 *
 * The first turn of a conversation reaches the provider with the operator's words wrapped in
 * `<user>…</user>` (a title side turn also sends a `<system-reminder>` user message first). The
 * command is inside the envelope; anything else is not this test's prompt.
 */
function commandText(raw: string): string {
  // The first turn carries the app's REMINDER as a prefix of the prompt; the title side turn wraps
  // its input in `<user>…</user>`.
  const body = raw.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/i, '')
  const user = /<user>\s*([\s\S]*?)\s*<\/user>/.exec(body)
  return (user?.[1] ?? body).trim()
}

/** Whether this request is the engine's title side turn, which answers with a name, not a tool. */
function isTitleTurn(messages: readonly ChatMessage[]): boolean {
  return messages.some(
    message =>
      message.role === 'system' && messageText(message).startsWith('You name coding-agent sessions'),
  )
}
/** The text of a message whose content is a string or an array of text parts. */
function messageText(message: ChatMessage | undefined): string {
  if (message === undefined) return ''
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .map(part => {
      if (typeof part !== 'object' || part === null || !('text' in part)) return ''
      const text: unknown = part.text
      return typeof text === 'string' ? text : ''
    })
    .join('')
}

/** One SSE chunk in the shape the engine's `openai-completions` provider reads. */
function chunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'mock-completion',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'smoke-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

/** One whole (non-streaming) completion body carrying the given assistant message. */
function jsonBody(message: Record<string, unknown>, finishReason: string): string {
  return JSON.stringify({
    id: 'mock-completion',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'smoke-model',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

/**
 * Starts the provider on an ephemeral loopback port.
 *
 * The returned URL is what the smoke writes into the fixture `models.yml`.
 */
export async function startMockProvider(): Promise<MockProvider> {
  /** Requests the provider keeps open on purpose (`hold`): the turn behind one has nothing in flight to settle. */
  const held: http.ServerResponse[] = []
  /** The command text of each answered request, so a scenario can read what the host sent next. */
  const seen: string[] = []
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(404).end('not found')
      return
    }
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      raw += chunk
    })
    request.on('end', () => {
      let body: ChatRequest
      try {
        body = JSON.parse(raw) as ChatRequest
      } catch {
        response.writeHead(400).end('bad json')
        return
      }
      const messages = body.messages ?? []
      const last = messages.at(-1)
      const prompt = [...messages].reverse().find(message => message.role === 'user')
      if (isTitleTurn(messages)) {
        respond(response, body, 'Smoke title')
        return
      }
      const text = commandText(messageText(prompt))
      seen.push(text)
      const [command = '', target = '', marker = 'from-model'] = text.split(/\s+/)
      // An endpoint that spends its own answer on a compaction summary instead of the work it was
      // asked for: the tool call runs, and the result is answered with the summary the host has to
      // adopt (`upstream-compaction`). The summary is written the way the endpoint wrote one.
      if (command === 'compact-after-tool' && target !== '') {
        if (last?.role === 'tool') {
          respond(response, body, COMPACTION_SUMMARY)
          return
        }
        respondToolCall(response, body, 'write', { path: target, content: marker })
        return
      }
      // The paused arrival (`upstream-compaction-paused`): a background job is still running when
      // the endpoint answers with the summary, so the engine settles with `awaitingAsyncWork`
      // instead of ending the turn. The job is the first tool call; the write is the second, so a
      // tool result precedes the summary exactly as in the terminal case.
      if (command === 'compact-while-background' && target !== '') {
        // Count only the results this command's turn produced: the history the scenario filled
        // beforehand already carries tool results of its own.
        const start = messages.findIndex(
          message => message.role === 'user' && messageText(message).includes('compact-while-background'),
        )
        const toolResults = start < 0 ? 0 : messages.slice(start).filter(message => message.role === 'tool').length
        if (toolResults === 0) {
          respondToolCall(response, body, 'bash', { command: 'node -e "setTimeout(()=>{},8000)"', async: true })
          return
        }
        if (toolResults === 1) {
          respondToolCall(response, body, 'write', { path: target, content: marker })
          return
        }
        respond(response, body, COMPACTION_SUMMARY)
        return
      }
      // The tool result came back: end the turn. This is also how a blocked write arrives - as a
      // tool error the model reads - so the scenario can assert the guard's message.
      if (last?.role === 'tool') {
        respond(response, body, 'done')
        return
      }
      if (command === 'read-range' && target !== '') {
        respondToolCall(response, body, 'read', { path: `${target}:1-1` })
        return
      }
      if (command === 'read-whole' && target !== '') {
        respondToolCall(response, body, 'read', { path: target })
        return
      }
      if (command === 'write-file' && target !== '') {
        respondToolCall(response, body, 'write', { path: target, content: marker })
        return
      }
      // The `ask` tool's form surface: one agent-written form, answered by the scenario through the
      // `form` dialog the host raises for it. The prompt text is the shape the tool's own prompt
      // asks for - a fieldset of radios, a checkbox group, a text field and context to decide on.
      if (command === 'ask-form') {
        respondToolCall(response, body, 'ask', { html: ASK_FORM })
        return
      }
      if (command === 'vibe-spawn') {
        respondToolCall(response, body, 'vibe_spawn', {
          cli: target === 'good' ? 'good' : 'fast',
          name: marker === 'from-model' ? 'held-worker' : marker,
          prompt: 'hold',
        })
        return
      }
      if (command === 'hold' || text.trim().endsWith('hold')) {
        // The request the scenario has work in flight under: never answered, so the turn that made
        // it stays running until something aborts it.
        held.push(response)
        return
      }
      if (command === 'external-write' && target !== '') {
        // A writer the guard never hears from: a command, an editor or a subagent. It changes the
        // bytes on disk between this conversation's read and its next write.
        fs.writeFileSync(target, marker)
        respond(response, body, 'done')
        return
      }
      respond(response, body, 'ok')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('the mock provider did not bind a port')
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    seen,
    stop: () => {
      // A held request keeps its socket open, and `close()` waits for open sockets: the turns
      // still waiting on one belong to sessions the scenario has already ended.
      for (const response of held) {
        if (!response.writableEnded) response.destroy()
      }
      held.length = 0
      server.close()
    },
  }
}

/**
 * The form the `ask-form` command makes the model write.
 *
 * It carries one of each control the tool's prompt documents - a radio group with its recommendation
 * preselected, a checkbox group, a numeric field with a bound, and a paragraph of context - so the
 * scenario exercises the whole projection rather than one field.
 */
const ASK_FORM = `<form>
  <p>Sessions live in memory and are lost on restart.</p>
  <fieldset>
    <legend>Session store</legend>
    <label><input type="radio" name="store" value="sqlite" checked> SQLite</label>
    <label><input type="radio" name="store" value="redis"> Redis</label>
  </fieldset>
  <fieldset>
    <legend>Optional extras</legend>
    <label><input type="checkbox" name="extras" value="metrics"> Metrics</label>
    <label><input type="checkbox" name="extras" value="tracing"> Tracing</label>
  </fieldset>
  <label>Session lifetime (days) <input type="number" name="ttl_days" value="30" min="1"></label>
</form>`

/**
 * The summary an upstream endpoint writes when it compacts a conversation on its own.
 *
 * Its envelope is the one those endpoints ask their model for - an `<analysis>` block, then the
 * `<summary>` document - and the host recognizes it by that shape plus the fact that a tool result
 * preceded it. The body is long enough to be a real handoff and carries a marker the scenario
 * looks for in the transcript afterwards.
 */
const COMPACTION_SUMMARY = `<analysis>
The conversation has outgrown what the endpoint will carry, so it is being summarized here.
</analysis>
<summary>
## Goal
smoke marker: adopt this summary as the conversation's context.

## Progress
- [x] the tool call under test ran
- [x] the endpoint answered with a summary instead of the work

## Next Steps
1. continue the turn from this summary.
${'detail the successor needs to resume without the transcript.\n'.repeat(6)}
</summary>`

/** Writes one assistant answer, streaming or whole according to the request. */
function respond(response: http.ServerResponse, request: ChatRequest, text: string): void {
  if (request.stream === false) {
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(jsonBody({ role: 'assistant', content: text }, 'stop'))
    return
  }
  const body = chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n'
  response.writeHead(200, { 'content-type': 'text/event-stream' }).end(body)
}

/** Writes one assistant tool call, streaming or whole according to the request. */
function respondToolCall(
  response: http.ServerResponse,
  request: ChatRequest,
  name: string,
  args: Record<string, unknown>,
): void {
  const call = {
    id: `call_${Math.random().toString(36).slice(2, 10)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
  if (request.stream === false) {
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(
        jsonBody(
          { role: 'assistant', content: null, tool_calls: [{ ...call, index: 0 }] },
          'tool_calls',
        ),
      )
    return
  }
  const body =
    chunk({ role: 'assistant', tool_calls: [{ ...call, index: 0 }] }, null) +
    chunk({}, 'tool_calls') +
    'data: [DONE]\n\n'
  response.writeHead(200, { 'content-type': 'text/event-stream' }).end(body)
}
