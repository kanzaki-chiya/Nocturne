# ADR-0108：项目级子代理定义（`.nocturne/agents`、`.claude/agents`）

- 状态：已接受
- 日期：2026-11-21
- 相关：[ADR-0105](ADR-0105-plugin-subagents.md)（插件定义子代理）、[ADR-0058](ADR-0058-subagent-profiles.md)（子代理档位）、[architecture/subagent.md](../architecture/subagent.md)（修订第 14、19 节）、[architecture/config.md](../architecture/config.md)（修订第 3 节）、[protocols/rpc.md](../protocols/rpc.md)

## 背景

[ADR-0105](ADR-0105-plugin-subagents.md) 引入了受控的插件子代理机制（Markdown frontmatter + 角色说明、仅收窄工具与可选 `effort`、不能指定模型），但 [subagent.md 第 14 节](../architecture/subagent.md#14-角色系统边界结论) 仍保留「用户级与项目级自定义 agent 文件依然不做」的边界。实际仓库维护中，团队常希望在仓库内随代码提交专职子代理（如架构审查、安全审计、领域文档核对），且不少仓库已经维护了 Claude Code 的 `.claude/agents/*.md` 文件。

本 ADR 将同一套受控子代理机制开放给项目级定义文件，同时保持用户级 `agents` 目录仍不开放。

## 决定

### 1. 发现与不要求项目信任

- **扫描范围**：从 `cwd` 上溯到 `workspaceRoot`，每一级依次单层扫描：
  - `.nocturne/agents/*.md`；
  - `.claude/agents/*.md`（受 `skills.sources.claude` 开关控制，缺省开启，与 `.claude/skills` 一致）。
- **根路径容错**：目录不存在或路径为普通文件时静默跳过、不报警告（同技能根规则）。不递归子目录；同目录按文件名排序；符号链接按真实路径去重。
- **重名覆盖优先级**：离 `cwd` 近的优先于远的；同一级目录中 `.nocturne` 优先于 `.claude`。被覆盖条目在公开查询中保留并标明 `shadowedBy`，同时记一条带文件路径的警告，不进入生效档位表。
- **不要求项目信任（修订路线图初稿「复用 trust.json」的设想）**：项目子代理定义只包含一段角色说明文本、工具白名单/黑名单（只能收窄、不能放宽权限）、以及可选 `effort`，不能指定或切换模型，也不能启动外部进程或注册 Hook。其安全风险等级与项目 `AGENTS.md` 和项目技能（[config.md 第 3 节](../architecture/config.md#3-项目配置的信任模型)、[skills.md 第 1 节](../architecture/skills.md)）相同，因此未信任项目同样照常加载，不依赖 `trust.json`。

### 2. 两种文件格式与校验

#### `.nocturne/agents/*.md`

与插件子代理共用同一套 Nocturne 原生 frontmatter 解析器（`config/subagent-markdown.ts`）：

- `name`（必填）：命名规则同 `isValidSubagentProfileName`（小写字母、数字、`-`，最长 32，`default` 保留）。
- `description`（必填）：非空字符串。
- `tools`（可选）：Nocturne 工具名字符串数组。
- `effort`（可选）：`off | minimal | low | medium | high | xhigh | max`，无效时跳过并警告。
- 其他字段（含 `model`）：一律忽略并记录警告；项目子代理不能指定模型。
- 正文（必填）：角色说明，去首尾空白后非空，最长 10,000 字符。

#### `.claude/agents/*.md`

兼容 Claude Code 子代理文档（核对日期 2026-11-21，[Create custom subagents - Claude Code Docs](https://code.claude.com/docs/en/sub-agents)）：

- `name`、`description` 必填，`name` 须满足 `isValidSubagentProfileName`，不合规跳过并警告。
- `tools` / `disallowedTools`：文档说明 `tools` 为 `"Tools the subagent can use, as a comma-separated string such as Read, Grep, Bash or a YAML list"`，`disallowedTools` 为 `"Tools to deny, removed from inherited or specified list. Same format as tools. An entry with a specifier, such as Bash(git push *), still removes the whole tool"`。本实现支持逗号分隔字符串（保留括号内逗号）与 YAML 列表两种写法，按下表映射到 Nocturne 工具名；`disallowedTools` 从结果中减掉（未写 `tools` 仅写 `disallowedTools` 时在运行时从工具池中剔除，带括号限定符的 `disallowedTools` 按基础工具名移除整个工具）；无法映射的名字忽略并各记一条警告。
- `effort`：取值在 `REASONING_EFFORT_ORDER` 内时生效，否则忽略并记警告（不跳过该文件）。
- 其余字段（文档所列 `model`、`permissionMode`、`maxTurns`、`autoCompactWindow`、`skills`、`mcpServers`、`hooks`、`memory`、`background`、`omitClaudeMd`、`isolation`、`color`、`initialPrompt`、`experimental` 及其他未知顶层字段）：一律忽略，每个文件合并成一条警告并列出忽略的字段名。
- 正文规则同上（必填，最长 10,000 字符）。

**Claude Code 工具名映射表**：

| Claude Code | Nocturne |
|---|---|
| `Read` | `read` |
| `Write`、`Edit`、`MultiEdit` | `edit`、`write`、`apply_patch`（三者均放进白名单，会话按模型 `capabilities.editTool` 实际拥有其一） |
| `Glob`、`LS` | `glob` |
| `Grep` | `grep` |
| `Bash` | `shell`、`shell_output`、`shell_kill` |
| `BashOutput` | `shell_output` |
| `KillShell`、`KillBash` | `shell_kill` |
| `WebFetch` | `web_fetch` |
| `TodoWrite` | `todo_write` |
| `Task`、`Agent` | `task` |
| `Skill` | `skill` |
| `mcp__<server>__<tool>` | 原样保留 |

#### `description` 截断规则（与插件子代理不同）

两种项目格式对超过 300 字符的 `description` 均**不跳过**：在注入 `task` 工具的档位选择表中截断到前 300 个字符并追加省略号（`…`），而在公开查询接口 `describeProjectSubagents` 中保留完整全文。

**与 ADR-0105 插件子代理规则不同的理由**：原生插件由插件作者专门面向 Nocturne 编写，受 300 字符硬约束以保持简洁；而现存的 `.claude/agents/*.md` 文件普遍在 `description` 中附带多段触发示例（`<example>...</example>`），动辄超过 300 字符，若沿用插件的整条跳过规则会导致大量现成文件直接失效。保留全文供界面详情查看、在选择表中统一截断，既兼容现成生态文件又控制了主会话上下文开销。

### 3. 档位接入与运行

- **档位 id**：`project:<名字>`。与插件子代理 id 冲突时（例如有名为 `project` 的插件提供同名子代理），项目子代理优先，冲突插件条目跳过并记警告。
- **选择表顺序**：`default` → 用户档位 → **项目子代理** → 插件子代理 → 外部 Agent。
- **模型与 effort**：模型始终跟随 `default`（`modelRoles.task`），本轮不做单独选模型设置；调用 `task` 时显式传入 `model` 参数照常生效；默认模型不可用时按现有规则排除出选择表并发 `subagent_profile_unavailable` 警告。`effort` 有定义则用、否则继承父会话，均经 `clampReasoningEffort` 就近降档。
- **工具池**：按 [subagent.md 第 6 节](../architecture/subagent.md) 算出后，若声明了 `tools` 则与白名单取交集（不在池内的工具名静默忽略，`finish` 始终保留），仅声明 `disallowedTools` 时从池中剔除；未声明时不收窄。过滤后只剩 `finish` 时，调用直接报 `invalid_input`（同插件）。
- **系统提示词**：固定 `subagentBasePrompt` 逐字不变；角色说明单独成段追加在其后，段首注明来源文件相对 `workspaceRoot` 的路径（`以下角色说明来自项目文件 <相对路径>：`）；工作树隔离段落照旧追加。
- **生效时机**：会话打开时取快照；文件增删改在下一个会话或配置重载（`reloadConfig` / `updateProviders`）后生效，规则同项目技能；设置页每次打开重新扫描。
- **Agent Loop 与嵌套**：Agent Loop 不按工具名或档位名分支；嵌套子会话复用同一张档位表。合奏（`/ensemble`）成员的 `profile` 走 `subagentProfiles` 独立表，本轮不扩展。

### 4. 公开查询、RPC 与客户端

- 新增 `Runtime.describeProjectSubagents({ workspaceRoot? })` 及对应 RPC 方法 `agents.describeProjectSubagents`，返回 `{ agents, warnings }`，每项为 `{ id, name, description, source, path, effort?, tools?, shadowedBy? }`（`tools` 为映射并相减后的结果，`warnings` 带文件路径）。方法仅本机开放，远程调用报 `remote_not_allowed`（同 `agents.describeExternalAgents`）。不新增或修改事件。
- **桌面端「设置」→「子代理」**：在「内置档位」与插件分组之间新增「项目」分组（无项目子代理时隐藏），列出所选工作区生效的项目子代理；解析警告按现有警告样式展示；点行进入只读详情页，展示名称、完整描述、来源文件路径、工具与思考档位，无模型选择、无开关、无多余说明文字或徽标。
- **TUI `/settings`**：存在生效的项目子代理时新增「项目」只读分组，列出 `project:<名字>`、工具数与思考档位，说明区展示描述与来源路径。

## 不做的事

- 不开放用户级 `~/.nocturne/agents` 或 `~/.claude/agents` 目录。
- 不为项目子代理提供单独选模型配置或启停开关。
- 不读取 Codex 的 agent 定义文件。
- 不扩展合奏（`/ensemble`）成员的 `profile` 列表，不改手机网页（手机无子代理设置页）。
