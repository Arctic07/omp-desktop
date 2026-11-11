/**
 * The `ask` tool's form surface against a real engine.
 *
 * Since engine 18.18.3 the tool asks with one HTML `<form>` and prefers `ui.formDialog`
 * (`tools/ask.ts`). The unit tests (`src/ui-form.test.ts`) decide how a parsed form projects onto
 * the wire and how an answer comes back; this scenario is the other half: that the engine reaches
 * the host's form surface at all, that the frame carries the document the model wrote, and that the
 * answer the scenario submits is what the tool reports to the model.
 *
 * Driven by the deterministic provider (`scripts/mock-provider.ts`, the `ask-form` command), so the
 * scenario is opt-in: it dials a model.
 */

import type { HostProcess } from '../client.ts'
import type { Report, Scenario } from '../harness.ts'
import { openSession, selectModel, turn, waitIdle } from './session-flow.ts'

/** The dialog frames a session was asked to answer. */
function formRequests(host: HostProcess, sessionId: string): Record<string, unknown>[] {
  return host
    .of('extension_ui_request')
    .filter(frame => frame.sessionId === sessionId && frame.method === 'form')
}

export const askFormScenarios: Record<string, Scenario> = {
  async 'ask-form'(host: HostProcess, report: Report) {
    const sessionId = await openSession(host, report, 'form')
    await selectModel(host, sessionId, report, 'form')

    // The turn is held open by the tool: the prompt resolves only after the form is answered.
    const prompt = host.send({ type: 'session_prompt', sessionId, message: 'ask-form' })
    const request = await host.waitFor<Record<string, unknown>>(
      'form dialog',
      frame => frame.type === 'extension_ui_request' && frame.sessionId === sessionId && frame.method === 'form',
      120_000,
    )
    report.record('form.asked', typeof request.id === 'string', `id=${String(request.id)}`)

    // The document the model wrote arrives whole: its context paragraph, its two fieldsets and its
    // text field, each a block the desktop can draw.
    const sections = (request.sections ?? []) as Array<Record<string, unknown>>
    const fields = (request.fields ?? []) as Array<Record<string, unknown>>
    const blocks = sections.flatMap(section => (section.blocks ?? []) as Array<Record<string, unknown>>)
    report.record(
      'form.document',
      sections.length > 0 && fields.length === 3,
      `sections=${sections.length} fields=${fields.map(field => String(field.name)).join(',')}`,
    )
    report.record(
      'form.context',
      blocks.some(block => block.kind === 'text') &&
        blocks.some(block => block.kind === 'field'),
      `blocks=${blocks.map(block => String(block.kind)).join(',')}`,
    )

    const store = fields.find(field => field.name === 'store')
    const options = (store?.options ?? []) as Array<Record<string, unknown>>
    report.record(
      'form.preselected',
      options.some(option => option.checked === true),
      `store=${options.map(option => `${String(option.value)}${option.checked === true ? '*' : ''}`).join(',')}`,
    )

    // Answer as the desktop does: per control, by name. The engine reports this data to the model,
    // and the turn ends on the tool result.
    const answered = await host.response(
      host.send({
        type: 'session_ui_response',
        sessionId,
        requestId: String(request.id),
        response: {
          answers: [
            { name: 'store', value: 'redis' },
            { name: 'extras', value: ['metrics', 'tracing'] },
            { name: 'ttl_days', value: 7 },
          ],
        },
      }),
      60_000,
    )
    report.record('form.answered', answered.success === true, JSON.stringify(answered).slice(0, 200))

    await host.response(prompt, 120_000)
    await host.waitFor('agent_end', frame => frame.sessionId === sessionId && frame.type === 'agent_end', 60_000)
    await waitIdle(host, sessionId)

    // The model received the submitted data as JSON. The assertion reads the tool **result** entry,
    // not the whole transcript: the call's own arguments carry the form HTML, which already contains
    // every option value, so a transcript-wide `includes` would pass even if the answer were dropped.
    //
    // This page is the engine's own message shape (`role` / `content`), not the desktop's projected
    // rows, so the result is the `toolResult` entry's text.
    const page = await host.response(host.send({ type: 'session_history_page', sessionId }), 60_000)
    const rows = ((page.data as Record<string, unknown> | undefined)?.messages ?? []) as Array<{
      role?: string
      toolName?: string
      content?: Array<{ type?: string; text?: string }>
    }>
    const askResult = rows.find(row => row.role === 'toolResult' && row.toolName === 'ask')
    const resultText = (askResult?.content ?? [])
      .filter((part): part is { type?: string; text: string } => typeof part.text === 'string')
      .map(part => part.text)
      .join('')
    report.record(
      'form.reported',
      resultText.includes('"redis"') && resultText.includes('"metrics"') && resultText.includes('"tracing"'),
      resultText.slice(0, 160),
    )

    await host.response(host.send({ type: 'session_close', sessionId }), 60_000)
    return { fields: fields.length, sections: sections.length }
  },
}
