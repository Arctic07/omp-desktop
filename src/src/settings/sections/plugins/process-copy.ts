import type { Localized } from '@/lib/i18n'

/**
 * The wording of a plugin's resident process, in both languages.
 *
 * Its own file for the same reason the market page's `market-copy.ts` has one: the page's table is
 * already long enough that a second subject would push it past the line limit
 * (`rules.md#single-file-line-limit`). `PluginsCopy` extends this interface, so a component still
 * reads one copy object and the two tables cannot drift apart without failing to compile.
 *
 * `processCodeNote` is the 「会运行代码」 tier of the three safety statements: the same trust the
 * consent card states for extension modules, said again where a process is started. It is
 * deliberately not the theme tier (a stylesheet) or the renderer tier (a module inside the app's own
 * window realm), and it must not be merged with either.
 */
export interface ProcessCopy {
  processTitle: string
  /** `stopped` / `starting` / `crashed`; `running` is worded by `processRunning` (it carries the pid). */
  processStateLabels: Readonly<Record<string, string>>
  processRunning: (pid: number | null) => string
  processRestarts: (count: number) => string
  processRestartAction: string
  processRestarting: string
  processRestartFailed: string
  /** The supervisor's refusal tokens (`plugin_process_permission_missing`, …). */
  processRefusalLabels: Readonly<Record<string, string>>
  /** The crash tokens (`plugin.process.timeout`, `plugin.process.protocol_mismatch`, …). */
  processCrashLabels: Readonly<Record<string, string>>
  processLastExit: (time: string) => string
  /** The manifest's `omp.desktop.autoRestart: false`: this row shows it instead of nothing. */
  processAutoRestartOff: string
  processCodeNote: string
  commandsTitle: string
  commandsNone: string
  commandRunAction: string
  commandRunning: string
  commandRan: (title: string) => string
  /** The label above a command's returned value, when it returned one. */
  commandResultLabel: string
  commandFailed: string
}

export const PROCESS_COPY: Localized<ProcessCopy> = {
  en: {
    processTitle: 'Plugin process',
    processStateLabels: {
      stopped: 'Not running',
      starting: 'Starting',
      crashed: 'Stopped',
    },
    processRunning: (pid) => (pid === null ? 'Running' : `Running (pid ${pid})`),
    processRestarts: (count) => {
      if (count === 0) return 'No restarts'
      return count === 1 ? 'Restarted once' : `Restarted ${count} times`
    },
    processRestartAction: 'Restart plugin process',
    processRestarting: 'Restarting…',
    processRestartFailed: 'The plugin process could not be restarted.',
    processRefusalLabels: {
      plugin_process_permission_missing:
        'A third-party plugin needs the `plugin.process` permission in its manifest before its process may run.',
      plugin_process_builtin_unverified:
        'This built-in plugin could not be verified, so its process may not run.',
    },
    processCrashLabels: {
      'plugin.process.timeout': 'The process did not answer in time, so it was stopped.',
      'plugin.process.protocol_mismatch':
        'The worker speaks a different protocol version, so the start was refused.',
      'plugin.process.crashed': 'The process exited unexpectedly.',
    },
    processLastExit: (time) => `Last exit ${time}`,
    processAutoRestartOff: 'It asked not to be restarted after a crash',
    processCodeNote:
      'A plugin process is resident JavaScript: the plugin’s own code runs, at the same trust tier as the extension modules it brings. Nothing here is sandboxed.',
    commandsTitle: 'Plugin commands',
    commandsNone: 'This plugin declares no command.',
    commandRunAction: 'Run',
    commandRunning: 'Running…',
    commandRan: (title) => `Ran ${title}.`,
    commandResultLabel: 'Returned',
    commandFailed: 'The command failed.',
  },
  zh: {
    processTitle: '插件进程',
    processStateLabels: {
      stopped: '未运行',
      starting: '启动中',
      crashed: '已停止',
    },
    processRunning: (pid) => (pid === null ? '运行中' : `运行中（pid ${pid}）`),
    processRestarts: (count) => (count === 0 ? '未重启过' : `已重启 ${count} 次`),
    processRestartAction: '重启插件进程',
    processRestarting: '正在重启…',
    processRestartFailed: '插件进程无法重启。',
    processRefusalLabels: {
      plugin_process_permission_missing:
        '第三方插件要在清单里声明 `plugin.process` 权限，才允许运行常驻进程。',
      plugin_process_builtin_unverified: '这个内置插件的身份未能验真，因此不允许启动进程。',
    },
    processCrashLabels: {
      'plugin.process.timeout': '进程在限定时间内没有应答，已被停止。',
      'plugin.process.protocol_mismatch': '进程的协议版本不一致，启动被拒绝。',
      'plugin.process.crashed': '进程意外退出。',
    },
    processLastExit: (time) => `上次退出：${time}`,
    processAutoRestartOff: '清单声明崩溃后不要自动重启',
    processCodeNote:
      '插件进程是常驻的 JavaScript：会运行插件自己的代码，与它带进来的扩展模块同一档信任，没有沙箱。',
    commandsTitle: '插件命令',
    commandsNone: '该插件没有声明命令。',
    commandRunAction: '运行',
    commandRunning: '运行中…',
    commandRan: (title) => `已执行「${title}」。`,
    commandResultLabel: '返回值',
    commandFailed: '命令执行失败。',
  },
}
