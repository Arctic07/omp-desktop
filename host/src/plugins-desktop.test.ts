import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import {
  PLUGIN_DESKTOP_API_VERSION,
  PLUGIN_RENDERER_ACTIONS,
  PLUGIN_RENDERER_ACTIONS_MAX,
  PLUGIN_RENDERER_CALL_METHODS_MAX,
  PLUGIN_RENDERER_METHOD_MAX,
  PLUGIN_THEME_COUNT_MAX,
} from './constants.ts'
import { desktopOf, type DesktopView } from './plugins-desktop.ts'

/**
 * The theme half of the `omp.desktop` block (plan §5, spec §3.2/§4.2).
 *
 * These tests read the validator the way every caller does - one manifest in, one projection out -
 * and do not load the engine. What they pin down: the two additive fields (`css`, `assets`) keep the
 * declared paths on this side of the contract, the shapes and counts are refused whole, and the new
 * `ui.theme.css` permission is separate from `ui.theme` rather than folded into it.
 */

/**
 * A fixture root with the one file the page entries name.
 *
 * It used to be `process.cwd()`, which made these assertions depend on a README the host package does
 * not ship: run from `host/`, every entry naming `README.md` resolved out of root and two tests
 * failed for a reason that had nothing to do with the block (2026-10-28). A directory of this test's
 * own is what the check actually means - a page entry inside the package it was declared in.
 */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-desktop-block-'))
fs.writeFileSync(path.join(ROOT, 'README.md'), '# fixture\n')
process.on('exit', () => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true })
  } catch {
    // A fixture that could not be removed is not a failed assertion.
  }
})
const BOTH = ['ui.theme', 'ui.theme.css']
const THEME = { '--dsw-alias-bg-base': '#0b0f1a' }

/** The desktop block one manifest produces; the caller asserts on the projection. */
function project(desktop: Record<string, unknown>): DesktopView {
  const result = desktopOf({ desktop: { schemaVersion: 1, ...desktop } }, ROOT)
  assert.equal(result.error, null)
  assert.notEqual(result.desktop, null)
  return result.desktop as DesktopView
}

/** One theme with the given extra fields, under the given permissions. */
function theme(extra: Record<string, unknown>, permissions: readonly string[] = BOTH): DesktopView {
  return project({ permissions: [...permissions], themes: [{ id: 'midnight', tokens: THEME, ...extra }] })
}

test('a theme carrying no stylesheet projects `css: null` and an empty asset list', () => {
  const desktop = theme({})
  assert.equal(desktop.valid, true)
  assert.deepEqual(desktop.themes, [
    { id: 'midnight', label: null, dark: null, tokens: THEME, css: null, assets: [] },
  ])
})

test('the declared stylesheet path and asset paths reach the page as written', () => {
  const desktop = theme({
    css: 'desktop/themes/midnight.css',
    assets: ['desktop/themes/bg.svg', 'desktop/themes/ink.woff2'],
  })
  assert.equal(desktop.valid, true)
  assert.equal(desktop.themes[0].css, 'desktop/themes/midnight.css')
  assert.deepEqual(desktop.themes[0].assets, ['desktop/themes/bg.svg', 'desktop/themes/ink.woff2'])
})

test('a stylesheet outside the package-relative shape refuses the whole block', () => {
  for (const css of ['/etc/midnight.css', 'desktop/../midnight.css', 'desktop\\midnight.css', 'desktop/themes/midnight.txt', '']) {
    const desktop = theme({ css })
    assert.equal(desktop.valid, false, css)
    assert.equal(desktop.reason, 'invalid_theme_css', css)
    assert.deepEqual(desktop.themes, [], css)
  }
})

test('a stylesheet path over the length cap is refused rather than trimmed', () => {
  const desktop = theme({ css: `${'a'.repeat(300)}.css` })
  assert.equal(desktop.reason, 'invalid_theme_css')
})

test('an asset list that is too long, duplicated, traversal-shaped or an unserved extension is refused', () => {
  const tooMany = Array.from({ length: 17 }, (_, index) => `desktop/themes/${index}.svg`)
  for (const assets of [
    tooMany,
    ['desktop/themes/bg.svg', 'desktop/themes/bg.svg'],
    ['../bg.svg'],
    ['desktop\\bg.svg'],
    ['desktop/themes/bg.gif'],
    ['desktop/themes/bg'],
  ]) {
    const desktop = theme({ assets })
    assert.equal(desktop.valid, false, JSON.stringify(assets))
    assert.equal(desktop.reason, 'invalid_theme_assets', JSON.stringify(assets))
    assert.deepEqual(desktop.themes, [])
  }
})

test('a stylesheet without `ui.theme.css` refuses the whole block', () => {
  const desktop = theme({ css: 'desktop/themes/midnight.css' }, ['ui.theme'])
  assert.equal(desktop.valid, false)
  assert.equal(desktop.reason, 'entry_permission_missing')
  assert.deepEqual(desktop.themes, [])
})

test('declared assets without `ui.theme.css` refuse the whole block', () => {
  const desktop = theme({ assets: ['desktop/themes/bg.svg'] }, ['ui.theme'])
  assert.equal(desktop.valid, false)
  assert.equal(desktop.reason, 'entry_permission_missing')
})

test('an empty asset list asks for no content permission', () => {
  const desktop = theme({ assets: [] }, ['ui.theme'])
  assert.equal(desktop.valid, true)
  assert.deepEqual(desktop.themes[0].assets, [])
})

test('`ui.theme.css` alone is not a theme permission', () => {
  const desktop = theme({}, ['ui.theme.css'])
  assert.equal(desktop.valid, false)
  assert.equal(desktop.reason, 'entry_permission_missing')
})

test('both permissions with no stylesheet is legal: the permission may be declared ahead of the content', () => {
  const desktop = theme({}, BOTH)
  assert.equal(desktop.valid, true)
  assert.equal(desktop.themes[0].css, null)
})

test('the existing token rules still decide a theme: name, value and count', () => {
  assert.equal(theme({ tokens: { '--evil-name': '#000' } }).reason, 'invalid_theme_token_name')
  assert.equal(theme({ tokens: { '--omp-bg': 'url(https://example.com/x.png)' } }).reason, 'invalid_theme_tokens')
  assert.equal(theme({ tokens: {} }).reason, 'invalid_theme_tokens')
  const many = Object.fromEntries(Array.from({ length: 97 }, (_, index) => [`--omp-t${index}`, '#000']))
  assert.equal(theme({ tokens: many }).reason, 'invalid_theme_tokens')
})

test('a theme may repaint the published palette, and nothing else', () => {
  // The rail and the conversation are tokens too: a palette that could tint the window frame and
  // not the content was a half-applied theme (2026-10-27).
  const published = {
    '--sidebar': '#0f1a14',
    '--sidebar-foreground': '#e6e9f0',
    '--background': '#0b0e14',
    '--card': '#10141c',
    '--radius': '0.75rem',
    '--chart-3': '#4f7cf7',
  }
  assert.equal(theme({ tokens: published }).valid, true)
  for (const name of ['--window-frame', '--sidebarish', '--chart-6', '--background-2', '--radius-x']) {
    assert.equal(theme({ tokens: { [name]: '#000' } }).reason, 'invalid_theme_token_name', name)
  }
})

test('a duplicate theme id still refuses the block, stylesheet or not', () => {
  const desktop = project({
    permissions: [...BOTH],
    themes: [
      { id: 'midnight', tokens: THEME, css: 'a.css' },
      { id: 'midnight', tokens: THEME },
    ],
  })
  assert.equal(desktop.reason, 'duplicate_entry_id')
})

test('a plugin contributes at most 8 themes; the ninth refuses the whole block', () => {
  const themes = (count: number): Array<Record<string, unknown>> =>
    Array.from({ length: count }, (_, index) => ({ id: `theme-${index}`, tokens: THEME }))
  const atCap = project({ permissions: ['ui.theme'], themes: themes(PLUGIN_THEME_COUNT_MAX) })
  assert.equal(atCap.valid, true)
  assert.equal(atCap.themes.length, PLUGIN_THEME_COUNT_MAX)
  const overCap = project({ permissions: ['ui.theme'], themes: themes(PLUGIN_THEME_COUNT_MAX + 1) })
  assert.equal(overCap.valid, false)
  assert.equal(overCap.reason, 'too_many_themes')
  assert.deepEqual(overCap.themes, [])
})

/**
 * The plugin-process half (plan §6.1): `main`, `activationEvents` and `contributes.commands`.
 *
 * The posture these pin down: shapes only, no permission refusal (Rust owns runnability and the
 * built-in exemption), an unknown activation event dropped with a log line, and a shape failure
 * refusing the whole desktop block like every other entry list.
 */

test('a complete process block projects `main`, its events and its commands as written', () => {
  const desktop = project({
    permissions: ['plugin.process', 'command.register'],
    main: 'desktop/main.js',
    activationEvents: ['onStartup', 'onCommand:git-helper.open', 'onView:main'],
    contributes: {
      commands: [
        { id: 'git-helper.open', title: { en: 'Git: Open', zh: 'Git：打开' }, keywords: ['git', 'open'] },
        { id: 'git-helper.close' },
      ],
    },
  })
  assert.equal(desktop.valid, true)
  assert.deepEqual(desktop.process, {
    main: 'desktop/main.js',
    activationEvents: ['onStartup', 'onCommand:git-helper.open', 'onView:main'],
    // Absent in the manifest means the supervisor's own behaviour, so the projection says `true`
    // rather than leaving a third state the page would have to interpret.
    autoRestart: true,
    commands: [
      { id: 'git-helper.open', title: { en: 'Git: Open', zh: 'Git：打开' }, keywords: ['git', 'open'] },
      { id: 'git-helper.close', title: null, keywords: [] },
    ],
  })
})

test('a process block may turn the crash restarts off, and only a boolean may', () => {
  const off = project({ permissions: ['plugin.process'], main: 'desktop/main.js', autoRestart: false })
  assert.equal(off.valid, true)
  assert.equal(off.process?.autoRestart, false)

  for (const autoRestart of ['no', 0, {}]) {
    const refused = project({ permissions: ['plugin.process'], main: 'desktop/main.js', autoRestart })
    assert.equal(refused.valid, false, JSON.stringify(autoRestart))
    assert.equal(refused.reason, 'invalid_process_autorestart')
  }
})

test('a process block without `plugin.process` still projects: runnability is Rust\'s', () => {
  // This is the built-in shape (a first-party plugin with a `main` and no `plugin.process`), and the
  // third-party shape the host must also leave for Rust to judge. Neither is a host refusal.
  for (const permissions of [[], ['ui.panel'], ['command.register']]) {
    const desktop = project({ permissions, main: 'desktop/main.mjs' })
    assert.equal(desktop.valid, true, JSON.stringify(permissions))
    assert.equal(desktop.process?.main, 'desktop/main.mjs')
  }
})

test('an unknown activation event is dropped and said out loud, not refused', () => {
  const writes: string[] = []
  const original = process.stderr.write
  process.stderr.write = ((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    const desktop = project({
      main: 'desktop/main.js',
      activationEvents: ['onStartup', 'onLanguage:typescript', 'onCommand:not a command', 'onView:'],
    })
    assert.equal(desktop.valid, true)
    assert.deepEqual(desktop.process?.activationEvents, ['onStartup'])
  } finally {
    process.stderr.write = original
  }
  const joined = writes.join('')
  assert.match(joined, /dropping unknown omp\.desktop activation event: onLanguage:typescript/)
  assert.match(joined, /onCommand:not a command/)
})

test('a `main` outside the package-relative shape refuses the whole block', () => {
  for (const main of ['/abs/main.js', '../main.js', 'desktop/../main.js', 'desktop\\main.js', 'desktop/main.ts', 'node_modules/x/main.js', 'Node_Modules/x/main.js', 'desktop/main.js/..']) {
    const desktop = project({ main })
    assert.equal(desktop.valid, false, main)
    assert.equal(desktop.reason, 'invalid_process_main', main)
    assert.equal(desktop.process, null, main)
  }
})

test('the activation-event and command lists are bounded, and duplicates refuse the block', () => {
  const manyEvents = Array.from({ length: 33 }, () => 'onStartup')
  assert.equal(project({ activationEvents: manyEvents }).reason, 'invalid_activation_events')
  const manyCommands = Array.from({ length: 33 }, (_, index) => ({ id: `demo.c${index}` }))
  assert.equal(project({ contributes: { commands: manyCommands } }).reason, 'invalid_commands')
  assert.equal(project({ contributes: { commands: [{ id: 'demo.same' }, { id: 'demo.same' }] } }).reason, 'duplicate_entry_id')
  assert.equal(project({ contributes: { commands: [{ id: 'not a token' }] } }).reason, 'invalid_commands')
  assert.equal(project({ contributes: { commands: [{ id: 'demo.ok', keywords: ['x'.repeat(65)] }] } }).reason, 'invalid_commands')
  assert.equal(project({ contributes: { commands: [{ id: 'demo.ok', keywords: Array.from({ length: 17 }, () => 'k') }] } }).reason, 'invalid_commands')
  assert.equal(project({ contributes: [] }).reason, 'invalid_contributes')
})

test('a block with only activation events has no process to project', () => {
  const desktop = project({ activationEvents: ['onStartup'] })
  assert.equal(desktop.valid, true)
  assert.equal(desktop.process, null)
})

test('a command id is unique inside its own namespace, not against page entry ids', () => {
  const desktop = project({
    permissions: ['ui.panel'],
    panels: [{ id: 'main', entry: 'README.md' }],
    contributes: { commands: [{ id: 'main' }] },
  })
  assert.equal(desktop.valid, true)
  assert.equal(desktop.process?.commands[0].id, 'main')
})

/**
 * The renderer-slot half (plan §7.1): `renderer`, `rendererActions` and `rendererCallMethods`.
 *
 * These pin the manifest-side whitelist: the module's path is one package-relative `.js`/`.mjs`, the
 * two dispatch lists are closed and bounded, and any of the three without `renderer.extension`
 * refuses the whole block. Nothing here asserts a URL, a resolution result or a runnability verdict -
 * those are the Rust boundary's (plan §D2), which is why the projection has no field for them.
 */

const RENDERER = 'desktop/renderer.mjs'
const RENDERER_GRANTED = ['renderer.extension']

test('a declared slot module projects its path and both dispatch lists as written', () => {
  const desktop = project({
    permissions: [...RENDERER_GRANTED],
    renderer: RENDERER,
    rendererActions: ['plugin.call', 'composer.insertText'],
    rendererCallMethods: ['insertSnippet', 'listSnippets'],
  })
  assert.equal(desktop.valid, true)
  assert.deepEqual(desktop.renderer, {
    path: RENDERER,
    actions: ['plugin.call', 'composer.insertText'],
    callMethods: ['insertSnippet', 'listSnippets'],
  })
  // The Rust boundary adds `url`, `available` and `reason` on its own row; this side produces none
  // of them, so a field the page might mistake for a verdict never reaches it from here.
  assert.deepEqual(Object.keys(desktop.renderer ?? {}).sort(), ['actions', 'callMethods', 'path'])
})

test('a block that declares no renderer projects `null`, permission or not', () => {
  for (const permissions of [[], [...RENDERER_GRANTED]]) {
    const desktop = project({ permissions })
    assert.equal(desktop.valid, true, JSON.stringify(permissions))
    assert.equal(desktop.renderer, null, JSON.stringify(permissions))
  }
})

test('a renderer path outside the package-relative shape refuses the whole block', () => {
  const paths = [
    '/abs/renderer.mjs',
    '../renderer.mjs',
    'desktop/../renderer.mjs',
    'desktop\\renderer.mjs',
    'desktop/renderer.ts',
    'desktop/renderer',
    'node_modules/x/renderer.mjs',
    'Node_Modules/x/renderer.mjs',
    `${'a'.repeat(300)}.mjs`,
  ]
  for (const renderer of paths) {
    const desktop = project({ permissions: [...RENDERER_GRANTED], renderer })
    assert.equal(desktop.valid, false, renderer)
    assert.equal(desktop.reason, 'invalid_renderer_path', renderer)
    assert.equal(desktop.renderer, null, renderer)
  }
})

test('a refused renderer keeps the declared permission for the consent gate', () => {
  const desktop = project({ permissions: [...RENDERER_GRANTED], renderer: '../escape.mjs' })
  assert.equal(desktop.valid, false)
  assert.deepEqual(desktop.permissions, [...RENDERER_GRANTED])
})

test('the action vocabulary is closed: an unknown token refuses the whole block', () => {
  for (const action of ['composer.paste', 'plugin.call.now', 'PLUGIN.CALL', '', ' composer.insertText']) {
    const desktop = project({ permissions: [...RENDERER_GRANTED], renderer: RENDERER, rendererActions: [action] })
    assert.equal(desktop.valid, false, action)
    assert.equal(desktop.reason, 'invalid_renderer_actions', action)
  }
  // A shape the host cannot read at all is the same refusal: a scalar or a nested value is not a
  // token this build could compare against the vocabulary.
  assert.equal(project({ permissions: [...RENDERER_GRANTED], renderer: RENDERER, rendererActions: 'plugin.call' }).reason, 'invalid_renderer_actions')
  assert.equal(project({ permissions: [...RENDERER_GRANTED], renderer: RENDERER, rendererActions: [1] }).reason, 'invalid_renderer_actions')
})

test('the action list is bounded, and every token of the vocabulary is accepted', () => {
  const desktop = project({ permissions: [...RENDERER_GRANTED], renderer: RENDERER, rendererActions: [...PLUGIN_RENDERER_ACTIONS] })
  assert.equal(desktop.valid, true)
  assert.deepEqual(desktop.renderer?.actions, [...PLUGIN_RENDERER_ACTIONS])
  // The bound is checked before the vocabulary, so the 17th token is refused even when it repeats.
  const overCap = Array.from({ length: PLUGIN_RENDERER_ACTIONS_MAX + 1 }, () => 'plugin.call')
  assert.equal(project({ permissions: [...RENDERER_GRANTED], renderer: RENDERER, rendererActions: overCap }).reason, 'invalid_renderer_actions')
})

test('a duplicate action refuses the block rather than being deduplicated', () => {
  const desktop = project({
    permissions: [...RENDERER_GRANTED],
    renderer: RENDERER,
    rendererActions: ['plugin.call', 'composer.insertText', 'plugin.call'],
  })
  assert.equal(desktop.reason, 'invalid_renderer_actions')
  assert.equal(desktop.renderer, null)
})

test('the call-method list is bounded, duplicate-free and token-shaped', () => {
  const methods = Array.from({ length: PLUGIN_RENDERER_CALL_METHODS_MAX }, (_, index) => `method${index}`)
  const accepted = project({ permissions: [...RENDERER_GRANTED], renderer: RENDERER, rendererCallMethods: methods })
  assert.equal(accepted.valid, true)
  assert.equal(accepted.renderer?.callMethods.length, PLUGIN_RENDERER_CALL_METHODS_MAX)
  // The 33rd method is refused, and so is a name at one character over the cap.
  assert.equal(
    project({ permissions: [...RENDERER_GRANTED], renderer: RENDERER, rendererCallMethods: [...methods, 'oneMore'] }).reason,
    'invalid_renderer_call_methods',
  )
  assert.equal(
    project({ permissions: [...RENDERER_GRANTED], renderer: RENDERER, rendererCallMethods: ['m'.repeat(PLUGIN_RENDERER_METHOD_MAX)] }).valid,
    true,
  )
  assert.equal(
    project({ permissions: [...RENDERER_GRANTED], renderer: RENDERER, rendererCallMethods: ['m'.repeat(PLUGIN_RENDERER_METHOD_MAX + 1)] }).reason,
    'invalid_renderer_call_methods',
  )
  assert.equal(
    project({ permissions: [...RENDERER_GRANTED], renderer: RENDERER, rendererCallMethods: ['listSnippets', 'listSnippets'] }).reason,
    'invalid_renderer_call_methods',
  )
  for (const method of ['1method', 'has space', 'has/slash', 'has:colon', '', 'trailing\n']) {
    assert.equal(
      project({ permissions: [...RENDERER_GRANTED], renderer: RENDERER, rendererCallMethods: [method] }).reason,
      'invalid_renderer_call_methods',
      JSON.stringify(method),
    )
  }
})

test('any of the three declarations without `renderer.extension` refuses the whole block', () => {
  const blocks: Array<Record<string, unknown>> = [
    { renderer: RENDERER },
    { rendererActions: ['plugin.call'] },
    { rendererCallMethods: ['insertSnippet'] },
    { renderer: RENDERER, rendererActions: ['composer.insertText'], rendererCallMethods: ['insertSnippet'] },
  ]
  for (const block of blocks) {
    const desktop = project(block)
    assert.equal(desktop.valid, false, JSON.stringify(block))
    assert.equal(desktop.reason, 'entry_permission_missing', JSON.stringify(block))
    assert.equal(desktop.renderer, null, JSON.stringify(block))
    assert.deepEqual(desktop.panels, [], JSON.stringify(block))
  }
})

test('the permission with nothing declared is legal, and a module with no actions merely cannot dispatch', () => {
  const bare = project({ permissions: [...RENDERER_GRANTED] })
  assert.equal(bare.valid, true)
  assert.equal(bare.renderer, null)
  const moduleOnly = project({ permissions: [...RENDERER_GRANTED], renderer: RENDERER })
  assert.equal(moduleOnly.valid, true)
  assert.deepEqual(moduleOnly.renderer, { path: RENDERER, actions: [], callMethods: [] })
  // Empty lists declare nothing either: they are not a reach, so they ask for no permission.
  const emptyLists = project({ rendererActions: [], rendererCallMethods: [] })
  assert.equal(emptyLists.valid, true)
  assert.equal(emptyLists.renderer, null)
})

test('actions declared with no module project no renderer: nothing could load or call them', () => {
  const desktop = project({
    permissions: [...RENDERER_GRANTED],
    rendererActions: ['plugin.call'],
    rendererCallMethods: ['insertSnippet'],
  })
  assert.equal(desktop.valid, true)
  assert.equal(desktop.renderer, null)
})

test('a block with panels and a renderer keeps both', () => {
  const desktop = project({
    permissions: ['ui.panel', ...RENDERER_GRANTED],
    panels: [{ id: 'main', entry: 'README.md' }],
    renderer: RENDERER,
    rendererActions: ['composer.readDraft'],
  })
  assert.equal(desktop.valid, true)
  assert.equal(desktop.panels[0].id, 'main')
  assert.deepEqual(desktop.renderer, { path: RENDERER, actions: ['composer.readDraft'], callMethods: [] })
})

/**
 * `omp.desktop.net.anyHost` (API 0.2.0): the second key beside `net.domains`.
 *
 * Two keys, so two ways to fail: a flag of the wrong type is refused rather than read as `false`
 * (which would silently drop a widening the author declared), and a flag without `net.anyHost` in
 * the permission list is refused whole - a block cannot widen its own reach by writing one boolean.
 */
test('the any-host flag is reported when both keys hold', () => {
  const desktop = project({
    permissions: ['net.fetch', 'net.anyHost'],
    net: { domains: ['api.example.com'], anyHost: true },
  })
  assert.equal(desktop.valid, true)
  assert.equal(desktop.netAnyHost, true)
  assert.deepEqual(desktop.netDomains, ['api.example.com'])
})

test('the flag defaults to false, and the permission alone is not a reach', () => {
  assert.equal(project({ permissions: ['net.fetch'], net: { domains: ['api.example.com'] } }).netAnyHost, false)
  assert.equal(project({ permissions: ['net.fetch', 'net.anyHost'], net: {} }).netAnyHost, false)
})

test('a flag that is not a boolean refuses the whole block', () => {
  for (const anyHost of ['true', 1, {}, []]) {
    const refused = project({
      permissions: ['net.fetch', 'net.anyHost'],
      net: { domains: [], anyHost },
    })
    assert.equal(refused.valid, false, `${JSON.stringify(anyHost)} is not a boolean`)
    assert.equal(refused.reason, 'invalid_net_any_host')
    assert.deepEqual(refused.panels, [], 'a refused block carries no entries')
  }
})

test('the flag without its permission refuses the whole block', () => {
  const refused = project({ permissions: ['net.fetch'], net: { anyHost: true } })
  assert.equal(refused.valid, false)
  assert.equal(refused.reason, 'invalid_net_any_host')
  // The flag is still reported, because a refused block reports what its author declared.
  assert.equal(refused.netAnyHost, true)
})

test('fs.anyPath is one permission this build serves, alone and beside the three file modes', () => {
  // Alone: the permission widens nothing until a file mode is declared beside it, exactly as
  // `net.anyHost` does nothing without `net.fetch`.
  const alone = project({ permissions: ['fs.anyPath'] })
  assert.equal(alone.valid, true)
  assert.deepEqual(alone.permissions, ['fs.anyPath'])
  assert.deepEqual(alone.fsScopes, { read: [], write: [], delete: [] })

  // Beside all three modes, with the scopes a plugin that does *not* need the widening would use:
  // the two declarations are independent, and the block keeps both.
  const both = project({
    permissions: ['fs.read', 'fs.write', 'fs.delete', 'fs.anyPath'],
    fs: { read: { scope: ['docs/**'] } },
  })
  assert.equal(both.valid, true)
  assert.deepEqual(both.permissions, ['fs.read', 'fs.write', 'fs.delete', 'fs.anyPath'])
  assert.deepEqual(both.fsScopes.read, ['docs/**'])
})

test('a permission this build does not serve still refuses the whole block', () => {
  // The negative control for the list above: `fs.anypath` is not the token, and a near miss is a
  // permission this host cannot read rather than one it silently drops.
  for (const name of ['fs.anypath', 'fs.any', 'fs.anyPath.read']) {
    const refused = project({ permissions: [name] })
    assert.equal(refused.valid, false, name)
    assert.equal(refused.reason, 'unknown_permission')
  }
})

test('`engines.ompDesktop` is evaluated against the version this build serves', () => {
  // The version the surfaces in this file belong to: `fs.glob`/`fs.readRange`/`fs.openDefault`/
  // `fs.reveal`, `session.rename`/`session.delete`, `browser.*` and `plugin.dataDir` are all
  // `BridgeMethod`s here, so a plugin that writes a range for them must be satisfied rather than
  // refused - the whole point of the constant moving with them.
  assert.equal(PLUGIN_DESKTOP_API_VERSION, '0.3.0')
  for (const range of ['>=0.1.0', '>=0.2.0', '>=0.3.0', '^0.3.0']) {
    assert.equal(project({ permissions: ['fs.read'], engines: { ompDesktop: range } }).valid, true, range)
  }
  // And the pin that excluded them is refused, which is the one behaviour a plugin author has to
  // know about the bump: `unsupported_engine_range` is what the row reports and the page shows.
  const refused = project({ permissions: ['fs.read'], engines: { ompDesktop: '^0.2.0' } })
  assert.equal(refused.valid, false)
  assert.equal(refused.reason, 'unsupported_engine_range')
})
