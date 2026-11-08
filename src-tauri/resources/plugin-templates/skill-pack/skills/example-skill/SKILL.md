---
name: example-skill
description: Use when the user asks how an omp plugin skill is shaped, wants a worked SKILL.md example to copy, or is authoring a skill for a plugin package. Replace the name, the description and the body with your own skill.
---

# Example Skill

这是模板自带的技能，内容是**它自己的写法**：把它当骨架，把 `name`、`description` 与正文换成你自己的技能。

## 形状（引擎惯例）

- 位置：`skills/<技能名>/SKILL.md`，**只发现一层** —— `skills/a/b/SKILL.md` 不会被发现；
- frontmatter：`name`（缺省用目录名）、`description`（**插件来源的技能必须写**，它是模型判断"什么时候用这个技能"的唯一依据）；
- 正文：模型在需要时按 `skill://` 读到的内容 —— 写成可执行的步骤，而不是介绍。

## 写自己的技能

1. **先写触发条件**：一句话说清"什么时候该用"，放进 `description`（模型只看得到 name + description）。
2. **再写步骤**：3–7 步，每步是可执行动作（读哪个文件、跑什么检查、输出什么），不要写背景知识。
3. **写清边界**：只读还是要改文件、有没有前置条件、失败时怎么办。
4. **改目录名**：把 `skills/example-skill/` 改成技能名；`NAME` 短、小写、连字符分隔即可（技能名是它被引用时的名字）。
5. **验证**：装好后问一句触发它的话，看模型是否按 `skill://example-skill` 去读这个文件。

## 边界

- 技能是**声明式内容**，不运行代码（要跑代码就用 `tools/` 或 `omp.extensions`）。
- 技能名与其它来源（用户自己的技能、其它插件）共用一个命名空间，撞名时按引擎的来源优先级决定谁生效。
