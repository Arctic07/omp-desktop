import type { Localized } from '@/lib/i18n'

/**
 * The plugin market page's wording.
 *
 * One table for the whole page: the header's own actions, the marketplace selector, the entry cards
 * and the source forms. The Chinese is the desktop app's wording, and every string a card or a notice
 * can draw is here rather than at a call site.
 */
export interface MarketCopy {
  title: string
  subtitle: string
  back: string
  manage: string
  refresh: string
  refreshFailed: string
  /** One catalogue read that was refused. */
  loadFailed: string
  loading: string

  sourcesAction: string
  sourcesTitle: string
  sourcesSubtitle: string
  sourcesEmpty: string
  sourcesSearchLabel: string
  sourcesSearchPlaceholder: string
  sourcesSearchEmpty: string
  sourceRemove: string
  /** The sources table's column headers. */
  sourceName: string
  sourceAddress: string
  sourceStatus: string
  sourceAction: string
  /** The switch's accessible name: on/off for one marketplace. */
  sourceToggle: (name: string, enabled: boolean) => string
  /** The marketplace selector's empty value. */
  selectPlaceholder: string
  /** The sources dialog's own close control. */
  close: string
  removeConfirmTitle: string
  removeBubbleBody: string
  removeConfirmAction: string
  /** Why the built-in source's delete button is disabled. */
  builtinDeleteHint: string
  removeFailed: string
  pagination: string
  previousPage: string
  nextPage: string
  pageOf: (page: number) => string
  backPages: (pages: number) => string
  forwardPages: (pages: number) => string

  addAction: string
  addCreate: string
  addMarket: string
  addSourceLabel: string
  addSourcePlaceholder: string
  addSourceHint: string
  addSourceSubmit: string
  addSourceSubmitting: string
  addSourceRequired: string
  addSourceFailed: string
  cancel: string
  /** The composer hand-off that starts the guided plugin-authoring skill. */
  createPrompt: string

  searchLabel: string
  searchPlaceholder: string
  searchEmpty: string
  empty: string
  /** The catalogue's default empty state, before any plugin can be listed. */
  emptyBrowseTitle: string
  emptyBrowseBody: string
  emptyNoSourcesBody: string
  emptyMarketBody: string
  emptySearchBody: string
  emptyOpenSources: string
  emptyAddMarket: string
  clearSearch: string
  entryCount: (count: number) => string

  install: string
  installing: string
  installed: string
  /** The scope one card would write, said on the button that writes it. */
  installToUser: string
  installToProject: (workspace: string) => string
  consentRequiredAction: string
  consentFailed: string
  builtin: string
  builtinHint: string
  installFailed: string
  installedNotice: (name: string) => string

  preparingBuiltin: string
  builtinFailed: string
  retry: string
}

export const MARKET_COPY: Localized<MarketCopy> = {
  en: {
    title: 'Plugin marketplace',
    subtitle:
      'Browse what the registered marketplaces publish. Installing happens here; plugins already installed are managed in Settings.',
    back: 'Back to the conversation',
    manage: 'Plugin management',
    refresh: 'Refresh marketplaces',
    refreshFailed: 'The marketplaces could not be refreshed',
    loadFailed: 'The catalogue could not be read',
    loading: 'Reading…',

    sourcesAction: 'Marketplace sources',
    sourcesTitle: 'Marketplace sources',
    sourcesSubtitle:
      'Switch a source off to hide it from browsing. Removing a source deletes only the catalogue and its cached files; plugins already installed stay installed.',
    sourcesEmpty: 'No marketplace is registered yet.',
    sourcesSearchLabel: 'Search marketplace sources',
    sourcesSearchPlaceholder: 'Search by name or source…',
    sourcesSearchEmpty: 'No source matches your search',
    sourceRemove: 'Remove this marketplace',
    sourceName: 'Marketplace',
    sourceAddress: 'Source',
    sourceStatus: 'Status',
    sourceAction: 'Actions',
    sourceToggle: (name, enabled) => `${enabled ? 'Disable' : 'Enable'} ${name}`,
    selectPlaceholder: 'Choose a marketplace',
    close: 'Close',
    removeConfirmTitle: 'Remove this marketplace?',
    removeBubbleBody: 'The source and its cached catalogue are deleted; installed plugins stay.',
    removeConfirmAction: 'Remove',
    builtinDeleteHint: 'The built-in marketplace cannot be removed.',
    removeFailed: 'The marketplace could not be removed',
    pagination: 'Marketplace sources',
    previousPage: 'Previous page',
    nextPage: 'Next page',
    pageOf: (page) => `Page ${page}`,
    backPages: (pages) => `Back ${pages} pages`,
    forwardPages: (pages) => `Forward ${pages} pages`,

    addAction: 'Add',
    addCreate: 'Create a plugin',
    addMarket: 'Add marketplace',
    addSourceLabel: 'Marketplace source',
    addSourcePlaceholder: 'A directory, a git URL, or owner/repo',
    addSourceHint:
      'The engine classifies what you enter: a local directory, a git URL, or a repository it adds as a catalogue.',
    addSourceSubmit: 'Add marketplace',
    addSourceSubmitting: 'Adding marketplace…',
    addSourceRequired: 'Enter a marketplace source.',
    addSourceFailed: 'The marketplace could not be added',
    cancel: 'Cancel',
    createPrompt: '/skill:plugin-creator I want to build a plugin: ',

    searchLabel: 'Search the marketplace',
    searchPlaceholder: 'Search by name, description, category or tag…',
    searchEmpty: 'No entry matches your search',
    empty: 'This marketplace publishes no entry yet.',
    emptyBrowseTitle: 'Choose a marketplace',
    emptyBrowseBody: 'Pick a marketplace above; the plugins it publishes will appear here.',
    emptyNoSourcesBody: 'Add a marketplace source; the plugins it publishes will appear here.',
    emptyMarketBody: 'Nothing has been published here yet.',
    emptySearchBody: 'Try another term, or clear the search to see every plugin.',
    emptyOpenSources: 'Open marketplace sources',
    emptyAddMarket: 'Add marketplace',
    clearSearch: 'Clear search',
    entryCount: (count) => `${count} ${count === 1 ? 'entry' : 'entries'}`,

    install: 'Install',
    installing: 'Installing…',
    installed: 'Installed',
    installToUser: 'Install for the user',
    installToProject: (workspace) => `Install in ${workspace}`,
    consentRequiredAction: 'Confirm',
    consentFailed: 'The confirmation could not be recorded',
    builtin: 'Built in',
    builtinHint: 'This application ships this plugin; it cannot be removed here.',
    installFailed: 'The plugin could not be installed',
    installedNotice: (name) => `${name} is installed.`,

    preparingBuiltin: 'Preparing the built-in marketplace…',
    builtinFailed: 'The built-in marketplace could not be prepared',
    retry: 'Retry',
  },
  zh: {
    title: '插件市场',
    subtitle: '浏览已登记市场发布的插件。安装在这里完成；已安装的插件仍在设置的插件管理里调整。',
    back: '返回对话',
    manage: '插件管理',
    refresh: '刷新市场',
    refreshFailed: '市场刷新失败',
    loadFailed: '无法读取目录',
    loading: '正在读取…',

    sourcesAction: '市场来源',
    sourcesTitle: '市场来源',
    sourcesSubtitle:
      '关闭开关只会让这个来源不参与市场浏览；移除来源只删除市场登记与缓存，已经安装好的插件保持不变。',
    sourcesEmpty: '还没有登记任何市场。',
    sourcesSearchLabel: '搜索市场来源',
    sourcesSearchPlaceholder: '按名称或来源搜索…',
    sourcesSearchEmpty: '没有匹配的市场来源',
    sourceRemove: '移除这个市场',
    sourceName: '市场',
    sourceAddress: '来源',
    sourceStatus: '状态',
    sourceAction: '操作',
    sourceToggle: (name, enabled) => `${enabled ? '停用' : '启用'} ${name}`,
    selectPlaceholder: '选择市场来源',
    close: '关闭',
    removeConfirmTitle: '移除这个市场？',
    removeBubbleBody: '只删除来源与缓存，已安装的插件保留。',
    removeConfirmAction: '删除',
    builtinDeleteHint: '内置市场不能删除。',
    removeFailed: '无法移除该市场',
    pagination: '市场来源',
    previousPage: '上一页',
    nextPage: '下一页',
    pageOf: (page) => `第 ${page} 页`,
    backPages: (pages) => `后退 ${pages} 页`,
    forwardPages: (pages) => `前进 ${pages} 页`,

    addAction: '添加',
    addCreate: '创建插件',
    addMarket: '添加插件市场',
    addSourceLabel: '市场来源',
    addSourcePlaceholder: '目录、git 地址，或 owner/repo',
    addSourceHint: '引擎会自行判断你填的内容：本地目录、git 地址，或作为目录添加的仓库。',
    addSourceSubmit: '添加市场',
    addSourceSubmitting: '正在添加市场…',
    addSourceRequired: '请填写市场来源。',
    addSourceFailed: '无法添加该市场',
    cancel: '取消',
    createPrompt: '/skill:plugin-creator 我想做一个插件：',

    searchLabel: '搜索插件市场',
    searchPlaceholder: '按名称、描述、分类或标签搜索…',
    searchEmpty: '没有匹配的条目',
    empty: '这个市场还没有发布任何条目。',
    emptyBrowseTitle: '选择一个市场来源',
    emptyBrowseBody: '在上方选择一个市场来源后，这里会显示它发布的可安装插件。',
    emptyNoSourcesBody: '添加一个市场来源后，这里会显示它发布的可安装插件。',
    emptyMarketBody: '这个市场还没有发布任何插件。',
    emptySearchBody: '换个关键词，或清除搜索查看全部插件。',
    emptyOpenSources: '打开市场来源',
    emptyAddMarket: '添加市场',
    clearSearch: '清除搜索',
    entryCount: (count) => `${count} 个条目`,

    install: '安装',
    installing: '安装中…',
    installed: '已安装',
    installToUser: '安装到用户',
    installToProject: (workspace) => `安装到 ${workspace}`,
    consentRequiredAction: '点击确认',
    consentFailed: '确认未能记录',
    builtin: '内置',
    builtinHint: '这个插件随应用一起提供，不能在这里移除。',
    installFailed: '插件安装失败',
    installedNotice: (name) => `${name} 已安装。`,

    preparingBuiltin: '正在准备内置插件市场…',
    builtinFailed: '内置插件市场准备失败',
    retry: '重试',
  },
}
