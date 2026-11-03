# 技能

技能（Skill）是一组按需加载的提示词与支持文件。每个技能是一个包含 `SKILL.md` 的子目录：会话启动时只将技能名与简短描述放入系统提示词，真正用到时才读取 `SKILL.md` 正文。

## 技能放在哪

Nocturne 按以下顺序扫描技能目录，同名技能以**项目级优先于用户级**为准：

1. **用户级（「用户」分组）**：
   - `~/.nocturne/skills/<name>/SKILL.md`
   - `~/.agents/skills/<name>/SKILL.md`（兼容目录，默认开启）
   - `~/.claude/skills/<name>/SKILL.md`（兼容目录，默认开启）
   - `config.json` 中 `skills.extraDirs` 指定的附加目录
2. **项目级（「项目」分组，从当前工作目录向工作区根目录逐级查找）**：
   - `.nocturne/skills/<name>/SKILL.md`
   - `.agents/skills/<name>/SKILL.md`
   - `.claude/skills/<name>/SKILL.md`

如果不需要扫描 `.agents/skills` 或 `.claude/skills`，可在 `config.json` 中将 `skills.sources.agents` 或 `skills.sources.claude` 设为 `false`。

### 从本地文件夹导入技能

1. 在桌面端打开「设置」→「技能」，点击右上角「导入技能…」。
2. 在弹窗的「导入到」中选择「用户技能」或「当前工作区」，点击「选择文件夹…」选中包含 `SKILL.md` 的文件夹（或包含多个技能子目录的上级文件夹）。
3. 预检列表会显示每个候选技能的大小与状态；若目标目录已存在同名技能，可在「改名」、「覆盖」、「跳过」之间切换。确认后点击底部的导入按钮完成复制。

## `SKILL.md` 格式

`SKILL.md` 顶部必须有闭合的 YAML 前言（`---`），常用字段如下：

```markdown
---
name: code-review
description: 审查当前分支改动并列出潜在缺陷
when_to_use: 当用户要求做代码审查或检查 PR 时使用
argument-hint: "[文件或分支]"
user-invocable: true
disable-model-invocation: false
---

请按以下步骤审查代码（参数：$ARGUMENTS）：
1. ...
```

- `name`：技能名称（省略时取目录名）。
- `description` 与 `when_to_use`：告诉模型何时调用该技能。
- `argument-hint`：斜杠命令补全时显示的参数提示。
- `user-invocable`：设为 `false` 时不在 `/` 补全菜单中显示，仅供模型调用（显示为「只限模型」）。
- `disable-model-invocation`：设为 `true` 时不注入模型目录，仅允许用户通过 `/<name>` 手动触发（显示为「只限用户」）。
- 正文支持 `$ARGUMENTS` 占位符替换传入参数，变量 `NOCTURNE_SKILL_DIR`、`CLAUDE_SKILL_DIR`、`CLAUDE_PROJECT_DIR` 和 `CLAUDE_SESSION_ID` 会分别替换为技能目录真实路径、工作区根目录和当前会话 ID。

技能正文只提供操作指引，**不会改变当前会话的权限、模型或思考档位**。`SKILL.md` 中若包含 `allowed-tools`、`model`、`effort`、`hooks` 等外部字段，Nocturne 会安全忽略并在技能详情页列出原因。

## 怎么调用技能

- **手动调用（`/<name>`）**：在输入框输入 `/` 弹出补全菜单（带「技能」标签），选择技能或直接输入 `/<name>` 加参数发送。
- **模型自动调用**：调用范围包含模型的已启用技能，模型会根据描述自行调用内置 `skill` 工具加载正文。
- **启用或停用**：在「设置」→「技能」选中技能后，可切换右上角的启用开关（对应配置项 `skills.disabled`），或点击「在资源管理器中打开 ↗」查看技能目录。

## 诊断与常见问题排查

在「设置」→「技能」页面（终端输入 `/skills`）可以查看全部已发现技能与诊断信息：

- **前言解析失败**：当 `SKILL.md` 缺少 YAML 前言、前言未闭合或字段类型错误时，左列底部会显示折叠条，展开可查看具体文件路径、行号与错误原因。
- **缺少说明或命令冲突**：未写 `description` 时详情页会提示「缺少说明，模型看不到这个技能」；与内置命令（如 `clear`、`compact`）重名时会提示「与内置命令重名，斜杠不能调用」。
- **同名覆盖**：列表只显示实际生效的技能；低优先级目录中的同名副本不列出，其路径显示在生效技能详情的「同名」一行。
- **不生效写法说明**：当技能包含外部工具专有字段时，详情页会列出「写法」与「在 Nocturne 里」的处理方式表格。
- **模型目录预算**：左列底部实时显示「模型目录预算」（默认上限为上下文窗口的 2% 且不超过 8,000 tokens）以及「完整说明」、「只显示名字」、「已停用」的技能数量。
