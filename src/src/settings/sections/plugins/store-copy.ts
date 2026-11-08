import type { Localized } from '@/lib/i18n'

/**
 * The plugin store's wording, in both languages.
 *
 * It is a file of its own because the page's table is already long, and because these keys are one
 * subject: everything the store and its two source forms need, and nothing the installed list draws.
 * `PluginsCopy` extends this interface, so a component still reads one `copy` object — the page's —
 * and the two tables cannot drift apart without failing to compile.
 *
 * The Chinese is the desktop app's own (`src/components/settings/pluginStoreCopy.ts`), verbatim.
 */
export interface PluginStoreCopy {
  storeTitle: string
  storeSubtitle: string
  storeSearchLabel: string
  storeSearchPlaceholder: string
  storeSearchEmpty: string
  storeRefreshAction: string
  storeRefreshing: string
  /** Said quietly when the backend's throttle skipped the refresh the store asked for. */
  storeThrottledNote: string
  /** The store's own refusal, when the un-throttled refresh was refused. */
  storeRefreshFailed: string
  /** One catalogue read that was refused; the sources' own names are drawn above it. */
  storeLoadFailed: string
  /** The catalogue's own empty state: no registered marketplace publishes an entry. */
  storeEmpty: string
  storeInstallAction: string
  storeInstalling: string
  storeInstalledBadge: string

  /** The toolbar's two source controls: the registry, and the add form. */
  storeSourcesAction: string
  storeAddSourceAction: string
  storeSourcesTitle: string
  storeSourcesEmpty: string
  storeSourcesRefresh: string
  storeSourcesRemove: string
  storeAddSourceLabel: string
  storeAddSourcePlaceholder: string
  storeAddSourceHint: string
  storeAddSourceSubmit: string
  /** The heading a refused add is shown under; the host's own sentence is drawn under it. */
  storeAddSourceFailed: string
}

export const STORE_COPY: Localized<PluginStoreCopy> = {
  en: {
    storeTitle: 'Plugin store',
    storeSubtitle:
      'Everything the registered marketplaces publish — install an entry, or manage the sources it comes from.',
    storeSearchLabel: 'Search the store',
    storeSearchPlaceholder: 'Search by name, description, category or tag…',
    storeSearchEmpty: 'No store entry matches your search',
    storeRefreshAction: 'Refresh catalogues',
    storeRefreshing: 'Refreshing…',
    storeThrottledNote:
      'The catalogues were refreshed less than ten minutes ago, so this visit reused them.',
    storeRefreshFailed: 'The catalogues could not be refreshed',
    storeLoadFailed: 'This marketplace’s catalogue could not be read',
    storeEmpty: 'No marketplace publishes an entry yet.',
    storeInstallAction: 'Install',
    storeInstalling: 'Installing…',
    storeInstalledBadge: 'Installed',

    storeSourcesAction: 'Marketplace sources',
    storeAddSourceAction: 'Add marketplace',
    storeSourcesTitle: 'Marketplace sources',
    storeSourcesEmpty: 'No marketplace is registered yet.',
    storeSourcesRefresh: 'Refresh this marketplace',
    storeSourcesRemove: 'Remove this marketplace',
    storeAddSourceLabel: 'Marketplace source',
    storeAddSourcePlaceholder: 'A directory, an npm package, a git URL, or name@marketplace',
    storeAddSourceHint:
      'The engine classifies what you enter: a local directory, an npm package, a git URL, or an entry of a marketplace you already added.',
    storeAddSourceSubmit: 'Add marketplace',
    storeAddSourceFailed: 'The marketplace could not be added',
  },
  zh: {
    storeTitle: '插件商店',
    storeSubtitle: '已登记市场发布的一切 —— 安装其中一个条目，或管理它们的来源。',
    storeSearchLabel: '搜索商店',
    storeSearchPlaceholder: '按名称、描述、分类或标签搜索…',
    storeSearchEmpty: '商店里没有匹配的条目',
    storeRefreshAction: '刷新目录',
    storeRefreshing: '刷新中…',
    storeThrottledNote: '目录在十分钟内刚刷新过，这次直接沿用了已有结果。',
    storeRefreshFailed: '目录刷新失败',
    storeLoadFailed: '无法读取该市场的目录',
    storeEmpty: '还没有任何市场发布条目。',
    storeInstallAction: '安装',
    storeInstalling: '安装中…',
    storeInstalledBadge: '已安装',

    storeSourcesAction: '市场来源',
    storeAddSourceAction: '添加市场',
    storeSourcesTitle: '市场来源',
    storeSourcesEmpty: '还没有登记任何市场。',
    storeSourcesRefresh: '刷新这个市场',
    storeSourcesRemove: '移除这个市场',
    storeAddSourceLabel: '市场来源',
    storeAddSourcePlaceholder: '目录、npm 包、git 地址，或 name@marketplace',
    storeAddSourceHint: '引擎会自行判断你填的内容：本地目录、npm 包、git 地址，或已添加市场的条目。',
    storeAddSourceSubmit: '添加市场',
    storeAddSourceFailed: '无法添加该市场',
  },
}
