/**
 * `agent.complete`: one completion on the models this application is already configured with
 * (`omp.desktop` API 0.2.0).
 *
 * The interesting half of this file is what it does **not** do. It does not choose a provider, read
 * an API key itself, or speak any provider's protocol: the model comes from the engine's own role
 * chain over the registry the host booted (`boot.ts`), the key from that registry's resolver, and the
 * call from `@oh-my-pi/pi-ai`'s `completeSimple` through the SDK seam (`sdk.ts`). A second
 * implementation of "which model, with which key" would be exactly the kind of copy `rules.md#plugin-system`
 * forbids, and it would drift from the one in the composer menu on the first provider change.
 *
 * What it *does* own:
 *
 * - **The model a completion runs on, when the caller named none.** The `default` role is the role a
 *   conversation with no recorded model starts on, resolved the same way `models.ts` resolves it for
 *   the role table - through the role's own alias, then through the engine's authenticated default
 *   pick - so a plugin gets the model the user's next new conversation would get.
 * - **The answer's shape.** `{ text, usage }` and nothing else: a plugin is handed the words and what
 *   they cost, not the engine's message objects, which are this application's internal shape.
 *
 * The budgets are not here (`services::plugins::agent_budget` in Rust counts them), and neither is
 * the permission: both were decided before a frame reached this process.
 */

import type { BootServices } from './boot.ts'
import { ERROR_CODES, HostError, invalidInput } from './protocol/errors.ts'
import type { SdkBundle } from './sdk.ts'

/** One completion, as the plugin's bridge call asked for it. */
export interface CompletionRequest {
  readonly prompt: string
  readonly system?: string
  readonly model?: string
  readonly maxTokens: number
}

/** One completion, as the plugin receives it: the words, and what they cost. */
export interface CompletionAnswer {
  readonly text: string
  readonly usage: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
    readonly reasoning: number
    readonly costUsd: number
  }
}

/** The same answer as the frame's own type: the dispatcher carries plain records. */
function asFrame(answer: CompletionAnswer): Record<string, unknown> {
  return { text: answer.text, usage: answer.usage }
}

/** Reads one frame's fields, refusing the shapes this side does not serve. */
export function readRequest(frame: Record<string, unknown>): CompletionRequest {
  const prompt = frame.prompt
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw invalidInput('agent.complete needs a prompt.')
  }
  const system = frame.system
  if (system !== undefined && system !== null && typeof system !== 'string') {
    throw invalidInput('The system prompt must be a string.')
  }
  const model = frame.model
  if (model !== undefined && model !== null && typeof model !== 'string') {
    throw invalidInput('The model selector must be a string.')
  }
  const maxTokens = frame.maxTokens
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw invalidInput('maxTokens must be a positive integer.')
  }
  return {
    prompt,
    ...(typeof system === 'string' && system !== '' ? { system } : {}),
    ...(typeof model === 'string' && model !== '' ? { model } : {}),
    maxTokens,
  }
}

/**
 * Runs one completion and answers it.
 *
 * A completion the provider refused is this process's failure, not the plugin's: the plugin asked a
 * well-formed question and the answer could not be produced, which is what `ENGINE_REQUEST_FAILED`
 * says. The engine's own sentence travels with it, because a plugin author looking at "no model
 * available" has to know whether the user has no key or whether the selector was wrong.
 */
export async function complete(
  sdk: SdkBundle,
  services: BootServices,
  request: CompletionRequest,
): Promise<Record<string, unknown>> {
  const { settings, registry } = services
  const available = registry.getAvailable()
  const matchPreferences = sdk.getModelMatchPreferences(settings)
  const resolved = request.model !== undefined
    ? sdk.resolveModelRoleValue(request.model, available, { settings, matchPreferences })
    : sdk.resolveModelRoleValue('@default', sdk.roleCandidatePool('default', settings, registry), {
        settings,
        matchPreferences,
      })
  const model = resolved.model ?? sdk.pickDefaultAvailableModel(
    available.filter(candidate => registry.hasConfiguredAuth(candidate)),
    provider => registry.hasConcreteAuth(provider),
  )
  if (model === undefined) {
    throw new HostError(ERROR_CODES.engine_request_failed, 'No model is available on this machine.')
  }
  const apiKey = await registry.getApiKey(model)
  if (!apiKey) {
    throw new HostError(
      ERROR_CODES.engine_request_failed,
      `No API key is available for ${model.provider}/${model.id}.`,
    )
  }
  const response = await sdk.completeSimple(
    model,
    {
      ...(request.system === undefined ? {} : { systemPrompt: [request.system] }),
      messages: [{ role: 'user', content: request.prompt, timestamp: Date.now() }],
    },
    {
      apiKey: registry.resolver(model),
      maxTokens: request.maxTokens,
    },
  )
  if (response.stopReason === 'error') {
    throw new HostError(
      ERROR_CODES.engine_request_failed,
      response.errorMessage ?? 'The model did not answer.',
    )
  }
  let text = ''
  for (const part of response.content) {
    if (part.type === 'text') text += part.text
  }
  const usage = response.usage
  return asFrame({
    text,
    usage: {
      input: numberField(usage, 'input'),
      output: numberField(usage, 'output'),
      cacheRead: numberField(usage, 'cacheRead'),
      cacheWrite: numberField(usage, 'cacheWrite'),
      reasoning: numberField(usage, 'reasoning'),
      costUsd: numberField(usage, 'costUsd'),
    },
  })
}

/** One usage field, as a number: the engine leaves a counter it does not have undefined. */
function numberField(usage: unknown, name: string): number {
  if (typeof usage !== 'object' || usage === null) return 0
  const value = (usage as Record<string, unknown>)[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
