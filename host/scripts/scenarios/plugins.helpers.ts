/**
 * The answer-reading helpers the plugin scenario's stages share.
 *
 * Split out of `plugins.ts` when the identity stage pushed that file past the line limit
 * (`rules.md#single-file-line-limit`): one row is read the same way by every stage - by id for an npm/link fixture, by
 * install handle for a marketplace one - and the facts every list answer must carry are asserted
 * once here instead of per stage.
 */

import * as fs from 'node:fs'

import { PROTOCOL_VERSION } from '../../src/constants.ts'
import type { HostProcess } from '../client.ts'
import type { Report } from '../harness.ts'
import { LINK_FIXTURE_ROOT, PLUGIN_ID, PLUGIN_VERSION } from './plugins.fixtures.ts'

/**
 * Records the row facts every list answer must carry, under `prefix`.
 *
 * Run for every stage that produces the fixture's row: the linked install, the assembled registry
 * entry and the link stage each reach the same projection through a different registry, so asserting
 * all of them proves the row is built from the plugin's own files rather than the registry's report.
 */
export function rowFacts(report: Report, prefix: string, row: Record<string, unknown>, sourceKind: 'link' | 'npm'): void {
  report.record(`${prefix}.version`, row.version === PLUGIN_VERSION, `version=${String(row.version)}`)
  const source = objectField(row, 'source')
  // A link row names the development directory, resolved to the spelling the filesystem reports,
  // because that is the only form both sides can be compared in (spec §3.4 shows the source in dev
  // mode); an npm row has nothing but its package name to show. A label that is not a path at all -
  // the package name this row used to carry - is the failure this asserts against.
  let linkLabelMatches = false
  if (sourceKind === 'link' && typeof source.label === 'string') {
    try {
      linkLabelMatches = fs.realpathSync.native(source.label) === fs.realpathSync.native(LINK_FIXTURE_ROOT)
    } catch {
      linkLabelMatches = false
    }
  }
  report.record(`${prefix}.source`, source.kind === sourceKind && (sourceKind === 'link' ? linkLabelMatches : source.label === PLUGIN_ID), JSON.stringify(source))
  // A manifest that read and parsed produces no manifest error: the row must not report one, which is
  // why the block's own facts and `desktopError: null` are asserted together.
  const desktop = objectField(row, 'desktop')
  report.record(
    `${prefix}.desktop`,
    JSON.stringify(desktop.permissions) === JSON.stringify(['notify', 'ui.theme']) && desktop.schemaVersion === 1 && desktop.valid === true && row.desktopError === null,
    JSON.stringify({ desktop, desktopError: row.desktopError }),
  )
  // The theme a manifest contributes (spec §4.2): its id, its base mode, its tokens and its labels
  // all survive the projection, which is what the appearance page renders from.
  const themes = (desktop.themes ?? []) as Array<Record<string, unknown>>
  const theme = themes[0] ?? {}
  const themeTokens = objectField(theme, 'tokens')
  const themeLabel = objectField(theme, 'label')
  report.record(
    `${prefix}.desktopThemes`,
    themes.length === 1
      && theme.id === 'smoke-dark'
      && theme.dark === true
      && themeTokens['--dsw-alias-bg-base'] === '#0b0f1a'
      && themeTokens['--omp-terminal-background'] === '#101418'
      && themeLabel.zh === '冒烟深色'
      && themeLabel.en === 'Smoke Dark',
    JSON.stringify(themes).slice(0, 300),
  )
  // The localisation block is projected with the row: the page renders a plugin in the app's
  // language from it, so the read has to survive the round trip through the registry.
  const i18n = objectField(desktop, 'i18n')
  report.record(`${prefix}.desktopI18n`, objectField(i18n, 'zh').name === '冒烟插件' && objectField(i18n, 'en').name === 'Smoke Plugin', JSON.stringify(i18n))
  // The setting labels a form shows (`i18n.<locale>.settings`): the projection carries them per
  // locale, keeps a key the engine's schema does not declare (the page aligns the two when it
  // renders), and drops the text the other localised fields would drop.
  const labelsZh = objectField(objectField(i18n, 'zh'), 'settings')
  const labelsEn = objectField(objectField(i18n, 'en'), 'settings')
  report.record(
    `${prefix}.desktopI18nSettings`,
    labelsZh.endpoint === '接口地址' && labelsZh.mode === '运行模式' && labelsEn.endpoint === 'API endpoint' && labelsEn.nope === 'Not in the schema' && labelsEn.blank === undefined && labelsEn.long === undefined,
    JSON.stringify({ zh: labelsZh, en: labelsEn }),
  )
  const settings = objectField(row, 'settings')
  const keys = (settings.keys ?? []) as string[]
  report.record(`${prefix}.settings`, ['endpoint', 'mode', 'retries'].every(key => keys.includes(key)) && settings.hasSecret === false, `keys=${JSON.stringify(keys)} hasSecret=${String(settings.hasSecret)}`)
  const consent = objectField(row, 'consent')
  report.record(`${prefix}.consent`, consent.required === false && Array.isArray(consent.reasons) && (consent.reasons as unknown[]).length === 0, JSON.stringify(consent))
  const code = objectField(row, 'code')
  report.record(
    `${prefix}.code`,
    code.skillsDir === true
      && code.rulesDir === true
      && code.promptsDir === true
      && code.extensions === 0
      && code.mcpConfig === false,
    JSON.stringify(code),
  )
}

/** One row of a `plugins_list` answer, by id. */
export function rowOf(data: Record<string, unknown> | undefined, id: string): Record<string, unknown> | null {
  const rows = (data?.plugins ?? []) as Array<Record<string, unknown>>
  return rows.find(row => row.id === id) ?? null
}

/**
 * One row of a `plugins_list` answer, by the install handle it carries.
 *
 * A marketplace fixture's row id is the plugin's own id, not the `name@marketplace` handle the
 * registry records it under (plan §4.1), so a check that knows only the fixture's install id finds
 * its row this way - and thereby asserts the handle reached the row.
 */
export function rowByInstall(rows: Array<Record<string, unknown>>, installId: string): Record<string, unknown> | null {
  return rows.find(row => objectField(row, 'source').installId === installId) ?? null
}

/** One marketplace of a `marketplaces_*` answer's `data`, by the name it is addressed by. */
export function marketOf(data: unknown, name: string): Record<string, unknown> | null {
  const rows = ((data as Record<string, unknown> | undefined)?.marketplaces ?? []) as Array<Record<string, unknown>>
  return rows.find(row => row.name === name) ?? null
}

/** The `plugins` array of an answer, as rows. */
export function rowsOf(data: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  return (data?.plugins ?? []) as Array<Record<string, unknown>>
}

/** A nested object field of a row, or an empty object when it is absent. */
export function objectField(source: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> {
  const value = source?.[key]
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/**
 * The handshake for a host this scenario launches itself.
 *
 * The driver's `handshake` records its assertions under fixed check names; a second host inside one
 * scenario would duplicate them in the ledger, so this one only performs the exchange.
 */
export async function nestedHandshake(host: HostProcess): Promise<void> {
  await host.waitFor('nested hello', frame => frame.type === 'hello', 30_000)
  await host.response(host.send({ type: 'hello_ok', protocol: PROTOCOL_VERSION }), 30_000)
  await host.waitFor('nested ready', frame => frame.type === 'ready', 60_000)
}
