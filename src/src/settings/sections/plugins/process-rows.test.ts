import assert from 'node:assert/strict'
import { test } from 'node:test'

import type {
  EngineDesktopBlock,
  EnginePluginProcessView,
  PluginRow,
} from '../../../api/plugins-types'
import type { ProcessCopy } from './process-copy'
import {
  COMMAND_VALUE_MAX_CHARS,
  commandResultValue,
  pluginPaletteCommands,
  pluginProcessCrashLabel,
  pluginProcessOf,
  pluginProcessRefusalLabel,
  pluginProcessRestartable,
  pluginProcessStateLabel,
  pluginViewActivatable,
} from './process-rows.ts'

/**
 * The plugin page's process rules.
 *
 * What is pinned down here: what a row's `omp.desktop.process` block projects to, which commands a
 * command list may offer (an enabled, runnable installation only), the label of every state the
 * supervisor reports, and that a token this build has never heard of is shown as it arrived rather
 * than dropped. The block is also read the way an older host would send it — fields missing — so a
 * host build that predates plugin processes cannot take the page down.
 *
 * The wording is a fixture rather than `copy.ts`: that module reaches the page through a bundler
 * alias the test runner cannot resolve, and what these tests check is the projection's choice of
 * word, not the sentence the page ships.
 */

function processCopy(language: 'zh' | 'en'): ProcessCopy {
  if (language === 'en') {
    return {
      processTitle: 'Plugin process',
      processStateLabels: { stopped: 'Not running', starting: 'Starting', crashed: 'Stopped' },
      processRunning: (pid) => (pid === null ? 'Running' : `Running (pid ${pid})`),
      processRestarts: (count) => `Restarted ${count} times`,
      processRestartAction: 'Restart plugin process',
      processRestarting: 'Restarting…',
      processRestartFailed: 'The plugin process could not be restarted.',
      processRefusalLabels: {
        plugin_process_permission_missing: 'It needs the plugin.process permission.',
        plugin_process_builtin_unverified: 'The built-in could not be verified.',
      },
      processCrashLabels: {
        'plugin.process.timeout': 'The process timed out and was stopped.',
        'plugin.process.protocol_mismatch': 'The worker speaks another protocol version.',
      },
      processLastExit: (time) => `Last exit ${time}`,
      processAutoRestartOff: 'It asked not to be restarted after a crash',
      processCodeNote: 'This runs the plugin’s own code.',
      commandsTitle: 'Plugin commands',
      commandsNone: 'This plugin declares no command.',
      commandRunAction: 'Run',
      commandRunning: 'Running…',
      commandRan: (title) => `Ran ${title}.`,
      commandResultLabel: 'Returned',
      commandFailed: 'The command failed.',
    }
  }
  return {
    processTitle: '插件进程',
    processStateLabels: { stopped: '未运行', starting: '启动中', crashed: '已停止' },
    processRunning: (pid) => (pid === null ? '运行中' : `运行中（pid ${pid}）`),
    processRestarts: (count) => `已重启 ${count} 次`,
    processRestartAction: '重启插件进程',
    processRestarting: '正在重启…',
    processRestartFailed: '插件进程无法重启。',
    processRefusalLabels: {
      plugin_process_permission_missing: '需要 plugin.process 权限。',
      plugin_process_builtin_unverified: '内置插件身份未验真。',
    },
    processCrashLabels: {
      'plugin.process.timeout': '进程超时被停止。',
      'plugin.process.protocol_mismatch': '进程协议版本不一致。',
    },
    processLastExit: (time) => `上次退出 ${time}`,
    processAutoRestartOff: '清单声明崩溃后不要自动重启',
    processCodeNote: '会运行插件自己的代码。',
    commandsTitle: '插件命令',
    commandsNone: '该插件没有声明命令。',
    commandRunAction: '运行',
    commandRunning: '运行中…',
    commandRan: (title) => `已执行 ${title}。`,
    commandResultLabel: '返回值',
    commandFailed: '命令执行失败。',
  }
}

const zh = processCopy('zh')
const en = processCopy('en')

function desktop(process?: EnginePluginProcessView | null): EngineDesktopBlock {
  return {
    schemaVersion: 1,
    valid: true,
    reason: null,
    panels: [],
    views: [],
    settingsDestinations: [],
    sidebarTabs: [],
    workPanelTabs: [],
    permissions: [],
    netDomains: [],
    fsScopes: { read: [], write: [], delete: [] },
    themes: [],
    enginesOmpDesktop: null,
    i18n: null,
    process,
  }
}

function row(overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    id: 'sample',
    installId: 'sample@market-a',
    name: 'sample',
    description: null,
    version: '1.0.0',
    scope: 'user',
    enabled: true,
    builtin: false,
    shadowedBy: null,
    source: {
      kind: 'marketplace',
      label: 'sample@market-a',
      gitCommitSha: null,
      marketplace: 'market-a',
      installId: 'sample@market-a',
      installed: true,
    },
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
    features: [],
    desktop: desktop(),
    desktopError: null,
    ...overrides,
  }
}

const withMain: EnginePluginProcessView = {
  main: 'desktop/main.js',
  activationEvents: ['onStartup', 'onCommand:git-helper.open'],
  commands: [
    { id: 'git-helper.open', title: { en: 'Git: Open', zh: 'Git：打开' }, keywords: ['git'] },
    { id: 'git-helper.status', title: null, keywords: [] },
  ],
  available: true,
  reason: null,
}

test('view activation requires enabled available declaration', () => {
  assert.equal(pluginViewActivatable(row({ desktop: desktop(withMain) }), 'git-helper.open'), false)
  assert.equal(pluginViewActivatable(row({ desktop: desktop({ ...withMain, activationEvents: ['onView:settings'] }) }), 'settings'), true)
  assert.equal(pluginViewActivatable(row({ enabled: false, desktop: desktop({ ...withMain, activationEvents: ['onView:x'] }) }), 'x'), false)
  assert.equal(pluginViewActivatable(row({ desktop: desktop({ ...withMain, available: false, activationEvents: ['onView:x'] }) }), 'x'), false)
})

test('the command list offers every runnable command of an enabled installation, in order', () => {
  const entries = pluginPaletteCommands(
    [
      row({ id: 'git-helper', desktop: desktop(withMain) }),
      row({ id: 'switched-off', enabled: false, desktop: desktop(withMain) }),
      row({
        id: 'refused',
        desktop: desktop({ ...withMain, available: false, reason: 'plugin_process_permission_missing' }),
      }),
      row({ id: 'no-process' }),
      row({
        id: 'commands-only',
        builtin: true,
        scope: 'project',
        desktop: desktop({ commands: [{ id: 'only.command', keywords: ['only'] }] }),
      }),
    ],
    'zh',
  )

  // Rows keep the host's order and commands keep the manifest's; a disabled or refused row offers
  // nothing, and a commands-only row is offered like any other.
  assert.deepEqual(
    entries.map((entry) => [entry.pluginId, entry.scope, entry.commandId, entry.title]),
    [
      ['git-helper', 'user', 'git-helper.open', 'Git：打开'],
      ['git-helper', 'user', 'git-helper.status', 'git-helper.status'],
      ['commands-only', 'project', 'only.command', 'only.command'],
    ],
  )
  assert.deepEqual(entries[0]?.keywords, ['git'])
  assert.deepEqual(entries[1]?.keywords, [])
  // An id is only unique within its installation, so the list's key carries both.
  assert.equal(new Set(entries.map((entry) => entry.key)).size, entries.length)

  // The English table words the same titles its own way, and falls back to the id all the same.
  assert.deepEqual(
    pluginPaletteCommands([row({ id: 'git-helper', desktop: desktop(withMain) })], 'en').map(
      (entry) => entry.title,
    ),
    ['Git: Open', 'git-helper.status'],
  )
})

test('a row without a process block yields nothing', () => {
  assert.equal(pluginProcessOf(row({ desktop: null })), null)
  assert.equal(pluginProcessOf(row({ desktop: desktop(null) })), null)
  assert.equal(pluginProcessOf(row({ desktop: desktop({}) })), null)
  assert.equal(
    pluginProcessOf(row({ desktop: desktop({ main: '   ', commands: [] }) })),
    null,
  )
  assert.deepEqual(pluginPaletteCommands([row({ desktop: null })], 'zh'), [])
})

test('the process block is read defensively, field by field', () => {
  // The host's oldest shape: a commands-only block with no verdict fields at all.
  assert.deepEqual(pluginProcessOf(row({ desktop: desktop({ commands: [{ id: 'a.b' }] }) })), {
    main: null,
    activationEvents: [],
    commands: [{ id: 'a.b', title: null, keywords: [] }],
    autoRestart: true,
    available: true,
    reason: null,
  })

  // A partial block: an entry with no id is not addressable and is skipped, unusable keywords and
  // events are dropped, and whitespace is not a value.
  assert.deepEqual(
    pluginProcessOf(
      row({
        desktop: desktop({
          main: ' desktop/main.js ',
          activationEvents: ['onStartup', '  '],
          commands: [
            { id: '   ' },
            { id: ' b.c ', keywords: ['git', '  '], title: { zh: 'B：运行' } },
          ],
          reason: '  ',
        }),
      }),
    ),
    {
      main: 'desktop/main.js',
      activationEvents: ['onStartup'],
      commands: [{ id: 'b.c', title: { zh: 'B：运行' }, keywords: ['git'] }],
      autoRestart: true,
      available: true,
      reason: null,
    },
  )

  // The supervisor's own verdict is carried through unchanged: false is a refusal, not a default.
  const refused = pluginProcessOf(
    row({
      desktop: desktop({
        main: 'desktop/main.js',
        available: false,
        reason: 'plugin_process_builtin_unverified',
      }),
    }),
  )
  assert.equal(refused?.available, false)
  assert.equal(refused?.reason, 'plugin_process_builtin_unverified')
})

test('every process state is worded, and an unknown token keeps its spelling', () => {
  assert.equal(pluginProcessStateLabel('stopped', null, zh), '未运行')
  assert.equal(pluginProcessStateLabel('starting', null, zh), '启动中')
  assert.equal(pluginProcessStateLabel('crashed', null, zh), '已停止')
  assert.equal(pluginProcessStateLabel('running', 4321, zh), '运行中（pid 4321）')
  // A running process whose pid the table did not carry is still running.
  assert.equal(pluginProcessStateLabel('running', null, zh), '运行中')
  assert.equal(pluginProcessStateLabel('vanished', null, zh), 'vanished')

  assert.equal(pluginProcessStateLabel('stopped', null, en), 'Not running')
  assert.equal(pluginProcessStateLabel('running', 7, en), 'Running (pid 7)')
})

test('a crash and a refusal are worded, and an unknown token is shown as it arrived', () => {
  assert.equal(pluginProcessCrashLabel('plugin.process.timeout', zh), zh.processCrashLabels['plugin.process.timeout'])
  assert.equal(
    pluginProcessCrashLabel('plugin.process.protocol_mismatch', en),
    en.processCrashLabels['plugin.process.protocol_mismatch'],
  )
  assert.equal(pluginProcessCrashLabel('worker_fatal', zh), 'worker_fatal')

  assert.equal(
    pluginProcessRefusalLabel('plugin_process_permission_missing', en),
    en.processRefusalLabels['plugin_process_permission_missing'],
  )
  assert.equal(pluginProcessRefusalLabel('plugin_process_something_new', zh), 'plugin_process_something_new')
  // The two vocabularies do not answer for each other: a refusal token is not a crash sentence.
  assert.equal(pluginProcessCrashLabel('plugin_process_permission_missing', zh), 'plugin_process_permission_missing')
})

test('only a starting process refuses a restart', () => {
  assert.equal(pluginProcessRestartable('starting'), false)
  assert.equal(pluginProcessRestartable('running'), true)
  assert.equal(pluginProcessRestartable('crashed'), true)
  assert.equal(pluginProcessRestartable('stopped'), true)
  assert.equal(pluginProcessRestartable('vanished'), true)
})

test('a command’s returned value is shown as data, bounded', () => {
  // Nothing to show is `null`, not the string "undefined": the row then prints the ran line alone.
  assert.equal(commandResultValue(undefined), null)
  assert.equal(commandResultValue(null), null)

  // A string stands as it stands (a handler that returns markup shows markup as text).
  assert.equal(commandResultValue('hello'), 'hello')
  assert.equal(commandResultValue('<b>x</b>'), '<b>x</b>')

  // Everything else is JSON, indented, so a returned object is readable.
  assert.equal(commandResultValue({ greeting: 'hi', count: 2 }), '{\n  "greeting": "hi",\n  "count": 2\n}')
  assert.equal(commandResultValue([1, 2]), '[\n  1,\n  2\n]')
  assert.equal(commandResultValue(0), '0')
  assert.equal(commandResultValue(false), 'false')

  // A value the JSON writer cannot represent is nothing to show, not a crash on the page.
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.equal(commandResultValue(cyclic), null)

  // The bound is the row's own: one character past it is truncated and marked.
  const long = 'x'.repeat(COMMAND_VALUE_MAX_CHARS + 10)
  const shown = commandResultValue(long)
  assert.equal(shown?.length, COMMAND_VALUE_MAX_CHARS + 1)
  assert.ok(shown?.endsWith('…'))
  assert.equal(commandResultValue('x'.repeat(COMMAND_VALUE_MAX_CHARS)), 'x'.repeat(COMMAND_VALUE_MAX_CHARS))
})
