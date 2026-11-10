import type { Localized } from '@/lib/i18n'

/**
 * Wording of the skills settings page, both languages, plus the two prompts its entries hand to the
 * engine.
 *
 * The page is the reference's (`src/components/settings/skillsCopy.ts`): the same scope picker, count
 * and search, the same level names, the same two switch families, the same empty state. The Chinese
 * below is that file verbatim, so the two frontends read the same; the English follows the register of
 * the copy already in this app.
 *
 * Two kinds of sentence are this app's own and say what the controls really do:
 *
 * - `importSkillPrompt` is the task the import entry hands to the engine. Skill files belong to the
 *   engine's own tools, so this app opens a session with a prompt instead of writing a file: the
 *   prompt names the file to read and the directory to write. The create entry writes nothing
 *   either — it opens a new task and puts `/skill:skill-creator` in the composer, the way the reference client
 *   opens one with its skill mention, and the seeded skill supplies the procedure.
 * - `storageHint` states the one thing about this list a reader cannot see: which directory this
 *   app's own skills land in (`rules.md#engine-integration-and-data-ownership` disclosure).
 *
 * The lookup tables exist because the levels and source ids come from the engine's discovery code:
 * an id this table does not know is shown as the engine spelled it rather than as a blank badge.
 */

/** One skill the import task names: what to copy, and the name the engine reports for it. */
export interface SkillImportSelection {
  name: string
  filePath: string
}

/** The engine's own level vocabulary, folded to the four names this page shows. */
export type SkillLevel = 'user' | 'project' | 'native' | 'unknown'

export interface SkillsCopy {
  retry: string
  /** The page's own re-read: the same forced read a retry makes, offered before anything fails. */
  refresh: string
  loading: string
  loadFailed: string
  /** A switch write the host refused; the row repeats this sentence plus the engine's code. */
  writeFailed: string
  writeBusy: string

  /** The count beside the toolbar: how many skills the picker's scope holds. */
  /** `技能 14` — a label and the number the current scope and query select. */
  countLabel: (count: number) => string
  searchLabel: string
  searchPlaceholder: string
  searchEmpty: string
  /** The pager under the list: the same three controls the models page pages providers with. */
  pagerLabel: string
  pagerPrevious: string
  pagerNext: string
  pagerStatus: (page: number, pageCount: number) => string

  installedEmptyTitle: string
  installedEmptyDescription: string
  /** The one authoring entry; its destination is the picker's scope. */
  newSkill: string
  newAction: string
  newProjectSkillPrompt: string
  newUserSkillPrompt: string
  importAction: string

  /** The engine found nothing from another agent to import, so no task was started. */
  importEmpty: string
  importSkillPrompt: (skills: readonly SkillImportSelection[]) => string
  /** The task the page started, and the one it could not start. */
  taskStarted: string
  taskFailed: string

  noDescription: string
  levelLabels: Readonly<Record<SkillLevel, string>>
  /** Provider id as the engine reports it → how this page names it. Missing id = show it as is. */
  providerLabels: Readonly<Record<string, string>>
  hiddenBadge: string
  /** The badge on a skill a plugin's package carries (the plugin's own name). */
  pluginBadge: (name: string) => string
  /** Why that row's switch is disabled: the row follows its plugin, and the plugin is the switch. */
  pluginHint: (name: string) => string

  engineTitle: string
  engineDescription: string
  masterTitle: string
  masterDescription: string
  masterOffHint: string
  /** Source switch id → how this page names it. Missing id = the engine's own label. */
  sourceLabels: Readonly<Record<string, string>>

  warningsTitle: string
  /** The collapsible banner's one line: how many diagnostics the engine reported. */
  warningsSummary: (count: number) => string
  warningsExpand: string
  warningsCollapse: string
  ignoredPatternsLabel: string
  includedPatternsLabel: string
  storageHint: string

  figureSkills: string
  figureEnabled: string
  figureDisabled: string
  figureHidden: string
  figureWarnings: string

  toggleOn: (name: string) => string
  toggleOff: (name: string) => string
}

/**
 * Where a skill this app owns lives: `$OMP_DESKTOP_CODING_AGENT_DIR/skills/<name>/SKILL.md`.
 *
 * `OMP_DESKTOP_CODING_AGENT_DIR` is pinned to this application's own data root, so naming it in a
 * prompt is naming this app's store and nothing else.
 */
export function skillDestination(name: string): string {
  return `$OMP_DESKTOP_CODING_AGENT_DIR/skills/${name}/SKILL.md`
}

/** One line of `importSkillPrompt`: the file the agent reads, and where the copy has to land. */
function importSkillLine(skill: SkillImportSelection): string {
  return `- ${skill.name}: \`${skill.filePath}\` → \`${skillDestination(skill.name)}\``
}

/**
 * Provider ids whose skills belong to **another agent** on this machine, and are therefore
 * importable: the engine's discovery walks every agent's own skill directories and attributes each
 * row to the provider that found it. The rest are this app's own (`native`, `omp-managed`) or arrive
 * inside a plugin package and have nothing to copy.
 */
export const IMPORTABLE_SKILL_PROVIDERS: readonly string[] = [
  'codex',
  'claude',
  'agents',
  'github',
  'opencode',
]

const en: SkillsCopy = {
  retry: 'Retry',
  refresh: 'Refresh',
  loading: 'Reading…',
  loadFailed: 'Could not read the skills the engine discovered.',
  writeFailed: 'The host refused this change.',
  writeBusy: 'Saving…',

  countLabel: (count) => `Skills ${count}`,
  searchLabel: 'Search skills',
  searchPlaceholder: 'Search skills...',
  searchEmpty: 'No skills match your search',
  pagerLabel: 'Skill list paging',
  pagerPrevious: 'Previous page',
  pagerNext: 'Next page',
  pagerStatus: (page, pageCount) => `Page ${page} / ${pageCount}`,

  installedEmptyTitle: 'No skills installed',
  installedEmptyDescription: 'Create a skill or import one from an external agent.',
  newSkill: 'New skill',
  newAction: 'New',
  newProjectSkillPrompt: '/skill:skill-creator Create a project-level skill in this workspace: ',
  newUserSkillPrompt: '/skill:skill-creator Create a user-level skill: ',
  importAction: 'Import',

  importEmpty: 'The engine found no skills from other agents on this machine.',
  importSkillPrompt: (skills) => [
    'Import skills from other agents on this machine into this application’s own store.',
    'Copy each of the following into this application’s own skills directory, keeping every `SKILL.md` and the rest of its directory intact:',
    ...skills.map(importSkillLine),
    'Never write into the project directory, leave the source files where they are, and report where each skill landed.',
  ].join('\n'),
  taskStarted: 'Started a new session for this — go back to the workspace to follow along.',
  taskFailed: 'Could not start a session for this task.',

  noDescription: 'No description',
  levelLabels: {
    user: 'User',
    project: 'Project',
    native: 'Native',
    unknown: 'Unknown',
  },
  providerLabels: {
    native: 'OMP',
    'omp-managed': 'OMP learned',
    'omp-plugins': 'OMP plugins',
    codex: 'Codex',
    claude: 'Claude',
    'claude-plugins': 'Claude plugins',
    agents: 'AGENTS.md',
    'agent-plugins': 'Agent plugins',
    github: 'GitHub',
    opencode: 'opencode',
  },
  hiddenBadge: 'Hidden',
  pluginBadge: (name) => `Plugin · ${name}`,
  pluginHint: (name) =>
    `This skill ships inside the ${name} plugin: it follows that plugin’s switch and cannot be turned off or removed on its own.`,

  engineTitle: 'Engine switches',
  engineDescription:
    'The engine loads skills through two families of settings: the master `skills.enabled` and one switch per source.',
  masterTitle: 'Skills master switch',
  masterDescription: 'The engine’s `skills.enabled`: while it is off, the engine loads no skill at all.',
  masterOffHint: 'The master switch is off, so the engine loads none of the skills above.',
  sourceLabels: {
    enableCodexUser: 'Codex (user)',
    enableClaudeUser: 'Claude (user)',
    enableClaudeProject: 'Claude (project)',
    enablePiUser: 'OMP (user)',
    enablePiProject: 'OMP (project)',
    enableAgentsUser: 'AGENTS.md (user)',
    enableAgentsProject: 'AGENTS.md (project)',
  },

  warningsTitle: 'Skills the engine refused',
  warningsSummary: (count) => `${count === 1 ? '1 skill warning' : `${count} skill warnings`}`,
  warningsExpand: 'Show the warnings',
  warningsCollapse: 'Hide the warnings',
  ignoredPatternsLabel: 'Ignored patterns',
  includedPatternsLabel: 'Included patterns',
  storageHint:
    'Skills created or imported here land in this application’s own data root, in the engine’s user-level skills directory (`<data root>/host/agent/skills`); the project’s and other tools’ skills are read only.',

  figureSkills: 'Skills',
  figureEnabled: 'Enabled',
  figureDisabled: 'Disabled',
  figureHidden: 'Hidden',
  figureWarnings: 'Warnings',

  toggleOn: (name) => `Load ${name}`,
  toggleOff: (name) => `Stop loading ${name}`,
}

const zh: SkillsCopy = {
  retry: '重试',
  refresh: '刷新',
  loading: '正在读取…',
  loadFailed: '无法读取引擎发现的技能。',
  writeFailed: '宿主拒绝了这次改动。',
  writeBusy: '保存中…',

  countLabel: (count) => `技能 ${count}`,
  searchLabel: '搜索技能',
  searchPlaceholder: '搜索技能...',
  searchEmpty: '没有匹配的技能',
  pagerLabel: '技能列表分页',
  pagerPrevious: '上一页',
  pagerNext: '下一页',
  pagerStatus: (page, pageCount) => `第 ${page} / ${pageCount} 页`,

  installedEmptyTitle: '尚未安装技能',
  installedEmptyDescription: '新建技能，或从外部 Agent 导入已有技能。',
  newSkill: '新建技能',
  newAction: '新建',
  newProjectSkillPrompt: '/skill:skill-creator 为当前工作区创建一个项目级技能：',
  newUserSkillPrompt: '/skill:skill-creator 创建一个用户级技能：',
  importAction: '导入',

  importEmpty: '引擎没有在本机其它 Agent 里发现可导入的技能。',
  importSkillPrompt: (skills) => [
    '把本机其它 Agent 的技能导入到本应用自己的存储里。',
    '把下面这些逐个复制到本应用自己的技能目录，保留每个 `SKILL.md` 及其所在目录的完整内容：',
    ...skills.map(importSkillLine),
    '不要写进项目目录，不要改动源文件，并告诉我每个技能的落点。',
  ].join('\n'),
  taskStarted: '已开启一个新会话处理这件事，返回工作区即可查看。',
  taskFailed: '无法为这次任务开启会话。',

  noDescription: '暂无描述',
  levelLabels: {
    user: '用户级',
    project: '项目级',
    native: '引擎内置',
    unknown: '未知',
  },
  providerLabels: {
    native: 'OMP',
    'omp-managed': 'OMP 学习',
    'omp-plugins': 'OMP 插件',
    codex: 'Codex',
    claude: 'Claude',
    'claude-plugins': 'Claude 插件',
    agents: 'AGENTS.md',
    'agent-plugins': 'Agent 插件',
    github: 'GitHub',
    opencode: 'opencode',
  },
  hiddenBadge: '已隐藏',
  pluginBadge: (name) => `插件 · ${name}`,
  pluginHint: (name) => `这个技能由插件「${name}」提供：随插件启用状态，不能单独关闭或卸载。`,

  engineTitle: '引擎开关',
  engineDescription: '引擎通过两组设置决定加载哪些技能：主开关 `skills.enabled`，以及每个来源一个开关。',
  masterTitle: '技能主开关',
  masterDescription: '引擎的 `skills.enabled`：关闭时引擎不加载任何技能。',
  masterOffHint: '主开关已关闭，上面的技能一个都不会被加载。',
  sourceLabels: {
    enableCodexUser: 'Codex（用户级）',
    enableClaudeUser: 'Claude（用户级）',
    enableClaudeProject: 'Claude（项目级）',
    enablePiUser: 'OMP（用户级）',
    enablePiProject: 'OMP（项目级）',
    enableAgentsUser: 'AGENTS.md（用户级）',
    enableAgentsProject: 'AGENTS.md（项目级）',
  },

  warningsTitle: '引擎拒绝的技能',
  warningsSummary: (count) => `${count} 条技能警告`,
  warningsExpand: '展开警告',
  warningsCollapse: '收起警告',
  ignoredPatternsLabel: '忽略的模式',
  includedPatternsLabel: '包含的模式',
  storageHint:
    '本页新建或导入的技能落在本应用自己的数据根内，即引擎的用户级技能目录（`<数据根>/host/agent/skills`）；项目与其它工具的技能只读。',

  figureSkills: '技能',
  figureEnabled: '已启用',
  figureDisabled: '已禁用',
  figureHidden: '已隐藏',
  figureWarnings: '警告',

  toggleOn: (name) => `加载「${name}」`,
  toggleOff: (name) => `停止加载「${name}」`,
}

export const SKILLS_COPY: Localized<SkillsCopy> = { en, zh }
