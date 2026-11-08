# panel-basic（模板）

Omp Desktop 自带的**面板插件模板**：一个只含桌面清单的插件包 —— 一个 `panels[]` 面板窗口，
页面里有一个按钮调用宿主 bridge 的 `ready`。它是最小的"桌面侧插件"，不含任何引擎侧代码。

- 模板本身不是插件，是**脚手架的起点**：复制出去改，或直接用它试一次安装流程。
- 这份包不跑代码、不出网、不读文件：清单里只有 `ui.panel`。

## 改哪里

| 位置 | 说明 |
| --- | --- |
| `package.json` → `name` / `version` | 插件身份与版本（`name` 必须是合法包名：字母数字开头，只含 `. _ -`）。 |
| `package.json` → `omp.name` / `omp.description` | 引擎与界面用的显示名、简介（缺省回退包名）。 |
| `package.json` → `omp.desktop.i18n` | 中英显示文案（`zh` 是中文界面读到的），`safetyNotes` 出现在同意界面。 |
| `package.json` → `omp.desktop.panels[0]` | `id`（插件内唯一，`^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`）、`title`、`width`/`height`（320–2048 / 240–1600）、`resizable`。 |
| `package.json` → `omp.desktop.permissions` | 用到什么声明什么：面板是 `ui.panel`；未知权限名会让整块桌面清单被拒。 |
| `desktop/panel/index.html` | 面板页面。必须自包含（无外部资源），可用的宿主 API 只有 `fetch('/__bridge…')`。 |

页面约束（宿主强制，见规范 §7.2）：CSP 为 `default-src 'none'; script-src 'self' 'unsafe-inline'; …;
connect-src 'self'`，所以内联脚本/样式可以，任何出网请求不行；bridge 方法是一个封闭集合 ——
`ready`、`close`（仅面板窗口）、`plugin.dataDir`，以及 `fs.read`、`fs.stat`、`fs.list`、`fs.glob`、
`fs.readRange`、`fs.openDefault`、`fs.reveal`、`net.fetch`、`clipboard.read`、`clipboard.write`、
`session.list`/`get`/`messages`/`rename`/`delete`、
`browser.navigate`/`reveal`/`snapshot`/`screenshot`/`evaluate`/`console`/`action`。
`fs.read`/`fs.stat`/`fs.list`/`fs.glob`/`fs.readRange` 共用 `fs.read` 权限，
`fs.openDefault`/`fs.reveal`/`session.*`/`browser.*`/`net.fetch`/`clipboard.*` 各自要同名的那个
（`session.rename`/`session.delete` 要 `session.write`），未声明即 403；`plugin.dataDir` 不要权限，
GET 一次就拿到本插件唯一可自由写入的目录（首次调用时创建）。`fs.openDefault` 会把路径交给系统默认
程序，可执行扩展名与凭据类文件名一律拒绝；`fs.reveal` 只在文件管理器里指出该路径。

## 怎么装

1. **从文件安装（推荐）**：把本目录**内容**（`package.json` 所在层）压成一个 zip，后缀改成
   `.omp.zip`（兼容 `.piplug`），然后在应用里打开**设置 → 插件 → 添加 ▾ → 从文件安装…** 选中它。
   包会被解压到应用数据根并走引擎的市场通道安装，免 Developer Mode。
2. **开发模式（link）**：用引擎自己的命令 `omp plugin link <本目录>` 直接把目录链进插件根，
   改完文件重启会话即可（Windows 未开启开发者模式时 symlink 会失败）。
3. 装好后在插件详情页**启用**（面板权限是低风险，启用即授予），再打开该插件的面板。

## 下一步可以做什么

- 加一个 `views[]`（`ui.view`）或 `sidebarTabs[]`（`ui.tab`）页面；
- 加 `fs.read` + `fs.read.scope` 或 `net.fetch` + `net.domains`，然后在页面里用 bridge 的
  对应方法（POST 通道），注意 scope/白名单缺省即"什么都拿不到"；
- 要遍历目录用 `fs.list`（`fs.read` 权限），要知道某个路径是什么用 `fs.stat`——两个都允许落在
  目录上；`fs.read` 本身只读文件；要找一批文件用 `fs.glob`（同样 `fs.read` 权限，模式语言与
  `fs.read.scope` 相同：段内 `*`、整段 `**`），要读大文件的一段用 `fs.readRange`（offset/length，
  返回 base64）；
- 要落盘的东西（缓存、数据库、下载下来的文件）放到 `fetch('/__bridge?m=plugin.dataDir')` 返回的
  目录里：它是本插件独占的，升级不会被清掉；
- 页面里最常用的第二件事是关掉窗口：`fetch('/__bridge?m=close')`。
