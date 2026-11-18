# ADR-0096：Hook 上下文注入与插件兼容设计

- 状态：已接受
- 日期：2026-11-18
- 相关：[architecture/hooks.md](../architecture/hooks.md)、[architecture/context.md](../architecture/context.md)、[architecture/subagent.md](../architecture/subagent.md)、[protocols/events.md](../protocols/events.md)、[protocols/view.md](../protocols/view.md)、[ADR-0012](ADR-0012-hooks.md)

## 背景

ADR-0012 与 [hooks.md](../architecture/hooks.md) 将 Hook 定位为控制流与工具反馈机制，明确不为 Hook 新增持久事件，且暂不设计上下文注入。

为了兼容「在会话开始、子代理启动与用户提交提示词时向模型注入规则/上下文」的工作流（并作为后续兼容 Claude Code / Codex 已安装插件的前置能力），需要分两期演进：

1. **第一期（本轮实现）**：让 Hook 能够向模型上下文注入有界文本，新增 `UserPromptSubmit` 与 `SubagentStart` 事件点，扩展 `SessionStart`（携带 `source` 与压缩后重跑），并以持久事件 `hook.context` 保证重放可重现。
2. **第二期（本轮只设计，不实现）**：只读发现用户本机已安装的 Claude Code / Codex 插件，经由受控白名单与用户显式启用后接入第一期的生命周期 Hook 与技能目录。

---

## 决定

### 第一部分：Hook 上下文注入（第一期，已实现）

#### 1. 事件点与输入/输出契约

| 点位 | 触发时机 | stdin 新增 | stdout 允许 |
|---|---|---|---|
| `SessionStart`（修订） | 会话新建（`startup`）、恢复（`resume`）、分叉首次打开（`fork`）后；L2 摘要（自动或手动）成功后、下一次模型请求前（`compact`） | `source: "startup" \| "resume" \| "fork" \| "compact"`（保留原有 `resumed: boolean`） | `{ additionalContext?: string }` |
| `UserPromptSubmit`（新增） | `message.user` 写入后、`TurnStart` 之前；只在本轮由用户输入发起时触发 | `turnId`、`text`（用户原文 `submit.text`，不含技能渲染块和文件块）、`skill?: { name, arguments? }` | `{ block?: boolean, reason?: string, additionalContext?: string }` |
| `SubagentStart`（新增） | 子会话的 `SessionStart` 之后、第一个 Turn 之前 | `agentType`（档位名；无档位或 `default` 为 `"general"`；自定义工具集为 `"custom"`） | `{ additionalContext?: string }` |

触发与作用范围：

- 以下消息**不**触发 `UserPromptSubmit`：
  - 带 `subagent` / `backgroundShell` / `ensemble` / `ensembleQuietReminder` 的非用户输入消息；
  - `workMode.source === "runtime"` 的运行时消息；
  - `steer: true`（运行中插话）的消息；
  - 子会话内的消息（`meta.parent !== undefined`）。
- `UserPromptSubmit` 的 `block: true` 与 `TurnStart` 同语义（Turn 以 `error(code: "hook_blocked")` 结算）；被拦截时，同批输出中的 `additionalContext` 一并丢弃。
- 外部 agent（ACP）不触发 `SubagentStart`。子会话里 `SessionStart` 照旧触发。
- 失败、超时、非零退出：不产生上下文，只写诊断并降级（`hook_failed`），不阻断会话。

#### 2. 持久事件 `hook.context` 与投影

- 新增会话级持久事件 `hook.context`：
  ```ts
  {
    point: "SessionStart" | "SubagentStart" | "UserPromptSubmit",
    source?: string,
    entries: { hook: string; text: string; truncated?: number }[],
  }
  ```
  - `hook` 沿用 `permission.resolved.rule` 的命名形式：`hook <点位> <command>`；
  - `UserPromptSubmit` 的事件携带 `turnId`；
  - 不提升 `formatVersion`：旧版 Runtime 遇到未知持久事件拒绝恢复（`session_log_newer`），旧只读客户端与 `SessionView` 忽略该事件（与 `events.md` 第 8 节一致）。
- **`SessionStart` / `SubagentStart`（会话快照）**：
  - 有效历史中最近一条对应点位的 `hook.context` 就是当前快照。
  - Context Builder 将其作为新的 system section `hookContext` 注入，位于技能目录（`skills`）之后、环境信息（`environment`）之前；计入 `ContextReport` 的 `hooks` 段（桌面端 `apps/desktop/src/context-panel.tsx` 的 `SECTIONS` 显式补录 `hooks: { label: "Hook", color: "var(--a-muted)" }`，其余界面不变）。
  - 本次结果与有效历史当前快照逐字相同时不写事件；原来有内容、本次全部执行成功但结果为空时写 `entries: []` 清空。快照只在打开、恢复、分叉与 L2 摘要后变化，其余时候 system 前缀不变；回退和分叉按有效事件前缀重建。
- **`UserPromptSubmit`（历史 note）**：
  - 在 `session/fold.ts` 中折叠为一条 `note`，落在该 `message.user` 之后；沿用既有 `note` 的投影、L1 不修剪、L2 纳入摘要与工具结果邻接规则，计入 `ContextReport.history.breakdown.user`。

#### 3. 文本格式与上限

- 注入文字使用英文标签包裹：
  - system section `hookContext` 以单行英文前言开头：`The following context was provided by user-configured hooks at session start:`；
  - 每条条目以 `<hook-context point="…">\n…\n</hook-context>` 包裹。
- 单条 `text` 上限 `10,000` 字符（`MAX_HOOK_CONTEXT_ENTRY_CHARS`），超出截断并在 `truncated` 记被截掉的字符数。
- 同一事件全部条目合计上限 `30,000` 字符（`MAX_HOOK_CONTEXT_TOTAL_CHARS`），超出的后续条目丢弃并记录 `hook.context_dropped` 诊断。

#### 4. 不变量

1. 未配置任何 Hook，或点位无匹配条目时：不写 `hook.context`；事件序列、模型请求与 `ContextReport` 与改动前逐项一致。
2. 同一份日志重放两次，上下文构建结果逐字节相同。
3. 同一 Turn 相邻 Step 的请求前缀不因 `hookContext` 改变（L2 摘要重建缓存后同样保持稳定）。

#### 5. 文档修订范围

本部分修订了 [hooks.md](../architecture/hooks.md) 第 1、2、3（原第 86 行）、7、8 节，[context.md](../architecture/context.md) 第 3 节与第 6 节（压缩后重跑 `SessionStart`），[events.md](../protocols/events.md)、[subagent.md](../architecture/subagent.md) 第 10 节、[view.md](../protocols/view.md) 与 [site-docs/config.md](../../site-docs/config.md)。

---

### 第二部分：读取已装插件（第二期设计，本轮不实现）

#### 1. 发现（只读）

- **Codex**：读取 `~/.codex/config.toml` 中 `[plugins."<name>@<marketplace>"] enabled = true`。插件目录位于 `~/.codex/plugins/cache/<marketplace>/<name>/<version>/`，清单为 `.codex-plugin/plugin.json`（含 `skills`、`hooks` 字段；`hooks` 缺省为 `hooks/hooks.json`；路径必须以 `./` 开头且不越出插件根目录）。
- **Claude Code**：读取 `~/.claude/plugins/installed_plugins.json` 中的 `installPath`，结合 `~/.claude/settings.json` 中的 `enabledPlugins`；清单为 `.claude-plugin/plugin.json`。
- **未决事项（实现前必查）**：Codex 如何从多个版本目录中选定生效版本**尚未确认**（本机 5.3.2 目录缺少 `.codex-plugin`，且同级存在 `plugin-install-*` 目录）。第二期实现前必须先查证 Codex 源码确认版本选择规则，不得自行臆定。

#### 2. 只兼容上下文注入类生命周期事件

- **兼容点位**：`SessionStart`、`UserPromptSubmit`、`SubagentStart`、`SessionEnd`。
- **明确不支持**：插件里的 `PreToolUse`、`PermissionRequest`、`PostToolUse` 等工具级拦截/审批点位。原因是这些插件格式允许 `allow` 并按 Claude 工具名做正则匹配，接入会绕过 Nocturne 权限层与工具主体模型。
- **避免重复注入**：Claude 格式的 `SessionStart` 只在父会话触发，子会话只走 `SubagentStart`。

#### 3. 格式翻译

- 配置条目 `{ matcher, hooks: [{ type: "command", command, timeout }] }` 翻译为内部 `HookEntry`。
- `command` 是 shell 字符串：Windows 上优先使用 Git Bash，没有时回退 PowerShell；其他平台使用 `sh -c`（遵循官方插件 Hook 文档约定）。
- `${PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}` / `${PLUGIN_DATA}` / `${CLAUDE_PLUGIN_DATA}` 在命令字符串中展开替换，同时也作为环境变量注入。
- `timeout` 单位为秒，转换为毫秒并夹到 `60_000` 以内。
- `matcher` 按官方文档解析：仅含字母、数字、`_`、`-`、空格、`,`、`|` 时按精确列表匹配，否则按正则匹配；`SessionStart` 匹配 `source`，`SubagentStart` 匹配 `agent_type`。
- stdin 字段映射为宿主约定字段：`hook_event_name`、`session_id`、`cwd`、`source`、`prompt`、`agent_type`、`turn_id`（技能调用时 `prompt` 为 `/<name> <arguments>`）。
- stdout 翻译：
  - 纯文本 stdout 当作上下文；
  - `hookSpecificOutput.additionalContext` 当作上下文；
  - `decision: "block"` 加 `reason` 表示拦截；
  - `UserPromptSubmit` 退出码 `2` 表示拦截，原因取 stderr；
  - 其余字段忽略。

#### 4. 环境变量与数据隔离

- 插件 Hook 仅获得白名单环境变量（与 [mcp.md](../architecture/mcp.md) 第 3 节出于同一安全原因，防止第三方插件默认读取用户 Provider 凭据），另行注入以模拟插件安装时所在宿主的约定：
  - `PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT`
  - `PLUGIN_DATA` / `CLAUDE_PLUGIN_DATA`，指向 `<NOCTURNE_HOME>/plugins/data/<name>-<marketplace>`
  - `CLAUDE_PROJECT_DIR`
- 不读写 `~/.codex`、`~/.claude` 下的运行时数据目录。

#### 5. 启用与信任

- 已发现的插件在 Nocturne 中默认**不启用**，由用户在桌面端「设置 › 插件」逐个显式打开。
- 启用时记录 Hook 定义及插件目录内被引用脚本的内容哈希；哈希变化（包括插件升级）即视为未信任，需用户重新确认后才生效。
- 启用与信任状态存储在 `<NOCTURNE_HOME>` 下的独立文件中，不写进用户手写的 `config.json`。

#### 6. 技能接入

- 已启用插件的 `skills` 目录作为新的技能发现来源层接入技能目录构建，按 [skills.md](../architecture/skills.md) 的真实路径规则去重。

#### 7. 明确不做

- 不支持 `commands/`（Codex `.toml` / Claude `.md` 自定义斜杠命令）；
- 不支持 `modules` / band / statusline 等宿主界面扩展；
- 不提供从 git 地址自行安装或升级插件的功能。

---

## 后果

- **可重现性与缓存**：上下文注入通过持久事件与独立 `hookContext` section 落地，既保证会话恢复、分叉、回退的逐字节重放一致，又把变化收敛在会话生命周期与压缩边界，不破坏普通 Step 之间的提示词缓存前缀。
- **兼容性**：新增持久化事件 `hook.context` 不提升 `formatVersion`；旧版本 Runtime 拒绝恢复包含它的日志（`session_log_newer`），只读端和视图忽略。
- **插件安全边界**：第二期坚持白名单环境、显式启用、脚本内容哈希复核与不接入工具放宽点位，在复用现有生态上下文插件的同时守住权限层与凭据隔离。

## 备选方案

- **把 `SessionStart` 注入当作临时状态、不写持久事件**：会话恢复或换机重放时若 Hook 配置变化或脚本输出依赖当时环境，重放结果会漂移，破坏模型输入可重现性。
- **直接放行第三方插件的 `PreToolUse` / `PermissionRequest`**：插件按 Claude 工具名匹配且允许返回 `allow`，与 Nocturne 按解析后权限主体求值的安全模型冲突。
- **把插件 Hook 写进用户 `config.json`**：违背 Nocturne「程序不改写手写 `config.json`」的原则，改用独立状态文件。
