# 技能

## 技能放在哪里

每个技能是一个包含 `SKILL.md` 文件的文件夹。Nocturne 会按以下优先级从高到低扫描技能目录（同名技能以高优先级为准）：

| 作用域 | 目录路径 | 用途 |
| --- | --- | --- |
| 项目级 | `<workspace>/.nocturne/skills/<name>/SKILL.md` | 当前仓库专用的工作流与规范 |
| 项目通用 | `<workspace>/.agents/skills/<name>/SKILL.md` | 跨 Agent 共享的项目技能目录 |
| 用户级 | `~/.nocturne/skills/<name>/SKILL.md` | 本机所有项目通用的个人技能 |
| 用户通用 | `~/.agents/skills/<name>/SKILL.md` | 跨 Agent 共享的用户技能目录 |
| 外部导入 | `~/.nocturne/skills-imported/<tool>/<name>/SKILL.md` | 从外部工具导入的技能 |

### `SKILL.md` 格式

`SKILL.md` 顶部使用 YAML frontmatter 声明名称和触发说明，下方写具体指令正文：

```markdown
---
name: release-check
description: 发布版本前核对变更日志、版本号并运行全量验证。当用户要求发版或打标签时使用。
argumentHint: "[版本号]"
---

请按以下步骤执行发布前检查：
1. 核对 `package.json` 与 `CHANGELOG.md` 的版本是否一致；
2. 运行 `pnpm typecheck` 与 `pnpm test`。
```

常用 frontmatter 字段：

- `name`（可选，缺省取目录名）：技能标识名，对应 `/name` 调用命令。
- `description`（必填）：告诉模型什么场景下应该调用该技能。
- `whenToUse`（可选）：补充触发条件说明。
- `argumentHint`（可选）：输入框补全时显示的参数提示。
- `userInvocable`（可选，默认 `true`）：是否允许用户通过 `/name` 手动调用。
- `disableModelInvocation`（可选，默认 `false`）：设为 `true` 时禁止模型自动调用，只能由用户手动触发。

## 怎么调用

- **手动调用**：在输入框输入 `/<技能名> [附加参数]`（输入 `/` 时会自动弹出技能补全列表），发送后该技能的正文会注入本轮对话。
- **模型自动调用**：未设置 `disableModelInvocation: true` 的技能，其名称与 `description` 会出现在系统提示词目录中，模型遇到匹配任务时会自动调用内置 `skill` 工具读取完整正文。

## 导入与诊断

- **导入外部技能**：在桌面端打开「设置 → 技能」点击「导入外部技能」，或在终端运行 `nocturne --import-skills`，可自动扫描本机 Claude Code（`~/.claude/skills`）、Codex（`~/.codex/skills`）、Cursor（`~/.cursor/skills`）、Windsurf（`~/.codeium/windsurf/skills`）和 OpenCode（`~/.config/opencode/skills`）中的技能并导入到 `~/.nocturne/skills-imported/`。
- **查看诊断**：如果某个技能未能加载（例如缺少 `SKILL.md`、YAML 格式错误、缺少 `description` 或被同名高优先级技能覆盖），桌面端「设置 → 技能」顶部的诊断提示区域以及终端 TUI 的 `/skills` 命令都会列出具体路径与原因。
