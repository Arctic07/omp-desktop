/**
 * The skill that turns "new skill" into a guided authoring task.
 *
 * The skills page does not send a creation prompt of its own: clicking *New skill* opens a
 * fresh task and puts a `skill-creator` mention in the composer, so the reader writes the request
 * and the skill supplies the procedure. This build has no such bundled skill, so the desktop seeds
 * one as a **native user skill** — the same level the terminal skill lives at, one level below any
 * plugin, which is what makes `/skill:skill-creator` resolve on a fresh data root.
 *
 * Two properties matter:
 *
 * ① The file follows the build (`native-skill.ts`): a copy nobody edited is refreshed to the recipe
 *   this build ships, and a copy the reader tuned is left exactly as it is - which is the property
 *   that matters here, since this one is a prompt recipe the reader may want to change. Deleting it
 *   re-seeds it on the next start, which is the reset.
 * ② It names both directories the engine's own discovery reads — the user level
 *   (`<agentDir>/skills/<name>/SKILL.md`) and a project's own (`.omp/skills/<name>/SKILL.md`) — and
 *   asks which one before writing, because the destination is the one thing the recipe cannot infer.
 */

import { seedNativeSkill } from './native-skill.ts'

/** The directory name, the frontmatter `name`, and the `/skill:<name>` token: one value. */
export const SKILL_CREATOR_NAME = 'skill-creator'

/** One line, as the engine's `<skills>` listing and the settings page show it. */
export const SKILL_CREATOR_DESCRIPTION =
  '创建或修改技能（SKILL.md），用户级或当前工作区的项目级：先问名字、用途、触发条件与级别，再写到对应目录。不生成插件包；可分发的插件用 plugin-creator。'

const SKILL_CREATOR_BODY = `---
name: ${SKILL_CREATOR_NAME}
description: ${SKILL_CREATOR_DESCRIPTION}
---

# 技能创建器

你负责为本应用的引擎编写**技能**：一个目录、一份 \`SKILL.md\`，级别是用户级或当前工作区的项目级。技能是给未来的自己看的操作手册，不是给用户看的文档。

## 1. 先问清楚，一次只问一个

不要上来就写文件。按顺序问，每个问题给 2–3 个具体建议：

1. **级别**：只给当前工作区用（项目级），还是所有项目都用（用户级）。
2. **名字**：小写 kebab-case，会成为目录名与 frontmatter 的 \`name\`（例如 \`commit-message\`）。
3. **用途**：什么输入 → 什么产出；是固定步骤、写作规范，还是判定规则。
4. **触发条件**：用户会怎么说、涉及哪些文件或工具时才该加载。这句话会进 \`description\`，引擎靠它决定是否加载。

如果用户已经在上一条消息里说清了，就不要重复问；缺什么问什么。

## 2. 写到哪里

- 用户级目录：\`$OMP_DESKTOP_CODING_AGENT_DIR/skills/<name>/\`
- 项目级目录：当前工作区的 \`.omp/skills/<name>/\`
- 文件：\`SKILL.md\`
- \`<name>\` 必须与 frontmatter 的 \`name\` 一致。
- **不要**把用户级技能写进项目目录，也**不要**把项目级技能写进用户目录；**不要**改别的技能，**不要**为了写技能去构建或测试仓库。
- 写完用 \`read\` 读回来确认，然后只告诉用户文件路径和一句话摘要。

## 3. 文件长什么样

\`\`\`markdown
---
name: <name>
description: <一句话：做什么 + 什么时候用>
---

# <标题>

<这类任务必须遵守的规则、步骤、判据。>
\`\`\`

正文要求：

- 先写**什么时候用、什么时候不用**，再写步骤。
- 命令、路径、失败判据要具体；不要写“根据情况处理”这种空话。
- 不复制大段引擎文档；只写这个技能真正需要的那几条。
- 如果技能会改文件或跑命令，写明边界与需要用户确认的动作。

## 4. 边界

- 一次只创建一个技能；用户要修改已有技能时，先 \`read\` 它再改。
- 只写技能，不生成插件包；要可分发的插件（含 \`skills/\`）用 \`plugin-creator\`。
- 项目级技能只写到当前工作区的 \`.omp/skills/\`，用户级技能只写到本应用数据根的 \`skills/\`。
- 用户没说清楚名字时不要猜；先问。
- 不要把用户的密钥、令牌或隐私写进技能。
`

/** Seeds `<agentDir>/skills/skill-creator/SKILL.md` by `native-skill.ts`'s rule: this build's recipe
 *  when the copy there is absent or unedited, and no change when the reader edited it. */
export function seedSkillCreator(agentDir: string): void {
  seedNativeSkill(agentDir, { name: SKILL_CREATOR_NAME, body: SKILL_CREATOR_BODY })
}
