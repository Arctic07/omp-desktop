/**
 * The plugin commands end to end, against the engine's real plugin system.
 *
 * The fixture tree these stages plant lives in `plugins.fixtures.ts`. The stages are split the way
 * they are because the engine's local-install path is not available on every machine: the
 * `PluginManager.link()` that a pasted directory path routes through calls `fs.symlink` with no
 * type, which Windows refuses with `EPERM` unless the process is elevated or Developer Mode is on.
 * A smoke that needed that call to succeed would be green only on some machines:
 *
 * 1. the read-only frames first: the empty list, the engine's own diagnostic (`plugins_engine`,
 *    checked against the numbers the greeting advertised, so an SDK or protocol move is visible on
 *    the page), and that same diagnostic plus an install in a second host whose `bun` is denied by
 *    the smoke knob - where the preflight has to answer `plugin_install_unavailable` with the tool
 *    named (spec §15.1-6).
 * 2. the real frame path - `plugins_install { source: <absolute path>, scope: "user" }` - is driven
 *    next. On success every row fact is asserted. On the engine's own refusal
 *    (`plugin_install_failed` / `plugin_invalid_spec` / `plugin_install_unavailable`) the pass
 *    condition is that the *frame* did its job: the failure was classified, code-carrying and
 *    redacted, and no partial state was reported as an install.
 * 3. the rest of the frames run against a plugin assembled the way an install leaves one: a real
 *    package directory under the plugins registry's `node_modules` plus an entry in the runtime lock
 *    file. That is the engine's own storage layout (its `PluginManager` reads the lock and the
 *    package), not a mock: discovery, the row projection, the settings lock, the enable flag and the
 *    uninstall path are the engine's. The shapes a *broken* or development install leaves behind
 *    follow in the same stage, because the list has to describe them rather than skip them.
 * 4. the plugin whose only code entry point lives in `omp.features.<name>` (a feature the engine
 *    enables by default) next to the one whose feature nothing enables: the consent gate reads the
 *    entry points the engine would really load, so these two rows differ only in whether their
 *    feature is on.
 * 5. the marketplace route, which stage 2 cannot walk on a machine without Developer Mode: a local
 *    catalog added by path and installed from by `name@marketplace`, whose Windows link is a
 *    junction (no elevation needed), driven through the toggle, a settings round trip and removal.
 *
 * Split out of `scenarios.ts` because it is the only scenario that needs the fixture tree below
 * (`rules.md#single-file-line-limit`), and it runs on a credential-free host like the other capability scenarios.
 *
 * The plugin id travels under `targetId` in every frame that addresses one plugin: `id` is the
 * client's own correlation key (`host.send` fills it in), and the desktop's Rust host overwrites it
 * before the frame is encoded - the same convention `skills_set` uses (`capabilities.ts`).
 */

import * as fs from 'node:fs'

import { HostProcess } from '../client.ts'
import type { Scenario } from '../harness.ts'
import {
  BROKEN_BLOCK_ID,
  BROKEN_INVALID_ID,
  BROKEN_MISSING_ID,
  FEATURE_DEFAULT_ID,
  FEATURE_MARKET_ID,
  FEATURE_MARKET_NAME,
  FEATURE_MARKET_ROOT,
  FEATURE_OPTIONAL_ID,
  LINK_FIXTURE_ROOT,
  DAP_FILE_ID,
  LSP_FILE_ID,
  MCP_FILE_ID,
  MARKET_B_NAME,
  MARKET_B_ROOT,
  MARKET_B_VERSION,
  MARKET_NAME,
  MARKET_PLUGIN_ID,
  MARKET_PLUGIN_NAME,
  MARKET_PLUGIN_VERSION,
  MARKET_ROOT,
  MARKET_RUNTIME_LINK,
  MARKET_SETTING_KEY,
  MARKET_SETTING_VALUE,
  CODE_SURFACE_ID,
  MARKET_PLUGIN_VERSION_NEXT,
  PLUGIN_ID,
  PLUGIN_VERSION,
  leftoverFixtures,
  plantCodeSurfaceFixture,
  plantConsentFileFixtures,
  plantDesktopFixture,
  plantEnginesMismatchFixture,
  plantFsScopeFixture,
  plantFsWholeTreeFixture,
  plantIconInvalidFixture,
  removeCodeSurfaceFixture,
  removeConsentFileFixtures,
  removeDesktopFixture,
  removeEnginesMismatchFixture,
  removeFsScopeFixture,
  removeFsWholeTreeFixture,
  removeIconInvalidFixture,
  plantBrokenManifests,
  plantFeatureFixtures,
  plantFeatureMarketplace,
  plantLinkFixture,
  plantMarketplaceFixture,
  plantRegistryFixture,
  plantSecondMarketplaceFixture,
  removeBrokenManifests,
  removeFeatureFixtures,
  removeMarketplaceFixture,
  removeRegistryFixture,
  removeSecondMarketplaceFixture,
  writeLock,
  writePackage,
} from './plugins.fixtures.ts'
import { checkDesktop } from './plugins.desktop.checks.ts'
import { plantProcessFixtures, removeProcessFixtures } from './plugins.process.fixtures.ts'
import { plantRendererFixtures, removeRendererFixtures } from './plugins.renderer.fixtures.ts'
import { plantThemeCssFixtures, removeThemeCssFixtures } from './plugins.theme.fixtures.ts'
import { marketOf, nestedHandshake, objectField, rowByInstall, rowFacts, rowOf, rowsOf } from './plugins.helpers.ts'

/** The plugin scenario, keyed the way the driver names it. */
export const pluginsScenarios: Record<string, Scenario> = {
  async plugins(host, report) {
    writePackage(LINK_FIXTURE_ROOT)

    // 1. The list is valid before anything is installed: the page has to render an empty registry,
    // not a failure.
    const initial = await host.response(host.send({ type: 'plugins_list' }))
    report.record(
      'plugins.list',
      initial.success === true && Array.isArray((initial.data as Record<string, unknown> | undefined)?.plugins),
      `success=${String(initial.success)} plugins=${String(rowsOf(initial.data as Record<string, unknown> | undefined).length)}`,
    )

    // 1b. The engine diagnostic. Both numbers have to be the ones the handshake advertised - the
    // greeting and this frame read the same loaded engine and the same protocol constant - so an
    // engine upgrade is visible on the page the moment the SDK moves, and the toolchain is reported
    // as booleans measured in the host process rather than inferred (spec §15.3-4).
    const hello = host.of('hello')[0] ?? {}
    const engine = await host.response(host.send({ type: 'plugins_engine' }))
    const engineData = (engine.data ?? {}) as Record<string, unknown>
    const toolchain = objectField(engineData, 'toolchain')
    report.record(
      'plugins.engine',
      engine.success === true
        && typeof engineData.sdkVersion === 'string'
        && engineData.sdkVersion.length > 0
        && engineData.sdkVersion === hello.sdkVersion
        && engineData.protocol === hello.protocol
        && typeof toolchain.bun === 'boolean'
        && typeof toolchain.git === 'boolean'
        && typeof toolchain.npm === 'boolean',
      JSON.stringify({
        engine: { sdkVersion: engineData.sdkVersion, protocol: engineData.protocol, toolchain },
        hello: { sdkVersion: hello.sdkVersion, protocol: hello.protocol },
      }),
    )

    // 1c. The install preflight on a machine without `bun` (spec §15.1-6). The tool is denied
    // *inside* the second host by the smoke knob rather than by rewriting the system `PATH`, so what
    // runs is the host's own decision; `local` installs are deliberately not covered here, because
    // they link rather than spawn `bun` and this machine's symlink permission is not a knob.
    const noToolchainHost = new HostProcess(host.mode, `${host.tag}-notoolchain`, {
      OMP_DESKTOP_SMOKE_TOOLCHAIN: 'bun=0',
    })
    try {
      await nestedHandshake(noToolchainHost)
      const deniedEngine = await noToolchainHost.response(noToolchainHost.send({ type: 'plugins_engine' }))
      const deniedToolchain = objectField((deniedEngine.data ?? {}) as Record<string, unknown>, 'toolchain')
      report.record(
        'plugins.engine.noToolchain',
        deniedEngine.success === true && deniedToolchain.bun === false && deniedToolchain.git === true,
        JSON.stringify(deniedToolchain),
      )
      const refused = await noToolchainHost.response(
        noToolchainHost.send({ type: 'plugins_install', source: 'smoke-plugin-no-toolchain', scope: 'user' }),
      )
      report.record(
        'plugins.install.noToolchain',
        refused.success === false
          && refused.code === 'plugin_install_unavailable'
          && String(refused.error ?? '').includes('bun'),
        JSON.stringify(refused),
      )
      noToolchainHost.send({ type: 'host_shutdown', reason: 'plugins.notoolchain' })
      await noToolchainHost.finish()
    } finally {
      await noToolchainHost.stop()
    }

    // 2. The real install frame, routing an absolute path through the engine's link path.
    const installed = await host.response(
      host.send({ type: 'plugins_install', source: LINK_FIXTURE_ROOT, scope: 'user' }),
      120_000,
    )
    const installCode = typeof installed.code === 'string' ? installed.code : ''
    const installRow = rowOf(installed.data as Record<string, unknown> | undefined, PLUGIN_ID)
    // The engine refusing its own install primitive is a legal outcome here, and which code it is
    // says *what* refused: an unusable source is `plugin_invalid_spec`, a link this machine will not
    // create (no Developer Mode / no symlink permission) is `plugin_install_unavailable`, and
    // anything else the engine said no to is `plugin_install_failed`.
    const classified =
      installCode === 'plugin_install_failed'
      || installCode === 'plugin_invalid_spec'
      || installCode === 'plugin_install_unavailable'
    if (installed.success === true && installRow !== null) {
      report.record('plugins.install', true, 'linked into the plugin registry')
      rowFacts(report, 'plugins.install', installRow, 'link')
    } else if (installed.success === false && classified) {
      // The engine refused its own install primitive (on this machine `fs.symlink` answers EPERM
      // without Developer Mode). The frame's job is to classify that, name a code and redact the
      // text - which is what this asserts - and stage 2 covers every other frame without a link.
      report.record('plugins.install.refused', true, `${installCode}: ${String(installed.error ?? '')}`)
    } else {
      report.record('plugins.install', false, JSON.stringify(installed))
    }

    // 3. Everything else runs against a plugin assembled the way an install leaves one: a real
    // package directory plus its runtime entry, with `enabled: false` so the toggle is observable.
    let stageTwoOk = true
    try {
      plantRegistryFixture()
      const planted = await host.response(host.send({ type: 'plugins_list' }))
      const plantedRow = rowOf(planted.data as Record<string, unknown> | undefined, PLUGIN_ID)
      stageTwoOk = plantedRow !== null
      report.record(
        'plugins.list.planted',
        plantedRow !== null
          && plantedRow.enabled === false
          && plantedRow.version === PLUGIN_VERSION
          && objectField(plantedRow, 'source').kind === 'npm',
        JSON.stringify({ enabled: plantedRow?.enabled, version: plantedRow?.version, source: plantedRow?.source }),
      )
      if (plantedRow !== null) rowFacts(report, 'plugins.planted', plantedRow, 'npm')

      // A settings write, read back twice: once from the answer and once from a fresh read. The
      // second read is the persistence check - the answer alone would not prove the lock file holds
      // the value a later tool run would load.
      const written = await host.response(
        host.send({ type: 'plugins_config_set', targetId: PLUGIN_ID, key: 'endpoint', value: 'https://example.test' }),
      )
      const writtenData = written.data as Record<string, unknown> | undefined
      const writtenValues = objectField(writtenData, 'values')
      report.record(
        'plugins.config.set',
        written.success === true
          && writtenValues.endpoint === 'https://example.test'
          && ((writtenData?.explicit ?? []) as string[]).includes('endpoint'),
        JSON.stringify({ values: writtenValues, explicit: writtenData?.explicit }),
      )
      const reread = await host.response(host.send({ type: 'plugins_config_list', targetId: PLUGIN_ID }))
      const rereadData = reread.data as Record<string, unknown> | undefined
      report.record(
        'plugins.config.reread',
        reread.success === true && objectField(rereadData, 'values').endpoint === 'https://example.test',
        JSON.stringify(rereadData?.values ?? reread),
      )
      report.record(
        'plugins.config.schema',
        objectField(objectField(rereadData, 'schema'), 'mode').type === 'enum'
          && objectField(objectField(rereadData, 'schema'), 'retries').max === 10,
        JSON.stringify(rereadData?.schema).slice(0, 200),
      )
      const reset = await host.response(
        host.send({ type: 'plugins_config_reset', targetId: PLUGIN_ID, key: 'endpoint' }),
      )
      report.record(
        'plugins.config.reset',
        reset.success === true
          && objectField(reset.data as Record<string, unknown> | undefined, 'values').endpoint === undefined,
        JSON.stringify((reset.data as Record<string, unknown> | undefined)?.values ?? reset),
      )

      // Both refusals: a value outside the schema's own bounds, and a key the schema does not
      // declare. A store that accepted either would leave a setting the engine ignores.
      const overMax = await host.response(
        host.send({ type: 'plugins_config_set', targetId: PLUGIN_ID, key: 'retries', value: 99 }),
      )
      report.record(
        'plugins.config.rejectAboveMax',
        overMax.success === false && overMax.code === 'invalid_input',
        JSON.stringify(overMax),
      )
      const unknown = await host.response(
        host.send({ type: 'plugins_config_set', targetId: PLUGIN_ID, key: 'nope', value: 'x' }),
      )
      report.record(
        'plugins.config.rejectUnknownKey',
        unknown.success === false && unknown.code === 'invalid_input',
        JSON.stringify(unknown),
      )

      // The enable toggle from the planted state (off), on and back off, each read from the answer.
      const on = await host.response(host.send({ type: 'plugins_set_enabled', targetId: PLUGIN_ID, enabled: true }))
      const onRow = rowOf(on.data as Record<string, unknown> | undefined, PLUGIN_ID)
      report.record(
        'plugins.enable.on',
        on.success === true && onRow?.enabled === true,
        `success=${String(on.success)} enabled=${String(onRow?.enabled ?? null)}`,
      )
      const off = await host.response(host.send({ type: 'plugins_set_enabled', targetId: PLUGIN_ID, enabled: false }))
      const offRow = rowOf(off.data as Record<string, unknown> | undefined, PLUGIN_ID)
      report.record(
        'plugins.enable.off',
        off.success === true && offRow?.enabled === false,
        `success=${String(off.success)} enabled=${String(offRow?.enabled ?? null)}`,
      )

      // The two read-only registries the page renders next to the list.
      const updates = await host.response(host.send({ type: 'plugins_check_updates' }))
      report.record(
        'plugins.checkUpdates',
        updates.success === true && Array.isArray((updates.data as Record<string, unknown> | undefined)?.updates),
        JSON.stringify(updates.data ?? updates).slice(0, 200),
      )
      const markets = await host.response(host.send({ type: 'marketplaces_list' }))
      report.record(
        'plugins.marketplaces',
        markets.success === true && Array.isArray((markets.data as Record<string, unknown> | undefined)?.marketplaces),
        JSON.stringify(markets.data ?? markets).slice(0, 200),
      )
      // A detached marketplace write still answers by id, with the classification a page branches
      // on: a name that is not registered has to come back as `plugin_not_found`, never as a frame
      // the read loop never got to.
      const unknownMarket = await host.response(host.send({ type: 'marketplaces_remove', name: 'smoke-missing-market' }))
      report.record(
        'plugins.marketplaceRemoveUnknown',
        unknownMarket.success === false && unknownMarket.code === 'plugin_not_found',
        JSON.stringify(unknownMarket).slice(0, 200),
      )

      // The fixture is taken away again. The engine's refusal is a legal outcome too - a plugin it
      // will not uninstall has to be reported with its code, never skipped.
      const removed = await host.response(host.send({ type: 'plugins_uninstall', targetId: PLUGIN_ID }), 120_000)
      const removedCode = typeof removed.code === 'string' ? removed.code : ''
      const refusedByEngine = removed.success === false && removedCode.startsWith('plugin_')
      report.record(
        'plugins.uninstall',
        (removed.success === true && rowOf(removed.data as Record<string, unknown> | undefined, PLUGIN_ID) === null)
          || refusedByEngine,
        removed.success === true
          ? `uninstalled by the engine; rows=${rowsOf(removed.data as Record<string, unknown> | undefined).length}`
          : `engine refused: code=${removedCode} ${String(removed.error ?? '')}`,
      )
      // 3. The shapes a broken or development install leaves behind, which the page has to describe
      // rather than skip: the fixture reached through a directory link (the link row the engine's
      // own `link()` produces on a machine that may create one), and three marketplace records whose
      // manifest is unusable (no `package.json`, not JSON, an `omp` block that is not an object).
      // One list answers all four rows.
      plantLinkFixture()
      plantBrokenManifests()
      const edge = await host.response(host.send({ type: 'plugins_list' }))
      const edgeData = edge.data as Record<string, unknown> | undefined
      const linkRow = rowOf(edgeData, PLUGIN_ID)
      report.record(
        'plugins.list.linked',
        linkRow !== null && objectField(linkRow, 'source').kind === 'link',
        JSON.stringify(linkRow?.source ?? edge),
      )
      if (linkRow !== null) rowFacts(report, 'plugins.linked', linkRow, 'link')
      const brokenRows = rowsOf(edgeData)
      const missingRow = rowByInstall(brokenRows, BROKEN_MISSING_ID)
      const invalidRow = rowByInstall(brokenRows, BROKEN_INVALID_ID)
      // The row is still listed - the engine's record says the plugin is installed - and it carries
      // the reason its manifest yielded nothing, which is what tells it apart from a plugin that
      // declares no desktop part at all.
      report.record(
        'plugins.manifestUnusable',
        missingRow?.desktopError === 'package.json could not be read'
          && missingRow?.desktop === null
          && invalidRow?.desktopError === 'package.json is not valid JSON'
          && invalidRow?.desktop === null,
        `missing=${missingRow === null ? 'absent' : String(missingRow.desktopError)} invalid=${invalidRow === null ? 'absent' : String(invalidRow.desktopError)}`,
      )
      // A manifest this host cannot read is not "no code": the engine loaded the plugin from its
      // own copy, so the gate has to treat the row as possibly carrying code (spec §15.1-4, reason
      // `manifest-unreadable`). All three shapes answer the same way, including the third one,
      // where the file reads fine but the `omp` block it declares is not an object.
      const blockRow = rowByInstall(brokenRows, BROKEN_BLOCK_ID)
      const unreadableRows: Array<[string, Record<string, unknown> | null]> = [
        ['missing', missingRow],
        ['invalid', invalidRow],
        ['block', blockRow],
      ]
      report.record(
        'plugins.consent.unreadable',
        unreadableRows.every(([, row]) => {
          if (row === null) return false
          const consent = objectField(row, 'consent')
          const reasons = consent.reasons
          return consent.required === true && Array.isArray(reasons) && reasons.includes('manifest-unreadable')
        }),
        unreadableRows.map(([name, row]) => `${name}=${JSON.stringify(row?.consent)}`).join(' '),
      )

      // 4. The code that lives in `omp.features`. The engine merges an enabled feature's entry
      // points into the same load as the manifest's own, so a row that read only the top level
      // would report a plugin whose whole code is feature-declared as carrying none - and the gate
      // would let it run without asking. Both fixtures are planted with `enabledFeatures: null`,
      // the state an ordinary install leaves, which the engine reads as "the features with a
      // truthy `default`": `smoke-feature-default`'s entries are in such a feature (all three of
      // them, which is the whole reason list the row may carry), while `smoke-feature-optional`'s
      // are in a feature nothing enables.
      plantFeatureFixtures()
      const featureList = await host.response(host.send({ type: 'plugins_list' }))
      const featureData = featureList.data as Record<string, unknown> | undefined
      const defaultRow = rowOf(featureData, FEATURE_DEFAULT_ID)
      const defaultConsent = objectField(defaultRow, 'consent')
      const defaultReasons = defaultConsent.reasons
      const defaultCode = objectField(defaultRow, 'code')
      report.record(
        'plugins.features.defaultEnabled',
        defaultRow !== null
          && defaultConsent.required === true
          && Array.isArray(defaultReasons)
          && JSON.stringify(defaultReasons) === JSON.stringify(['extension-modules', 'base-tools', 'base-hooks'])
          && defaultCode.extensions === 1
          && defaultCode.baseTools === true
          && defaultCode.baseHooks === true
          && defaultCode.hooksDir === false
          && defaultCode.toolsDir === false,
        JSON.stringify({ consent: defaultRow?.consent, code: defaultRow?.code }),
      )
      const optionalRow = rowOf(featureData, FEATURE_OPTIONAL_ID)
      const optionalConsent = objectField(optionalRow, 'consent')
      const optionalReasons = optionalConsent.reasons
      report.record(
        'plugins.features.defaultOff',
        optionalRow !== null
          && optionalConsent.required === false
          && Array.isArray(optionalReasons)
          && optionalReasons.length === 0
          && objectField(optionalRow, 'code').extensions === 0,
        JSON.stringify({ consent: optionalRow?.consent, code: optionalRow?.code }),
      )
      // The same off fixture with its feature selected, the state `omp plugin install pkg[code]`
      // leaves in the lock: the engine loads exactly the names an explicit list carries, so the
      // row has to follow that list too.
      writeLock(FEATURE_OPTIONAL_ID, { version: PLUGIN_VERSION, enabledFeatures: ['code'], enabled: true })
      const featureOnList = await host.response(host.send({ type: 'plugins_list' }))
      const featureOnRow = rowOf(featureOnList.data as Record<string, unknown> | undefined, FEATURE_OPTIONAL_ID)
      const featureOnConsent = objectField(featureOnRow, 'consent')
      const featureOnReasons = featureOnConsent.reasons
      report.record(
        'plugins.features.selected',
        featureOnRow !== null
          && featureOnConsent.required === true
          && Array.isArray(featureOnReasons)
          && featureOnReasons.includes('extension-modules')
          && objectField(featureOnRow, 'code').extensions === 1,
        JSON.stringify({ consent: featureOnRow?.consent, code: featureOnRow?.code }),
      )
      // The same plugin as a marketplace row: `PluginManager.list()` never reports a marketplace
      // runtime link, so this row's features come from the record's own package. The lock selects
      // the feature, which is the direction that matters - a lookup that quietly failed would tell
      // the page this plugin runs nothing while the engine loads its extension module.
      plantFeatureMarketplace()
      const marketList = await host.response(host.send({ type: 'plugins_list' }))
      const marketFeatureRow = rowByInstall(rowsOf(marketList.data as Record<string, unknown> | undefined), FEATURE_MARKET_ID)
      const marketConsent = objectField(marketFeatureRow, 'consent')
      const marketReasons = marketConsent.reasons
      report.record(
        'plugins.features.marketplace',
        marketFeatureRow !== null
          && marketConsent.required === true
          && Array.isArray(marketReasons)
          && marketReasons.includes('extension-modules')
          && objectField(marketFeatureRow, 'code').extensions === 1,
        JSON.stringify({ consent: marketFeatureRow?.consent, code: marketFeatureRow?.code }),
      )
    } finally {
      // Whatever happened above, the fixtures do not outlive the scenario: the data root is shared
      // by every scenario and the suite may run this one more than once.
      removeRegistryFixture()
      removeBrokenManifests()
      removeFeatureFixtures()
    }
    // 5. The marketplace route end to end, on the one source this machine can walk without a
    // network, an account or `git`: a local catalog added by path and installed from by
    // `name@marketplace`. The engine copies the package the catalog points at into its own cache and
    // links that copy into the runtime `node_modules` with a *junction* on Windows
    // (`marketplace/manager.ts`), which needs no elevation - unlike the pasted-path link stage 2
    // drives - so this install really succeeds here. The fixture goes away whatever these answer.
    try {
      plantMarketplaceFixture()
      const added = await host.response(host.send({ type: 'marketplaces_add', source: MARKET_ROOT }))
      const listed = await host.response(host.send({ type: 'marketplaces_list' }))
      report.record('plugins.market.add', added.success === true && marketOf(added.data, MARKET_NAME)?.sourceUri === MARKET_ROOT && marketOf(listed.data, MARKET_NAME) !== null, JSON.stringify(listed.data ?? listed).slice(0, 200))
      // The store's own read, before anything is installed from it: the catalogue entry the frame
      // projects, named by the catalogue, carrying the marketplace it was read from and one readable
      // source label (`plugins-market.ts::listMarketplacePlugins`, the `marketplace_plugins` frame).
      const catalog = await host.response(host.send({ type: 'marketplace_plugins', marketplace: MARKET_NAME }))
      const entry = rowsOf(catalog.data as Record<string, unknown> | undefined).find(candidate => candidate.name === MARKET_PLUGIN_NAME) ?? null
      report.record(
        'plugins.market.catalog',
        catalog.success === true && entry !== null && entry.marketplace === MARKET_NAME && entry.version === MARKET_PLUGIN_VERSION
          && typeof entry.source === 'string' && entry.source.length > 0,
        JSON.stringify(catalog.data ?? catalog).slice(0, 300),
      )
      const install = await host.response(host.send({ type: 'plugins_install', source: MARKET_PLUGIN_ID }), 120_000)
      const installRows = rowsOf(install.data as Record<string, unknown> | undefined)
      const row = rowOf(install.data as Record<string, unknown> | undefined, MARKET_PLUGIN_NAME)
      const consent = objectField(row, 'consent')
      const source = objectField(row, 'source')
      report.record(
        'plugins.market.install',
        install.success === true && row !== null && row.version === MARKET_PLUGIN_VERSION && source.kind === 'marketplace' && source.label === MARKET_PLUGIN_ID
          && objectField(row, 'code').extensions === 1 && consent.required === true && Array.isArray(consent.reasons) && (consent.reasons as unknown[]).includes('extension-modules'),
        JSON.stringify({ row, consent }).slice(0, 400),
      )
      // The row's identity (plan §4.1, §4.5): it is keyed by the plugin's own id, the engine's
      // `name@marketplace` is only the install handle the write commands address, and the source
      // names the marketplace the install came from plus the handle again. One install is one row -
      // the same plugin recorded twice would otherwise render twice.
      const identitySources = (row?.sources ?? []) as Array<Record<string, unknown>>
      report.record(
        'plugins.desktop.identity',
        row !== null
          && row.id === MARKET_PLUGIN_NAME
          && row.installId === MARKET_PLUGIN_ID
          && source.marketplace === MARKET_NAME
          && source.installId === MARKET_PLUGIN_ID
          && source.installed === true
          && installRows.filter(candidate => candidate.id === MARKET_PLUGIN_NAME).length === 1
          && identitySources.length === 1
          && identitySources[0]?.marketplace === MARKET_NAME
          && identitySources[0]?.version === MARKET_PLUGIN_VERSION
          && identitySources[0]?.sourceLabel === MARKET_PLUGIN_ID
          && identitySources[0]?.installed === true,
        JSON.stringify({ id: row?.id, installId: row?.installId, source, sources: identitySources }).slice(0, 400),
      )
      // The route this stage exists for: the runtime entry is the junction the engine's registration
      // writes on Windows (`fs.symlink(..., 'junction')`), not a copy - which is why no Developer
      // Mode is needed - and the uninstall has to take it away, or the listing could drop the row
      // while the package stayed loadable.
      report.record('plugins.market.junction', fs.existsSync(MARKET_RUNTIME_LINK) && fs.lstatSync(MARKET_RUNTIME_LINK).isSymbolicLink(), MARKET_RUNTIME_LINK)
      // The engine registers a fresh install with no `enabled` flag and reads a missing flag as on, so
      // this row is on before any consent was given: the engine's own default, recorded as the fact it
      // is (the desktop's Rust side, not this host, is what isolates a plugin nobody has confirmed).
      report.record('plugins.market.defaultEnabled', row?.enabled === true, `enabled=${String(row?.enabled ?? null)}`)
      // A newer package arrives at the same catalogue: the desktop replaces the source, refreshes
      // the engine's cached catalogue, and the engine's own comparison is what calls it an upgrade.
      plantMarketplaceFixture(MARKET_PLUGIN_VERSION_NEXT)
      const refreshed = await host.response(host.send({ type: 'marketplaces_update', name: MARKET_NAME }), 60_000)
      report.record('plugins.market.update', refreshed.success === true, JSON.stringify(refreshed).slice(0, 200))
      const checked = await host.response(host.send({ type: 'plugins_check_updates' }), 120_000)
      const checkedData = (checked.data ?? {}) as Record<string, unknown>
      // The engine's own row, renamed into the row identity (plan §4.2): `installId` is what the
      // upgrade is applied through, `pluginId` is the row key, and the marketplace it compares
      // against is named. The engine reported this one, so it is an in-place upgrade.
      const pending = (checkedData.updates as Array<Record<string, unknown>> | undefined)?.find(
        update => update.installId === MARKET_PLUGIN_ID,
      )
      report.record(
        'plugins.market.checkUpdates',
        pending?.pluginId === MARKET_PLUGIN_NAME
          && pending?.from === MARKET_PLUGIN_VERSION
          && pending?.to === MARKET_PLUGIN_VERSION_NEXT
          && pending?.marketplace === MARKET_NAME
          && pending?.kind === 'in-place',
        JSON.stringify(pending ?? checked).slice(0, 260),
      )
      // The candidates the update card lists beside it: every version the registered marketplaces
      // declare for an installed plugin, whether or not it is newer.
      const candidates = (checkedData.candidates ?? []) as Array<Record<string, unknown>>
      const demoCandidate = candidates.find(
        candidate => candidate.pluginId === MARKET_PLUGIN_NAME && candidate.scope === 'user',
      )
      const candidateSources = (demoCandidate?.sources ?? []) as Array<Record<string, unknown>>
      report.record(
        'plugins.updates.candidates',
        demoCandidate !== undefined
          && candidateSources.length === 1
          && candidateSources[0]?.marketplace === MARKET_NAME
          && candidateSources[0]?.version === MARKET_PLUGIN_VERSION_NEXT,
        JSON.stringify(demoCandidate ?? candidates).slice(0, 260),
      )
      // The upgrade addresses the install handle, and its answer is read back by plugin id.
      const upgraded = await host.response(host.send({ type: 'plugins_upgrade', targetId: MARKET_PLUGIN_ID, scope: 'user' }), 120_000)
      const upgradedRow = rowOf(upgraded.data as Record<string, unknown> | undefined, MARKET_PLUGIN_NAME)
      report.record(
        'plugins.market.upgrade',
        upgraded.success === true && upgradedRow?.version === MARKET_PLUGIN_VERSION_NEXT && upgradedRow?.installId === MARKET_PLUGIN_ID,
        JSON.stringify({ version: upgradedRow?.version, installId: upgradedRow?.installId }).slice(0, 160),
      )
      // 5b. The cross-market half of the update answer (plan §4.2). The installed copy is current in
      // its own marketplace, so the engine reports nothing; a second marketplace lists the same
      // plugin at a newer version, which only this host's scan can see - and it has to call it a
      // source switch, because `upgradePlugin` cannot reinstall from another marketplace.
      try {
        plantSecondMarketplaceFixture()
        const marketB = await host.response(host.send({ type: 'marketplaces_add', source: MARKET_B_ROOT }))
        report.record(
          'plugins.market.secondMarket.add',
          marketB.success === true && marketOf(marketB.data, MARKET_B_NAME) !== null,
          JSON.stringify(marketB.data ?? marketB).slice(0, 200),
        )
        const listedWithB = await host.response(host.send({ type: 'plugins_list' }))
        const rowWithB = rowOf(listedWithB.data as Record<string, unknown> | undefined, MARKET_PLUGIN_NAME)
        // Both marketplaces, ordered by name, with `installed` true only on the one the engine holds
        // the install for. The second one's version is the catalog's, not a package this host read.
        report.record(
          'plugins.market.sources',
          JSON.stringify(rowWithB?.sources) ===
            JSON.stringify([
              { marketplace: MARKET_NAME, version: MARKET_PLUGIN_VERSION_NEXT, sourceLabel: MARKET_PLUGIN_ID, installed: true },
              { marketplace: MARKET_B_NAME, version: MARKET_B_VERSION, sourceLabel: `${MARKET_PLUGIN_NAME}@${MARKET_B_NAME}`, installed: false },
            ]),
          JSON.stringify(rowWithB?.sources).slice(0, 300),
        )
        const crossCheck = await host.response(host.send({ type: 'plugins_check_updates' }), 120_000)
        const crossPending = (((crossCheck.data ?? {}) as Record<string, unknown>).updates as Array<Record<string, unknown>> | undefined)?.find(
          update => update.installId === MARKET_PLUGIN_ID,
        )
        report.record(
          'plugins.updates.switchSource',
          crossPending?.pluginId === MARKET_PLUGIN_NAME
            && crossPending?.kind === 'switch-source'
            && crossPending?.marketplace === MARKET_B_NAME
            && crossPending?.from === MARKET_PLUGIN_VERSION_NEXT
            && crossPending?.to === MARKET_B_VERSION,
          JSON.stringify(crossPending ?? crossCheck).slice(0, 260),
        )
      } finally {
        await host.response(host.send({ type: 'marketplaces_remove', name: MARKET_B_NAME }))
        removeSecondMarketplaceFixture()
      }
      // The reload frame has no other coverage: it answers how many live sessions were rebuilt, and
      // how many could not be (M4) - a caller that only read `sessions` would take a partial reload
      // for a whole one.
      const reloaded = await host.response(host.send({ type: 'plugins_reload' }), 60_000)
      const reloadData = (reloaded.data ?? {}) as Record<string, unknown>
      report.record(
        'plugins.reload',
        reloaded.success === true && typeof reloadData.sessions === 'number' && typeof reloadData.failed === 'number',
        JSON.stringify(reloaded).slice(0, 160),
      )
      // Every write below answers with the list it changed, so each check reads that one answer: the
      // toggle both ways, the settings round trip on the marketplace id the page uses, and the
      // uninstall that has to take the row away. The toggle and the uninstall address the install
      // handle (plan §4.1) and are read back by the plugin id; the settings frames keep the handle
      // because the engine's settings are keyed by the installed package.
      const rowIn = (answer: Record<string, unknown>): Record<string, unknown> | null => rowOf(answer.data as Record<string, unknown> | undefined, MARKET_PLUGIN_NAME)
      const settingIn = (answer: Record<string, unknown>): unknown => objectField(answer.data as Record<string, unknown> | undefined, 'values')[MARKET_SETTING_KEY]
      const steps: Array<[string, Record<string, unknown>, (answer: Record<string, unknown>) => boolean]> = [
        ['plugins.market.disable', { type: 'plugins_set_enabled', targetId: MARKET_PLUGIN_ID, enabled: false }, answer => rowIn(answer)?.enabled === false],
        ['plugins.market.enable', { type: 'plugins_set_enabled', targetId: MARKET_PLUGIN_ID, enabled: true }, answer => rowIn(answer)?.enabled === true],
        ['plugins.market.config.set', { type: 'plugins_config_set', targetId: MARKET_PLUGIN_ID, key: MARKET_SETTING_KEY, value: MARKET_SETTING_VALUE }, answer => settingIn(answer) === MARKET_SETTING_VALUE],
        ['plugins.market.config.list', { type: 'plugins_config_list', targetId: MARKET_PLUGIN_ID }, answer => settingIn(answer) === MARKET_SETTING_VALUE],
        ['plugins.market.config.reset', { type: 'plugins_config_reset', targetId: MARKET_PLUGIN_ID, key: MARKET_SETTING_KEY }, answer => settingIn(answer) === undefined],
        ['plugins.market.uninstall', { type: 'plugins_uninstall', targetId: MARKET_PLUGIN_ID }, answer => rowIn(answer) === null],
      ]
      for (const [name, frame, fact] of steps) {
        const answer = await host.response(host.send(frame), 120_000)
        report.record(name, answer.success === true && fact(answer), JSON.stringify(answer).slice(0, 200))
      }
      report.record('plugins.market.uninstalledLink', !fs.existsSync(MARKET_RUNTIME_LINK), MARKET_RUNTIME_LINK)
      const afterUninstall = await host.response(host.send({ type: 'plugins_list' }))
      const afterUninstallRows = rowsOf(afterUninstall.data as Record<string, unknown> | undefined)
      report.record(
        'plugins.market.listAfterUninstall',
        rowByInstall(afterUninstallRows, MARKET_PLUGIN_ID) === null && rowOf(afterUninstall.data as Record<string, unknown> | undefined, MARKET_PLUGIN_NAME) === null,
        JSON.stringify(afterUninstall.data ?? afterUninstall).slice(0, 200),
      )
      const removed = await host.response(host.send({ type: 'marketplaces_remove', name: MARKET_NAME }))
      const afterRemove = await host.response(host.send({ type: 'marketplaces_list' }))
      report.record('plugins.market.remove', removed.success === true && marketOf(removed.data, MARKET_NAME) === null && marketOf(afterRemove.data, MARKET_NAME) === null, JSON.stringify(removed.data ?? removed).slice(0, 200))
    } finally {
      // The fixture does not outlive the scenario: the registry it was added to is shared, and a rerun
      // has to start from a root that holds neither it nor the plugin.
      removeMarketplaceFixture()
    }
    // 4b. The two shapes the desktop block reports, and the code surfaces the consent facts have to
    // see (spec §3.2, §4.2, §9.2-5). Planted as registry records, because what is under test is the
    // host's own reading of a plugin directory, not an install.
    try {
      plantDesktopFixture()
      plantEnginesMismatchFixture()
      plantFsScopeFixture()
      plantFsWholeTreeFixture()
      plantIconInvalidFixture()
      plantCodeSurfaceFixture()
      plantConsentFileFixtures()
      plantProcessFixtures()
      plantRendererFixtures()
      plantThemeCssFixtures()
      const listed = await host.response(host.send({ type: 'plugins_list' }))
      const rows = (((listed.data ?? {}) as Record<string, unknown>).plugins) as Array<Record<string, unknown>> | undefined
      checkDesktop(rows ?? [], report)
      const surfaceRow = rowByInstall(rows ?? [], CODE_SURFACE_ID)
      const surfaceConsent = objectField(surfaceRow ?? {}, 'consent')
      const reasons = (surfaceConsent.reasons ?? []) as string[]
      report.record(
        'plugins.consent.codeSurfaces',
        surfaceConsent.required === true
          && ['mcp-config', 'lsp-config', 'dap-config'].every(reason => reasons.includes(reason)),
        JSON.stringify(reasons),
      )
      // The unprefixed spellings the engine also reads from a plugin root (H1). Each fixture ships
      // exactly one surface, so a probe that missed it reports `reasons: []` and `required: false` -
      // the fail-open shape this assertion exists to catch - and the exact-one check keeps a
      // fixture that accidentally grew a second surface from passing for the wrong reason.
      const consentOf = (id: string): { required: unknown; reasons: string[] } => {
        const consent = objectField(rowByInstall(rows ?? [], id) ?? {}, 'consent')
        return { required: consent.required, reasons: (consent.reasons ?? []) as string[] }
      }
      const fileSurfaces: Array<[string, string, string]> = [
        ['plugins.consent.mcpFile', MCP_FILE_ID, 'mcp-config'],
        ['plugins.consent.lspFile', LSP_FILE_ID, 'lsp-config'],
        ['plugins.consent.dapFile', DAP_FILE_ID, 'dap-config'],
      ]
      for (const [name, id, reason] of fileSurfaces) {
        const surface = consentOf(id)
        report.record(
          name,
          surface.required === true && surface.reasons.length === 1 && surface.reasons[0] === reason,
          JSON.stringify({ id, consent: surface }),
        )
      }
    } finally {
      removeDesktopFixture()
      removeEnginesMismatchFixture()
      removeFsScopeFixture()
      removeFsWholeTreeFixture()
      removeIconInvalidFixture()
      removeCodeSurfaceFixture()
      removeConsentFileFixtures()
      removeProcessFixtures()
      removeRendererFixtures()
      removeThemeCssFixtures()
    }

    const leftovers = leftoverFixtures()
    report.record(
      'plugins.cleanup',
      leftovers.length === 0,
      leftovers.length === 0 ? 'fixtures removed' : `fixtures still present: ${leftovers.join(', ')}`,
    )

    host.send({ type: 'host_shutdown', reason: 'plugins' })
    const exit = await host.finish()
    report.record('plugins.exit', exit === 0, `exit=${exit}`)
    return { installed: installed.success === true, stageTwo: stageTwoOk }
  },
}
