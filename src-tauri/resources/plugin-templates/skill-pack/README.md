# skill-pack（模板）

Omp Desktop 自带的**纯声明式插件模板**：一个技能（`skills/<名字>/SKILL.md`）和一个斜杠命令
（`commands/<名字>.md`），`package.json` 里只声明 `omp.name` / `omp.description`。

- 这份包里**没有代码**：技能与命令都是引擎装载的 Markdown，不进 agent 进程、不跑脚本。
- 因为没有代码，安装后**不需要同意确认**：直接在插件详情页启用即可（同意闸门只拦会运行代码的插件）。

## 改哪里

| 位置 | 说明 |
| --- | --- |
| `package.json` → `name` / `version` / `description` | 包身份（`name` 必须是合法 name segment：字母数字开头，只含 `. _ -`）与版本。 |
| `package.json` → `omp.name` / `omp.description` | 显示名与简介（缺省回退包名）。 |
| `skills/example-skill/` → 目录名 | 技能名（frontmatter 里的 `name` 缺省取目录名）。**只发现一层**：`skills/<技能名>/SKILL.md`。 |
| `skills/example-skill/SKILL.md` → frontmatter | `name` + `description`；**插件来源的技能必须写 `description`**（模型靠它判断何时使用这个技能）。 |
| `skills/example-skill/SKILL.md` → 正文 | 模型按需读取的步骤（`skill://<技能名>`）。 |
| `commands/example-command.md` → 文件名 | 命令名（去掉 `.md`）。 |
| `commands/example-command.md` | frontmatter 的 `description` / `argument-hint` + 正文；正文支持 `$1`、`$ARGUMENTS` 占位符。 |

## 怎么装

1. **从文件安装（推荐）**：把本目录**内容**（`package.json` 所在层）压成 zip，后缀改成
   `.omp.zip`（兼容 `.piplug`），应用里走**设置 → 插件 → 添加 ▾ → 从文件安装…**。
   包会解压到数据根并走引擎的市场通道安装（免 Developer Mode）。
2. **开发模式（link）**：`omp plugin link <本目录>`（引擎命令；Windows 未开启开发者模式时 symlink 会失败）。
3. 装好并启用后：技能出现在模型的可用技能里（问一句触发 `description` 的话即可验证），
   斜杠命令在市场插件里带插件名前缀 —— 也就是 `/skill-pack:example-command`。

## 注意

- 技能与命令都由**引擎**发现自己目录下的内容，桌面只展示"这个插件提供了什么"；
- 技能名、命令名与用户自己的及其它插件的同名项共用一个命名空间，撞名时按引擎的来源优先级决定谁生效；
- 改完文件后要让引擎重新发现（新会话；开发期 link 的话重启会话即可）。
