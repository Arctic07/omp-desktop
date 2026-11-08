import type { Localized } from '@/lib/i18n'
import { PROVIDER_KEYS_MAX } from '@/settings/sections/models/limits'

/**
 * The model page's wording: the three views it switches between, and every label and sentence
 * inside them.
 *
 * The words are the desktop app's own (`src/components/settings/modelsCopy.ts` and
 * `modelRolesCopy.ts` in the Vue frontend, which own this page's copy, plus the conversation
 * shard's `thinkingLevelLabels` for the effort levels) — the two frontends read the same.
 */
export interface ModelsCopy {
  /** The tab bar's own name, for the list that switches the three views. */
  tabsLabel: string
  rolesTabLabel: string
  providersTabLabel: string
  customTabLabel: string

  /** The page's own read state: it loads all six lists at once, so one state covers them. */
  loadingLabel: string
  loadFailedLabel: string
  retry: string
  refreshModels: string
  refreshingModels: string
  /** What the refresh button asks the host to do; the button's own title, not a label. */
  refreshModelsHint: string
  /** The one-click copy of a terminal omp installation's configuration on this machine. */
  importLabel: string
  importHint: string

  /** The roles view: what each role resolves to and how its model is selected. */
  rolesLead: string
  docsLabel: string
  chatGroupTitle: string
  kindGroupTitle: string
  rolesConfiguredLabel: string
  rolesAutoLabel: string
  rolesEmptyLabel: string
  busyLabel: string
  assignFailed: (role: string) => string
  /** The model picker's own choice for handing the role back to the engine. */
  roleDefaultChoice: string
  candidatesFailedLabel: string
  candidatesEmptyLabel: string
  thinkingStrengthLabel: string
  /** The level control's first choice: no `:<level>` suffix, so the engine decides. */
  levelNoneLabel: string
  /** Stands in for the level control when the role's model has no effort surface to set. */
  levelUnavailableLabel: string
  /** The engine's effort levels in words; a level this map lacks keeps the engine's spelling. */
  thinkingLevelLabels: Readonly<Record<string, string>>
  editRole: (role: string) => string
  defaultRoleNote: string
  projectOverrideNote: string

  /** The providers view: the engine's own providers and the key form under a row. */
  providersLead: string
  providersEmpty: string
  providerFilterLabel: string
  providerFilterPlaceholder: string
  providersNoMatch: string
  pagerLabel: string
  pagerPrevious: string
  pagerNext: string
  pagerStatus: (page: number, pageCount: number) => string
  pagerTotal: (count: number) => string
  providerConfiguredLabel: string
  providerNotConfiguredLabel: string
  authenticatedLabel: string
  configureKey: string
  hideKeyEditor: string
  providerToggleLabel: (name: string, expanded: boolean) => string
  apiKeyLabel: string
  apiKeyPlaceholder: string
  apiKeyEnvLabel: string
  clearKey: string
  saveKey: string
  savingKey: string
  keySaveFailed: string
  keyClearFailed: string
  keySaved: string
  keyCleared: string
  /** The running engine host took the key; it is in effect now. */
  keyLive: string
  /** No running host could be told, so the key takes effect at the next engine start. */
  keyRestartRequired: string
  providerNoKeyForm: string
  providerModelsTitle: string
  providerModelsEmpty: string
  modelsLabel: string
  modelContextShort: string
  modelOutputShort: string
  modelImagesShort: string

  /** The custom view: the providers this app defines itself and the editor for one of them. */
  customLead: string
  customEmpty: string
  customEdit: string
  customRemove: string
  customRemoveConfirm: string
  customRemoveHint: string
  customCancel: string
  customSave: string
  customSaving: string
  customSaved: string
  customFailed: string
  customRemoved: string
  customKeyCleared: string
  /** The stored key could not be pushed to a running engine host; it takes effect at next start. */
  customKeyDeferred: string
  customKeyRolledBack: string
  customKeyOrphaned: string
  customNewTitle: string
  customEditTitle: string
  /** The new-provider block's own introduction, above the card. */
  customNewLead: string
  /** The button that opens the new-provider block. */
  customNewOpen: string
  customNameLabel: string
  customBaseUrlLabel: string
  customApiLabel: string
  customKeysLabel: string
  customKeysHint: (count: number) => string
  customKeysAdd: string
  customKeysRemove: string
  customKeysRowLabel: (index: number) => string
  /** Marks a row that shows a saved key's masked form rather than an input. */
  customKeysSavedTag: string
  customModelsTitle: string
  customModelsHint: string
  customFetchModels: string
  customFetching: string
  customFetchFailed: string
  customFetchEmpty: string
  customAddModel: string
  customRemoveModel: string
  customModelIdLabel: string
  customModelNameLabel: string
  customReasoningLabel: string
  customErrorIdInvalid: string
  customErrorNameRequired: string
  customErrorBaseUrlInvalid: string
  customErrorModelIdRequired: string
  customErrorModelIdDuplicate: string
  modelsEmpty: string
  expandModel: string
  collapseModel: string
  clearStoredKey: string
  contextWindowLabel: string
  maxTokensLabel: string
  supportsImagesLabel: string
}

export const MODELS_COPY: Localized<ModelsCopy> = {
  en: {
    tabsLabel: 'Model configuration views',
    rolesTabLabel: 'Model roles',
    providersTabLabel: 'Built-in providers',
    customTabLabel: 'Custom providers',

    loadingLabel: 'Loading…',
    loadFailedLabel: 'Could not read the model configuration.',
    retry: 'Retry',
    refreshModels: 'Refresh models',
    refreshingModels: 'Refreshing…',
    refreshModelsHint:
      'Asks the host to re-read `models.yml` and rebuild its catalogue. Saved keys reach a running engine when they are stored; a key from an earlier session is read when the engine starts.',
    importLabel: 'Import local omp configuration',
    importHint:
      'Copies the model roles, provider keys, custom providers, MCP servers and skills of the terminal omp configured on this machine. Anything already present is skipped, never duplicated.',

    rolesLead:
      'The model each engine role resolves to. Assignments are written to the engine’s own settings, so the engine uses them for every conversation.',
    docsLabel: 'Engine configuration docs',
    chatGroupTitle: 'Conversation roles',
    kindGroupTitle: 'Service roles',
    rolesConfiguredLabel: 'assigned',
    rolesAutoLabel: 'automatic',
    rolesEmptyLabel: 'The engine reported no model roles.',
    busyLabel: 'Saving…',
    assignFailed: (role) => `${role} was not changed`,
    roleDefaultChoice: 'Use the engine default',
    candidatesFailedLabel: 'The candidate models could not be read',
    candidatesEmptyLabel: 'The engine offers no model for this role.',
    thinkingStrengthLabel: 'Thinking strength',
    levelNoneLabel: 'Not specified (engine decides)',
    levelUnavailableLabel: 'This model has no thinking strength to set.',
    thinkingLevelLabels: {
      auto: 'Auto (engine decides)',
      off: 'Off',
      minimal: 'Minimal',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      xhigh: 'X-high',
      max: 'Max',
    },
    editRole: (role) => `Assign a model to the ${role} role`,
    defaultRoleNote:
      'The default role decides which model a new conversation starts on. A model picked inside a conversation wins for that conversation, and the conversation remembers it.',
    projectOverrideNote:
      'App-level setting written here; a workspace configuration currently overrides it.',

    providersLead:
      'Keys are stored in the operating system keyring and injected as environment variables when the engine starts.',
    providersEmpty: 'The engine reported no providers.',
    providerFilterLabel: 'Filter providers',
    providerFilterPlaceholder: 'Filter by id, name, variable, or model',
    providersNoMatch: 'No matching providers.',
    pagerLabel: 'Provider list paging',
    pagerPrevious: 'Previous page',
    pagerNext: 'Next page',
    pagerStatus: (page, pageCount) => `Page ${page} / ${pageCount}`,
    pagerTotal: (count) => `${count} providers`,
    providerConfiguredLabel: 'Configured',
    providerNotConfiguredLabel: 'Not configured',
    authenticatedLabel: 'Signed in',
    configureKey: 'Configure key',
    hideKeyEditor: 'Hide',
    providerToggleLabel: (name, expanded) => (expanded ? `Collapse ${name}` : `Configure ${name}`),
    apiKeyLabel: 'API key',
    apiKeyPlaceholder: 'Enter an API key',
    apiKeyEnvLabel: 'Environment variable',
    clearKey: 'Clear',
    saveKey: 'Save',
    savingKey: 'Saving…',
    keySaveFailed: 'Could not save the key.',
    keyClearFailed: 'Could not clear the key.',
    keySaved: 'Key saved',
    keyCleared: 'Key cleared',
    keyLive: 'in effect in the running engine',
    keyRestartRequired: 'takes effect after the engine restarts',
    providerNoKeyForm:
      'This provider is configured from a terminal or the data directory, so no input field is offered here.',
    providerModelsTitle: 'Models',
    providerModelsEmpty: 'The engine reported no models for this provider.',
    modelsLabel: 'models',
    modelContextShort: 'context',
    modelOutputShort: 'output',
    modelImagesShort: 'images',

    customLead:
      'Providers you define here are written to the engine model configuration (`models.yml`); the host reads it when it refreshes its model catalog.',
    customEmpty: 'No custom provider yet.',
    customEdit: 'Edit',
    customRemove: 'Delete',
    customRemoveConfirm: 'Confirm delete',
    customRemoveHint: 'Nothing has been deleted yet. Deleting also removes the stored key.',
    customCancel: 'Cancel',
    customSave: 'Save',
    customSaving: 'Saving…',
    customSaved: 'Written to the engine model configuration.',
    customFailed: 'The operation failed.',
    customRemoved: 'Custom provider deleted.',
    customKeyCleared: 'Key cleared.',
    customKeyDeferred:
      'The key is stored; no engine was running to take it now, so it takes effect when the engine next starts.',
    customKeyRolledBack:
      'The key stored by this attempt was rolled back and the provider was not written; press Save again to retry.',
    customKeyOrphaned:
      'The key is stored but the provider was not written. Remove the key with Clear on the card, then retry.',
    customNewTitle: 'New custom provider',
    customEditTitle: 'Edit custom provider',
    customNewLead:
      "Fill in the service and save it; the provider is written into the engine's model configuration. At least one model ID is required.",
    customNewOpen: 'Add custom provider',
    customNameLabel: 'Display name',
    customBaseUrlLabel: 'API address',
    customApiLabel: 'API type',
    customKeysLabel: 'API keys',
    customKeysHint: count =>
      count === 0
        ? `Add up to ${PROVIDER_KEYS_MAX} keys. The engine rotates across them when one fails or its quota runs out.`
        : `${count} saved ${count === 1 ? 'key is' : 'keys are'} shown masked. Remove a row or add a key, then save.`,
    customKeysAdd: 'Add key',
    customKeysRemove: 'Remove key',
    customKeysRowLabel: index => `Key ${index}`,
    customKeysSavedTag: 'saved',
    customModelsTitle: 'Models',
    customModelsHint:
      'Most OpenAI-compatible services only return model ids, so fill in the context window and max output by hand.',
    customFetchModels: 'Get models',
    customFetching: 'Getting models…',
    customFetchFailed: 'Could not get models from this address.',
    customFetchEmpty: 'The address returned no models.',
    customAddModel: 'Add model',
    customRemoveModel: 'Remove model',
    customModelIdLabel: 'Model ID',
    customModelNameLabel: 'Display name',
    customReasoningLabel: 'Reasoning',
    customErrorIdInvalid:
      'Use lowercase letters, digits and hyphens, 2 to 32 characters, starting with a letter or digit.',
    customErrorNameRequired: 'Enter a display name.',
    customErrorBaseUrlInvalid: 'Enter an http or https address.',
    customErrorModelIdRequired: 'Every model needs an id.',
    customErrorModelIdDuplicate: 'Model ids must be unique.',
    modelsEmpty: 'No model yet.',
    expandModel: 'Expand model details',
    collapseModel: 'Collapse model details',
    clearStoredKey: 'Clear key',
    contextWindowLabel: 'Context window',
    maxTokensLabel: 'Max output tokens',
    supportsImagesLabel: 'Image support',
  },
  zh: {
    tabsLabel: '模型配置类型',
    rolesTabLabel: '模型角色',
    providersTabLabel: '系统内置',
    customTabLabel: '自定义',

    loadingLabel: '正在读取…',
    loadFailedLabel: '无法读取模型配置。',
    retry: '重试',
    refreshModels: '刷新模型',
    refreshingModels: '刷新中…',
    refreshModelsHint:
      '让宿主重新读取 `models.yml` 并重建模型目录。保存密钥时就会推送给运行中的引擎；更早保存的密钥由引擎下次启动时读取。',
    importLabel: '导入本机 omp 配置',
    importHint:
      '从本机终端版 omp 的配置中复制模型角色、服务商密钥、自定义服务商、MCP 服务器和技能。本机已有的项会被跳过，不会重复。',

    rolesLead: '引擎每个角色实际使用的模型。这里的选择写入引擎自己的设置，引擎对所有会话都按它工作。',
    docsLabel: '引擎配置文档',
    chatGroupTitle: '对话角色',
    kindGroupTitle: '服务角色',
    rolesConfiguredLabel: '已指定',
    rolesAutoLabel: '自动',
    rolesEmptyLabel: '引擎没有报告任何模型角色。',
    busyLabel: '保存中…',
    assignFailed: (role) => `「${role}」没有改动`,
    roleDefaultChoice: '改由引擎自动选择',
    candidatesFailedLabel: '无法读取候选模型',
    candidatesEmptyLabel: '引擎没有为该角色提供任何模型。',
    thinkingStrengthLabel: '思考强度',
    levelNoneLabel: '不指定（由引擎决定）',
    levelUnavailableLabel: '该模型没有可设置的思考强度。',
    thinkingLevelLabels: {
      auto: '自动（由引擎决定）',
      off: '关闭',
      minimal: '极简',
      low: '低',
      medium: '中',
      high: '高',
      xhigh: '极高',
      max: '最高',
    },
    editRole: (role) => `为「${role}」角色指定模型`,
    defaultRoleNote:
      'default 角色决定新会话用哪个模型开始。会话里选中的模型对该会话优先，并且会被这个会话记住。',
    projectOverrideNote: '此处写入的是应用级设置，当前被该工作区的配置覆盖。',

    providersLead: '密钥保存在操作系统安全存储中，并在引擎启动时以环境变量注入。',
    providersEmpty: '引擎未报告任何服务商。',
    providerFilterLabel: '筛选供应商',
    providerFilterPlaceholder: '按 id、名称、环境变量或模型筛选',
    providersNoMatch: '没有匹配的供应商。',
    pagerLabel: '供应商列表分页',
    pagerPrevious: '上一页',
    pagerNext: '下一页',
    pagerStatus: (page, pageCount) => `第 ${page} / ${pageCount} 页`,
    pagerTotal: (count) => `共 ${count} 个服务商`,
    providerConfiguredLabel: '已配置',
    providerNotConfiguredLabel: '未配置',
    authenticatedLabel: '引擎已登录',
    configureKey: '配置密钥',
    hideKeyEditor: '收起',
    providerToggleLabel: (name, expanded) => (expanded ? `收起「${name}」` : `配置「${name}」`),
    apiKeyLabel: 'API 密钥',
    apiKeyPlaceholder: '输入 API 密钥',
    apiKeyEnvLabel: '环境变量',
    clearKey: '清除',
    saveKey: '保存',
    savingKey: '保存中…',
    keySaveFailed: '密钥保存失败。',
    keyClearFailed: '密钥清除失败。',
    keySaved: '密钥已保存',
    keyCleared: '密钥已清除',
    keyLive: '已在运行中的引擎生效',
    keyRestartRequired: '引擎重启后生效',
    providerNoKeyForm: '该供应商需在终端或数据目录中配置，此处不提供输入框。',
    providerModelsTitle: '模型',
    providerModelsEmpty: '引擎未报告该服务商的模型。',
    modelsLabel: '个模型',
    modelContextShort: '上下文',
    modelOutputShort: '输出',
    modelImagesShort: '图片',

    customLead: '在这里定义的供应商会写入引擎的模型配置（`models.yml`），宿主刷新模型目录时读取。',
    customEmpty: '还没有自定义供应商。',
    customEdit: '编辑',
    customRemove: '删除',
    customRemoveConfirm: '确认删除',
    customRemoveHint: '尚未删除。删除会同时清除已保存的密钥。',
    customCancel: '取消',
    customSave: '保存',
    customSaving: '保存中…',
    customSaved: '已写入引擎模型配置。',
    customFailed: '操作失败。',
    customRemoved: '已删除自定义供应商。',
    customKeyCleared: '密钥已清除。',
    customKeyDeferred: '密钥已保存；当前没有运行中的引擎，将在引擎下次启动时生效。',
    customKeyRolledBack: '本次写入的密钥已回滚，供应商未写入；修正后再次点「保存」即可重试。',
    customKeyOrphaned: '密钥已写入但供应商未写入。请在卡片上用「清除」移除密钥后重试。',
    customNewTitle: '新增自定义供应商',
    customEditTitle: '编辑自定义供应商',
    customNewLead: '填写服务信息并保存，供应商会写入引擎的模型配置；至少需要一个模型 ID。',
    customNewOpen: '新增自定义供应商',
    customNameLabel: '供应商名称',
    customBaseUrlLabel: 'API 地址',
    customApiLabel: 'API 类型',
    customKeysLabel: 'API 密钥',
    customKeysHint: count =>
      count === 0
        ? `可添加多个密钥（最多 ${PROVIDER_KEYS_MAX} 个）；某个密钥失败或配额用尽时，引擎会轮换到下一个。`
        : `已保存 ${count} 个密钥（仅显示去敏片段）；删除某行或添加新密钥后保存。`,
    customKeysAdd: '添加密钥',
    customKeysRemove: '删除密钥',
    customKeysRowLabel: index => `密钥 ${index}`,
    customKeysSavedTag: '已保存',
    customModelsTitle: '模型',
    customModelsHint: '多数 OpenAI 兼容服务只返回模型 ID，请手工补全上下文长度与最大输出。',
    customFetchModels: '获取模型',
    customFetching: '正在获取…',
    customFetchFailed: '无法从该地址获取模型。',
    customFetchEmpty: '该地址没有返回任何模型。',
    customAddModel: '添加模型',
    customRemoveModel: '删除模型',
    customModelIdLabel: '模型 ID',
    customModelNameLabel: '显示名称',
    customReasoningLabel: '支持推理',
    customErrorIdInvalid: '请使用小写字母、数字和连字符，2 到 32 个字符，且以字母或数字开头。',
    customErrorNameRequired: '请填写显示名。',
    customErrorBaseUrlInvalid: '请填写 http 或 https 地址。',
    customErrorModelIdRequired: '每个模型都必须填写模型 ID。',
    customErrorModelIdDuplicate: '模型 ID 必须唯一。',
    modelsEmpty: '尚未添加模型。',
    expandModel: '展开模型详情',
    collapseModel: '收起模型详情',
    clearStoredKey: '清除密钥',
    contextWindowLabel: '上下文长度',
    maxTokensLabel: '最大输出 tokens',
    supportsImagesLabel: '是否支持图片',
  },
}
