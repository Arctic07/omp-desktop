import type { Localized } from '@/lib/i18n'

/**
 * Wording of the local-configuration import.
 *
 * Two sentences carry the rule the feature exists to keep: the lead says the copy is additive, and
 * the skip count says how much of it this installation already had. A user reading "已导入 0 项" with
 * "跳过 12 项" learns the truth - nothing was missing - without a second question.
 *
 * Status words are the desktop's closed vocabulary (`host/src/omp-import.ts`), never the host's
 * prose: `configured` is "本机已有", `unresolved` names a model this catalogue cannot offer, and
 * `unsupported` marks a credential the keyring cannot hold (OAuth).
 */
export interface OmpImportCopy {
  title: string
  /** The source directory the read names, with the rule the import follows. */
  lead: (source: string) => string
  loading: string
  loadFailed: string
  retry: string
  notFound: (source: string) => string
  close: string

  /** The three categories, each with the number of items the source offers. */
  modelsCategory: string
  mcpCategory: string
  skillsCategory: string
  categoryCount: (count: number) => string
  /** The per-section counts inside 模型: roles, credentials, custom providers. */
  rolesCount: (count: number) => string
  credentialsCount: (count: number) => string
  providersCount: (count: number) => string

  /** A credential row's kind, in words: the host reports the engine's own token. */
  credentialApiKey: string
  credentialOauth: string
  /** The two tick marks: this machine already has the item, or it does not and will be copied. */
  statusConfigured: string
  statusMissing: string
  statusUnsupported: string
  statusUnresolved: string
  oauthNote: string
  /** A provider the source carries with an inline key. */
  inlineKeyNote: string

  nothingToImport: string
  apply: string
  applying: string
  nothingSelected: string
  /** What an apply did, by category. */
  doneSummary: (imported: number, skipped: number) => string
  doneFailed: string
  warningsTitle: string
}

export const OMP_IMPORT_COPY: Localized<OmpImportCopy> = {
  en: {
    title: 'Import the omp configuration on this machine',
    lead: (source) =>
      `Reads the model roles, provider keys, custom providers, MCP servers and skills of the terminal omp configured at ${source}. The copy is additive: anything this installation already has is skipped, never duplicated.`,
    loading: 'Reading the configuration…',
    loadFailed: 'The configuration could not be read.',
    retry: 'Try again',
    notFound: (source) => `There is no omp agent directory at ${source}.`,
    close: 'Close',

    modelsCategory: 'Models',
    mcpCategory: 'MCP servers',
    skillsCategory: 'Skills',
    categoryCount: (count) => `${count} found`,
    rolesCount: (count) => `${count} roles`,
    credentialsCount: (count) => `${count} provider keys`,
    providersCount: (count) => `${count} custom providers`,

    credentialApiKey: 'API key',
    credentialOauth: 'OAuth session',
    statusConfigured: 'already here',
    statusMissing: 'not here yet; will be copied',
    statusUnsupported: 'not supported',
    statusUnresolved: 'no matching model',
    oauthNote: 'An OAuth session is not a key: sign in again on this machine instead.',
    inlineKeyNote: 'carries a key',

    nothingToImport: 'Nothing in this directory can be imported.',
    apply: 'Confirm import',
    applying: 'Importing…',
    nothingSelected: 'Choose at least one category.',
    doneSummary: (imported, skipped) => `Imported ${imported} item(s); skipped ${skipped} already present.`,
    doneFailed: 'The import did not finish.',
    warningsTitle: 'Notes from the import',
  },
  zh: {
    title: '导入本机 omp 配置',
    lead: (source) =>
      `从 ${source} 读取终端 omp 的模型角色、服务商密钥、自定义服务商、MCP 服务器和技能。导入只做新增：本机已有的同名项会被跳过，不会重复。`,
    loading: '正在读取配置…',
    loadFailed: '读取配置失败。',
    retry: '重试',
    notFound: (source) => `${source} 下没有 omp 配置目录。`,
    close: '关闭',

    modelsCategory: '模型',
    mcpCategory: 'MCP 服务器',
    skillsCategory: '技能',
    categoryCount: (count) => `发现 ${count} 项`,
    rolesCount: (count) => `${count} 个角色`,
    credentialsCount: (count) => `${count} 个服务商密钥`,
    providersCount: (count) => `${count} 个自定义服务商`,

    credentialApiKey: 'API 密钥',
    credentialOauth: 'OAuth 登录',
    statusConfigured: '本机已有',
    statusMissing: '本机没有，将被导入',
    statusUnsupported: '不支持迁移',
    statusUnresolved: '目录中没有该模型',
    oauthNote: 'OAuth 登录无法作为密钥迁移，请在本机重新登录。',
    inlineKeyNote: '带密钥',

    nothingToImport: '这个目录里没有可导入的项。',
    apply: '确认导入',
    applying: '正在导入…',
    nothingSelected: '至少选择一类。',
    doneSummary: (imported, skipped) => `已导入 ${imported} 项，跳过 ${skipped} 项（本机已有）。`,
    doneFailed: '导入没有完成。',
    warningsTitle: '导入提示',
  },
}
