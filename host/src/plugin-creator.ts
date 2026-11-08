/**
 * The skill that turns "make me a plugin" into a guided authoring task.
 *
 * The welcome screen's fourth starter writes `/skill:plugin-creator ` into the composer, the way the
 * Skills page's *New skill* writes `/skill:skill-creator ` — the reader still writes the sentence and
 * presses Enter, and this recipe supplies the interview and the manifest rules. It is seeded as a
 * **native user skill** (`<agentDir>/skills/plugin-creator/SKILL.md`), the same level
 * `skill-creator` lives at, so `/skill:plugin-creator` resolves on a fresh data root.
 *
 * The file follows the build (`native-skill.ts`): an unedited copy is refreshed to the recipe this
 * build ships, so a capability change reaches a machine that already ran the previous build, while a
 * copy the reader edited is left alone (and deleting it is the reset).
 *
 * Every fact in the body is a rule this build enforces somewhere, because a recipe that teaches a
 * manifest this build refuses is worse than none: the permissions and their names are the host's
 * closed list (`host/src/constants.ts::PLUGIN_DESKTOP_PERMISSIONS`), the entry/id/icon shapes are
 * `plugins-desktop` and `models::plugins::desktop`, the theme token families are
 * `PLUGIN_THEME_TOKEN_NAME`, and the template names are `services::plugins::scaffold::TEMPLATES`.
 * Changing any of those rules means changing this text in the same edit.
 */

import { seedNativeSkill } from './native-skill.ts'

/** The directory name, the frontmatter `name`, and the `/skill:<name>` token: one value. */
export const PLUGIN_CREATOR_NAME = 'plugin-creator'

/** One line, as the engine's `<skills>` listing and the settings page show it. */
export const PLUGIN_CREATOR_DESCRIPTION =
  '创建本应用的插件（omp 插件包）：先问用途、要哪些界面（主题、右侧边栏、工作面板、面板窗口、设置页、agent 技能/工具）与要哪些能力（文件、会话、浏览器、出网、模型、总线），再按清单规范写文件，并说明安装与验证。插件内的 skills/ 随包分发；单独的、本机使用的技能用 skill-creator。'

const PLUGIN_CREATOR_BODY = `---
name: ${PLUGIN_CREATOR_NAME}
description: ${PLUGIN_CREATOR_DESCRIPTION}
---

# 插件创建器

你负责为用户写一个**本应用的插件包**：一个目录，\`package.json\` 在根，加上页面与（可选的）引擎侧文件。插件是**用户自己的文件**，不是本应用的数据——不要创建在应用数据根里。

## 1. 先问清楚，一次只问一个

不要上来就写文件。按顺序问，每问给 2–3 个具体选项；用户上一条消息里已经说清的就不要重复问。

1. **用途**：一句话，什么场景下用、解决什么。
2. **要哪些界面**（可多选，决定清单字段与权限）：

| 想要的 | 清单字段 | 权限 |
| --- | --- | --- |
| 换配色/圆角（主题） | \`omp.desktop.themes\` | \`ui.theme\`；还带 CSS/图片再加 \`ui.theme.css\` |
| 侧边栏入口（右侧一级导航） | \`omp.desktop.sidebarTabs\` | \`ui.tab\` |
| 工作面板里的停靠页面 | \`omp.desktop.views\` | \`ui.view\` |
| 独立面板窗口 | \`omp.desktop.panels\` | \`ui.panel\` |
| 插件详情里的设置页 | \`omp.desktop.settingsDestinations\` | \`ui.settings\` |
| 给 agent 的技能/命令/工具 | \`skills/\`、\`commands/\`、\`tools/\`、\`rules/\`、\`omp.extensions\` | 工具与扩展要 \`agent.extension\` |
| 调色板命令、常驻进程 | \`omp.desktop.main\` + \`contributes\` | \`plugin.process\`（+ \`command.register\`） |
| 跑在本应用窗口里的插槽模块 | \`omp.desktop.renderer\` | \`renderer.extension\` |

不是界面、但经常一起要的**能力**（同样按需声明，多写一个就是在同意界面多吓用户一条）：

| 想要的 | 权限 | 要点 |
| --- | --- | --- |
| 读它的项目或任意路径的文件 | \`fs.read\`（+ \`fs.anyPath\`） | 可达范围由 \`omp.desktop.fs.read.scope\` 声明；找一批文件用 \`fs.glob\`（模式语言与 scope 同源），看某路径是什么用 \`fs.stat\`，读大文件的一段用 \`fs.readRange\` |
| 写 / 删文件 | \`fs.write\` / \`fs.delete\` | 各自有自己的 scope；删除有每分钟 50 次的刹车 |
| 交给系统默认程序打开 / 在文件管理器指出 | \`fs.openDefault\` / \`fs.reveal\` | 两个独立权限：前者能启动程序，后者只开一个文件管理器窗口。可执行扩展名与凭据类文件名**一律拒绝**，\`fs.anyPath\` 也不放宽 |
| 读会话（列表 / 元数据 / 消息） | \`session.read\` | 只读、分页；消息正文要显式给 \`contentLimit\` |
| 改名 / 删除会话 | \`session.write\` | **真实改动用户数据**；改名只对已打开的会话生效（否则 \`not_found\`），会话仍在工作时删除被拒 |
| 自己驱动一个浏览器页 | \`browser.use\` | 页面归插件自己（不是用户正在看的那张），导航仍受 \`net.domains\` 约束；没有 cookie / storage / CDP |
| 调模型（花用户的钱） | \`agent.complete\` | 首次使用单独确认，且有速率与并发上限 |
| 出网 / WebSocket / 打开外链 | \`net.fetch\`+\`omp.desktop.net.domains\` / \`net.websocket\` / \`shell.openExternal\` | \`net.anyHost\` 必须与 \`omp.desktop.net.anyHost: true\` 同时写 |
| 剪贴板、通知 | \`clipboard.read\` / \`clipboard.write\` / \`notify\` | 剪贴板首次使用要确认 |
| 插件之间通信 | \`bus.publish\` / \`bus.subscribe\` | 订阅只有常驻进程能收 |

3. **要不要跑代码**：任何在进程里跑的代码（扩展、工具、常驻进程、插槽模块）都要用户逐条确认；纯声明式（主题、页面、技能、命令）不需要。
4. **放哪儿**：用户自己的目录，例如工作区里的一个新文件夹。

"要在右侧工作面板出现"有两种实现，先让用户选：第三方插件用 \`views\`（\`ui.view\`，一个自包含页面）；\`workPanelTabs\` 只给本应用自己实现的渲染器用（当前只服务 \`terminal\`），插件声明了也不会被画出来。

## 2. 可以省事的起点

- 应用内：**设置 → 插件 → 添加 → 模板**，四个模板任选（\`panel-basic\` 面板页、\`agent-tool-basic\` agent 工具、\`skill-pack\` 技能包、\`renderer-slots-basic\` 插槽模块），骨架写到用户选的目录（只拷文件，不安装）。
- 本仓库里同一份模板在 \`src-tauri/resources/plugin-templates/\`，开发时可以直接抄。
改模板的**副本**，不要改模板本身。

## 3. 清单规范

纯声明式的最小清单（一个侧边栏页面）：

\`\`\`json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "一句话",
  "omp": {
    "name": "显示名",
    "description": "简介",
    "desktop": {
      "schemaVersion": 1,
      "engines": { "ompDesktop": ">=0.1.0" },
      "i18n": {
        "en": { "name": "Display name", "description": "One line", "safetyNotes": "What it can read or run." },
        "zh": { "name": "显示名", "description": "一句话", "safetyNotes": "它能读到什么、跑什么。" }
      },
      "permissions": ["ui.tab"],
      "sidebarTabs": [{ "id": "main", "title": { "en": "My tab", "zh": "我的入口" }, "entry": "desktop/index.html" }]
    }
  }
}
\`\`\`

- \`name\`：字母数字开头，只含 \`. _ -\`。它同时是插件 id（授权、页面、主题、设置都按它存），改名等于换一个插件。
- \`version\`：安装根是带版本的缓存，**内容改了必须 bump**，否则永远读到旧的。
- \`omp.desktop.i18n\`：\`en\` 与 \`zh\` 两份显示名、简介与 \`safetyNotes\`；\`safetyNotes\` 出现在同意界面，如实写它能做什么。
- \`id\`：\`^[a-zA-Z][a-zA-Z0-9_-]{0,63}$\`，同一列表内唯一；\`icon\` 是 \`^[a-z][a-z0-9-]{0,31}$\` 的 token。
- \`engines.ompDesktop\`：**必须**能被本 build 报告的版本满足，否则整块桌面清单被拒（\`unsupported_engine_range\`）。本 build 报告的是 \`0.3.0\`，所以写 \`>=0.3.0\`（模板里写的是 \`>=0.1.0\`，同样满足）；用的能力越少可以写越低的范围，但**别写排除 0.3.0 的范围**（\`^0.2.0\`、\`<0.3.0\` 都会被拒）。用到 \`fs.glob\`、\`fs.readRange\`、\`fs.openDefault\`、\`fs.reveal\`、\`session.write\`、\`browser.*\` 这些 0.3.0 能力就写 \`>=0.3.0\`。
- 权限是封闭表：**用到的才声明；写一个不存在的名字会让整块桌面清单被拒**，不是静默忽略。
  \`ui.panel\` \`ui.view\` \`ui.settings\` \`ui.tab\` \`ui.theme\` \`ui.theme.css\` \`notify\` \`clipboard.read\` \`clipboard.write\` \`fs.read\` \`fs.write\` \`fs.delete\` \`fs.anyPath\` \`fs.openDefault\` \`fs.reveal\` \`net.fetch\` \`agent.extension\` \`plugin.process\` \`command.register\` \`renderer.extension\` \`session.read\` \`session.write\` \`usage.read\` \`agent.complete\` \`bus.publish\` \`bus.subscribe\` \`net.websocket\` \`shell.openExternal\` \`browser.use\` \`net.anyHost\`

### 页面（panels / views / sidebarTabs / settingsDestinations）

- \`entry\` 是相对插件根的路径；页面必须自包含：CSP 不允许外部资源与出网。
- 唯一可用的宿主 API 是 \`fetch('/__bridge?m=<方法>')\`：\`ready\`、\`close\`（仅面板窗口）、\`fs.read\`、\`fs.stat\`、\`fs.list\`、\`fs.glob\`、\`fs.readRange\`、\`fs.openDefault\`、\`fs.reveal\`、\`net.fetch\`、\`clipboard.read\`、\`clipboard.write\`、\`session.list/get/messages/rename/delete\`、\`browser.navigate/reveal/snapshot/screenshot/evaluate/console/action\`，以及 \`plugin.dataDir\`（GET，无权限，返回本插件唯一可自由写入的目录，首次调用时创建）。除 \`ready\`/\`close\`/\`plugin.dataDir\` 外各自需要同名权限（\`fs.glob\`、\`fs.readRange\` 用 \`fs.read\`），没声明就是 403。
- 常驻进程（\`omp.desktop.main\`）拿到的是同一套 API 的 \`pi\` 形式（\`pi.fs.read/write/delete/stat/list/glob/readRange/openDefault/reveal\`、\`pi.session.rename/delete\`、\`pi.browser.*\`、\`pi.net.fetch\`、\`pi.plugin.getDataPath()\` 等）：页面走 \`fetch('/__bridge')\`，进程走 \`worker_invoke\`，两侧判定是同一张表。
- 出网要 \`omp.desktop.net.domains\`（缺省 = 一个域都拿不到）；读文件要 \`omp.desktop.fs.read.scope\`，写与删各有自己的 scope 与权限。声明 \`fs.anyPath\` 则**读、写、删**三种模式都可指名任意路径：工作区、插件自身包、拒绝表与 scope 对这三种不再适用（与 \`net.anyHost\` 对称的文件侧开关）——但 \`fs.openDefault\`/\`fs.reveal\` 的两道拒绝不受它影响，别指望用 \`fs.anyPath\` 绕过。

### 能力（文件 / 会话 / 浏览器 / 常驻进程）

- **文件**：\`fs.read\`、\`fs.write\`、\`fs.delete\`、\`fs.stat\`、\`fs.list\`、\`fs.glob\`、\`fs.readRange\`、\`fs.openDefault\`、\`fs.reveal\`。\`fs.glob\` 的模式语言**就是** \`fs.read.scope\` 那一套（段内 \`*\`、整段 \`**\`，\`?\`/\`[]\`/\`{}\` 会被拒）；答案有上界（512 条 / 256 个目录 / 16 层），命中任一个就 \`truncated: true\` 停下来，不是报错。声明 \`fs.anyPath\` 后模式和路径都可以是绝对的（含盘根，如 \`C:/**\`），否则只能用相对模式。拒绝表（\`.env\`、\`.ssh\`、\`.git\` 之类）对读、\`fs.stat\`、\`fs.list\`、\`fs.glob\` 的读数一致：没声明 \`fs.anyPath\` 时它们都不会把那些名字交给你，声明了则和普通路径一样可见。\`fs.readRange\` 返回 base64（\`offset\`/\`length\`，越界给空 answer 而不是报错，单次上限 2 MiB）。\`fs.openDefault\`/\`fs.reveal\` 交给系统时，程序文件（\`.exe\`/\`.bat\`/\`.cmd\`/\`.ps1\`/\`.js\`/\`.jar\`/\`.sh\` 等）和凭据类名字永远被拒——不要把它当“万能打开”用。
- **会话**：\`session.list/get/messages\`（\`session.read\`）与 \`session.rename/delete\`（\`session.write\`，独立权限，不是读的赠品）。改名走该会话自己的打开实例，**没打开的会话改名会 \`not_found\`**；删除是真实删除（文件从磁盘消失），会话仍在工作时被拒。要在界面话术里说清这一点，别让用户以为能撤销。
- **浏览器**：\`browser.navigate/reveal/snapshot/screenshot/evaluate/console/action\`。它给插件一张**自己的页**，不是用户正在看的那张；默认不显示在界面上——\`browser.reveal\` 只回答**这张页是否存在**（\`{"revealed": true|false}\`），它不会让任何东西显示出来：工作面板按会话索引 tab，而安装不是会话，插件的页永远不会被画出来——所以把取到的东西画在插件自己的 \`views\`/\`sidebarTabs\` 页面里。导航只允许 \`net.domains\` 里列的域；这个能力面里没有 cookie / storage / DevTools 接口。快照和 console 都有上界：快照被截断时末尾有 \`... (truncated)\`，给出的 uid 都是它真列出来的（列表里没有的别拿去点）；console 一次读不完时答 \`too_large\`，用 \`limit\` 少要几条再试。
- **常驻进程**（\`omp.desktop.main\`）：崩溃后按 1s→2s→4s→8s→16s 重试，最多 5 次；进程存活过 60 秒则预算重置；耗尽后停在 \`crashed\`，等用户手动重启（本应用从不因为崩溃禁用插件）。要自己管恢复流程的插件在 \`omp.desktop\` 里写 \`{ "autoRestart": false }\`，崩溃后就不再被拉起；崩溃日志里有退出码。\`activationEvents\` 里的 \`onStartup\` 是“应用起来就跑”，别对每个插件都加。

### 主题（themes）

- 一条：\`{ "id": "midnight", "label": { "en": "Midnight", "zh": "午夜" }, "dark": true, "tokens": { "--background": "#0b0b0c" } }\`。
- token 名只能取本应用已发布的：\`--dsw-*\`、\`--omp-*\`、\`--sidebar-*\`，以及 \`:root\` 里的裸名（\`--background\` \`--foreground\` \`--card\` \`--primary\` \`--muted\` \`--border\` \`--radius\` \`--chart-1\`..\`--chart-5\` 等）；值是颜色或长度，**不能带 \`url()\`**。
- 带样式表（\`css\`）或图片（\`assets\`）要 \`ui.theme.css\`，那是单独一次同意。

### 引擎侧（可选）

- \`omp.extensions\`：TS 模块直接 import，不打包、不能装 npm 依赖、不能 import SDK 运行时（只有类型导入可以）；装载期只做注册。
- \`tools/*.ts\`：默认导出工厂，返回 \`{ name, label, description, parameters, execute }\`；工具名全局唯一。
- \`skills/<名>/SKILL.md\`：**必须写 \`description\`**，模型靠它判断何时加载；只发现一层。
- \`commands/<名>.md\`：正文支持 \`$1\`、\`$ARGUMENTS\`；市场插件的命令带插件名前缀。
- \`rules/*.md\`：可 \`alwaysApply\`，正文进每次请求的系统提示。

## 4. 装与验

1. 把**插件目录的内容**（\`package.json\` 所在层）压成 zip，后缀 \`.omp.zip\`（兼容 \`.piplug\`）→ 设置 → 插件 → 添加 → **包文件**。
2. 或者 添加 → **来源**，填本地目录路径。
3. 启用：页面、主题、面板这类低风险权限启用即授予；跑代码的权限要逐条确认。
4. 验证：插件详情页看它报告了哪些页面与主题；有 \`valid: false\` 或 reason 就是被拒了，按 reason 改清单再重装。主题去设置 → 外观里选；技能与命令要新建一个会话才生效。

## 5. 边界

- 一次只做一个插件；改已有插件时先 \`read\` 它的 \`package.json\`。
- 插件内的 \`skills/\` 随包分发；单独的、本机使用的技能用 \`skill-creator\`，不要为它建插件包。
- 不装依赖、不构建、不为插件改本仓库；插件是独立目录。
- 不把密钥、令牌或用户隐私写进插件，也不在页面里内联真实凭据。
- 不要宣称插件是被沙箱隔离的：页面在独立 frame 里但仍能申请 bridge 权限，插槽模块直接跑在本应用页面里。
- 本仓库 \`rules.md\` 的插件系统一节（\`rules.md#plugin-system\`）是插件契约的权威；清单字段有疑问先对照它。
`

/** Seeds `<agentDir>/skills/plugin-creator/SKILL.md` by `native-skill.ts`'s rule: this build's recipe
 *  when the copy there is absent or unedited, and no change when the reader edited it. */
export function seedPluginCreator(agentDir: string): void {
  seedNativeSkill(agentDir, { name: PLUGIN_CREATOR_NAME, body: PLUGIN_CREATOR_BODY })
}
