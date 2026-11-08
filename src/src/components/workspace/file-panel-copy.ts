import type { Localized } from '@/lib/i18n'

/** The file panel's wording: the tree, its search, and the preview's own states. */
export interface FilePanelCopy {
  /** The tab, the panel's accessible name, and the tree. */
  title: string
  treeLabel: string
  searchPlaceholder: string
  searchLabel: string
  clearSearch: string
  refreshing: string
  resizeTree: string
  reveal: string
  revealFailed: string
  /** The row menu. */
  addToConversation: string
  addToConversationDirectory: string
  addToConversationTooLarge: (name: string) => string
  addToConversationFailed: string
  copyPath: string
  copyPathFailed: string
  /** Empty and failed states. */
  noWorkspace: string
  noWorkspaceHint: string
  loading: string
  searching: string
  readFailed: string
  emptyWorkspace: string
  searchEmpty: string
  searchFailed: string
  searchTruncated: string
  retry: string
  /** The preview. */
  previewEmpty: string
  previewEmptyHint: string
  directoryFailed: string
  fileFailed: string
  /** A path that is a folder rather than a file: what it is, and where it can be opened. */
  folder: string
  folderHint: string
  folderLabel: string
  openFolder: string
  openFolderFailed: string
  binary: string
  tooLarge: string
  emptyFile: string
  copy: string
  copied: string
  /** The editor: its mode toggle, the save action and what the header says about the file. */
  edit: string
  preview: string
  save: string
  saveHint: string
  saving: string
  saved: string
  unsaved: string
  saveFailed: string
  imageAlt: (name: string) => string
  /** The find bar over the file's text. */
  findLabel: string
  findPlaceholder: string
  findNone: string
  findNext: string
  findPrev: string
  findClose: string
  /** The picture lightbox. */
  zoomImage: string
  zoomIn: string
  zoomOut: string
  zoomReset: string
  zoomClose: string
  zoomHint: string
  /** The root row's name in search results. */
  root: string
}

export const FILE_PANEL_COPY: Localized<FilePanelCopy> = {
  en: {
    title: 'Files',
    treeLabel: 'Workspace files',
    searchPlaceholder: 'Search files',
    searchLabel: 'Search workspace files',
    clearSearch: 'Clear search',
    refreshing: 'Refreshing',
    resizeTree: 'Resize the file tree',
    reveal: 'Show in folder',
    revealFailed: 'The file manager could not show this file.',
    addToConversation: 'Add to conversation',
    addToConversationDirectory: 'Only files can be added to a conversation.',
    addToConversationTooLarge: (name) => `${name} is too large to attach.`,
    addToConversationFailed: 'The file could not be added to the conversation.',
    copyPath: 'Copy path',
    copyPathFailed: 'The path could not be copied.',
    noWorkspace: 'No workspace',
    noWorkspaceHint: 'Open a folder to browse its files here.',
    loading: 'Reading files',
    searching: 'Searching files',
    readFailed: 'Could not read the file tree.',
    emptyWorkspace: 'This workspace has no files.',
    searchEmpty: 'No matching files.',
    searchFailed: 'The file search failed.',
    searchTruncated: 'More files matched than fit on one page.',
    retry: 'Retry',
    previewEmpty: 'Select a file',
    previewEmptyHint: 'Choose a file on the left to read it here.',
    directoryFailed: 'Could not read this folder.',
    fileFailed: 'Could not read this file.',
    folder: 'This is a folder',
    folderHint: 'Its contents are not previewed here.',
    folderLabel: 'Folder',
    openFolder: 'Open in the file manager',
    openFolderFailed: 'The file manager could not open this folder.',
    binary: 'Binary file — nothing to show as text.',
    tooLarge: 'This file is too large to preview.',
    emptyFile: 'Empty file',
    copy: 'Copy contents',
    copied: 'Copied',
    edit: 'Edit',
    preview: 'Preview',
    save: 'Save',
    saveHint: 'Save · Ctrl+S',
    saving: 'Saving',
    saved: 'Saved',
    unsaved: 'Unsaved changes',
    saveFailed: 'Could not save this file.',
    imageAlt: (name) => `Preview of ${name}`,
    findLabel: 'Find in file',
    findPlaceholder: 'Find in file',
    findNone: 'No matches',
    findNext: 'Next match · Enter',
    findPrev: 'Previous match · Shift+Enter',
    findClose: 'Close find · Esc',
    zoomImage: 'Open the picture at full size',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    zoomReset: 'Reset zoom',
    zoomClose: 'Close the picture',
    zoomHint: 'Scroll to zoom · drag to pan · double-click to switch',
    root: 'Workspace',
  },
  zh: {
    title: '文件',
    treeLabel: '工作区文件',
    searchPlaceholder: '搜索文件',
    searchLabel: '搜索工作区文件',
    clearSearch: '清除搜索',
    refreshing: '正在刷新',
    resizeTree: '调整文件树宽度',
    reveal: '在文件夹中显示',
    revealFailed: '无法在资源管理器中显示这个文件。',
    addToConversation: '添加到对话',
    addToConversationDirectory: '只能把文件添加到对话。',
    addToConversationTooLarge: (name) => `${name} 过大，无法添加为附件。`,
    addToConversationFailed: '无法把这个文件添加到对话。',
    copyPath: '复制路径',
    copyPathFailed: '无法复制这个路径。',
    noWorkspace: '没有工作区',
    noWorkspaceHint: '打开一个文件夹后，这里会显示它的文件。',
    loading: '正在读取文件',
    searching: '正在搜索文件',
    readFailed: '无法读取文件树。',
    emptyWorkspace: '这个工作区没有文件。',
    searchEmpty: '没有匹配的文件。',
    searchFailed: '文件搜索失败。',
    searchTruncated: '匹配的文件较多，只显示第一页。',
    retry: '重试',
    previewEmpty: '选择一个文件',
    previewEmptyHint: '从左侧文件树中选择一个文件，内容会显示在这里。',
    directoryFailed: '无法读取这个文件夹。',
    fileFailed: '无法读取这个文件。',
    folder: '这是一个文件夹',
    folderHint: '里面有什么不在这里预览。',
    folderLabel: '文件夹',
    openFolder: '在资源管理器中打开',
    openFolderFailed: '无法在资源管理器中打开这个文件夹。',
    binary: '二进制文件，无法以文本显示。',
    tooLarge: '文件过大，无法预览。',
    emptyFile: '空文件',
    copy: '复制内容',
    copied: '已复制',
    edit: '编辑',
    preview: '预览',
    save: '保存',
    saveHint: '保存 · Ctrl+S',
    saving: '正在保存',
    saved: '已保存',
    unsaved: '有未保存的更改',
    saveFailed: '无法保存这个文件。',
    imageAlt: (name) => `${name} 的预览`,
    findLabel: '在文件中查找',
    findPlaceholder: '在文件中查找',
    findNone: '没有匹配',
    findNext: '下一个匹配 · Enter',
    findPrev: '上一个匹配 · Shift+Enter',
    findClose: '关闭查找 · Esc',
    zoomImage: '放大查看图片',
    zoomIn: '放大',
    zoomOut: '缩小',
    zoomReset: '重置缩放',
    zoomClose: '关闭图片',
    zoomHint: '滚轮缩放 · 拖动平移 · 双击切换',
    root: '工作区',
  },
}
