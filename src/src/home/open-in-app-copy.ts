/**
 * The open-in-app menu's data: which ids this page names, in which order, and what each is called.
 *
 * The desktop answers with the ids it resolved on this machine (`services/open_in_app/catalog.rs`);
 * names are the page's job, so an id this table does not carry stays off the menu rather than
 * appearing as a raw token. The order below is the menu's own: editors first, then the file manager,
 * then terminals, then git clients.
 */

import type { Localized } from '@/lib/i18n'

export const OPEN_IN_APPS = [
  'vscode',
  'cursor',
  'vscodeinsiders',
  'windsurf',
  'zed',
  'sublimetext',
  'explorer',
  'finder',
  'filemanager',
  'windowsterminal',
  'terminal',
  'iterm',
  'warp',
  'ghostty',
  'kitty',
  'gnometerminal',
  'konsole',
  'gitbash',
  'xcode',
  'androidstudio',
  'intellij',
  'idea',
  'pycharm',
  'webstorm',
  'phpstorm',
  'goland',
  'rider',
  'rustrover',
  'fork',
  'sourcetree',
  'github',
  'tower',
  'gitkraken',
  'smartgit',
  'sublimemerge',
] as const

/** The installed ids this page can name, in menu order. */
export function orderedOpenInApps(installed: readonly string[]): string[] {
  const present = new Set(installed)
  return OPEN_IN_APPS.filter((id) => present.has(id))
}

/**
 * The app the split button opens on its own: the remembered one, else the first installed.
 *
 * A remembered id only counts while it is still installed, so uninstalling an editor does not
 * leave the split button pointing at nothing.
 */
export function defaultOpenInAppFor(
  installed: readonly string[],
  rememberedId: string | null,
): string | null {
  const available = orderedOpenInApps(installed)
  if (rememberedId !== null && available.includes(rememberedId)) return rememberedId
  return available[0] ?? null
}

interface OpenInAppCopy {
  /** The main button's label and tooltip: "Open in VS Code". */
  openIn: (name: string) => string
  /** The chevron's own name, and the menu's accessible name. */
  choose: string
  copyPath: string
  copied: string
  copyFailed: string
  launchFailed: string
  /** Brand names, in the language the menu is read in. */
  names: Record<string, string>
}

const EN_NAMES: Record<string, string> = {
  vscode: 'VS Code',
  cursor: 'Cursor',
  vscodeinsiders: 'VS Code Insiders',
  windsurf: 'Windsurf',
  zed: 'Zed',
  sublimetext: 'Sublime Text',
  explorer: 'File Explorer',
  finder: 'Finder',
  filemanager: 'File Manager',
  windowsterminal: 'Terminal',
  terminal: 'Terminal',
  iterm: 'iTerm',
  warp: 'Warp',
  ghostty: 'Ghostty',
  kitty: 'kitty',
  gnometerminal: 'GNOME Terminal',
  konsole: 'Konsole',
  gitbash: 'Git Bash',
  xcode: 'Xcode',
  androidstudio: 'Android Studio',
  intellij: 'IntelliJ IDEA Ultimate',
  idea: 'IntelliJ IDEA Community',
  pycharm: 'PyCharm',
  webstorm: 'WebStorm',
  phpstorm: 'PhpStorm',
  goland: 'GoLand',
  rider: 'Rider',
  rustrover: 'RustRover',
  fork: 'Fork',
  sourcetree: 'Sourcetree',
  github: 'GitHub Desktop',
  tower: 'Tower',
  gitkraken: 'GitKraken',
  smartgit: 'SmartGit',
  sublimemerge: 'Sublime Merge',
}

const ZH_NAMES: Record<string, string> = {
  ...EN_NAMES,
  explorer: '文件资源管理器',
  finder: '访达',
  filemanager: '文件管理器',
  windowsterminal: '终端',
  terminal: '终端',
  gnometerminal: 'GNOME 终端',
  github: 'GitHub Desktop',
}

export const OPEN_IN_APP_COPY: Localized<OpenInAppCopy> = {
  en: {
    openIn: (name) => `Open in ${name}`,
    choose: 'Choose an application to open this project in',
    copyPath: 'Copy path',
    copied: 'Path copied',
    copyFailed: 'The path could not be copied.',
    launchFailed: 'The application could not be opened.',
    names: EN_NAMES,
  },
  zh: {
    openIn: (name) => `在 ${name} 中打开`,
    choose: '选择打开本项目的应用',
    copyPath: '复制路径',
    copied: '已复制路径',
    copyFailed: '无法复制这个路径。',
    launchFailed: '无法打开这个应用。',
    names: ZH_NAMES,
  },
}
