# ADR-0049：外部 agent 子代理——经 ACP 调用其他 AI 命令行工具

- 状态：已接受（维护者 2026-10-06 确认：第 9 节三项按建议执行）
- 日期：2026-10-06

## 背景

Gemini CLI、Qwen Code、Google Antigravity 等命令行工具自带 ACP（Agent Client Protocol）服务端模式；Codex、Claude Code 有 Zed 维护的开源 ACP 适配器。DimAgent、Pi 等客户端已经通过 ACP 调用它们。这种接法的特点是：真正发出模型请求的是官方程序，用的是用户在那个程序里自己登录的账号；客户端只负责启动进程，并经 stdio 收发 ACP 消息，不接触对方的凭据。

用户希望 nocturne 能把子任务委派给这些外部 agent。可选的形态有两种：

1. **当作 Provider**（Pi 对 Antigravity 的做法）。ACP 对面是一个完整的 agent，有自己的循环、工具和上下文。包成 Provider 会出现两层循环叠在一起的情况：思考强度、token 计数、工具调用都无法如实映射，外部 agent 的文件和命令操作也会绕开 nocturne 的权限层。这违反 AGENTS.md 的硬约束，不采用。
2. **当作子代理**（DimAgent 的做法）。子代理的契约本来就是「交一段自包含的任务，拿回一段结果」（[subagent.md](../architecture/subagent.md) 第 1 节），父会话不关心子任务内部怎么完成。外部 agent 正好填进这个位置。

本 ADR 决定采用第 2 种，并确定以下几件事：怎么接线；权限边界怎么守；外部 agent 的执行过程记在哪里；配置的信任问题怎么处理。

## 决定

### 1. 接线：`task` 工具新增 `agent` 字段，由注入的 connector 执行

- `task` 输入新增可选字段 `agent: string`，取值为已启用的外部 agent 名称。给了 `agent` 时，`preset`、`tools`、`outputSchema` 都不能再给，否则返回 `invalid_input`（外部 agent 的工具集由它自己决定，也没有 `finish` 工具来提交结构化结果）。
- `tools` 模块新增 `ExternalAgentConnector` 接口（纯类型）。新包 `packages/acp`（`@nocturne/acp`）提供实现，依赖规则与 `packages/mcp` 相同：只依赖 Core 的公开入口和官方 ACP TypeScript SDK（包名和许可证在实现时确认）。实现由 `apps/cli` 装配，经 `RuntimeOptions.externalAgents` 注入。Core 不依赖 `acp`。
- `task` 工具的 `execute` 按输入里有没有 `agent` 字段，选择交给 `SubagentLauncher` 还是 `ExternalAgentConnector`。这是按**输入字段**分流，不是按工具名或 agent 名写分支。
- 工具描述里列出当前已启用的外部 agent 名称和用户写的一句说明，让父模型知道有哪些可选。

### 2. 生命周期：每次调用起一个进程，用完即关

- 每次 `task` 调用依次执行：启动配置里的命令 → `initialize` → `session/new`（cwd 为工作区根）→ 如果配置了 `mode`，发 `session/set_mode` → `session/prompt` 发送任务文本 → 收集流式更新，直到 prompt 返回 → 关闭进程（Windows 上清理整个进程树，做法同 MCP）。
- 结果取外部 agent 本次 prompt 的最终回复文本，作为 `modelContent`，超出预算时沿用现有的截断加落盘路径。
- 中断或超时：先发 `session/cancel`，等待一小段宽限时间后结束进程树；结算方式与现有工具相同（`cancelled` / `timeout`）。
- `initialize` 返回需要认证时，不在 nocturne 里代办登录，返回 `external_agent_auth_required`，提示用户先在那个命令行工具里登录。
- 不常驻，不跨调用复用 ACP 会话（`session/load`），与 subagent.md 第 16 节「子代理不常驻」一致。
- 并发：与内置子代理共用运行级并发上限。`traits` 照抄 `task`（`mutates: true`、`concurrencySafe: false`）。

### 3. 权限：入口把关，加上外部请求进权限层

外部 agent 的操作分成两层处理。

- **入口**：`task` 调用在父会话里照常走权限管线，主体为 `{ kind: "subagent", target: "external:<name>" }`。所有交互式预设下默认都是 `ask`。用户可以用规则放行某个外部 agent，例如 `subagent external:gemini → allow`，或者用 `subagent external:* → deny` 整体关闭。
- **执行期**：外部 agent 发来的 `session/request_permission` 由 connector 转成权限主体，交给一个非交互 gate 判定。这个 gate 用父会话的同一套策略输入重建，规则同 ADR-0013 第 2 条：剩余的 `ask` 一律 `deny(source: "non_interactive")`，smart 审查器照常参与。映射规则：

| ACP `toolCall.kind` | nocturne 主体 |
|---|---|
| `read`、`search` | `read`，target 取 `locations` 里的路径；没有路径时为 `*` |
| `edit`、`delete`、`move` | `edit`，target 同上 |
| `execute` | `shell`，target 为 `*`（ACP 没有规范化的命令字段，只能匹配通配规则） |
| `fetch` | `network`，target 为 `*` |
| `switch_mode`、`think`、`other`、未知类型 | 一律回复拒绝 |

  判定为 allow 时回复对方给出的 `allow_once` 选项，否则回复 `reject_once`。永远不回复 `allow_always`，以免外部 agent 记住授权，此后不再询问。

- **不提供** ACP 的客户端文件系统和终端能力（`fs/*`、`terminal/*`）。外部 agent 用它自己的工具读写文件、执行命令。

这样做的保证边界必须如实说明：**执行期的把关只覆盖外部 agent 主动请求的操作。** ACP 里什么时候请求权限由 agent 自己决定，如果它在自己的自动模式下直接改文件，nocturne 根本收不到请求。所以本设计的真实保证是：委派这个动作本身由用户或规则批准；执行期能拦截的都拦截；外部 agent 应该配置成它自己的「逐项询问」模式（第 4 节的 `mode`）。

### 4. 配置：只认用户级，按数据声明，不按名称写分支

- 用户级配置新增 `externalAgents` 段，每项包括：
  - `name`
  - `command`、`args`、`env?`
  - `mode?`：启动后通过 `session/set_mode` 设置的模式 id。各家 agent 的取值不同，是一个不透明字符串，Core 不解释它的含义
  - `description?`：给父模型看的一句说明
  - `enabled`
- **项目级配置里的 `externalAgents` 段一律忽略**，即使项目已被信任也不读。理由：这一段本质上是任意命令，和 Hook、MCP 是同一类风险，但没有「项目自带外部 agent」的真实需求。项目配置里出现这一段时发出警告。
- 可以内置一份「已知外部 agent」预设数据（命令、参数、默认模式），供向导和桌面端列表使用，默认全部不启用。它和服务商预设一样是数据表；Core 和 connector 都不按 agent 名写逻辑。具体命令写法在实现时逐个核实。
- 探测：「已安装」的判定是能在 PATH 上解析到对应命令；版本号取 `initialize` 返回的 agent 信息，只在用户打开列表或手动刷新时探测。

### 5. 记录：外部 agent 的执行过程不是 nocturne 会话

- **不创建 nocturne 子会话，不新增事件类型。** 外部 agent 的消息、思考、工具调用由它自己的循环产生，伪造成 `message.assistant` 加 `tool.started` / `tool.completed` 会破坏「工具调用成对」等不变量（[events.md](../protocols/events.md) 第 5 节），也会让重放显示出 nocturne 实际并没有执行过的工具调用。
- 父会话里能看到的内容：
  - 进度：经现有的 `tool.progress(stream: "info")` 转发一行式进度，例如「Codex：编辑 src/a.ts」「Codex：执行命令」；
  - 结果：`tool.completed` 照常记录，`output` 携带 `{ agent, agentVersion?, transcriptPath, stopReason, permissionDecisions }`。`usage` 不填，因为费用计在对方账号上，ACP 也没有统一的用量字段。
- 完整过程写入父会话附件目录下的 `external/<callId>.jsonl`，内容是 ACP 的 `session/update` 原文，外加执行期每一次权限判定的记录。这是一份审计材料，不是事件日志，不参与重放，不受 `formatVersion` 约束。
- 执行期的权限判定不写进父会话事件日志，因为那里没有对应的 `callId` 可以挂。判定记录在上面的 transcript 文件和诊断通道里，汇总数量放进 `tool.completed.output.permissionDecisions`。

## 后果

- 父会话的事件协议只多了一个工具输入字段和一个 `output` 结构，旧版本能照常读取这些日志。
- 新增 `packages/acp` 包和一项第三方依赖。依赖方向规则同 `packages/mcp`，depcheck 要加对应规则。
- **检查点和回退（ADR-0041）不追踪外部 agent 改动的文件**：按文件回退时，这些改动不会被恢复。工具描述和文档都要写明这一点。
- 在 `default` 预设下，如果用户没有为外部 agent 的执行期操作配置规则、Grant 或 `--yes`，外部 agent 主动请求的写入和执行都会被拒，效果上接近只读委派。这是安全默认的有意取舍；委托模式首版不做（第 9 节第 1 条）。
- 费用和用量 nocturne 看不到。界面上要写明「费用与额度计在该 agent 自己的账号上」。
- 子代理不能嵌套：外部 agent 看不到 nocturne 的 `task` 工具。

## 本 ADR 不做

- 把外部 agent 当作 Provider 或模型；
- 让外部 agent 作为一种独立会话类型直接对话（Zed 的形态），以后另写 ADR；
- 向外部 agent 提供客户端文件系统或终端能力；
- 跨调用复用外部会话、常驻进程；
- 在 nocturne 里代办外部 agent 的登录；
- 桌面端「外部 agent」设置页（截图里那种开关列表），留到实现的第 2 步。

## 实施顺序（提议）

1. `tools` 接口、`task` 新增 `agent` 字段、`packages/acp` 的 connector、权限主体映射、配置段（只认用户级）、transcript 落盘、`tool.progress` 转发；用一个假 ACP agent（测试夹具进程）离线覆盖全部路径；冒烟测试用本机已装的一个真实 agent，单独运行。
2. RPC 查询外部 agent 列表和探测结果，桌面端设置页，TUI 的 `/agents` 列表。
3. 文档：subagent.md、permissions.md（主体表和预设表）、config.md、modules.md、repository-layout.md、mcp.md 对照说明、README（只写面向用户的配置示例）。

## 9. 已拍板

1. **不提供执行期「委托」模式**：首版所有执行期请求都经 nocturne 的非交互 gate 判定。只有真实使用中证明不够用时，才另行修订，加入单个 agent 的 `permissions: "delegate"`（入口主体为 `external-delegate:<name>`，不接受会话 Grant 和项目 Grant）。
2. **内置预设首版只带两三个**：只收录维护者本机确认在用的外部 agent（例如 Gemini CLI、Codex），每个命令写法在实现时逐个核实；其余由用户自己写配置。
3. **会话 Grant 对执行期请求生效**：父会话的会话 Grant 以只读方式作用于执行期 gate，与 ADR-0013 的子会话一致；执行期 gate 不写入新的授权。

## 修订

### 2026-10-07：实现前核实 SDK 与首批预设

- 第 1 节的官方 ACP TypeScript SDK 为 `@agentclientprotocol/sdk`（Apache-2.0，可与 GPL-3.0 合用）；唯一的 peer 依赖 zod 仓库已在用。
- 第 9 节第 2 条的首批内置预设定为 omp 与 Codex 两个（维护者本机在用，逐个核实）：
  - omp 自带 ACP 模式，命令 `omp --mode acp`，本机 18.6.0 实测 `initialize` 正常，凭据沿用 `~/.omp`。
  - Codex CLI 本身没有 ACP 模式，经官方适配器 `@agentclientprotocol/codex-acp`（Apache-2.0，原 `@zed-industries/codex-acp` 已弃用并迁移至此）接入，命令 `npx @agentclientprotocol/codex-acp`，登录沿用 `~/.codex`。
- 维护者在用的 Antigravity CLI（`agy`）没有 ACP 模式，现有适配器都是个人项目且需要 Bun，不进内置预设；需要的用户自行在 `externalAgents` 里配置。不为它写 stream-json 桥接。
