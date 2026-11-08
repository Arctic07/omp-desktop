# agent-tool-basic（模板）

Omp Desktop 自带的**引擎侧插件模板**：一个扩展模块（`omp.extensions`）、一个自定义工具
（引擎惯例目录 `tools/`），外加一个桌面设置页（`ui.settings` + `settingsDestinations[]`）
和一个 `omp.settings` schema 示例。

- 引擎侧的两个模块都在 **agent 进程内**运行、与 agent 同权 —— 因此清单里声明了
  `agent.extension`：安装后插件保持**禁用**，直到你在插件详情页确认并启用（"安装不是同意"）。
- 桌面侧的设置页只是插件详情「设置」块里的一个子页签（停靠 iframe，无宿主 API）。

## 改哪里

| 位置 | 说明 |
| --- | --- |
| `package.json` → `name` / `version` | 包名（合法 name segment：字母数字开头，只含 `. _ -`）与版本；版本是升级比较与缓存键的唯一来源。 |
| `package.json` → `omp.extensions` | 扩展模块入口，相对插件根的路径（可以写多个）。 |
| `package.json` → `omp.settings` | 设置 schema（`string` / `number` / `boolean` / `enum`），宿主据此渲染表单；值是引擎的，桌面不另存。 |
| `package.json` → `omp.desktop.permissions` | `agent.extension`（在 agent 进程跑代码）与 `ui.settings`（设置页）。少声明 = 不生效；多声明不存在的名字 = 整块被拒。 |
| `index.ts` | 扩展模块：装载期只做注册（`pi.on` / `pi.registerTool` / `pi.registerCommand`），斜杠命令名记得改名避免撞名。 |
| `tools/greet.ts` | 自定义工具模块（默认导出工厂，返回 `{ name, label, description, parameters, execute }`）；工具名要全局唯一。 |
| `desktop/settings/index.html` | 设置页；必须自包含，只能 `fetch('/__bridge…')`。 |

## 怎么装

1. **从文件安装（推荐）**：把本目录**内容**（`package.json` 所在层）压成 zip，后缀改成
   `.omp.zip`（兼容 `.piplug`），应用里走**设置 → 插件 → 添加 ▾ → 从文件安装…**。
   包会解压到数据根并走引擎的市场通道安装（免 Developer Mode）。
2. **开发模式（link）**：`omp plugin link <本目录>`（引擎命令；Windows 未开启开发者模式时 symlink 会失败）。
3. 装好之后：插件会处于**未确认**状态 —— 在插件详情页确认（"允许该插件在 agent 进程内运行代码"）
   并启用，然后重开会话让扩展模块装载；之后模型可以调用 `greet` 工具，用户可以用 `/hello`。

## 注意

- 扩展模块与工具模块是**直接 import 的 TS**：不打包、不需要 `node_modules`、不能用 npm 依赖，
  也不能 `import` `@oh-my-pi/pi-coding-agent`（只有类型导入可以，装载时被擦除）。
- 工具/命令名与内置工具、其它插件共用命名空间，冲突即失败或遮蔽。
- 改完插件文件后，已打开的会话里已装载的旧代码要到**新建/重开会话**才完全替换。
- v1 插件代码读不到自己的设置值（没有读取通道），设置只影响宿主渲染的表单与引擎侧的读取方。
