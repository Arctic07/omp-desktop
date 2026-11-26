---
name: upgrade-omp-sdk
description: 把 OMP SDK（@oh-my-pi/pi-coding-agent、pi-ai、pi-utils）升级到最新版并适配本仓库：建本地分支、更新 pin/补丁/锁文件、按 changelog 接新功能（界面入口与输出展示用 BeUI）、逐项判断宿主注入是否已被上游取代（是则删除注入，否则继续适配）、跑旧数据+新引擎与全套门禁。用户说“升级 omp sdk / 更新 omp 版本 / 适配最新 SDK / 把引擎升到最新”时使用。
---

# 升级 OMP SDK 并适配

## 何时用

- 用户要求把 `@oh-my-pi/*` 升到最新版本，或要求“适配新版 omp / 新 SDK 功能”。
- 一次升级只做一条分支；不混入无关功能开发。

## 何时不用

- 只改 Rust、前端或协议、不动 SDK：按 `rules.md` 的普通改动流程。
- 只发布新版本、不升级 SDK：用 `release-omp-desktop`。
- `pnpm check:upstream` 退出 0（已是最新）：停，报告“已是最新”，不要为升级而升级。

## 边界

- 先读 `AGENTS.md`、`rules.md`（Dependencies、Engine upgrade and distribution、Artifact rebuild）、`src/AGENTS.md`、`src/rules.md`。
- `@oh-my-pi/*` 只在 `host/**` 内导入；前端与 Rust 不 import 引擎包，不保留第二套集成。
- 引擎能力属于 SDK；宿主只做转接。上游已有等价能力时删除我们的注入，绝不两套并存。
- git：只允许 `git switch -c` 建分支；不 commit、不 push、不 merge、不打 tag，除非用户明确要求。
- 不关闭 `omp_desktop` 进程，尤其不按进程名杀。本会话的祖先实例（`bash → bun.exe (the host) → omp_desktop.exe`）由用户重启。
- 源码改了必须重建产物；不重建等于没改。
- 新 SDK 若引入监听端口，只能绑 loopback 并在 note 说明；安装包保持 per-user、不写防火墙规则（`rules.md#updates-and-upgrades`，`scripts/check-installer-surface.mjs` 由 `pnpm check:repo` 跑）。

## 步骤

### 1. 记录基线

```bash
git status --porcelain          # 必须干净；有别人的改动就停，不 stash、不覆盖
node scripts/check-upstream.mjs # 退出 10 = 有新版；0 = 已最新
node -p "require('./node_modules/@oh-my-pi/pi-coding-agent/package.json').version"
```

- 记下旧版本 `<OLD>`，以**安装树**版本为准，不以 `host/package.json` 为准（两者可能已漂移）。
- 升级前留一份旧引擎写出的数据：

```bash
find host/.dev-data/data/host/agent/sessions -name '*.jsonl' | head
```

没有就先跑一次 `cd host && bun run scripts/smoke.ts`，让旧版本把会话文件写出来。

### 2. 建分支

```bash
git branch --list 'chore/sdk-*'
git switch -c chore/sdk-<NEW>
```

分支名固定 `chore/sdk-<NEW>`。同名分支已存在就停，先问用户。

### 3. 改 pin 并安装

全部用精确版本，不用 `^` / `~`：

- `host/package.json`：`@oh-my-pi/pi-coding-agent`、`@oh-my-pi/pi-ai`、`@oh-my-pi/pi-utils` 三处。
- 根 `package.json`：`devDependencies["@oh-my-pi/pi-coding-agent"]`。
- 根 `package.json`：`pnpm.patchedDependencies` 的键（包名@版本）。
- `patches/@oh-my-pi__*.patch` 文件名里的版本。

```bash
pnpm install
```

- 补丁无法应用 = 第一时间失败点。不要加 `--no-patch`、不要改 lockfile 绕过；只能按第 6 节重做补丁。
- `pnpm-lock.yaml` 由 pnpm 更新，不手改。
- `bundle/manifest.json` 的 `sdkVersion` 由 `host/build.ts` 从安装树读取，重建后自动更新；不手写。

### 4. 读变更日志，列工作单

```bash
sed -n '/^## \[<NEW>\]/,/^## \[<OLD>\]/p' node_modules/@oh-my-pi/pi-coding-agent/CHANGELOG.md
```

- changelog 是上游变更的事实源；`omp.sh/docs` 只用于确认 API 用法。
- 按 `Added / Changed / Fixed` 建两张单子：
  1. 可能取代我们注入的条目（关键词：transport、retry、compaction、write、stale、guard、title、skill、browser、terminal、tool call、reasoning、markup）。
  2. 需要桌面入口或输出展示的新功能。
- “上游是否已具备”必须看安装树里的实现与公开导出，不能只看 changelog 的一句话。

### 5. 适配编译面

```bash
cd host && pnpm typecheck
cd host && bun run scripts/seam-check.ts
```

- `host/src/engine-contract.ts` 报错 = 上游加了键。按该文件头部策略回答 `read` / `ignored: 原因` / `entry-counted`；**新能力不得写成 `entry-ungated`**。
- `seam-check` 失败 = 新引擎导入出现在未批准文件。优先把入口收敛进 `host/src/sdk.ts`，不为过检查随手扩白名单。
- 深路径导入最脆：`@oh-my-pi/pi-coding-agent/<subpath>`。子路径移动时同步改 import、`engine-prompts.d.ts` 声明，并在新包里确认导出存在。
- `host/src/engine-prompts.d.ts` 声明的是引擎 Markdown prompt 的文本导入（`prompts/*` → `src/prompts/*.md`）；文件没了改路径，不再需要就删声明和调用点。

### 6. 审计每一个注入（升级的核心）

先枚举，再逐项判定：

```bash
grep -rn "@oh-my-pi/" host/src --include=*.ts
grep -n "customTools\|extensions:\|titleSystemPrompt\|autoTitle\|interactivePrompts\|skipPythonPreflight\|\.override(" host/src/session-activate.ts
ls patches
```

已知注入点与判定（每项都要给出 kept / removed 结论与证据）：

| 注入 | 位置 | 它补的能力 | 上游已有等价能力时 |
|---|---|---|---|
| Go 传输错误分类补丁 | `patches/@oh-my-pi__pi-ai@*.patch`（`src/error/flags.ts`） | Go relay 的 `read tcp …` 等归为可重试 | 删除补丁与 `patchedDependencies` 条目，`host/src/provider-transport-errors.test.ts` 改为断言上游行为 |
| turn-recovery 传输类 | `patches/@oh-my-pi__pi-coding-agent@*.patch`（`src/session/turn-recovery.ts`） | 已提交文本后中断可续跑 | 同上；上游有就删 |
| 跨会话写保护 | `host/src/write-guard.ts`，经 `session-activate.ts` 的 inline extension 注入 | 防两个会话互相覆盖写 | 上游若提供 stale-write 守卫，删除扩展与 `write-guard` 场景，改用上游并保留行为测试 |
| 上游压缩采纳 | `host/src/upstream-compaction.ts`，inline extension | 端点自行压缩时采纳其摘要，避免下一轮重发超长历史 | 上游若处理该返回，删除扩展与 `upstream-compaction*` 场景 |
| 自定义工具 | `host/src/tools.ts`，`customTools` | `workspace_terminal`（桌面 pty）、`Browser` / `BrowserPreview`（桌面子 webview） | 上游若提供宿主可注入的后端/工具覆盖，优先用上游 seam；同名但不同物的工具不能替代，保留桥接 |
| 标题提示词 | `session-activate.ts` 的 `titleSystemPrompt` | 让引擎用用户语言命名 | 上游若支持语言/标题指令配置，删除覆盖 |
| 技能种子 | `host/src/skill-creator.ts`、`plugin-creator.ts`、`native-skill.ts` | 内置 `skill-creator` / `plugin-creator` 技能 | 上游若自带同名技能，停止 seed，并把名字加进 `legacy-skills.ts` 的退役列表 |
| goal 续跑覆盖 | `session-activate.ts` 的 `goalSettings.continuationModes.override` | 桌面前端也获得自动续跑 | 上游若原生覆盖桌面/RPC 形态，删除 override |
| 手抄目录 | `host/src/constants.ts` 的 `PLUGIN_MCP/LSP/DAP_FILENAMES` 等 | 同意门按引擎真实文件名探测 | 重读新版 `src/discovery/omp-plugins.ts`、`src/lsp/config.ts`、`src/dap/config.ts`；变了就同步 `engine-contract.ts` 与 plugins smoke |
| 前端输出兜底 | `src/src/home/reasoning-echo.ts`、`tool-call-markup.ts`、`code-ranges.ts` 等 | 解析旧引擎漏出的 reasoning / 工具调用标记 | 上游改结构化输出后，删除兜底与对应测试；否则继续适配 |

判定顺序（逐项）：

1. 写清它补的能力，以及“上游具备”必须长什么样。
2. 在新安装树里找等价实现，确认接口是宿主可用的公开面，不是内部未导出细节。
3. 有 → 删除注入、测试/场景、相关声明与文案；写一条 `notes/implemented/simplification/…`。绝不两套并存。
4. 没有 → 保留并按新 API 适配，让它有可执行的验证（单测或 smoke 场景）。
5. 结论写进交付说明：kept / removed + 证据文件或上游路径。

补丁重做：用 `pnpm patch <pkg>@<NEW>` 编辑后 `pnpm patch-commit <临时目录>` 重新生成，确认 `patches/` 文件名与 `pnpm.patchedDependencies` 键一致；绝不手工搬运旧 hunk。

### 7. 新功能入口与输出展示（BeUI）

先判断归属：

- **代理侧行为/工具**：通常不加新 UI；确认现有工具行能显示结果。新结果形状 → 在 `home/ConversationPane.tsx`、`AssistantRow.tsx`、`ToolResult` 的现有行规则里补渲染。
- **用户侧命令/设置/面板**：按层落：协议（`host/src/protocol/**`、`dispatch.ts`、`constants.ts`）→ host → Rust（`src-tauri/**`）→ `src/src/api/**` → `src/src/state/**` → UI。协议增删命令必须同步提升 `PROTOCOL_VERSION`（`host/src/constants.ts` 与 `src-tauri/src/services/runtime/mod.rs` 两处相等）。
- 引擎已能通过现有命令/事件表达的，不加协议、不加第二套状态。

UI 强制规则（`src/rules.md`）：

- 本任务只允许一个组件库：**BeUI**（<https://beui.dev>）。禁止混用图标、圆角、动效、字体、配色体系。
- 先复用 `src/src/components/agents/**`、`src/src/components/motion/**` 的已有适配件；新组件从 BeUI 对应角色取，只取需要的部分，保留文件头 `// beui.dev/<path>` 出处注释，用 `cn()` 与全局 Tailwind token 适配。
- 间距、颜色、圆角、字号、阴影只用 `src/src/index.css` 的全局变量；没有精确值时用最近值，不写死新值。
- 新文案走 `Localized<T>` + `useCopy`，中文只放在对应 `*Copy.ts`。
- 入口用现有机制：菜单 `home/MenuBar.tsx` 的 `TOOL_MENU_ENTRIES`，斜杠命令走 `SessionRuntimeState.commands`，设置走 `settings/**` + `state/resource.ts`，右栏 tab 走 `state/panel-store.ts`；不新建导航或注册表。
- 单文件 ≤1000 行；无 `any` / `@ts-ignore` / `@ts-expect-error`；无 mock 数据。
- 导入前查许可证、框架版本、可访问性、响应式；只取本任务需要的部分。

### 8. 重建与旧数据验证

按改动层重建（完整规则见 `rules.md#artifact-rebuild`）：

```bash
pnpm host:install              # host/src/** 或 SDK 升级：写 host/dist 与 src-tauri/binaries，自校验 sha256
pnpm --filter src build        # src/src/** 改动
pnpm tauri:build --no-bundle   # src-tauri/** 改动或需嵌入新前端；先按 profile 关闭占用实例
```

- 只关正在重建 profile 的实例，按 `ExecutablePath`；本会话祖先实例交给用户。
- `pnpm host:install` 同时写 `host/dist/bundle/` 与 `src-tauri/binaries/bundle/`，逐文件校验 sha256；没有编译后的 `omp-host.exe`，也不往 `target/` 手工复制任何东西。
- 两份 bundle（`host/dist/bundle/`、`src-tauri/binaries/bundle/`）的 `manifest.json` 必须 `protocol` 一致、每个 `files[]` 的 `sha256`/`bytes` 一致，且 `sdkVersion` = 新 pin（`rules.md#artifact-rebuild`）。
- 前端嵌入校验：`grep -aoE "assets/main-[A-Za-z0-9_-]+\.js" src-tauri/target/release/omp_desktop.exe | sort -u` 必须等于 `src/dist/index.html` 里的名字；不一致就 `touch src-tauri/build.rs` 后重建。

**旧数据 + 新引擎**（`rules.md#engine-upgrade-and-distribution` 的必跑路径）：

1. 取升级前的会话文件（第 1 节留下的 `host/.dev-data/data/host/agent/sessions/**/*.jsonl`）。
2. 新宿主起来后：handshake → `session_list` → `session_open`（带 `sessionFile`）→ `session_prompt` 一轮（mock provider 或真实 provider）。
3. 断言：握手 `sdkVersion` = 新 pin、列表能读到旧会话、旧消息可翻页、prompt 得到 `message_update` 与 `agent_end`。
4. 这条路径不能只靠 smoke：smoke 的 fixture 是当前版本现写的，必须显式打开旧文件。

### 9. 门禁

```bash
cd host && bun test
cd host && bun run scripts/seam-check.ts
cd host && bun run scripts/isolation.ts before
cd host && OMP_DESKTOP_SMOKE_SCENARIOS=<相关场景，逗号分隔> bun run scripts/smoke.ts
cd host && bun run scripts/isolation.ts after
cd host && bun run scripts/isolation.ts diff
cd host && bun run scripts/artifacts.ts
pnpm --filter src typecheck
pnpm --filter src lint
pnpm --filter src test
pnpm --filter src build
pnpm check:repo
git diff --check
```

- 保留或改动了注入时，跑对应场景：`write-guard`、`upstream-compaction`、`upstream-compaction-paused`、`rewind`、`vibe`、`stop-turn`（这些是 mock 场景，需在 `OMP_DESKTOP_SMOKE_SCENARIOS` 显式列名）。
- Rust 有改动：`cargo fmt --check`、`cargo check`、`cargo test --lib`；本会话先按 `AGENTS.md#running-dev-from-an-app-hosted-session` 准备 MSVC wrapper，再 `cmd /c "%TEMP%\omp-cargo.bat" test --lib`。
- `check:repo` 的 notices 因新版本许可证清单变化而红时：`pnpm notices:generate` 后重跑。
- 新 UI 必须在真实窗口验证；本会话托管在 dev 实例时，重启交给用户，绝不按名字杀进程。

### 10. 记录与交付

- 写 note：`notes/implemented/{architecture|process|simplification}/yyyy-mm-dd-sdk-<NEW>.md`，记旧/新版本、每个注入的 kept/removed 与证据、新功能入口、跑过与没跑过的检查、剩余风险。格式由 `pnpm check:notes` 校验。
- 补丁被删除时，更新 `AGENTS.md#engine-patches` 对应句子（只保留仍成立的规则），再跑 `pnpm check:docs`、`check:links`。
- 交付说明必须写：版本轴（SDK_VERSION 旧→新、`bundle/manifest.json`）、用户升级路径、既有数据是否保留、重建了哪些层、没跑哪些检查、剩余风险、分支名。
- 不提交、不推送；等用户下一步。

## 失败判据（遇到就停，不绕过）

- `pnpm install` 无法应用补丁 → 补丁过期，按新版本重做。
- `typecheck` 在 `engine-contract.ts` 报新键 → 按策略回答，不用 `as` / `any` 压掉。
- `seam-check` 报新导入 → 收敛进 `sdk.ts`，不扩白名单。
- smoke 握手 `sdkVersion` 不匹配 → 宿主产物是旧的，重新 `pnpm host:install`。
- 两份 bundle 的 manifest 或文件摘要不一致 → 重跑 `pnpm host:install`，不手改 manifest。
- 旧会话打不开或 prompt 失败 → 先判上游格式/迁移问题，不删旧文件、不静默跳过。

## 完成判据

版本 pin、补丁、锁文件、产物、`sdkVersion` 全部一致；每个注入有 kept/removed 结论；新功能有入口或输出展示且用 BeUI；旧数据路径通过；门禁通过；note 与交付说明齐全。
