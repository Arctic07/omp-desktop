/**
 * The plugin fixtures the scenario plants: package trees, registry entries, the runtime lock, a
 * local marketplace catalog and marketplace records.
 *
 * Everything here writes the engine's *own* storage layout under the smoke data root - a package
 * directory in the plugins registry's `node_modules`, an entry in `omp-plugins.lock.json`, a
 * record in `installed_plugins.json`, a directory junction for the link shape, and, for the
 * marketplace stage, the catalog directory the engine fetches and the package it points at -
 * because the scenario has to exercise the engine's discovery rather than a mock of it. Nothing
 * here asserts: the stage bodies in `plugins.ts` own the checks. `leftoverFixtures` is the one
 * piece a stage calls for itself, to look for fixtures that outlived the run.
 *
 * Every plant has a matching remove, and the scenario calls them from a `finally`: the data root is
 * shared with every other scenario and a run may drive this one more than once, so a fixture that
 * outlived the run would change what the next one sees.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { dataRoot } from '../client.ts'

/** The package name the fixture plugin is installed and addressed by. */
export const PLUGIN_ID = 'smoke-plugin'

/** The version the fixture declares; the list row must report this one (spec §3.4). */
export const PLUGIN_VERSION = '1.2.3'

/** Where stage 2's install source lives: inside the smoke data root, never inside the registry. */
export const LINK_FIXTURE_ROOT = path.join(dataRoot, 'smoke-plugin')

/** A marketplace record whose cache directory exists but has no `package.json` (stage 3). */
export const BROKEN_MISSING_ID = 'smoke-broken-missing@smoke-market'
const BROKEN_MISSING_ROOT = path.join(dataRoot, 'smoke-broken-missing')

/** A marketplace record whose cache directory holds a `package.json` that is not JSON (stage 3). */
export const BROKEN_INVALID_ID = 'smoke-broken-invalid@smoke-market'
const BROKEN_INVALID_ROOT = path.join(dataRoot, 'smoke-broken-invalid')

/**
 * A marketplace record whose cache holds valid JSON whose `omp` block is not an object (stage 3):
 * the shape `manifestBlockUnreadable` exists for, where the file reads but the manifest it declares
 * cannot be used.
 */
export const BROKEN_BLOCK_ID = 'smoke-broken-block@smoke-market'
const BROKEN_BLOCK_ROOT = path.join(dataRoot, 'smoke-broken-block')

/**
 * The two feature-gated fixtures (stage 4): plugins whose only code entry point lives inside
 * `omp.features.<name>` rather than at the manifest's top level. The first feature is enabled by
 * the engine's own default rule, the second is not.
 */
/** A plugin whose desktop block declares an engines range and one theme (spec §3.2, §4.2). */
export const DESKTOP_ID = 'smoke-desktop@smoke-market'
export const DESKTOP_ROOT = path.join(dataRoot, 'smoke-desktop-plugin')

/**
 * The shape the page reports: `engines.ompDesktop` evaluated against this build, one theme whose
 * tokens are the desktop's own families, and the four page lists - each entry carrying the id, the
 * localised title, the entry path, the order, an optional icon token and (for a panel) the window it
 * asked for.
 *
 * The four entry files are written, because the host checks that a declared entry exists before a
 * page may be contributed at all; the stage then asserts what the row says about them.
 */
export function plantDesktopFixture(): void {
  fs.rmSync(DESKTOP_ROOT, { recursive: true, force: true })
  for (const entry of ['desktop/panel/index.html', 'desktop/view/log.html', 'desktop/settings/advanced.html', 'desktop/tab/index.html']) {
    fs.mkdirSync(path.dirname(path.join(DESKTOP_ROOT, entry)), { recursive: true })
    fs.writeFileSync(path.join(DESKTOP_ROOT, entry), '<!doctype html><title>smoke</title>\n', 'utf8')
  }
  fs.writeFileSync(
    path.join(DESKTOP_ROOT, 'package.json'),
    `${JSON.stringify({
      name: 'smoke-desktop-plugin',
      version: PLUGIN_VERSION,
      omp: {
        desktop: {
          schemaVersion: 1,
          engines: { ompDesktop: '>=0.1.0' },
          permissions: [
            'ui.theme',
            'ui.panel',
            'ui.view',
            'ui.settings',
            'ui.tab',
            'fs.read',
            'fs.write',
            'fs.delete',
          ],
          // The standing reach each file mode stands for (spec §3.2, §6.3): a literal file and a
          // multi-segment star for reading, and one directory for the two modes that change what is
          // on disk - which is what the stage asserts the row carries to the Rust side.
          fs: {
            read: { scope: ['desktop/**', 'README.md'] },
            write: { scope: ['desktop/out/**'] },
            delete: { scope: ['desktop/out/**'] },
          },
          themes: [{ id: 'smoke-theme', tokens: { '--dsw-alias-bg-base': '#0b0f1a' } }],
          panels: [
            {
              id: 'main',
              title: { en: 'Smoke Panel', zh: '冒烟面板' },
              entry: 'desktop/panel/index.html',
              // The icon token every list may carry (spec §3.2): the host checks the shape only, so
              // the stage asserts the token written here is the token the row reports - and that a
              // name this build has no glyph for (`no-such-icon`, on the view) still travels.
              icon: 'globe-2',
              width: 480,
              height: 360,
              resizable: false,
            },
          ],
          views: [{ id: 'log', title: { en: 'Smoke Log' }, entry: 'desktop/view/log.html', order: 10, icon: 'no-such-icon' }],
          settingsDestinations: [
            // No icon: the field is optional, and the stage asserts the row reports `null` rather
            // than inventing a token for an entry that declared none.
            { id: 'advanced', title: { zh: '高级' }, entry: 'desktop/settings/advanced.html' },
          ],
          sidebarTabs: [{ id: 'tab', title: { en: 'Smoke Tab' }, entry: 'desktop/tab/index.html', icon: 'globe-2' }],
          // A work-panel tab this application draws itself (spec §3.2, §4.2): no `entry` at all -
          // the stage asserts the renderer token travels and that nothing invents a document for it.
          workPanelTabs: [
            { id: 'terminal', title: { en: 'Smoke Terminal' }, icon: 'terminal', order: 30, renderer: 'terminal' },
          ],
        },
      },
    }, null, 2)}\n`,
    'utf8',
  )
  writeInstalledRecord(DESKTOP_ID, {
    scope: 'user',
    installPath: DESKTOP_ROOT,
    version: PLUGIN_VERSION,
    installedAt: new Date(0).toISOString(),
    lastUpdated: new Date(0).toISOString(),
    enabled: true,
  })
}

/**
 * A plugin whose desktop range this build cannot satisfy (stage 4b): the block has to be refused,
 * with the engine part untouched.
 */
export const ENGINES_MISMATCH_ID = 'smoke-engines@smoke-market'
export const ENGINES_MISMATCH_ROOT = path.join(dataRoot, 'smoke-engines-plugin')

/**
 * The same block with a range far beyond this desktop, plus the shapes that would be *unreadable*
 * rather than unsatisfied - a panel whose entry climbs out of the root, a list that names a
 * permission the manifest does not grant - left for the unit-level rules the host shares with the
 * page. What this fixture proves is the one thing a row can show: the range decided it.
 */
export function plantEnginesMismatchFixture(): void {
  fs.rmSync(ENGINES_MISMATCH_ROOT, { recursive: true, force: true })
  fs.mkdirSync(ENGINES_MISMATCH_ROOT, { recursive: true })
  fs.writeFileSync(
    path.join(ENGINES_MISMATCH_ROOT, 'package.json'),
    `${JSON.stringify({
      name: 'smoke-engines',
      version: PLUGIN_VERSION,
      omp: {
        desktop: {
          schemaVersion: 1,
          engines: { ompDesktop: '^99.0.0' },
          permissions: ['ui.panel'],
          panels: [{ id: 'main', entry: 'index.html' }],
        },
      },
    }, null, 2)}\n`,
    'utf8',
  )
  fs.writeFileSync(path.join(ENGINES_MISMATCH_ROOT, 'index.html'), '<!doctype html>\n', 'utf8')
  writeInstalledRecord(ENGINES_MISMATCH_ID, {
    scope: 'user',
    installPath: ENGINES_MISMATCH_ROOT,
    version: PLUGIN_VERSION,
    installedAt: new Date(0).toISOString(),
    lastUpdated: new Date(0).toISOString(),
    enabled: true,
  })
}

/** Guarantees the range-mismatch fixture does not outlive the scenario. */
export function removeEnginesMismatchFixture(): void {
  fs.rmSync(ENGINES_MISMATCH_ROOT, { recursive: true, force: true })
  writeInstalledRecord(ENGINES_MISMATCH_ID, null)
}

/**
 * A plugin whose file scope is not one both sides could read the same way (stage 4b): `panel**` is a
 * star *inside* a segment, which the rule refuses rather than reading as "one star" - so the whole
 * desktop block is refused and nothing about the plugin loads.
 *
 * It plants the one shape the rules are about, because the rule is the same on both sides: the host
 * refuses the block, and the Rust side would refuse the same pattern again if a row carried it.
 */
export const FS_SCOPE_INVALID_ID = 'smoke-scope@smoke-market'
export const FS_SCOPE_INVALID_ROOT = path.join(dataRoot, 'smoke-scope-plugin')

export function plantFsScopeFixture(): void {
  fs.rmSync(FS_SCOPE_INVALID_ROOT, { recursive: true, force: true })
  fs.mkdirSync(FS_SCOPE_INVALID_ROOT, { recursive: true })
  fs.writeFileSync(
    path.join(FS_SCOPE_INVALID_ROOT, 'package.json'),
    `${JSON.stringify({
      name: 'smoke-scope',
      version: PLUGIN_VERSION,
      omp: {
        desktop: {
          schemaVersion: 1,
          permissions: ['ui.panel', 'fs.read'],
          fs: { read: { scope: ['desktop/panel**', 'ok/**'] } },
          panels: [{ id: 'main', entry: 'index.html' }],
        },
      },
    }, null, 2)}\n`,
    'utf8',
  )
  fs.writeFileSync(path.join(FS_SCOPE_INVALID_ROOT, 'index.html'), '<!doctype html>\n', 'utf8')
  writeInstalledRecord(FS_SCOPE_INVALID_ID, {
    scope: 'user',
    installPath: FS_SCOPE_INVALID_ROOT,
    version: PLUGIN_VERSION,
    installedAt: new Date(0).toISOString(),
    lastUpdated: new Date(0).toISOString(),
    enabled: true,
  })
}

/** Guarantees the invalid-scope fixture does not outlive the scenario. */
export function removeFsScopeFixture(): void {
  fs.rmSync(FS_SCOPE_INVALID_ROOT, { recursive: true, force: true })
  writeInstalledRecord(FS_SCOPE_INVALID_ID, null)
}

/**
 * A plugin whose *write* scope names a whole tree (stage 4b): only a read may be a whole-tree reach
 * (spec §3.2), so the block is refused - a plugin that may change everything has no range at all.
 */
export const FS_WHOLE_TREE_ID = 'smoke-whole-tree@smoke-market'
export const FS_WHOLE_TREE_ROOT = path.join(dataRoot, 'smoke-whole-tree-plugin')

export function plantFsWholeTreeFixture(): void {
  fs.rmSync(FS_WHOLE_TREE_ROOT, { recursive: true, force: true })
  fs.mkdirSync(FS_WHOLE_TREE_ROOT, { recursive: true })
  fs.writeFileSync(
    path.join(FS_WHOLE_TREE_ROOT, 'package.json'),
    `${JSON.stringify({
      name: 'smoke-whole-tree',
      version: PLUGIN_VERSION,
      omp: {
        desktop: {
          schemaVersion: 1,
          permissions: ['ui.panel', 'fs.write'],
          fs: { write: { scope: ['**'] } },
          panels: [{ id: 'main', entry: 'index.html' }],
        },
      },
    }, null, 2)}\n`,
    'utf8',
  )
  fs.writeFileSync(path.join(FS_WHOLE_TREE_ROOT, 'index.html'), '<!doctype html>\n', 'utf8')
  writeInstalledRecord(FS_WHOLE_TREE_ID, {
    scope: 'user',
    installPath: FS_WHOLE_TREE_ROOT,
    version: PLUGIN_VERSION,
    installedAt: new Date(0).toISOString(),
    lastUpdated: new Date(0).toISOString(),
    enabled: true,
  })
}

/** Guarantees the whole-tree fixture does not outlive the scenario. */
export function removeFsWholeTreeFixture(): void {
  fs.rmSync(FS_WHOLE_TREE_ROOT, { recursive: true, force: true })
  writeInstalledRecord(FS_WHOLE_TREE_ID, null)
}

/** Guarantees the desktop fixture does not outlive the scenario. */
export function removeDesktopFixture(): void {
  fs.rmSync(DESKTOP_ROOT, { recursive: true, force: true })
  writeInstalledRecord(DESKTOP_ID, null)
}

/**
 * A plugin whose page entry declares an icon outside the token shape (stage 4b): `Not An Icon` is
 * neither lowercase nor a single token, so the whole desktop block is refused the way every other
 * entry-field failure refuses it - the four lists are emptied and nothing about the plugin loads.
 *
 * The name set is deliberately *not* what this plants: a token this build has no glyph for is still
 * a token (the desktop fixture's view carries one), so only the shape is under test here.
 */
export const ICON_INVALID_ID = 'smoke-icon@smoke-market'
export const ICON_INVALID_ROOT = path.join(dataRoot, 'smoke-icon-plugin')

export function plantIconInvalidFixture(): void {
  fs.rmSync(ICON_INVALID_ROOT, { recursive: true, force: true })
  fs.mkdirSync(ICON_INVALID_ROOT, { recursive: true })
  fs.writeFileSync(
    path.join(ICON_INVALID_ROOT, 'package.json'),
    `${JSON.stringify({
      name: 'smoke-icon',
      version: PLUGIN_VERSION,
      omp: {
        desktop: {
          schemaVersion: 1,
          permissions: ['ui.panel'],
          panels: [{ id: 'main', entry: 'index.html', icon: 'Not An Icon' }],
        },
      },
    }, null, 2)}\n`,
    'utf8',
  )
  fs.writeFileSync(path.join(ICON_INVALID_ROOT, 'index.html'), '<!doctype html>\n', 'utf8')
  writeInstalledRecord(ICON_INVALID_ID, {
    scope: 'user',
    installPath: ICON_INVALID_ROOT,
    version: PLUGIN_VERSION,
    installedAt: new Date(0).toISOString(),
    lastUpdated: new Date(0).toISOString(),
    enabled: true,
  })
}

/** Guarantees the invalid-icon fixture does not outlive the scenario. */
export function removeIconInvalidFixture(): void {
  fs.rmSync(ICON_INVALID_ROOT, { recursive: true, force: true })
  writeInstalledRecord(ICON_INVALID_ID, null)
}

/**
 * A plugin whose LSP/DAP configuration the engine materialises, and whose MCP servers come from a
 * manifest field rather than `.mcp.json`: three code surfaces the consent facts have to see even
 * though the package ships none of them by hand (spec §9.2-5).
 */
export const CODE_SURFACE_ID = 'smoke-code-surface@smoke-market'
export const CODE_SURFACE_ROOT = path.join(dataRoot, 'smoke-code-surface')

export function plantCodeSurfaceFixture(): void {
  fs.rmSync(CODE_SURFACE_ROOT, { recursive: true, force: true })
  fs.mkdirSync(path.join(CODE_SURFACE_ROOT, 'skills', 'surface'), { recursive: true })
  // `.omp-plugin/plugin.json` is where the engine prefers a manifest's own `mcpServers` over the
  // conventional `.mcp.json`; the row has to read the same source.
  fs.mkdirSync(path.join(CODE_SURFACE_ROOT, '.omp-plugin'), { recursive: true })
  fs.writeFileSync(
    path.join(CODE_SURFACE_ROOT, '.omp-plugin', 'plugin.json'),
    `${JSON.stringify({ mcpServers: { smoke: { command: 'node', args: ['server.js'] } } }, null, 2)}\n`,
    'utf8',
  )
  // The two files a marketplace entry's `lspServers` / `dapAdapters` are written as.
  fs.writeFileSync(path.join(CODE_SURFACE_ROOT, '.lsp.json'), `${JSON.stringify({ servers: {} }, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(CODE_SURFACE_ROOT, '.dap.json'), `${JSON.stringify({ adapters: {} }, null, 2)}\n`, 'utf8')
  fs.writeFileSync(
    path.join(CODE_SURFACE_ROOT, 'package.json'),
    `${JSON.stringify({ name: 'smoke-code-surface', version: PLUGIN_VERSION }, null, 2)}\n`,
    'utf8',
  )
  writeInstalledRecord(CODE_SURFACE_ID, {
    scope: 'user',
    installPath: CODE_SURFACE_ROOT,
    version: PLUGIN_VERSION,
    installedAt: new Date(0).toISOString(),
    lastUpdated: new Date(0).toISOString(),
    enabled: true,
  })
}

export function removeCodeSurfaceFixture(): void {
  fs.rmSync(CODE_SURFACE_ROOT, { recursive: true, force: true })
  writeInstalledRecord(CODE_SURFACE_ID, null)
}

/**
 * The three fixtures whose *only* code surface is the unprefixed config file name the engine reads
 * from a plugin root (stage 4b, H1): `mcp.json`, `lsp.yaml` and `dap.json` each sit in a plugin
 * directory with nothing else - no skills tree, no `omp` block, no dotted config file - so a probe
 * that only looked for `.mcp.json` / `.lsp.json` / `.dap.json` would report no code at all and wave
 * all three through the consent gate.
 */
export const MCP_FILE_ID = 'smoke-mcp-file@smoke-market'
export const LSP_FILE_ID = 'smoke-lsp-file@smoke-market'
export const DAP_FILE_ID = 'smoke-dap-file@smoke-market'
const MCP_FILE_ROOT = path.join(dataRoot, 'smoke-mcp-file')
const LSP_FILE_ROOT = path.join(dataRoot, 'smoke-lsp-file')
const DAP_FILE_ROOT = path.join(dataRoot, 'smoke-dap-file')

/** Writes one fixture whose only code surface is `file`, with `contents`, in its plugin root. */
function plantCodeFileFixture(id: string, root: string, file: string, contents: string): void {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, file), contents, 'utf8')
  // A manifest with no `omp`/`pi` block, so the one fact the row can report is the file above.
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: id.slice(0, id.indexOf('@')), version: PLUGIN_VERSION }, null, 2)}\n`,
    'utf8',
  )
  writeInstalledRecord(id, installedRecord(root))
}

export function plantConsentFileFixtures(): void {
  plantCodeFileFixture(MCP_FILE_ID, MCP_FILE_ROOT, 'mcp.json', `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`)
  plantCodeFileFixture(LSP_FILE_ID, LSP_FILE_ROOT, 'lsp.yaml', 'servers: {}\n')
  plantCodeFileFixture(DAP_FILE_ID, DAP_FILE_ROOT, 'dap.json', `${JSON.stringify({ adapters: {} }, null, 2)}\n`)
}

/** Guarantees the three consent-file fixtures do not outlive the scenario. */
export function removeConsentFileFixtures(): void {
  const fixtures = [
    [MCP_FILE_ID, MCP_FILE_ROOT],
    [LSP_FILE_ID, LSP_FILE_ROOT],
    [DAP_FILE_ID, DAP_FILE_ROOT],
  ]
  for (const [id, root] of fixtures) {
    fs.rmSync(root, { recursive: true, force: true })
    writeInstalledRecord(id, null)
  }
}

export const FEATURE_DEFAULT_ID = 'smoke-feature-default'
export const FEATURE_OPTIONAL_ID = 'smoke-feature-optional'

/**
 * The same shape reached through a marketplace record: the row a page renders under
 * `<name>@<marketplace>`, whose features are resolved from the record's install path.
 */
export const FEATURE_MARKET_ID = 'smoke-feature-market@smoke-market'
export const FEATURE_MARKET_NAME = 'smoke-feature-market'
export const FEATURE_MARKET_ROOT = path.join(dataRoot, 'smoke-feature-market')

/**
 * The engine's plugin directory under the smoke's pinned environment.
 *
 * The engine resolves it from its directory table (`pi-utils/dirs.ts`): an XDG data root wins where
 * the platform honours one (`$XDG_DATA_HOME/omp/plugins`, i.e. Linux), and everywhere else it hangs
 * off the pinned home as `<home>/<PI_CONFIG_DIR>/plugins` - the launcher pins
 * `PI_CONFIG_DIR=omp-desktop`. Its `node_modules` appears as soon as any install has been attempted,
 * so the candidate that has one is the directory the host in this run really used; the platform rule
 * is the fallback for a run that touched no registry yet.
 */
export function pluginsDir(): string {
  const candidates = [
    path.join(dataRoot, 'host', 'xdg', 'omp', 'plugins'),
    path.join(dataRoot, 'home', 'omp-desktop', 'plugins'),
  ]
  const used = candidates.find(candidate => fs.existsSync(path.join(candidate, 'node_modules')))
  if (used !== undefined) return used
  return process.platform === 'linux' ? candidates[0] : candidates[1]
}

/** The runtime lock file the engine reads a plugin's enabled flag and settings from. */
function lockPath(): string {
  return path.join(pluginsDir(), 'omp-plugins.lock.json')
}

/** The fixture package's manifest: engine settings and a desktop block with both locales. */
function fixtureManifest(): Record<string, unknown> {
  return {
    name: PLUGIN_ID,
    version: PLUGIN_VERSION,
    description: 'Fixture package the plugin smoke installs',
    omp: {
      description: 'Smoke fixture plugin',
      settings: {
        endpoint: { type: 'string', description: 'Where the plugin calls', default: 'a' },
        retries: { type: 'number', min: 0, max: 10 },
        mode: { type: 'enum', values: ['safe', 'fast'] },
      },
      desktop: {
        schemaVersion: 1,
        permissions: ['notify', 'ui.theme'],
        // One theme, so the smoke carries the contribution through the registry: the tokens are the
        // desktop's own two families, and the label is localised like every other text here.
        themes: [
          {
            id: 'smoke-dark',
            label: { en: 'Smoke Dark', zh: '冒烟深色' },
            dark: true,
            tokens: { '--dsw-alias-bg-base': '#0b0f1a', '--omp-terminal-background': '#101418' },
          },
        ],
        // `settings` renames the form's controls (spec §5.5). `nope` is not in the engine's schema
        // on purpose - the projection keeps it and the page aligns the two when it renders - while
        // the blank and over-long labels are the text rule the other localised fields use.
        i18n: {
          zh: { name: '冒烟插件', settings: { endpoint: '接口地址', mode: '运行模式' } },
          en: {
            name: 'Smoke Plugin',
            settings: { endpoint: 'API endpoint', nope: 'Not in the schema', blank: '   ', long: 'x'.repeat(600) },
          },
        },
      },
    },
  }
}

/** Writes a complete package directory, replacing whatever is at `root`. */
export function writePackage(root: string): void {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, 'skills', 'smoke-plugin-skill'), { recursive: true })
  // The two prompt surfaces the row reports (spec §4.1.1): a rule the engine can put in a system
  // prompt and a prompt template it discovers. Neither is a consent reason, and the row must still
  // say they are shipped.
  fs.mkdirSync(path.join(root, 'rules'), { recursive: true })
  fs.mkdirSync(path.join(root, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(fixtureManifest(), null, 2)}\n`, 'utf8')
  fs.writeFileSync(
    path.join(root, 'skills', 'smoke-plugin-skill', 'SKILL.md'),
    `---\nname: smoke-plugin-skill\ndescription: Fixture skill the plugin ships\n---\n\n# Smoke plugin skill\n\nNothing reads this body in the smoke.\n`,
    'utf8',
  )
  fs.writeFileSync(
    path.join(root, 'rules', 'smoke-rule.md'),
    `---\ndescription: Fixture rule the smoke only reports\n---\n\n# Smoke rule\n\nNothing injects this body: the fixture plugin stays disabled.\n`,
    'utf8',
  )
  fs.writeFileSync(
    path.join(root, 'prompts', 'smoke-prompt.md'),
    `---\ndescription: Fixture prompt template\n---\n\nFixture prompt body.\n`,
    'utf8',
  )
}

/** The plugin a stage 2 fixture is assembled for: a real package directory, never a link. */
export function plantRegistryFixture(): void {
  writePackage(path.join(pluginsDir(), 'node_modules', PLUGIN_ID))
  writeLock(PLUGIN_ID, { version: PLUGIN_VERSION, enabledFeatures: null, enabled: false })
}

/** Guarantees the fixture is gone, whatever the frames did with it. */
export function removeRegistryFixture(): void {
  fs.rmSync(path.join(pluginsDir(), 'node_modules', PLUGIN_ID), { recursive: true, force: true })
  writeLock(PLUGIN_ID, null)
}

/**
 * Merges (or removes, with `state === null`) one plugin's entry in the runtime lock file.
 *
 * Everything else in the file is preserved: the lock is shared with every other plugin in the data
 * root, and a scenario that rewrote it whole would change what other scenarios see. Removing also
 * drops the plugin's settings entry, because the engine's own uninstall does - and a run whose
 * uninstall was refused would otherwise leave the fixture's values behind for the next run.
 */
export function writeLock(name: string, state: Record<string, unknown> | null): void {
  const file = lockPath()
  let lock: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) lock = parsed as Record<string, unknown>
  } catch {
    // A missing or unreadable lock is an empty one; the engine reads it exactly the same way.
  }
  const plugins = { ...((lock.plugins ?? {}) as Record<string, unknown>) }
  const settings = { ...((lock.settings ?? {}) as Record<string, unknown>) }
  const pluginsWithout = { ...plugins }
  delete pluginsWithout[name]
  const settingsWithout = { ...settings }
  delete settingsWithout[name]
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      { ...lock, plugins: state === null ? pluginsWithout : { ...plugins, [name]: state }, settings: state === null ? settingsWithout : settings },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

/**
 * The link fixture: the same package, reached through a directory link in the plugins registry.
 *
 * The engine's own `link()` is not usable for this on every machine (`fs.symlink` with no type is
 * what Windows refuses without Developer Mode, see the header), so the link is planted the way a
 * developer's own tooling would: a directory junction, which needs no elevation on Windows and is
 * an ordinary symlink elsewhere. The manager only reads the entry, and a junction is the one shape
 * `isLink` reports, so the row this produces is the row a real `omp plugin link` produces.
 */
export function plantLinkFixture(): void {
  const link = path.join(pluginsDir(), 'node_modules', PLUGIN_ID)
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.rmSync(link, { recursive: true, force: true })
  fs.symlinkSync(LINK_FIXTURE_ROOT, link, 'junction')
  writeLock(PLUGIN_ID, { version: PLUGIN_VERSION, enabledFeatures: null, enabled: false })
}

/**
 * Adds (or removes, with `entry === null`) one marketplace install record.
 *
 * `installed_plugins.json` under the plugins directory is the engine's own record of what it
 * installed (`marketplace/types.ts`), and this writes it exactly as the engine does - a record per
 * plugin id, an array of entries each. Everything else in the file is preserved: the data root is
 * shared with every other scenario, so a rewrite would change what those see.
 */
export function writeInstalledRecord(id: string, entry: Record<string, unknown> | null): void {
  const file = path.join(pluginsDir(), 'installed_plugins.json')
  let registry: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) registry = parsed as Record<string, unknown>
  } catch {
    // A missing or unreadable registry is an empty one; the engine reads it exactly the same way.
  }
  const plugins = { ...((registry.plugins ?? {}) as Record<string, unknown>) }
  if (entry === null) delete plugins[id]
  else plugins[id] = [entry]
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ version: 2, ...registry, plugins }, null, 2)}\n`, 'utf8')
}

/** One marketplace record, as a cache directory that produced it. */
function installedRecord(installPath: string): Record<string, unknown> {
  return {
    scope: 'user',
    installPath,
    version: PLUGIN_VERSION,
    installedAt: new Date(0).toISOString(),
    lastUpdated: new Date(0).toISOString(),
    enabled: true,
  }
}

/**
 * The three unusable manifests stage 3 plants: one cache directory with no `package.json` at all,
 * one whose `package.json` is not JSON, and one whose JSON is valid but declares an `omp` block
 * that is not an object. All three are rows a page still has to render - the engine's record says
 * the plugin is installed - so the host reports *why* the manifest yielded nothing instead of
 * leaving a row that looks like an engine-only plugin, and every one of them fails closed as
 * possibly carrying code (spec §15.1-4).
 */
export function plantBrokenManifests(): void {
  const recordedAt = new Date(0).toISOString()
  fs.rmSync(BROKEN_MISSING_ROOT, { recursive: true, force: true })
  fs.mkdirSync(BROKEN_MISSING_ROOT, { recursive: true })
  fs.rmSync(BROKEN_INVALID_ROOT, { recursive: true, force: true })
  fs.mkdirSync(BROKEN_INVALID_ROOT, { recursive: true })
  fs.writeFileSync(path.join(BROKEN_INVALID_ROOT, 'package.json'), '{ "name": "smoke-broken-invalid",\n', 'utf8')
  fs.rmSync(BROKEN_BLOCK_ROOT, { recursive: true, force: true })
  fs.mkdirSync(BROKEN_BLOCK_ROOT, { recursive: true })
  fs.writeFileSync(
    path.join(BROKEN_BLOCK_ROOT, 'package.json'),
    `${JSON.stringify({ name: 'smoke-broken-block', version: PLUGIN_VERSION, omp: 'not a manifest' }, null, 2)}\n`,
    'utf8',
  )
  writeInstalledRecord(BROKEN_MISSING_ID, {
    scope: 'user',
    installPath: BROKEN_MISSING_ROOT,
    version: PLUGIN_VERSION,
    installedAt: recordedAt,
    lastUpdated: recordedAt,
    enabled: true,
  })
  writeInstalledRecord(BROKEN_INVALID_ID, {
    scope: 'user',
    installPath: BROKEN_INVALID_ROOT,
    version: PLUGIN_VERSION,
    installedAt: recordedAt,
    lastUpdated: recordedAt,
    enabled: true,
  })
  writeInstalledRecord(BROKEN_BLOCK_ID, {
    scope: 'user',
    installPath: BROKEN_BLOCK_ROOT,
    version: PLUGIN_VERSION,
    installedAt: recordedAt,
    lastUpdated: recordedAt,
    enabled: true,
  })
}

/** Guarantees no stage 3 fixture outlives the scenario, whatever the frames did with them. */
export function removeBrokenManifests(): void {
  fs.rmSync(BROKEN_MISSING_ROOT, { recursive: true, force: true })
  fs.rmSync(BROKEN_INVALID_ROOT, { recursive: true, force: true })
  fs.rmSync(BROKEN_BLOCK_ROOT, { recursive: true, force: true })
  writeInstalledRecord(BROKEN_MISSING_ID, null)
  writeInstalledRecord(BROKEN_INVALID_ID, null)
  writeInstalledRecord(BROKEN_BLOCK_ID, null)
}

/**
 * One feature-gated package (stage 4) at `root`: the entry points are declared inside
 * `omp.features.code` and nowhere else - no top-level `extensions` / `tools` / `hooks`, no `hooks/`
 * or `tools/` directory, no `.mcp.json` - so the reasons the row carries can only come from that
 * one feature. The files it points at are empty modules that export nothing: the smoke reads the
 * row and never loads them (no session enables the feature here).
 */
function writeFeaturePackage(root: string, name: string, feature: Record<string, unknown>): void {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name, version: PLUGIN_VERSION, omp: { features: { code: feature } } }, null, 2)}\n`,
    'utf8',
  )
  for (const key of ['extensions', 'tools', 'hooks']) {
    const declared = feature[key]
    if (!Array.isArray(declared)) continue
    for (const entry of declared) {
      if (typeof entry !== 'string' || entry.length === 0) continue
      fs.writeFileSync(path.join(root, entry), 'export default function () {}\n', 'utf8')
    }
  }
}

/**
 * The two registry fixtures, with the runtime state an ordinary install leaves behind:
 * `enabledFeatures: null`, which the engine reads as "the features that declare `default: true`".
 *
 * The default-on feature declares all three entry-point fields, because the engine merges every one
 * of them into the load it performs: a row that read only `extensions` would still miss a plugin
 * whose tools or hooks are feature-declared.
 */
export function plantFeatureFixtures(): void {
  const fixtures: Array<[string, Record<string, unknown>]> = [
    [FEATURE_DEFAULT_ID, { default: true, extensions: ['index.js'], tools: ['tools.js'], hooks: ['hook.js'] }],
    [FEATURE_OPTIONAL_ID, { default: false, extensions: ['index.js'] }],
  ]
  for (const [name, feature] of fixtures) {
    writeFeaturePackage(path.join(pluginsDir(), 'node_modules', name), name, feature)
    writeLock(name, { version: PLUGIN_VERSION, enabledFeatures: null, enabled: true })
  }
}

/**
 * The marketplace echo of those fixtures: a real marketplace install - a cache directory, the
 * junction into the registry's `node_modules` and a record in `installed_plugins.json`, which is
 * the layout `MarketplaceManager.#registerRuntimePlugin` writes - whose feature nothing enables by
 * default and the lock selects. A marketplace row never reaches `PluginManager.list()`, so its
 * features are resolved through the record instead, and that lookup has to agree with the gate:
 * the plugin runs its extension module the moment a session loads it.
 */
export function plantFeatureMarketplace(): void {
  writeFeaturePackage(FEATURE_MARKET_ROOT, FEATURE_MARKET_NAME, { default: false, extensions: ['index.js'] })
  const link = path.join(pluginsDir(), 'node_modules', FEATURE_MARKET_NAME)
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.rmSync(link, { recursive: true, force: true })
  fs.symlinkSync(FEATURE_MARKET_ROOT, link, 'junction')
  writeInstalledRecord(FEATURE_MARKET_ID, installedRecord(FEATURE_MARKET_ROOT))
  writeLock(FEATURE_MARKET_NAME, { version: PLUGIN_VERSION, enabledFeatures: ['code'], enabled: true })
}

/** Guarantees no feature fixture outlives the scenario, whatever the frames did with them. */
export function removeFeatureFixtures(): void {
  for (const name of [FEATURE_DEFAULT_ID, FEATURE_OPTIONAL_ID, FEATURE_MARKET_NAME]) {
    fs.rmSync(path.join(pluginsDir(), 'node_modules', name), { recursive: true, force: true })
    writeLock(name, null)
  }
  fs.rmSync(FEATURE_MARKET_ROOT, { recursive: true, force: true })
  writeInstalledRecord(FEATURE_MARKET_ID, null)
}

/**
 * Stage 5's marketplace: a local catalog directory, added by path and installed from by name.
 *
 * A `sourceType: "local"` marketplace is nothing but a directory the engine reads a catalog from
 * (`marketplace/fetcher.ts`: `.omp-plugin/marketplace.json`, falling back to the Claude Code
 * path), so the whole route from catalog to a running install can be driven without a network, a
 * credential or `git`. The catalog it plants declares the fields the engine validates - `name`,
 * `owner.name`, and one `plugins[]` entry with `name`, a `./`-relative `source`, `version` and
 * `description` - and the package that entry resolves to declares one extension module and one
 * setting: enough for the row's consent facts and for a settings round trip, and nothing that runs
 * on import.
 */
export const MARKET_NAME = 'smoke-local-market'

/** The one plugin the fixture catalog lists, and the id an install of it is recorded under. */
export const MARKET_PLUGIN_NAME = 'demo'
export const MARKET_PLUGIN_ID = `${MARKET_PLUGIN_NAME}@${MARKET_NAME}`

/** The version the catalog entry *and* the package declare; the install row has to show it. */
export const MARKET_PLUGIN_VERSION = '0.4.2'

/** The one setting the fixture package declares, and the value a stage puts through it. */
export const MARKET_SETTING_KEY = 'greeting'
export const MARKET_SETTING_VALUE = 'hello from the smoke'

/** The catalog directory itself: inside the smoke data root, never inside the registry. */
export const MARKET_ROOT = path.join(dataRoot, 'smoke-market')

/**
 * The catalog the engine fetches from one marketplace root: every field its parser validates, one
 * entry for the fixture plugin.
 */
function marketCatalog(marketplace: string, version: string): Record<string, unknown> {
  return {
    name: marketplace,
    owner: { name: 'Smoke Fixture Owner' },
    plugins: [
      {
        name: MARKET_PLUGIN_NAME,
        source: `./${MARKET_PLUGIN_NAME}`,
        version,
        description: 'Fixture plugin the local marketplace stage installs',
      },
    ],
  }
}

/** The package the catalog entry points at: one extension module, one setting. */
function marketPluginManifest(version: string): Record<string, unknown> {
  return {
    name: MARKET_PLUGIN_NAME,
    version,
    description: 'Fixture package a local marketplace install leaves in the engine cache',
    omp: {
      extensions: ['index.js'],
      settings: {
        [MARKET_SETTING_KEY]: { type: 'string', description: 'Greeting the fixture module would use', default: 'a' },
      },
    },
  }
}

/**
 * Writes one local marketplace and the package its catalog entry points at.
 *
 * `index.js` exports a function and does nothing on import, so nothing here has a side effect even
 * if a later tool loads it; the smoke itself never loads it (no session enables the plugin).
 */
function plantMarketplace(marketplace: string, root: string, version: string): void {
  const pluginRoot = path.join(root, MARKET_PLUGIN_NAME)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, '.omp-plugin'), { recursive: true })
  fs.mkdirSync(pluginRoot, { recursive: true })
  fs.writeFileSync(path.join(root, '.omp-plugin', 'marketplace.json'), `${JSON.stringify(marketCatalog(marketplace, version), null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(pluginRoot, 'package.json'), `${JSON.stringify(marketPluginManifest(version), null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(pluginRoot, 'index.js'), 'export default function () {}\n', 'utf8')
}

/** The marketplace the stage installs from and refreshes. */
export function plantMarketplaceFixture(version: string = MARKET_PLUGIN_VERSION): void {
  plantMarketplace(MARKET_NAME, MARKET_ROOT, version)
}

/**
 * The second local marketplace: the same plugin at a newer version, never installed from.
 *
 * It exists for one answer the engine cannot give (plan §4.2): `checkForUpdates` compares an install
 * only with its own marketplace's catalog, so a newer version in another marketplace is visible to
 * this host alone - and it is a source switch, because `upgradePlugin` cannot reinstall from a
 * marketplace other than the recorded one.
 */
export const MARKET_B_NAME = 'smoke-local-market-b'
export const MARKET_B_ROOT = path.join(dataRoot, 'smoke-market-b')
export const MARKET_B_VERSION = '0.6.0'

export function plantSecondMarketplaceFixture(): void {
  plantMarketplace(MARKET_B_NAME, MARKET_B_ROOT, MARKET_B_VERSION)
}

/** Drops the second marketplace and the clone the engine made of it, whatever the frames did. */
export function removeSecondMarketplaceFixture(): void {
  fs.rmSync(MARKET_B_ROOT, { recursive: true, force: true })
  fs.rmSync(path.join(pluginsDir(), 'cache', 'marketplaces', MARKET_B_NAME), { recursive: true, force: true })
  removeMarketplaceRecord(MARKET_B_NAME)
}

/**
 * The newer version the upgrade stage re-imports. Deliberately the next minor: the comparison is the
 * engine's own semver read, and the stage exists to prove this desktop's import path leaves a
 * source the engine can call newer.
 */
export const MARKET_PLUGIN_VERSION_NEXT = '0.5.0'

/**
 * The runtime link an install of the fixture writes into the registry's `node_modules`: a directory
 * junction on Windows (`marketplace/manager.ts`), i.e. the entry that proves the install linked the
 * cached copy rather than copying it again.
 */
export const MARKET_RUNTIME_LINK = path.join(pluginsDir(), 'node_modules', MARKET_PLUGIN_NAME)

/**
 * Where an install of the fixture lives in the engine's own storage, so a run can check that none
 * of it outlived the scenario: the runtime link the registration writes, the cached copy it links
 * to, and the catalog the add persisted.
 *
 * The cache paths repeat the engine's layout (`cache/plugins/<marketplace>___<name>___<version>`),
 * which is the same kind of duplication the lock and registry writers above already carry: a
 * fixture that asked the engine where its own files are could not run before the engine answered.
 */
function marketplaceStoragePaths(): string[] {
  return [
    MARKET_RUNTIME_LINK,
    path.join(pluginsDir(), 'cache', 'plugins', `${MARKET_NAME}___${MARKET_PLUGIN_NAME}___${MARKET_PLUGIN_VERSION}`),
    path.join(pluginsDir(), 'cache', 'marketplaces', MARKET_NAME),
  ]
}

/** Drops one marketplace from the engine's registry file, preserving every other entry. */
function removeMarketplaceRecord(name: string): void {
  const file = path.join(path.dirname(pluginsDir()), 'marketplaces.json')
  let registry: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) registry = parsed as Record<string, unknown>
  } catch {
    // A missing or unreadable registry is an empty one; the engine reads it exactly the same way.
  }
  const marketplaces = Array.isArray(registry.marketplaces) ? registry.marketplaces : []
  const kept = marketplaces.filter(entry => (entry as { name?: unknown } | null)?.name !== name)
  if (kept.length === marketplaces.length) return
  fs.writeFileSync(file, `${JSON.stringify({ ...registry, marketplaces: kept }, null, 2)}\n`, 'utf8')
}

/**
 * Guarantees no stage 5 fixture outlives the scenario, whatever the frames did with it.
 *
 * Every removal here is what the engine's own uninstall and remove do - the runtime link, the lock
 * entry, the install record, both cache trees, the registry entry - so a run whose frames failed,
 * which is exactly the state a rerun would start from, still leaves the data root as it found it.
 */
export function removeMarketplaceFixture(): void {
  for (const target of marketplaceStoragePaths()) fs.rmSync(target, { recursive: true, force: true })
  writeLock(MARKET_PLUGIN_NAME, null)
  writeInstalledRecord(MARKET_PLUGIN_ID, null)
  removeMarketplaceRecord(MARKET_NAME)
  fs.rmSync(MARKET_ROOT, { recursive: true, force: true })
}

/**
 * Every path this scenario's fixtures occupy, so the scenario can report any that outlived it.
 *
 * The data root is shared by every scenario and a run may drive this one more than once, so a
 * fixture still on disk at the end would change what the next run sees; the check reads the whole
 * set at once rather than one stage at a time, which is also how it covers a stage whose own
 * cleanup never ran.
 */
export function leftoverFixtures(): string[] {
  return [
    path.join(pluginsDir(), 'node_modules', PLUGIN_ID),
    path.join(pluginsDir(), 'node_modules', FEATURE_DEFAULT_ID),
    path.join(pluginsDir(), 'node_modules', FEATURE_OPTIONAL_ID),
    path.join(pluginsDir(), 'node_modules', FEATURE_MARKET_NAME),
    FEATURE_MARKET_ROOT,
    MARKET_ROOT,
    MARKET_B_ROOT,
    DESKTOP_ROOT,
    ENGINES_MISMATCH_ROOT,
    ICON_INVALID_ROOT,
    CODE_SURFACE_ROOT,
    MCP_FILE_ROOT,
    LSP_FILE_ROOT,
    DAP_FILE_ROOT,
    // The process fixtures live in their own module (`plugins.process.fixtures.ts`), but the
    // leftover probe is the one place that has to know every root there is.
    path.join(dataRoot, 'smoke-process-plugin'),
    path.join(dataRoot, 'smoke-process-builtin'),
    // The renderer fixtures likewise (`plugins.renderer.fixtures.ts`).
    path.join(dataRoot, 'smoke-renderer-plugin'),
    path.join(dataRoot, 'smoke-renderer-bare'),
    // And the theme-stylesheet fixtures (`plugins.theme.fixtures.ts`).
    path.join(dataRoot, 'smoke-theme-css'),
    path.join(dataRoot, 'smoke-theme-css-bare'),
    ...marketplaceStoragePaths(),
  ].filter(candidate => fs.existsSync(candidate))
}
