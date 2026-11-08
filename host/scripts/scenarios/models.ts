/**
 * The engine's model roles, and the provider credential the desktop pushes into a *running* engine.
 *
 * Split out of `scenarios.ts` because these two are the only scenarios that need the keyed fixture
 * provider (`rules.md#single-file-line-limit`).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { dataRoot, workspace } from '../client.ts'
import {
  OMP_DESKTOP_SMOKE_KEYED_MODEL,
  OMP_DESKTOP_SMOKE_KEYED_PROVIDER,
  OMP_DESKTOP_SMOKE_MODEL,
  OMP_DESKTOP_SMOKE_PROVIDER,
  OMP_DESKTOP_SMOKE_THINKING,
} from '../fixtures.ts'
import type { Scenario } from '../harness.ts'

/** The role table a `model_roles` / `model_role_set` answer carries; a refusal carries none. */
function roleTable(response: Record<string, unknown>): Array<Record<string, unknown>> {
  const data = (response.data ?? {}) as Record<string, unknown>
  return Array.isArray(data.roles) ? (data.roles as Array<Record<string, unknown>>) : []
}

/** The role-table and credential scenarios, keyed the way the driver names them. */
export const modelsScenarios: Record<string, Scenario> = {
  async roles(host, report) {
    // Roles live in the engine's own settings file, and this driver never writes one for its data
    // root, so a run starts from an empty `modelRoles`: no row may carry an assignment of its own.
    // Whether an *unassigned* role still resolves is the engine's own business - keyless runners
    // (`web/parallel`, `local/kokoro`) resolve with no credential at all - so the count is reported
    // rather than asserted, while the assignment-free table is what a leftover from an earlier run
    // (or an operator pointing OMP_DESKTOP_SMOKE_DATA_ROOT at a real root) would break.
    const table = await host.response(host.send({ type: 'model_roles' }))
    const rows = roleTable(table)
    const ids = rows.map(row => String(row.id))
    const sections = [...new Set(rows.map(row => String(row.section)))].sort().join(',')
    report.record(
      'roles.table',
      table.success === true && rows.length >= 15 && ids.includes('default') && ids.includes('judge') && sections === 'chat,kind',
      `success=${String(table.success)} rows=${rows.length} sections=${sections || 'none'} missing=${['default', 'judge'].filter(id => !ids.includes(id)).join(',') || 'none'}`,
    )
    const unexpected = rows.filter(row => row.configured !== false || row.value !== null || row.autoSelected !== true)
    const resolved = rows.filter(row => row.model !== null).length
    report.record(
      'roles.unconfigured',
      rows.length > 0 && unexpected.length === 0,
      `rows=${rows.length} unexpected=${unexpected.length} resolved=${resolved} ${JSON.stringify(unexpected.slice(0, 2))}`,
    )

    // Per-role candidates are the pool a selector has to resolve against, capped and said so.
    const candidates = await host.response(host.send({ type: 'model_role_candidates', role: 'vision' }))
    const candidateData = (candidates.data ?? {}) as Record<string, unknown>
    report.record(
      'roles.candidates',
      candidates.success === true && candidateData.role === 'vision' && Array.isArray(candidateData.models) && typeof candidateData.truncated === 'boolean',
      `success=${String(candidates.success)} role=${String(candidateData.role)} models=${Array.isArray(candidateData.models) ? candidateData.models.length : 'none'} truncated=${String(candidateData.truncated)}`,
    )

    const candidateModels = Array.isArray(candidateData.models)
      ? candidateData.models as Array<Record<string, unknown>>
      : []
    const fixtureSummary = candidateModels.find(model => model.provider === OMP_DESKTOP_SMOKE_PROVIDER && model.id === OMP_DESKTOP_SMOKE_MODEL)
    const fixtureThinkingLevels = fixtureSummary?.thinkingLevels
    report.record(
      'roles.modelThinkingLevels',
      JSON.stringify(fixtureThinkingLevels) === '["off","low","medium"]',
      `model=${OMP_DESKTOP_SMOKE_PROVIDER}/${OMP_DESKTOP_SMOKE_MODEL} thinkingLevels=${JSON.stringify(fixtureThinkingLevels)}`,
    )

    // A write is refused before it can persist: a role the engine does not know, and a selector no
    // model in that role's pool matches.
    const unknownRole = await host.response(host.send({ type: 'model_role_set', role: 'no-such-role', selector: `${OMP_DESKTOP_SMOKE_PROVIDER}/${OMP_DESKTOP_SMOKE_MODEL}` }))
    report.record('roles.unknownRole', unknownRole.success === false && unknownRole.code === 'invalid_input', JSON.stringify(unknownRole).slice(0, 180))
    const unresolvable = await host.response(host.send({ type: 'model_role_set', role: 'vision', selector: 'no-such-provider/no-such-model' }))
    report.record('roles.unresolvableSelector', unresolvable.success === false && unresolvable.code === 'invalid_input', JSON.stringify(unresolvable).slice(0, 180))

    // The write path is proved by a value that can be read back: `vision` accepts the fixture's
    // chat model, so the row must come back configured, carrying the selector it was given.
    const selector = `${OMP_DESKTOP_SMOKE_PROVIDER}/${OMP_DESKTOP_SMOKE_MODEL}`
    const assigned = await host.response(host.send({ type: 'model_role_set', role: 'vision', selector }))
    const afterAssign = roleTable(assigned).find(row => row.id === 'vision')
    const assignModel = afterAssign === undefined ? null : (afterAssign.model as Record<string, unknown> | null)
    report.record(
      'roles.assign',
      assigned.success === true && roleTable(assigned).length === rows.length && afterAssign !== undefined &&
        afterAssign.configured === true && afterAssign.value === selector && afterAssign.autoSelected === false &&
        assignModel !== null && assignModel.id === OMP_DESKTOP_SMOKE_MODEL,
      `vision=${JSON.stringify(afterAssign)} selector=${selector}`,
    )

    // Clearing is a write too, and it is the one that leaves the data root the way it was found.
    const cleared = await host.response(host.send({ type: 'model_role_set', role: 'vision', selector: null }))
    const clearedRows = roleTable(cleared)
    const afterClear = clearedRows.find(row => row.id === 'vision')
    report.record(
      'roles.clear',
      cleared.success === true && clearedRows.length === rows.length && afterClear !== undefined &&
        afterClear.configured === false && afterClear.value === null && afterClear.model === null && afterClear.autoSelected === true,
      `vision=${JSON.stringify(afterClear)}`,
    )

    const opened = (await host.response(host.send({ type: 'session_open', cwd: workspace }))).data as Record<string, unknown>
    const sessionId = opened.sessionId as string
    const openedState = opened.state as Record<string, unknown>
    const openedThinkingLevels = openedState.thinkingLevels
    report.record(
      'roles.openStateThinkingLevels',
      JSON.stringify(openedThinkingLevels) === '["auto","off","low","medium"]',
      `thinkingLevels=${JSON.stringify(openedThinkingLevels)}`,
    )

    // The `default` row is the model a new conversation starts on - that is what makes the
    // composer's name for it true. Unassigned, it reports the engine's own startup pick, so the
    // row must equal the model this untouched session actually opened on.
    const defaultRow = rows.find(row => row.id === 'default')
    const defaultModel = (defaultRow?.model ?? null) as Record<string, unknown> | null
    const openedModel = openedState.model as Record<string, unknown> | undefined
    report.record(
      'roles.defaultMatchesSession',
      defaultRow !== undefined && defaultRow.configured === false && defaultRow.autoSelected === true &&
        defaultModel !== null && openedModel !== undefined &&
        defaultModel.provider === openedModel.provider && defaultModel.id === openedModel.id,
      `row=${JSON.stringify(defaultModel)} session=${JSON.stringify(openedModel)}`,
    )
    const modelResponse = await host.response(host.send({
      type: 'session_set_model',
      sessionId,
      provider: OMP_DESKTOP_SMOKE_PROVIDER,
      modelId: OMP_DESKTOP_SMOKE_MODEL,
    }))
    const modelState = ((modelResponse.data ?? {}) as Record<string, unknown>).state as Record<string, unknown> | undefined
    const stateThinkingLevels = modelState?.thinkingLevels
    report.record(
      'roles.stateThinkingLevels',
      modelResponse.success === true && JSON.stringify(stateThinkingLevels) === '["auto","off","low","medium"]',
      `success=${String(modelResponse.success)} thinkingLevels=${JSON.stringify(stateThinkingLevels)}`,
    )

    const adapted = await host.response(host.send({ type: 'session_set_thinking', sessionId, level: OMP_DESKTOP_SMOKE_THINKING }))
    const adaptedState = ((adapted.data ?? {}) as Record<string, unknown>).state as Record<string, unknown> | undefined
    const applied = adaptedState?.thinkingLevel
    const adaptedLevels: unknown[] = Array.isArray(adaptedState?.thinkingLevels) ? adaptedState.thinkingLevels : []
    report.record(
      'roles.thinkingAdapts',
      adapted.success === true && applied === 'medium' && adaptedLevels.includes(applied),
      `success=${String(adapted.success)} thinkingLevel=${String(applied)} levels=${JSON.stringify(adaptedLevels)}`,
    )

    const bogus = await host.response(host.send({ type: 'session_set_thinking', sessionId, level: 'bogus' }))
    report.record(
      'roles.thinkingRejectsUnknown',
      bogus.success === false && bogus.code === 'invalid_input',
      JSON.stringify(bogus).slice(0, 180),
    )

    // A model with no reasoning surface answers with no stops at all - not with `auto`, and not with
    // the padded `off`/`auto` pair that used to draw a strength slider over a model that cannot
    // think. The fixture's second model carries no `reasoning:` line, so the engine reads it as
    // `false` (2026-10-29, user report: an unchecked "supports reasoning" box still offered `max`).
    const plainSelector = { provider: OMP_DESKTOP_SMOKE_KEYED_PROVIDER, modelId: OMP_DESKTOP_SMOKE_KEYED_MODEL }
    const plainResponse = await host.response(host.send({ type: 'session_set_model', sessionId, ...plainSelector }))
    const plainState = ((plainResponse.data ?? {}) as Record<string, unknown>).state as Record<string, unknown> | undefined
    report.record(
      'roles.thinkingLevelsNoReasoning',
      plainResponse.success === true && JSON.stringify(plainState?.thinkingLevels) === '[]',
      `success=${String(plainResponse.success)} thinkingLevels=${JSON.stringify(plainState?.thinkingLevels)}`,
    )
    const plainCatalogue = await host.response(host.send({ type: 'session_config', sessionId }))
    const plainModels = Array.isArray((plainCatalogue.data as Record<string, unknown> | undefined)?.models)
      ? (plainCatalogue.data as Record<string, unknown>).models as Array<Record<string, unknown>>
      : []
    const plainSummary = plainModels.find(model => model.provider === OMP_DESKTOP_SMOKE_KEYED_PROVIDER && model.id === OMP_DESKTOP_SMOKE_KEYED_MODEL)
    report.record(
      'roles.catalogueThinkingLevelsNoReasoning',
      plainSummary !== undefined && plainSummary.reasoning === false && JSON.stringify(plainSummary.thinkingLevels) === '[]',
      `summary=${JSON.stringify(plainSummary)}`,
    )
    // Back to the reasoning model: the reads below are about ITS ladder and the session's own model.
    await host.response(host.send({
      type: 'session_set_model',
      sessionId,
      provider: OMP_DESKTOP_SMOKE_PROVIDER,
      modelId: OMP_DESKTOP_SMOKE_MODEL,
    }))

    // The other half of the same promise: an assignment wins over the engine's pick, and clearing
    // it hands the decision back. Both are read back through a conversation opened afterwards,
    // which is where a role's answer has to be visible.
    const assignedDefault = await host.response(host.send({ type: 'model_role_set', role: 'default', selector }))
    const assignedDefaultRow = roleTable(assignedDefault).find(row => row.id === 'default')
    const assignedDefaultOk = assignedDefaultRow !== undefined && assignedDefaultRow.configured === true &&
      assignedDefaultRow.value === selector
    const second = (await host.response(host.send({ type: 'session_open', cwd: workspace }))).data as Record<string, unknown>
    const secondModel = (second.state as Record<string, unknown>).model as Record<string, unknown> | undefined
    report.record(
      'roles.defaultAssignedWins',
      assignedDefault.success === true && assignedDefaultOk &&
        secondModel !== undefined && secondModel.provider === OMP_DESKTOP_SMOKE_PROVIDER && secondModel.id === OMP_DESKTOP_SMOKE_MODEL,
      `row=${JSON.stringify(assignedDefaultRow)} session=${JSON.stringify(secondModel)}`,
    )
    host.send({ type: 'session_close', sessionId: second.sessionId as string })
    const clearedDefault = await host.response(host.send({ type: 'model_role_set', role: 'default', selector: null }))
    const clearedDefaultRow = roleTable(clearedDefault).find(row => row.id === 'default')
    const clearedDefaultOk = clearedDefaultRow !== undefined && clearedDefaultRow.configured === false &&
      clearedDefaultRow.autoSelected === true && clearedDefaultRow.model !== null
    report.record(
      'roles.defaultCleared',
      clearedDefault.success === true && clearedDefaultOk,
      `row=${JSON.stringify(clearedDefaultRow)}`,
    )
    host.send({ type: 'session_close', sessionId })

    host.send({ type: 'host_shutdown', reason: 'roles' })
    const exit = await host.finish()
    report.record('roles.exit', exit === 0, `exit=${exit}`)
    return { rows: rows.length, sections, vision: afterClear, stateThinkingLevels, applied, defaultModel: defaultModel ?? null }
  },

  /**
   * The provider credential the desktop pushes into the running engine: set, rotate, clear.
   *
   * The fixture's `smoke-keyed` provider is authenticated by a `models.yml` `apiKey:` that names an
   * environment variable no host under test has set, and the engine reads that name as the literal
   * key when the variable is absent - so the catalogue lists the model while the credential in play
   * is not a real one. These commands do not repair that file (the scenario proves it is untouched);
   * they hand the engine the key the desktop keeps in its own keyring, as an in-memory runtime
   * override that outranks the config key. Every answer is also checked for the secret's absence,
   * because the one thing this path must never do is echo it back.
   */
  async credentials(host, report) {
    const modelsFile = path.join(dataRoot, 'host', 'agent', 'models.yml')
    const before = fs.readFileSync(modelsFile, 'utf8')

    // The control: the config `apiKey:` name alone marks the provider authenticated, so its model
    // is in the catalogue before any runtime key is pushed.
    const reload = await host.response(host.send({ type: 'models_reload' }))
    const catalogue = (reload.data ?? {}) as Record<string, unknown>
    const models = Array.isArray(catalogue.models) ? catalogue.models as Array<Record<string, unknown>> : []
    const listed = models.some(model => model.provider === OMP_DESKTOP_SMOKE_KEYED_PROVIDER && model.id === OMP_DESKTOP_SMOKE_KEYED_MODEL)
    report.record(
      'credentials.catalog',
      reload.success === true && listed,
      `success=${String(reload.success)} models=${models.length} listed=${String(listed)}`,
    )

    // The push: the answer carries the provider and the source kind, and never the key itself.
    const set = await host.response(host.send({
      type: 'provider_key_set',
      providerId: OMP_DESKTOP_SMOKE_KEYED_PROVIDER,
      apiKey: 'smoke-secret-value',
    }))
    const setData = (set.data ?? {}) as Record<string, unknown>
    report.record(
      'credentials.set',
      set.success === true && setData.provider === OMP_DESKTOP_SMOKE_KEYED_PROVIDER && setData.source === 'runtime' &&
        !JSON.stringify(set).includes('smoke-secret-value'),
      `success=${String(set.success)} provider=${String(setData.provider)} source=${String(setData.source)} echoed=${String(JSON.stringify(set).includes('smoke-secret-value'))}`,
    )

    // Rotation is the same write with a new value: the override is replaced, not appended.
    const rotated = await host.response(host.send({
      type: 'provider_key_set',
      providerId: OMP_DESKTOP_SMOKE_KEYED_PROVIDER,
      apiKey: 'smoke-secret-rotated',
    }))
    const rotatedData = (rotated.data ?? {}) as Record<string, unknown>
    report.record(
      'credentials.rotate',
      rotated.success === true && rotatedData.source === 'runtime' && !JSON.stringify(rotated).includes('smoke-secret-rotated'),
      `success=${String(rotated.success)} source=${String(rotatedData.source)} echoed=${String(JSON.stringify(rotated).includes('smoke-secret-rotated'))}`,
    )

    // Clearing drops the override, so the provider falls back to the `models.yml` config key.
    const cleared = await host.response(host.send({ type: 'provider_key_clear', providerId: OMP_DESKTOP_SMOKE_KEYED_PROVIDER }))
    const clearedData = (cleared.data ?? {}) as Record<string, unknown>
    report.record(
      'credentials.clear',
      cleared.success === true && clearedData.provider === OMP_DESKTOP_SMOKE_KEYED_PROVIDER && clearedData.source === 'config',
      `success=${String(cleared.success)} provider=${String(clearedData.provider)} source=${String(clearedData.source)}`,
    )

    // Bounds: an empty provider id and an oversized key are both refused before anything is set.
    const emptyProvider = await host.response(host.send({ type: 'provider_key_set', providerId: '', apiKey: 'x' }))
    report.record('credentials.boundsProvider', emptyProvider.success === false && emptyProvider.code === 'invalid_input', JSON.stringify(emptyProvider).slice(0, 180))
    const longKey = await host.response(host.send({ type: 'provider_key_set', providerId: OMP_DESKTOP_SMOKE_KEYED_PROVIDER, apiKey: 'k'.repeat(5_000) }))
    report.record('credentials.boundsKey', longKey.success === false && longKey.code === 'invalid_input', JSON.stringify(longKey).slice(0, 180))

    // A rotation pool on the keyless fixture: the engine's own selector must see both rows, and a
    // one-key replacement must go back through the environment tier.
    const pooled = await host.response(host.send({
      type: 'provider_keys_set',
      providerId: OMP_DESKTOP_SMOKE_PROVIDER,
      apiKeys: ['smoke-pool-one', 'smoke-pool-two'],
    }))
    const pooledData = (pooled.data ?? {}) as Record<string, unknown>
    report.record(
      'credentials.pool',
      pooled.success === true && pooledData.source === 'api_key' && pooledData.count === 2 &&
        !JSON.stringify(pooled).includes('smoke-pool-one'),
      `success=${String(pooled.success)} source=${String(pooledData.source)} count=${String(pooledData.count)} echoed=${String(JSON.stringify(pooled).includes('smoke-pool-one'))}`,
    )
    const single = await host.response(host.send({
      type: 'provider_keys_set',
      providerId: OMP_DESKTOP_SMOKE_PROVIDER,
      apiKeys: ['smoke-pool-two'],
    }))
    const singleData = (single.data ?? {}) as Record<string, unknown>
    // The fixture keeps `auth: none` (this frame does not rewrite `models.yml`), so the pool row is
    // what authenticates; the real Rust writer adds `apiKey: <variable>` for a one-key provider,
    // and the engine then reports `config` instead.
    report.record(
      'credentials.poolSingle',
      single.success === true && singleData.source === 'api_key' && singleData.count === 1,
      `success=${String(single.success)} source=${String(singleData.source)} count=${String(singleData.count)}`,
    )
    const poolCleared = await host.response(host.send({
      type: 'provider_key_clear',
      providerId: OMP_DESKTOP_SMOKE_PROVIDER,
    }))
    const poolClearedData = (poolCleared.data ?? {}) as Record<string, unknown>
    report.record(
      'credentials.poolClear',
      poolCleared.success === true && poolClearedData.source === null,
      `success=${String(poolCleared.success)} source=${String(poolClearedData.source)}`,
    )

    // Nothing above touched the file: the fixture is byte-for-byte what it was.
    const after = fs.readFileSync(modelsFile, 'utf8')
    report.record('credentials.modelsUnchanged', before === after, `bytes=${before.length}->${after.length}`)

    host.send({ type: 'host_shutdown', reason: 'credentials' })
    const exit = await host.finish()
    report.record('credentials.exit', exit === 0, `exit=${exit}`)
    return {
      listed,
      sources: { set: setData.source ?? null, rotated: rotatedData.source ?? null, cleared: clearedData.source ?? null },
    }
  },

  /**
   * A model's context information edited while a conversation is open.
   *
   * The desktop's settings write a custom model's `contextWindow` into `models.yml` and then ask the
   * host to re-read it (`models_reload`), which is the whole of what the reader's edit does. What has
   * to follow is the *open* conversation: a session holds the model object it was bound to, and the
   * engine reads that object for the context window and for where the window would be compacted, so
   * without a rebind the field says one thing and the gauge and the compaction boundary say another
   * until the conversation is reopened. The window is doubled in the fixture, the reload is asked
   * for, and both halves are checked: the answer says how many sessions moved, and the session's own
   * channel carries the new window without the session being reopened.
   *
   * The fixture file is restored whatever happens, because every scenario after this one reads the
   * same catalogue.
   */
  async 'model-metadata'(host, report) {
    const modelsFile = path.join(dataRoot, 'host', 'agent', 'models.yml')
    const original = fs.readFileSync(modelsFile, 'utf8')
    const windowOf = (state: Record<string, unknown>): number => {
      const usage = state.contextUsage as Record<string, unknown> | undefined
      return typeof usage?.contextWindow === 'number' ? usage.contextWindow : 0
    }
    let measured = 0
    try {
      const opened = await host.response(host.send({ type: 'session_open', cwd: workspace }))
      const sessionId = (opened.data as Record<string, unknown>).sessionId as string
      const selected = await host.response(host.send({
        type: 'session_set_model',
        sessionId,
        provider: OMP_DESKTOP_SMOKE_PROVIDER,
        modelId: OMP_DESKTOP_SMOKE_MODEL,
      }))
      measured = windowOf((selected.data as Record<string, unknown>).state as Record<string, unknown>)
      report.record('model-metadata.before', measured === 128_000, `contextWindow=${measured}`)

      // The reader's edit, as the settings page writes it: the same entry, one number larger.
      const edited = measured * 2
      fs.writeFileSync(
        modelsFile,
        original.replace(
          new RegExp(`(id: ${OMP_DESKTOP_SMOKE_MODEL}\\b[\\s\\S]*?contextWindow: )\\d+`),
          `$1${edited}`,
        ),
        'utf8',
      )
      const framesBefore = host.of('state').length
      const reload = await host.response(host.send({ type: 'models_reload' }))
      const reloadData = (reload.data ?? {}) as Record<string, unknown>
      report.record(
        'model-metadata.rebound',
        reload.success === true && reloadData.rebound === 1,
        `success=${String(reload.success)} rebound=${String(reloadData.rebound)}`,
      )

      // The open conversation follows without being reopened: the host republishes its state, and
      // that frame is where the new window is read from.
      await host.waitFor(
        'state',
        frame => frame.type === 'state' && windowOf(frame.state as Record<string, unknown>) === edited,
        15_000,
      ).catch(() => undefined)
      const republished = host.of('state').slice(framesBefore)
        .some(frame => windowOf(frame.state as Record<string, unknown>) === edited)
      report.record('model-metadata.republished', republished, `${host.of('state').length - framesBefore} state frame(s)`)

      const read = await host.response(host.send({ type: 'session_state', sessionId }))
      const after = windowOf((read.data as Record<string, unknown>).state as Record<string, unknown>)
      report.record('model-metadata.after', after === edited, `contextWindow=${after} expected=${edited}`)

      const closed = await host.response(host.send({ type: 'session_close', sessionId }))
      report.record('model-metadata.close', closed.success === true, 'closed')
      return { before: measured, after }
    } finally {
      fs.writeFileSync(modelsFile, original, 'utf8')
      host.send({ type: 'host_shutdown', reason: 'model-metadata' })
      const exit = await host.finish()
      report.record('model-metadata.exit', exit === 0, `exit=${exit}`)
    }
  },
}
