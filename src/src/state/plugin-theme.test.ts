import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EngineDesktopBlock, EnginePluginTheme, PluginRow } from '@/api/plugins-types'
import {
  pluginThemes,
  pluginThemeStore,
  reconcilePluginTheme,
  selectPluginTheme,
  startPluginTheme,
  themeStylesheetState,
} from './plugin-theme.ts'

/**
 * The lifecycle of the two `<style>` elements a plugin theme paints (plan §5.3).
 *
 * The document here is a stand-in, not a renderer: what is under test is which elements exist, what
 * they contain, and in which order — the three things that decide whether a contributed stylesheet
 * can override the token block and whether dropping a theme leaves an orphan behind.
 */

interface FakeStyle {
  id: string
  textContent: string
  remove: () => void
}

const STYLE_IDS = ['omp-plugin-theme', 'omp-plugin-theme-css']

/** A `<head>` that tracks appended `<style>` elements, and the `document` that reaches it. */
function installDocument(): FakeStyle[] {
  const children: FakeStyle[] = []
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      head: {
        // `append` moves a node that is already there, exactly as the DOM does: the module re-appends
        // its two elements on every paint so they stay after the application's own stylesheet.
        append: (node: FakeStyle) => {
          const index = children.indexOf(node)
          if (index >= 0) children.splice(index, 1)
          children.push(node)
        },
      },
      createElement: (tag: string) => {
        assert.equal(tag, 'style')
        const node: FakeStyle = {
          id: '',
          textContent: '',
          remove: () => {
            const index = children.indexOf(node)
            if (index >= 0) children.splice(index, 1)
          },
        }
        return node
      },
      getElementById: (id: string) => children.find((child) => child.id === id) ?? null,
    },
  })
  return children
}

/** The persistence this module writes through; the key is part of its contract. */
function installStorage(initial: string | null): { readonly read: () => string | null } {
  let stored = initial
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: () => stored,
        setItem: (_key: string, value: string) => {
          stored = value
        },
        removeItem: () => {
          stored = null
        },
      },
    },
  })
  return { read: () => stored }
}

function theme(id: string, css: string | null, cssError: string | null = null): EnginePluginTheme {
  return {
    id,
    label: null,
    dark: null,
    tokens: { '--dsw-alias-bg-base': '#0b0f1a' },
    css,
    assets: [],
    cssError,
  }
}

/** A row that contributes exactly the themes under test; every other fact is the empty case. */
function row(themes: EnginePluginTheme[]): PluginRow {
  const desktop: EngineDesktopBlock = {
    schemaVersion: 1,
    valid: true,
    reason: null,
    panels: [],
    views: [],
    settingsDestinations: [],
    sidebarTabs: [],
    workPanelTabs: [],
    permissions: ['ui.theme', 'ui.theme.css'],
    netDomains: [],
    fsScopes: { read: [], write: [], delete: [] },
    themes,
    enginesOmpDesktop: null,
    i18n: null,
  }
  return {
    id: 'demo.theme',
    installId: null,
    name: 'demo.theme',
    description: null,
    version: '1.0.0',
    scope: 'user',
    enabled: true,
    builtin: false,
    shadowedBy: null,
    source: { kind: 'npm', label: 'demo.theme', gitCommitSha: null, marketplace: null, installId: null, installed: true },
    sources: [],
    installedAt: null,
    lastUpdated: null,
    consent: { required: false, reasons: [] },
    code: {
      extensions: 0,
      baseTools: false,
      baseHooks: false,
      hooksDir: false,
      toolsDir: false,
      mcpConfig: false,
      skillsDir: false,
      commandsDir: false,
      agentsDir: false,
      rulesDir: false,
      promptsDir: false,
      lspConfig: false,
      dapConfig: false,
    },
    settings: { keys: [], hasSecret: false },
    desktop,
    desktopError: null,
  }
}

/** A fresh document, and this module back on the default theme. */
function reset(): FakeStyle[] {
  const children = installDocument()
  installStorage(null)
  selectPluginTheme(null)
  return children
}

test('a stylesheet theme writes the token element first and the stylesheet second', () => {
  const children = reset()
  const themes = pluginThemes([row([theme('midnight', ':root{--dsw-alias-bg-base:#0b0f1a}')])], 'en')
  selectPluginTheme(themes[0])

  assert.deepEqual(children.map((child) => child.id), STYLE_IDS)
  assert.equal(children[0].textContent, ':root{--dsw-alias-bg-base:#0b0f1a;}')
  assert.equal(children[1].textContent, ':root{--dsw-alias-bg-base:#0b0f1a}')
  assert.equal(pluginThemeStore.get().selected?.themeId, 'midnight')
})

test('a theme without a stylesheet leaves exactly one element behind', () => {
  const children = reset()
  const themes = pluginThemes([row([theme('plain', null)])], 'en')
  selectPluginTheme(themes[0])

  assert.deepEqual(children.map((child) => child.id), ['omp-plugin-theme'])
})

test('a repaint moves the theme to the end of head, so it wins the cascade', () => {
  const children = reset()
  const themes = pluginThemes([row([theme('midnight', ':root{color:red}')])], 'en')
  selectPluginTheme(themes[0])

  // The application's own stylesheet, arriving after the start-up shell painted its copy: the palette
  // it declares is at the same specificity, so the later rule is the one that wins.
  const applicationSheet: FakeStyle = { id: 'application', textContent: '', remove: () => {} }
  ;(document.head as unknown as { append: (node: FakeStyle) => void }).append(applicationSheet)
  selectPluginTheme(themes[0])

  assert.deepEqual(children.map((child) => child.id), ['application', ...STYLE_IDS])
})

test('choosing another theme replaces both texts in place rather than stacking elements', () => {
  const children = reset()
  const first = pluginThemes([row([theme('first', ':root{color:red}')])], 'en')[0]
  const second = pluginThemes([row([theme('second', ':root{color:blue}')])], 'en')[0]

  selectPluginTheme(first)
  selectPluginTheme(second)

  assert.deepEqual(children.map((child) => child.id), STYLE_IDS)
  assert.equal(children[1].textContent, ':root{color:blue}')
})

test('choosing a theme without a stylesheet after one with a stylesheet removes the stylesheet', () => {
  const children = reset()
  const withCss = pluginThemes([row([theme('with-css', ':root{color:red}')])], 'en')[0]
  const plain = pluginThemes([row([theme('plain', null)])], 'en')[0]

  selectPluginTheme(withCss)
  assert.deepEqual(children.map((child) => child.id), STYLE_IDS)
  selectPluginTheme(plain)

  assert.deepEqual(children.map((child) => child.id), ['omp-plugin-theme'])
})

test('the default theme removes both elements', () => {
  const children = reset()
  const themes = pluginThemes([row([theme('midnight', ':root{color:red}')])], 'en')

  selectPluginTheme(themes[0])
  selectPluginTheme(null)

  assert.deepEqual(children.map((child) => child.id), [])
  assert.equal(pluginThemeStore.get().selected, null)
})

test('reconciling away an uninstalled theme drops the choice and both elements', () => {
  const children = reset()
  const themes = pluginThemes([row([theme('midnight', ':root{color:red}')])], 'en')
  selectPluginTheme(themes[0])

  reconcilePluginTheme([])

  assert.equal(pluginThemeStore.get().selected, null)
  assert.deepEqual(children.map((child) => child.id), [])
})

test('reconciling an installed theme keeps it painted', () => {
  const children = reset()
  const themes = pluginThemes([row([theme('midnight', ':root{color:red}')])], 'en')
  selectPluginTheme(themes[0])

  reconcilePluginTheme(themes)

  assert.equal(pluginThemeStore.get().selected?.themeId, 'midnight')
  assert.deepEqual(children.map((child) => child.id), STYLE_IDS)
})

test('startup paints the stored stylesheet before the plugin list is read', () => {
  const children = installDocument()
  const stored = JSON.stringify({
    key: 'demo.theme\u0000user\u0000midnight',
    pluginId: 'demo.theme',
    pluginName: 'demo.theme',
    themeId: 'midnight',
    label: 'Midnight',
    dark: true,
    tokens: { '--dsw-alias-bg-base': '#0b0f1a' },
    css: ':root{color:red}',
  })
  installStorage(stored)

  startPluginTheme()

  assert.deepEqual(children.map((child) => child.id), STYLE_IDS)
  assert.equal(children[1].textContent, ':root{color:red}')
})

test('a stored entry from before stylesheets paints tokens only', () => {
  const children = installDocument()
  installStorage(
    JSON.stringify({
      key: 'demo.theme\u0000user\u0000plain',
      pluginId: 'demo.theme',
      pluginName: 'demo.theme',
      themeId: 'plain',
      label: 'Plain',
      dark: null,
      tokens: { '--dsw-alias-bg-base': '#0b0f1a' },
    }),
  )

  startPluginTheme()

  assert.deepEqual(children.map((child) => child.id), ['omp-plugin-theme'])
})

test('a theme whose stylesheet was refused paints its tokens and leaves exactly one element', () => {
  const children = reset()
  const themes = pluginThemes([row([theme('broken', null, 'theme_css_invalid')])], 'en')

  assert.equal(themes[0].cssError, 'theme_css_invalid')
  assert.deepEqual(themeStylesheetState(themes[0]), { kind: 'unavailable', reason: 'theme_css_invalid' })

  selectPluginTheme(themes[0])

  assert.deepEqual(children.map((child) => child.id), ['omp-plugin-theme'])
  assert.equal(children[0].textContent, ':root{--dsw-alias-bg-base:#0b0f1a;}')
})

test('the badge projection names the applied stylesheet, the refusal, or neither', () => {
  const [applied] = pluginThemes([row([theme('applied', ':root{color:red}')])], 'en')
  const [refused] = pluginThemes([row([theme('refused', null, 'theme_css_invalid')])], 'en')
  const [plain] = pluginThemes([row([theme('plain', null)])], 'en')

  assert.deepEqual(themeStylesheetState(applied), { kind: 'stylesheet' })
  assert.deepEqual(themeStylesheetState(refused), { kind: 'unavailable', reason: 'theme_css_invalid' })
  assert.deepEqual(themeStylesheetState(plain), { kind: 'none' })
})

test('a refused stylesheet stays stated when the choice is restored from storage', () => {
  const children = installDocument()
  installStorage(
    JSON.stringify({
      key: 'demo.theme\u0000user\u0000broken',
      pluginId: 'demo.theme',
      pluginName: 'demo.theme',
      themeId: 'broken',
      label: 'Broken',
      dark: null,
      tokens: { '--dsw-alias-bg-base': '#0b0f1a' },
      css: null,
      cssError: 'theme_css_invalid',
    }),
  )

  startPluginTheme()

  assert.deepEqual(pluginThemeStore.get().selected?.cssError, 'theme_css_invalid')
  assert.deepEqual(children.map((child) => child.id), ['omp-plugin-theme'])
})
