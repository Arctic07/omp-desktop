/**
 * The `plugins.desktop.*` assertions of the plugin scenario: what one row's `omp.desktop` block
 * projects, and what each refused block reports instead.
 *
 * Split out of `plugins.ts` at the line limit (`rules.md#single-file-line-limit`), by responsibility: the stage plants
 * its fixtures, lists them once and hands the rows here, so every desktop fact is asserted in one
 * place rather than in the middle of the install/marketplace stages. Nothing here talks to the host -
 * the stage owns the frame and the fixture lifecycle.
 */

import type { Report } from '../harness.ts'
import {
  DESKTOP_ID,
  ENGINES_MISMATCH_ID,
  FS_SCOPE_INVALID_ID,
  FS_WHOLE_TREE_ID,
  ICON_INVALID_ID,
} from './plugins.fixtures.ts'
import { objectField, rowByInstall } from './plugins.helpers.ts'
import { PROCESS_ID, PROCESS_UNPRIVILEGED_ID } from './plugins.process.fixtures.ts'
import {
  RENDERER_ACTIONS,
  RENDERER_CALL_METHODS,
  RENDERER_ID,
  RENDERER_UNPERMITTED_ID,
} from './plugins.renderer.fixtures.ts'
import {
  THEME_CSS_ASSETS,
  THEME_CSS_ID,
  THEME_CSS_PATH,
  THEME_CSS_UNPERMITTED_ID,
} from './plugins.theme.fixtures.ts'

/**
 * Records every `plugins.desktop.*` fact of one `plugins_list` answer.
 *
 * `rows` is the answer's `plugins` array; the caller asserts that the answer itself succeeded, so a
 * missing row here reads as the fixture not being listed rather than as a frame failure.
 */
export function checkDesktop(rows: Array<Record<string, unknown>>, report: Report): void {
  const desktopRow = rowByInstall(rows, DESKTOP_ID)
  const desktop = objectField(desktopRow ?? {}, 'desktop')
  report.record(
    'plugins.desktop.engines',
    desktop.enginesOmpDesktop === '>=0.1.0',
    JSON.stringify(desktop).slice(0, 240),
  )
  const desktopThemes = (desktop.themes ?? []) as Array<Record<string, unknown>>
  report.record(
    'plugins.desktop.theme',
    desktopThemes.length === 1
      && objectField(desktopThemes[0], 'tokens')['--dsw-alias-bg-base'] === '#0b0f1a',
    JSON.stringify(desktop.themes).slice(0, 240),
  )
  // The four page lists, as entries rather than ids (spec §3.2): each one carries what the shell
  // needs to draw it - a localised title, the entry it loads, where it sorts, the icon token it
  // asked for, and for a panel the window it asked for.
  const panel = ((desktop.panels ?? []) as Array<Record<string, unknown>>)[0] ?? {}
  const panelTitle = objectField(panel, 'title')
  report.record(
    'plugins.desktop.panel',
    panel.id === 'main'
      && panel.entry === 'desktop/panel/index.html'
      && panelTitle.zh === '冒烟面板'
      && panelTitle.en === 'Smoke Panel'
      && panel.icon === 'globe-2'
      && panel.width === 480
      && panel.height === 360
      && panel.resizable === false,
    JSON.stringify(desktop.panels).slice(0, 240),
  )
  // An icon token is a name the *page* resolves (spec §3.2): the host checks the shape and never
  // the vocabulary, so the view's token - one this build has no glyph for - still travels and the
  // block is still valid.
  const view = ((desktop.views ?? []) as Array<Record<string, unknown>>)[0] ?? {}
  report.record(
    'plugins.desktop.view',
    desktop.valid === true
      && view.id === 'log'
      && view.entry === 'desktop/view/log.html'
      && view.order === 10
      && view.icon === 'no-such-icon',
    JSON.stringify(desktop.views).slice(0, 240),
  )
  const destination = ((desktop.settingsDestinations ?? []) as Array<Record<string, unknown>>)[0] ?? {}
  const tab = ((desktop.sidebarTabs ?? []) as Array<Record<string, unknown>>)[0] ?? {}
  report.record(
    'plugins.desktop.pages',
    destination.id === 'advanced'
      && objectField(destination, 'title').zh === '高级'
      && destination.order === 100
      && destination.icon === null
      && tab.id === 'tab'
      && tab.entry === 'desktop/tab/index.html'
      && tab.icon === 'globe-2',
    JSON.stringify({ settingsDestinations: desktop.settingsDestinations, sidebarTabs: desktop.sidebarTabs }).slice(0, 260),
  )
  // A work-panel tab names a renderer of this application's own rather than a document (spec
  // §3.2, §4.2): the renderer token, the place it sorts in and its icon travel, and there is no
  // `entry` on the row at all - nothing may invent a document for a tab the host draws itself.
  const workTab = ((desktop.workPanelTabs ?? []) as Array<Record<string, unknown>>)[0] ?? {}
  report.record(
    'plugins.desktop.workPanelTab',
    desktop.valid === true
      && workTab.id === 'terminal'
      && workTab.renderer === 'terminal'
      && workTab.order === 30
      && workTab.icon === 'terminal'
      && objectField(workTab, 'title').en === 'Smoke Terminal'
      && workTab.entry === undefined,
    JSON.stringify(desktop.workPanelTabs).slice(0, 240),
  )
  // The standing reach a read permission declares (spec §3.2, §6.3): the row carries the
  // patterns as the rules read them, and a pattern the two sides could read differently refuses
  // the whole block rather than being trimmed to the parts that happened to parse.
  const scopes = objectField(desktop, 'fsScopes')
  report.record(
    'plugins.desktop.fsScope',
    JSON.stringify(scopes.read) === JSON.stringify(['desktop/**', 'README.md'])
      && JSON.stringify(scopes.write) === JSON.stringify(['desktop/out/**'])
      && JSON.stringify(scopes.delete) === JSON.stringify(['desktop/out/**']),
    JSON.stringify(scopes).slice(0, 240),
  )
  const scopeRow = rowByInstall(rows, FS_SCOPE_INVALID_ID)
  const scopeBlock = objectField(scopeRow ?? {}, 'desktop')
  report.record(
    'plugins.desktop.fsScopeInvalid',
    scopeRow !== null
      && scopeBlock.valid === false
      && scopeBlock.reason === 'invalid_fs_scope'
      && JSON.stringify(objectField(scopeBlock, 'fsScopes')) === JSON.stringify({ read: [], write: [], delete: [] })
      && ((scopeBlock.panels ?? []) as unknown[]).length === 0,
    JSON.stringify(scopeBlock).slice(0, 200),
  )
  // A *write* scope may not name a whole tree (spec §3.2): the block is refused, and the plugin's
  // engine part is untouched by that.
  const wholeTreeRow = rowByInstall(rows, FS_WHOLE_TREE_ID)
  const wholeTreeBlock = objectField(wholeTreeRow ?? {}, 'desktop')
  report.record(
    'plugins.desktop.fsScopeWholeTree',
    wholeTreeRow !== null
      && wholeTreeBlock.valid === false
      && wholeTreeBlock.reason === 'whole_tree_fs_scope'
      && ((wholeTreeBlock.panels ?? []) as unknown[]).length === 0,
    JSON.stringify(wholeTreeBlock).slice(0, 200),
  )
  // An icon outside the token shape refuses the whole block (spec §3.2), like every other entry
  // field: the four lists are emptied and the plugin's engine part is untouched. What is *not*
  // refused is a token this build has no glyph for - that is the view assertion above.
  const iconRow = rowByInstall(rows, ICON_INVALID_ID)
  const iconBlock = objectField(iconRow ?? {}, 'desktop')
  report.record(
    'plugins.desktop.iconInvalid',
    iconRow !== null
      && iconBlock.valid === false
      && iconBlock.reason === 'invalid_entry_field'
      && ((iconBlock.panels ?? []) as unknown[]).length === 0,
    JSON.stringify(iconBlock).slice(0, 200),
  )
  // A block whose own range this build cannot satisfy is refused whole (spec §3.2), and the
  // plugin's engine part is untouched by that: the row is still listed.
  const mismatchRow = rowByInstall(rows, ENGINES_MISMATCH_ID)
  const mismatch = objectField(mismatchRow ?? {}, 'desktop')
  report.record(
    'plugins.desktop.enginesMismatch',
    mismatchRow !== null
      && mismatch.valid === false
      && mismatch.reason === 'unsupported_engine_range'
      && ((mismatch.panels ?? []) as unknown[]).length === 0
      && mismatch.enginesOmpDesktop === '^99.0.0',
    JSON.stringify(mismatch).slice(0, 240),
  )
  // A resident plugin process (plan §6.1/§6.5): `main`, the activation events this build
  // implements (the unknown one is dropped, not a refusal) and the contributed command all reach
  // the row as written, and the two names the manifest declares are accepted permissions.
  const processRow = rowByInstall(rows, PROCESS_ID)
  const processBlock = objectField(processRow ?? {}, 'desktop')
  const processView = objectField(processBlock, 'process')
  const processCommands = (processView.commands ?? []) as Array<Record<string, unknown>>
  const processCommand = processCommands[0] ?? {}
  report.record(
    'plugins.desktop.process',
    processRow !== null
      && processBlock.valid === true
      && processView.main === 'desktop/main.js'
      && JSON.stringify(processView.activationEvents) === JSON.stringify(['onStartup', 'onCommand:smoke.hello'])
      && processCommands.length === 1
      && processCommand.id === 'smoke.hello'
      && objectField(processCommand, 'title').zh === '冒烟问候'
      && JSON.stringify(processCommand.keywords) === JSON.stringify(['smoke', 'hello'])
      && ((processBlock.permissions ?? []) as string[]).includes('plugin.process')
      && ((processBlock.permissions ?? []) as string[]).includes('command.register'),
    JSON.stringify(processView).slice(0, 300),
  )
  // The built-in shape: a `main` and a command with no `plugin.process` to declare. The host
  // must project it (and the Rust supervisor, not this host, owns the exemption).
  const builtinProcessRow = rowByInstall(rows, PROCESS_UNPRIVILEGED_ID)
  const builtinProcess = objectField(builtinProcessRow ?? {}, 'desktop')
  report.record(
    'plugins.desktop.processBuiltin',
    builtinProcessRow !== null
      && builtinProcess.valid === true
      && objectField(builtinProcess, 'process').main === 'desktop/main.js'
      && ((builtinProcess.permissions ?? []) as unknown[]).length === 0,
    JSON.stringify(builtinProcess.process ?? null).slice(0, 240),
  )
  // A slot module (plan §7.1): the package-relative entry, the action whitelist and the methods
  // `plugin.call` may reach all arrive as written - and nothing else does, because the URL, its
  // resolution and the runnability verdict are the Rust boundary's (plan §D2). The same module
  // declared without `renderer.extension` has the whole block refused instead.
  const rendererRow = rowByInstall(rows, RENDERER_ID)
  const rendererBlock = objectField(rendererRow ?? {}, 'desktop')
  const rendererView = objectField(rendererBlock, 'renderer')
  const unpermittedRow = rowByInstall(rows, RENDERER_UNPERMITTED_ID)
  const unpermittedBlock = objectField(unpermittedRow ?? {}, 'desktop')
  report.record(
    'plugins.desktop.renderer',
    rendererRow !== null
      && rendererBlock.valid === true
      && rendererView.path === 'desktop/renderer.mjs'
      && JSON.stringify(rendererView.actions) === JSON.stringify([...RENDERER_ACTIONS])
      && JSON.stringify(rendererView.callMethods) === JSON.stringify([...RENDERER_CALL_METHODS])
      && rendererView.url === undefined
      && rendererView.available === undefined
      && unpermittedRow !== null
      && unpermittedBlock.valid === false
      && unpermittedBlock.reason === 'entry_permission_missing'
      && unpermittedBlock.renderer === null,
    JSON.stringify({
      renderer: rendererView,
      unpermitted: { valid: unpermittedBlock.valid, reason: unpermittedBlock.reason, renderer: unpermittedBlock.renderer },
    }).slice(0, 300),
  )
  // A theme's stylesheet and assets (plan §5.4, spec §4.2): the declared package-relative paths
  // reach the row as written, and the Rust boundary is the one that reads the bytes and rewrites
  // them into served text and URLs. The same theme without `ui.theme.css` refuses the block whole -
  // a theme whose stylesheet was quietly dropped is not the theme its author declared.
  const themeCssRow = rowByInstall(rows, THEME_CSS_ID)
  const themeCssBlock = objectField(themeCssRow ?? {}, 'desktop')
  const themeCssTheme = ((themeCssBlock.themes ?? []) as Array<Record<string, unknown>>)[0] ?? {}
  const themeCssBareRow = rowByInstall(rows, THEME_CSS_UNPERMITTED_ID)
  const themeCssBareBlock = objectField(themeCssBareRow ?? {}, 'desktop')
  report.record(
    'plugins.desktop.themeCss',
    themeCssRow !== null
      && themeCssBlock.valid === true
      && themeCssTheme.id === 'smoke-css'
      && themeCssTheme.css === THEME_CSS_PATH
      && JSON.stringify(themeCssTheme.assets) === JSON.stringify([...THEME_CSS_ASSETS])
      && themeCssBareRow !== null
      && themeCssBareBlock.valid === false
      && themeCssBareBlock.reason === 'entry_permission_missing'
      && ((themeCssBareBlock.themes ?? []) as unknown[]).length === 0,
    JSON.stringify({
      projected: themeCssTheme,
      refused: { valid: themeCssBareBlock.valid, reason: themeCssBareBlock.reason },
    }).slice(0, 300),
  )
  // Desktop code is code that runs (plan §5.4): a `main` and a slot module are consent reasons of
  // their own, so the consent chain can confirm what it would start. Neither fixture declares an
  // engine extension, which is what makes these the *only* reason on each row.
  const processConsent = objectField(processRow ?? {}, 'consent')
  const rendererConsent = objectField(rendererRow ?? {}, 'consent')
  report.record(
    'plugins.desktop.consent',
    processConsent.required === true
      && JSON.stringify(processConsent.reasons) === JSON.stringify(['process-main'])
      && rendererConsent.required === true
      && JSON.stringify(rendererConsent.reasons) === JSON.stringify(['renderer-module']),
    JSON.stringify({ process: processConsent, renderer: rendererConsent }),
  )
}
