import type { Localized } from '@/lib/i18n'

/**
 * Wording of the MCP settings page and its editor, both languages.
 *
 * The page is the reference's (`src/components/settings/mcpCopy.ts` and the section that reads it):
 * the same scope picker, count and search, the same installed group with its actions, the same
 * status names with the engine's own reason as the badge's title, the same two editor modes. The
 * Chinese below is that file verbatim, so the two frontends read the same; the English is that file's
 * own English, which is the register this app writes in.
 *
 * Three families of string are this page's own and are worded for what the controls really do:
 *
 * - `missingName` / `missingCommand` / `missingUrl` / `badTimeout` — what the editor refuses with.
 *   The Vue editor answers a missing field with the field's own label ("命令"); a refusal reads
 *   better as the sentence that says what is wrong.
 * - `sourceImport*` — the import dialog, which reads the other agents on this machine and copies
 *   the servers this application does not have. Its own states are words, not marks: which agents
 *   were found, how many servers each holds, and why there is nothing to copy.
 */

/** The engine's own transport vocabulary (`EngineMcpServerRow.transport`). */
export type McpTransport = 'stdio' | 'http' | 'sse'

/** The engine's own connection vocabulary (`EngineMcpServerRow.status`). */
export type McpStatus = 'connected' | 'connecting' | 'disconnected' | 'unknown'

/** A row's transport token, folded to the three names this page knows. */
export function transportOf(value: string): McpTransport {
  return value === 'http' || value === 'sse' ? value : 'stdio'
}

/** A row's status token, folded to the four names this page knows. */
export function statusOf(value: string): McpStatus {
  return value === 'connected' || value === 'connecting' || value === 'disconnected'
    ? value
    : 'unknown'
}

export interface McpCopy {
  retry: string
  close: string
  loading: string
  loadFailed: string
  /** A switch write the host refused; the row repeats this sentence beside the engine's code. */
  writeFailed: string

  /** The toolbar: the scope label the editor and list share. */
  scopeLabel: string
  scopeUser: string
  scopeProject: string
  mcpCount: (count: number) => string
  /** The list's pager: the servers are paged the way the provider list is. */
  pagerLabel: string
  pagerPrevious: string
  pagerNext: string
  pagerStatus: (page: number, pageCount: number) => string
  pagerTotal: (count: number) => string
  searchLabel: string
  searchPlaceholder: string
  searchEmpty: string

  /** The installed group's header and its actions. */
  installedTitle: string
  newServer: string
  refresh: string
  importAction: string
  /** The import dialog: the agents on this machine, and what each of them defines. */
  sourceImportTitle: string
  sourceImportLead: string
  sourceImportLoading: string
  sourceImportFailed: string
  sourceImportRescan: string
  /** Not one of the four agents has a configuration on this machine. */
  sourceImportNoneFound: string
  sourceImportNoneFoundHint: string
  /** Agents were found, and this application already defines every server they hold. */
  sourceImportAllHere: string
  /** The line naming the agents this machine has no MCP configuration for. */
  sourceImportAbsent: (names: readonly string[]) => string
  sourceImportApply: (count: number) => string
  sourceImportApplying: string
  sourceImportDone: (imported: number, skipped: number) => string
  /** The agents' names, in the dialog's order. */
  sourceNames: Readonly<Record<'claude' | 'codex' | 'omp' | 'pi', string>>
  /** A found agent's state, as the chip at the end of its row. */
  sourceBadgeImportable: (count: number) => string
  sourceBadgeConfigured: string
  sourceBadgeEmpty: string
  sourceServerConfigured: string
  sourceServerImportable: string
  /** A credential the source resolves through its own environment, which this app cannot carry. */
  sourceNoteReference: string
  sourceNoteForwarded: string

  /** Nothing installed yet: the block that offers the two ways in. */
  emptyTitle: string
  empty: string
  emptyNewServer: string

  transportLabels: Readonly<Record<McpTransport, string>>
  statusLabels: Readonly<Record<McpStatus, string>>
  /** The status badge's title: why the row reads the status it does. */
  statusReasons: Readonly<Record<McpStatus, string>>
  /** An MCP switched off by the definition or the user; it has no connection attempt to report. */
  disabledBadge: string
  disabledReason: string
  toolCount: (count: number) => string
  /** Joins the two halves of a row's definition line, with this language's punctuation. */
  countSeparator: string
  /** A definition its own file switches off, which no user-level list explains. */
  definitionDisabled: string
  /** A definition another tool's file holds: listed, not rewritten here. */
  foreignHint: (provider: string) => string

  /** The engine's own report, which reaches the screen as it arrived. */
  problemsTitle: string
  problemsDescription: string

  toggleOn: (name: string) => string
  toggleOff: (name: string) => string

  /** The editor: its own header, its two modes, and the fields of a definition. */
  formBack: string
  formCreateTitle: string
  formEditTitle: string
  formCreateDescription: string
  formEditDescription: string
  modeForm: string
  modeJson: string
  fullConfig: string
  pasteHintPrefix: string
  pasteHintMiddle: string
  pasteHintSuffix: string
  jsonParseError: string
  /** The draft carries keys this application's writer does not own, so they would be dropped. */
  jsonUnknownKeys: (keys: string) => string
  nameLabel: string
  namePlaceholder: string
  nameLocked: string
  typeLabel: string
  typeOptions: Readonly<Record<McpTransport, string>>
  commandLabel: string
  commandPlaceholder: string
  argsLabel: string
  argsPlaceholder: string
  urlLabel: string
  urlPlaceholder: string
  timeoutLabel: string
  timeoutPlaceholder: string
  envOptional: string
  headersOptional: string
  envPlaceholder: string
  headersPlaceholder: string
  jsonPlaceholder: string
  missingName: string
  missingCommand: string
  missingUrl: string
  badTimeout: string
  save: string
  saving: string
  cancel: string
  /** The host refused the definition; the editor stays open and this line says why. */
  saveFailed: string
  deleteServer: string
  deleteConfirmTitle: (name: string) => string
  deleteConfirmDescription: string
  deleteConfirmAction: string
  deleting: string
  /** The editor was filled in from a definition another tool owns, so it says what it filled in. */
  importNote: string
}

const en: McpCopy = {
  retry: 'Retry',
  close: 'Close',
  loading: 'Reading…',
  loadFailed: 'Could not read the MCP servers the engine found.',
  writeFailed: 'The host refused this change.',

  scopeLabel: 'Scope',
  scopeUser: 'User',
  scopeProject: 'Workspace',
  mcpCount: (count) => `MCP ${count}`,
  pagerLabel: 'MCP server paging',
  pagerPrevious: 'Previous page',
  pagerNext: 'Next page',
  pagerStatus: (page, pageCount) => `Page ${page} / ${pageCount}`,
  pagerTotal: (count) => `${count} servers`,
  searchLabel: 'Search MCP servers',
  searchPlaceholder: 'Search MCP servers…',
  searchEmpty: 'No MCP server matches',

  installedTitle: 'Installed',
  newServer: 'New',
  refresh: 'Refresh',
  importAction: 'Import',
  sourceImportTitle: 'Import MCP servers from another agent',
  sourceImportLead:
    'Servers the agents on this machine already define are copied in; a name this application already has is skipped, and imported servers connect right away.',
  sourceImportLoading: 'Reading the other agents’ configuration…',
  sourceImportFailed: 'The configuration could not be read.',
  sourceImportRescan: 'Scan again',
  sourceImportNoneFound: 'No MCP configuration from these agents was found',
  sourceImportNoneFoundHint:
    'Claude Code, Codex, omp and pi hold no server on this machine. Add one in any of them, then scan again.',
  sourceImportAllHere: 'Every server these agents define is already here.',
  sourceImportAbsent: (names) => `No configuration found: ${names.join(', ')}`,
  sourceImportApply: (count) => (count === 0 ? 'Import' : `Import ${count}`),
  sourceImportApplying: 'Importing…',
  sourceImportDone: (imported, skipped) => `Imported ${imported} server(s); skipped ${skipped} already present.`,
  sourceNames: { claude: 'Claude Code', codex: 'Codex', omp: 'omp', pi: 'pi (legacy layout)' },
  sourceBadgeImportable: (count) => (count === 1 ? '1 to import' : `${count} to import`),
  sourceBadgeConfigured: 'All here',
  sourceBadgeEmpty: 'No servers',
  sourceServerConfigured: 'already here',
  sourceServerImportable: 'will be copied',
  sourceNoteReference:
    'Its environment references a variable; the engine expands `${VAR}` from its own environment, so check the value after importing.',
  sourceNoteForwarded:
    'Its credentials are forwarded from the agent’s own environment, which this application does not inherit: add the key after importing.',

  emptyTitle: 'No MCP server yet',
  empty: 'Add an MCP server so the agent gains extra capabilities.',
  emptyNewServer: 'New MCP server',

  transportLabels: {
    stdio: 'stdio',
    http: 'http',
    sse: 'sse',
  },
  statusLabels: {
    connected: 'Connected',
    connecting: 'Connecting',
    disconnected: 'Not connected',
    unknown: 'Unknown',
  },
  statusReasons: {
    connected: 'Connected and available.',
    connecting: 'Connecting to the MCP runtime.',
    disconnected: 'The MCP server is not connected right now.',
    unknown: 'The MCP server status is not available yet.',
  },
  disabledBadge: 'Switched off',
  disabledReason: 'This MCP server is switched off; turn it on to start a connection.',
  toolCount: (count) => `${count} tools`,
  countSeparator: ' · ',
  definitionDisabled: 'Off in its definition file',
  foreignHint: (provider) => `Defined by ${provider}; click to copy it into your own configuration and edit it`,

  problemsTitle: 'Configuration problems',
  problemsDescription:
    'What the engine reported while loading definitions, in its own words. The file it names is part of the message.',

  toggleOn: (name) => `${name}: turn on`,
  toggleOff: (name) => `${name}: turn off`,

  formBack: 'Back',
  formCreateTitle: 'New MCP server',
  formEditTitle: 'Edit MCP server',
  formCreateDescription: 'Fill in the new MCP configuration; saving returns to the list.',
  formEditDescription: 'Change this MCP configuration; saving returns to the list.',
  modeForm: 'Form',
  modeJson: 'JSON',
  fullConfig: 'Full configuration',
  pasteHintPrefix: 'You can paste',
  pasteHintMiddle: 'or',
  pasteHintSuffix: '.',
  jsonParseError: 'JSON parsing failed',
  jsonUnknownKeys: (keys) => `These fields are not part of a definition here and will be ignored: ${keys}.`,
  nameLabel: 'Name',
  namePlaceholder: 'my-mcp-server',
  nameLocked: 'A definition is addressed by its name, so an edit keeps it.',
  typeLabel: 'Type',
  typeOptions: {
    stdio: 'stdio (local command)',
    http: 'HTTP',
    sse: 'SSE (Server-Sent Events)',
  },
  commandLabel: 'Command',
  commandPlaceholder: 'npx',
  argsLabel: 'Arguments (space separated)',
  argsPlaceholder: '-y @modelcontextprotocol/server-memory',
  urlLabel: 'URL',
  urlPlaceholder: 'https://mcp.example.com/mcp',
  timeoutLabel: 'Timeout MS',
  timeoutPlaceholder: '30000',
  envOptional: 'Environment variables (optional)',
  headersOptional: 'Headers (optional)',
  envPlaceholder: '{\n  "MY_API_KEY": "your-key"\n}',
  headersPlaceholder: '{\n  "Authorization": "Bearer your-token"\n}',
  jsonPlaceholder:
    '{\n  "my-mcp-server": {\n    "type": "http",\n    "url": "https://example.com/mcp"\n  }\n}',
  missingName: 'A definition needs a name.',
  missingCommand: 'A stdio server needs a command.',
  missingUrl: 'An http or sse server needs a URL.',
  badTimeout: 'The timeout must be a whole number of milliseconds, 0 or more.',
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  saveFailed: 'The engine refused this definition:',
  deleteServer: 'Delete',
  deleteConfirmTitle: (name) => `Delete the MCP server "${name}"?`,
  deleteConfirmDescription: 'This cannot be undone; the server is removed from the configuration file.',
  deleteConfirmAction: 'Delete',
  deleting: 'Deleting…',
  importNote:
    'Filled in from the definition the engine read. Saving creates your own definition under the new name at the scope this editor shows, and leaves the original untouched. Environment and headers are left empty on purpose: the engine expands `${VAR}` references while reading, so copying them would write resolved values - tokens included - as plain text. Fill in what this server needs.',
}

const zh: McpCopy = {
  retry: '重试',
  close: '关闭',
  loading: '正在读取…',
  loadFailed: '无法读取引擎发现的 MCP 服务器。',
  writeFailed: '宿主拒绝了这次改动。',

  scopeLabel: '作用域',
  scopeUser: '用户',
  scopeProject: '工作区',
  mcpCount: (count) => `MCP ${count}`,
  pagerLabel: 'MCP 服务器分页',
  pagerPrevious: '上一页',
  pagerNext: '下一页',
  pagerStatus: (page, pageCount) => `第 ${page} / ${pageCount} 页`,
  pagerTotal: (count) => `共 ${count} 个服务器`,
  searchLabel: '搜索 MCP 服务器',
  searchPlaceholder: '搜索 MCP 服务器…',
  searchEmpty: '没有匹配的 MCP 服务器',

  installedTitle: '已安装',
  newServer: '新建',
  refresh: '刷新',
  importAction: '导入',
  sourceImportTitle: '从其他 Agent 导入 MCP',
  sourceImportLead:
    '先读本机的 Claude Code、Codex、omp 和 pi，再把这台机器上已有的服务器复制过来。已有同名服务器会跳过，导入后立即连接。',
  sourceImportLoading: '正在检查本机配置…',
  sourceImportFailed: '读取配置失败。',
  sourceImportRescan: '重新扫描',
  sourceImportNoneFound: '本机没有找到这几个 Agent 的 MCP 配置',
  sourceImportNoneFoundHint:
    'Claude Code、Codex、omp、pi 在这台机器上都没有定义服务器。在其中一个里添加后重新扫描。',
  sourceImportAllHere: '这几个 Agent 定义的服务器本机都已有。',
  sourceImportAbsent: (names) => `未找到配置：${names.join('、')}`,
  sourceImportApply: (count) => (count === 0 ? '导入' : `导入 ${count} 个`),
  sourceImportApplying: '导入中…',
  sourceImportDone: (imported, skipped) => `已导入 ${imported} 个服务器，跳过 ${skipped} 个（本机已有）。`,
  sourceNames: { claude: 'Claude Code', codex: 'Codex', omp: 'omp', pi: 'pi（旧版布局）' },
  sourceBadgeImportable: (count) => `可导入 ${count}`,
  sourceBadgeConfigured: '全部已有',
  sourceBadgeEmpty: '无服务器',
  sourceServerConfigured: '已有',
  sourceServerImportable: '将导入',
  sourceNoteReference: '它引用了环境变量：引擎会用自身环境展开 `${VAR}`，导入后请确认取值。',
  sourceNoteForwarded: '它的凭据来自该 Agent 自己的环境，本应用不会继承：导入后请补上密钥。',

  emptyTitle: '还没有 MCP 服务器',
  empty: '添加一个 MCP 服务器，让 Agent 获得额外能力。',
  emptyNewServer: '新建 MCP 服务器',

  transportLabels: {
    stdio: 'stdio',
    http: 'http',
    sse: 'sse',
  },
  statusLabels: {
    connected: '已连接',
    connecting: '连接中',
    disconnected: '未连接',
    unknown: '未知',
  },
  statusReasons: {
    connected: '已连接并可用。',
    connecting: '正在连接 MCP runtime。',
    disconnected: 'MCP 服务器当前未连接。',
    unknown: '暂时无法获取 MCP 服务器状态。',
  },
  disabledBadge: '已停用',
  disabledReason: '这个 MCP 已关闭；开启后才会尝试连接。',
  toolCount: (count) => `${count} 个工具`,
  countSeparator: ' · ',
  definitionDisabled: '定义文件中已关闭',
  foreignHint: (provider) => `来自 ${provider}；点击复制到本应用配置后可修改`,

  problemsTitle: '配置问题',
  problemsDescription: '引擎在加载定义时报告的问题，原文照录——涉及的文件就在这句话里。',

  toggleOn: (name) => `${name}：开启`,
  toggleOff: (name) => `${name}：关闭`,

  formBack: '返回',
  formCreateTitle: '新建 MCP 服务器',
  formEditTitle: '编辑 MCP 服务器',
  formCreateDescription: '填写新的 MCP 配置，保存后返回列表。',
  formEditDescription: '修改当前 MCP 配置，保存后返回列表。',
  modeForm: '表单',
  modeJson: 'JSON',
  fullConfig: '完整配置',
  pasteHintPrefix: '支持直接粘贴',
  pasteHintMiddle: '或',
  pasteHintSuffix: '。',
  jsonParseError: 'JSON 解析失败',
  jsonUnknownKeys: (keys) => `以下字段不属于本应用的配置范围，会被忽略：${keys}。`,
  nameLabel: '名称',
  namePlaceholder: 'my-mcp-server',
  nameLocked: '定义以名称为寻址方式，因此编辑时不能改名。',
  typeLabel: '类型',
  typeOptions: {
    stdio: 'stdio（本地命令）',
    http: 'HTTP',
    sse: 'SSE（Server-Sent Events）',
  },
  commandLabel: '命令',
  commandPlaceholder: 'npx',
  argsLabel: '参数（空格分隔）',
  argsPlaceholder: '-y @modelcontextprotocol/server-memory',
  urlLabel: 'URL',
  urlPlaceholder: 'https://mcp.example.com/mcp',
  timeoutLabel: '超时时间 MS',
  timeoutPlaceholder: '30000',
  envOptional: '环境变量（可选）',
  headersOptional: '请求头（可选）',
  envPlaceholder: '{\n  "MY_API_KEY": "your-key"\n}',
  headersPlaceholder: '{\n  "Authorization": "Bearer your-token"\n}',
  jsonPlaceholder:
    '{\n  "my-mcp-server": {\n    "type": "http",\n    "url": "https://example.com/mcp"\n  }\n}',
  missingName: '名称不能为空。',
  missingCommand: 'stdio 服务器需要命令。',
  missingUrl: 'http 或 sse 服务器需要 URL。',
  badTimeout: '超时时间必须是不小于 0 的整数毫秒值。',
  save: '保存',
  saving: '保存中…',
  cancel: '取消',
  saveFailed: '引擎拒绝了这份定义：',
  deleteServer: '删除',
  deleteConfirmTitle: (name) => `删除 MCP 服务器“${name}”？`,
  deleteConfirmDescription: '删除后将无法恢复，该服务器配置将从文件中移除。',
  deleteConfirmAction: '确认删除',
  deleting: '正在删除…',
  importNote:
    '内容按引擎读到的定义预填。保存会在新名称下按当前编辑器的级别创建本应用的定义，原定义保持不变。环境变量与请求头刻意留空：引擎读取时会展开 `${VAR}`，照抄会把展开后的值（含令牌）以明文写进配置文件。请按这个服务器的需要填写。',
}

/** Resolve page and editor copy with `useCopy(MCP_COPY)`. */
export const MCP_COPY: Localized<McpCopy> = { en, zh }
