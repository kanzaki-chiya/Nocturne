# ZCode 架构评审

> 性质：研究快照，不随代码维护，不作为约束来源 ｜ 日期：2026-09-23（同日按评审修正事件持久化相关表述）
> 对象：[zai-org/ZCode](https://github.com/zai-org/ZCode) 提交 `328c1a0`，重点 `apps/zcode-cli`
> 对照：openai/codex 提交 `30fc686`（`codex-rs/protocol`、`app-server-protocol`、`history`），sst/opencode 提交 `18ef3cc`（`packages/opencode/src`）

下文路径中 `cli/` 表示 `apps/zcode-cli/packages/`。"确认"表示读过源码；"推测"表示依据命名、注释或局部代码推断，未完整验证。

## 1. 总体印象

- **规模**：`cli/` 下非测试 TypeScript 约二十万行。其中 `core/src/runtime` 约 3.7 万行、`core/src/tool` 约 3.3 万行、`bootstrap` 约 6.5 万行（含两代协议实现）。确认。
- **分层意图清晰**：`contracts`（接口与类型）→ `core`（业务）→ `adapters`（I/O）→ `bootstrap`（组装与协议）→ `cli` / `tui`。`tui` 只依赖 `contracts`、`i18n`、`shared`，不依赖 `core`。确认（各包 `package.json`）。
- **工程治理认真**：`apps/zcode-cli/AGENTS.md` 对工具契约、I/O 边界、traceId、错误处理有细致规定；根目录 `architecture-policy.yaml` 以文件行数、公开方法数、禁止循环依赖等规则机检架构，但几乎所有模块仍标记为 `managed: false`（存量未纳管）。确认。
- **产品功能深度嵌入核心**：动态工作流、定时任务、闲时任务、目标验证、浏览器 / 桌面控制、官方套餐网关等产品能力直接出现在 Turn 循环、工具上下文和事件类型中。这是 Nocturne 最需要避免照搬的部分。

## 2. 模块评审表

| ZCode 模块 | 是否采用 | 采用程度 | Nocturne 方案 | 理由与源码位置 |
|---|---|---|---|---|
| Agent Runtime | 否（结构） | 只参考思想 | 无状态 Agent Loop + 状态归会话，依赖通过窄接口注入 | `cli/core/src/runtime/agent-runtime.ts` 的 `AgentRuntime` 有约 80 个私有字段，方法通过 `installAgentRuntimeMethods` 从 `runtime/methods/`（上百个文件）混入，并用声明合并补类型。职责过度集中，属于"巨型 Agent 类" |
| Agent Loop | 部分 | 借鉴但简化 | 见 [agent-loop.md](../architecture/agent-loop.md) | `runtime/methods/turn-loop.ts` 的 `runRegularTurnLoop` 每轮依次：中断检查 → 排空运行时命令 → 微压缩 → 自动压缩 → MCP 初始化 → 计算工具集 → 注入提醒 → 构建请求 → 模型步。"每个 Step 重建请求"和"压缩在请求前判定"值得借鉴；循环内按自动化任务、闲时任务过滤工具（`buildTurnDisallowedTools`）等产品逻辑不带入。ZCode 刻意不设工具调用次数上限（`apps/zcode-cli/AGENTS.md`），Nocturne 保留可配置的安全上限 |
| Session（持久化） | 否 | 只参考思想 | 追加式 JSONL 事件日志（[ADR-0003](../decisions/ADR-0003-session-event-log.md)） | `cli/adapters/src/storage/session-store/`：`node:sqlite`，表 `session` / `message` / `part` / `session_entry` / `todo` 以及大量工作流相关表（`migrations.ts`）。Message + Part 结构（`contracts/src/interfaces/session-store.port.ts`，`ToolPart.state` 为 pending / running / completed / error）与 OpenCode 同形，推测源自 OpenCode |
| Session（恢复） | 是 | 借鉴但简化 | 恢复时为未完成工具调用补写 `interrupted` 结果 | `core/src/agent/session-history-hydrator.ts` 以 `"[Tool execution was interrupted before resume]"` 补齐未完成的工具调用，保证请求中调用与结果配对。思路直接采用；Nocturne 以追加事件实现并区分"是否已开始执行" |
| Event | 部分 | 借鉴但简化 | 持久化 / 临时两类事件，统一信封（[events.md](../protocols/events.md)） | `contracts/src/events/session.events.ts`：信封含 `id`、`sessionId`、`turnId`、`type`、`timestamp`、`traceId`、`sequenceNumber`、`payload: unknown`，约 80 种类型（含排队、工作流、目标、Hook 审查等）。会话事件流本身存放在内存：`SessionEventStorePort` 只有内存实现 `in-memory-session-event-store.ts`，并按 Turn 窗口淘汰临时事件（`session-event-retention.ts`）；部分事件类型经 `core/src/runtime/methods/events.ts` 的 `persistDurableSessionEvent` 写入 session_entry、session_input 等持久表；冷恢复时由 `bootstrap/src/zcode-protocol-v4/transcript-hydration.ts` 的 `synthesizeEventsFromMessages` 从持久消息合成展示事件。持久存储是清楚的事实来源，事件是派生视图；更准确的问题是**实时路径与冷恢复路径经过不同的投影过程**，维持两者一致的成本高。信封字段与"临时事件"的分类值得借鉴；`payload: unknown` 与事件类型膨胀不带入 |
| Event Reducer | 是 | 借鉴但简化 | 会话状态由事件折叠；客户端视图 reducer 放在 protocol（Phase 4） | `contracts/src/events/event-reducer.ts` 把事件折叠为 `SessionProjection`；`packages/shared/src/zcode-protocol-v4/apply.ts` 的 `applyConversationDelta` 是服务端与客户端共用的纯函数（注释要求客户端 store 不得引入额外分支）。"共享纯函数 reducer"直接采用 |
| Context | 是 | 借鉴但简化 | 分段构建、来源可见、稳定内容在前（[context.md](../architecture/context.md)） | `core/src/context/types.ts` 的 `ContextSection` 带 `source`、`injectionTarget`、`cacheHint`、`tokens`，便于解释上下文构成。`PresentationSurface: "terminal" \| "zcode_desktop"` 与工作流子代理身份等产品段落不带入 |
| Compact | 部分 | 借鉴但简化 | L1 修剪 + L2 摘要，均以事件记录 | `core/src/compact/`（policy、microcompact）与 `runtime/methods/compact*.ts`、`helpers/compact*.ts` 合计约 4000 行：输出预留、缓冲、连续失败熔断、"快速回填"检测。阈值计算扣除输出预留的做法采用；熔断与回填检测等复杂度在 MVP 不需要 |
| Tool（契约） | 是 | 借鉴但简化 | `ToolDefinition`：schema + traits + permissionSubjects（[tool-api.md](../protocols/tool-api.md)） | `contracts/src/tools/contract.ts` 声明 `sideEffectScope`、`resultBudget`、`timeout`、`cancellation`、`trace`、`permission`，理念正确。问题：`core/src/tool/types.ts` 的 `ToolMetadata` 与 `ToolPermissionSpec` 重复声明 `riskLevel`、`sideEffectScope`、`needsApproval`，`PermissionService.resolveCapability` 需在三处来源与按名字的默认值之间合并 |
| Tool（执行管线） | 是 | 强烈建议借鉴（顺序） | 查找 → 校验 → 权限主体 → 权限 → 开始 → 执行 → 归一化 → 完成 | `core/src/tool/executor/call-runner.ts`：查找 → schema 校验 → 工具自定义校验 → `resolveInput` 归一化 → PreToolUse Hook → 权限 → `ToolCallStarted` → 带超时与中断执行 → 输出校验 → 结果预算序列化 → PostToolUse Hook → 结果事件。并且注释多次强调"每个提前返回都必须发出错误事件，否则界面行永久停在进行中"——这正是 Nocturne"每个调用恰好一个 `tool.completed`"不变量的来源 |
| Tool（上下文） | 否 | 只参考思想 | 窄 `ToolContext` | `core/src/tool/types.ts` 的 `ToolExecutionContext` 有四十多个字段，大多可选（工作流端口、自动化端口、浏览器端口、会话存储……），任何工具都能拿到几乎所有能力 |
| Tool（调度） | 部分 | 借鉴但简化 | 声明 `concurrencySafe`；MVP 串行 | `core/src/tool/scheduler.ts` 按依赖拓扑与并发安全性分组并行，但保留按名字的 `READ_ONLY_TOOLS` 兜底集合 |
| 内置工具 | 部分 | 借鉴但简化 | read / write / edit / grep / glob / shell | 先读后写与过期检测（`tool/read-file-state.ts`）采用。Bash 只读判定有约 30 个 `bash-readonly-policy-*` 文件，成本极高；Nocturne 的 shell 默认 ask，不做自动只读分类 |
| Permission | 部分 | 借鉴但简化 | 规则化策略层（[ADR-0004](../decisions/ADR-0004-permission-rules.md)） | `core/src/permission/service.ts`：决定带 `ruleId` 与 `reason`（采用）；判定器与审批通道分离——`PermissionBrokerPort`（`contracts/src/interfaces/permission.port.ts`），无客户端时 `DenyPermissionBroker` 一律拒绝（采用）；"始终允许"区分会话级与持久级（采用）。不带入：五种模式分支、按工具名特判（WebFetch、AmendWorkflow、`Write` 视同 `Edit`、官方 CUA）、注释承认的 `yolo` 先于禁用工具放行。`core/src/tool/path-policy.ts` 注释说明当前不阻止工作区外路径——Nocturne 以 `where: outside` 规则处理 |
| Hooks | 以后 | 借鉴但简化 | Phase 5；PreToolUse / PostToolUse 等少量点位 | `contracts/src/hooks/index.ts`：SessionStart、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、PostToolUseFailure、Stop，与 Claude Code 的 Hook 事件名一致（推测为有意兼容）。`core/src/hooks/workspace-hook-trust-*` 为项目级 Hook 提供信任审查——安全上必要，Nocturne 在 Phase 5 采用同等思路 |
| Provider | 部分 | 借鉴但简化 | 自有接口（[ADR-0005](../decisions/ADR-0005-own-provider-interface.md)） | `contracts/src/model/model.ts` 的 `Model` 接口很小（`bind` / `generateText` / `streamText`），流事件（`model/index.ts` 的 `ModelStreamEvent`）区分 text / reasoning / tool_input / tool_call / finish，值得借鉴。问题：`finishReason` 是任意字符串、`error` 事件携带 `unknown`；流事件中混入压缩专用的 `compact_stream_boundary`；`ModelTextRequest` 混有大量"仅运行时"字段（状态回调、准入、重试预算）。能力数据（`packages/shared/src/model-config.ts` 的 `ModelProperties`）独立于 Provider，采用。Core 中未发现按 Provider 名的分支（确认），差异集中在 `cli/adapters/src/model/`（基于 AI SDK，且仓库对 `@ai-sdk/anthropic`、`@ai-sdk/openai-compatible` 打了补丁） |
| Provider 重试 | 否 | 只参考思想 | 重试在 Agent Loop，仅在未产生输出前重试 | ZCode 在适配器内重试（`adapters/src/model/runner-retry.ts`、`retry-policy.ts`），并为流中断后的恢复建立了锚点、账本、尾部丢弃等机制（`stream-recovery.events.ts`）。复杂度高，MVP 不需要 |
| MCP | 以后 | 强烈建议借鉴（接入方式） | Phase 5；MCP 工具即普通 `ToolDefinition` | `contracts/src/interfaces/mcp.port.ts` + `adapters/src/mcp/`（连接池、OAuth、stdio）；`core/src/mcp/name.ts` 以 `mcp__<server>__<tool>` 命名注册进工具注册表。"MCP 工具走普通注册表与执行管线"采用；官方鉴权相关逻辑不带入 |
| Subagent | 以后 | 借鉴但简化 | Phase 6；工具 + 注入 launcher + 子会话 | `contracts/src/interfaces/subagent.port.ts` 与 `core/src/subagent/`（explore、general-purpose 两种内置类型，子会话共享父事件存储并携带 `parentSessionId`）。"子代理即受限子会话"采用；持久记忆、协调者回复、工作流子代理不带入 |
| Background Task | 否（MVP） | 只参考思想 | 未排期 | `core/src/runtime-task/registry.ts` 的 `RuntimeTaskType` 为 local_agent / local_bash / local_workflow / local_dynamic_workflow / monitor_mcp，注释说明新旧两种工作流类型并存。完成通知以合成用户消息回灌会话 |
| RPC / 协议 | 以后 | 只参考思想 | 公开 API 语义即将来的 RPC 语义；传输推迟 | `cli/cli/src/run.ts` 的 `app-server` / `agent-server` 子命令以 stdio 提供协议服务（Desktop 通过它驱动 Agent，见根 `AGENTS.md`）——"服务端模式是同一二进制的子命令"值得借鉴。v3（`bootstrap/src/zcode-protocol`）与 v4（`bootstrap/src/zcode-protocol-v4`：命令收件箱、产品投影、快照 + 增量、回放）并存，属历史包袱 |
| CLI | 部分 | 只参考思想 | 薄客户端 | `cli/cli/src/` 包含参数、登录、插件、技能、TUI 装载等；`tui-session-event-relay.ts` 通过 `unknown` 类型读取 runtime 上的订阅函数（注释"能力不在静态类型面上"），说明客户端与 Runtime 的接口没有被静态约束 |
| TUI | 以后 | 只参考思想 | Phase 4；消费事件与共享 reducer | `cli/tui/`（opentui + React），业务状态不放 TUI 的规则写在 `apps/zcode-cli/AGENTS.md`，值得采用。TUI 与 Desktop 两条消费路径各有投影逻辑，不采用 |
| Desktop | 否 | 不带入 | 未排期 | 根目录 `packages/desktop`（Electron）、`packages/web`、`packages/server`、`packages/ui` 属产品外壳 |
| 动态工作流 / 定时 / 闲时 / 目标 | 否 | 不带入 | — | `cli/dynamic-workflow*`、`core/src/workflow`、`contracts/src/tools/*workflow*`、`automation.ts`、`off-peak.ts`、`target.ts`；深度渗入事件、工具上下文与 Turn 循环 |
| 账号、套餐、网关、品牌 | 否 | 不带入 | — | `cli/adapters/src/model/official-coding-plan-gateway.ts`（官方套餐请求改走平台网关）、`cli/bootstrap/src/auth-login*.ts`、`packages/provider/src/account-provider-*.ts`、远端内置模型目录同步（`packages/provider-node/src/zcode-builtin-*`）、MCP 官方鉴权 |
| 架构治理脚本 | 以后 | 只参考思想 | Phase 1 用现成依赖检查工具 | `architecture-policy.yaml` + `scripts/architecture/`：思路好（规则可机检），但自建脚本维护成本高；Nocturne 先用 dependency-cruiser 之类的现成工具 |

## 3. 分类汇总

### A. 强烈建议借鉴
- 工具执行管线的步骤顺序，以及"每个提前退出都要产生结束事件"的不变量。
- 权限判定与审批通道分离；无客户端时默认拒绝；决定附带规则来源与理由。
- 模型能力作为独立数据，而非 Provider 名称判断。
- MCP 工具以命名空间注册为普通工具。
- 恢复时为未完成工具调用补写结果。
- 服务端与客户端共享的纯函数 reducer。
- 服务端模式作为同一 CLI 的子命令（将来 RPC 时）。

### B. 借鉴但简化
- 工具契约（副作用、超时、中断、结果预算）→ 收敛为 `traits` + `permissionSubjects`，去掉重复声明。
- 上下文分段与来源标注 → 保留，去掉产品段落。
- 压缩策略 → 两级，事件化，去掉熔断与回填检测。
- Hooks 与项目 Hook 信任 → Phase 5 以少量点位实现。
- Subagent 作为子会话 → Phase 6。
- 事件信封与"临时事件"概念 → 保留，并让持久化事件本身成为事实存储，使实时与恢复共用一条投影路径。

### C. 只参考思想
- 以文件行数、公开方法数等规则机检架构。
- `traceId` 贯穿全链路的要求（Nocturne 在 Subagent 阶段引入）。
- 流中断恢复（锚点、账本）——记录为将来可能需要的问题，而非方案。
- 输入排队、引导（steering）、自动排空等交互语义。

### D. 不带入
Z.AI 账号与登录、Coding Plan 套餐与网关、远端模型目录同步、官方 MCP 鉴权、品牌与产品 UI、Desktop / Web 外壳、动态工作流、定时与闲时任务、目标验证、浏览器与桌面控制（CUA）、插件市场。

## 4. 历史包袱与值得警惕的信号

1. **冷热两条投影路径**：实时状态来自内存事件流，冷恢复状态来自持久消息合成的事件，两条路径需要人为保持一致；代码中大量"冷热同形"注释。（第 1 版此处写作"两份事实来源"，评审指出结论过重：持久存储是事实来源，事件是派生视图，已据此修正。）
2. **两代协议并存**：v3 与 v4 同时存在，事件类型注释中频繁出现"v4 投影"、"v3 侧剥离"。
3. **巨型 Runtime**：约 80 个字段的类 + 方法混入。
4. **产品逻辑进入核心循环**：自动化、闲时任务、目标、工作流在 Turn 循环与工具上下文中有专门分支。
5. **按名字特判**：权限服务与调度器中的工具名集合与特例。
6. **文档漂移**：`apps/zcode-cli/README.md` 仍描述"运行时零生产依赖、`src/cli`、`src/core`、`src/ui` 结构"，与实际多包结构和依赖不符。
7. **治理未落地**：`architecture-policy.yaml` 中大多数模块 `managed: false`。

这些不是对 ZCode 的否定：它们是一个快速迭代的产品在真实需求压力下的自然结果。对 Nocturne 的意义是，在规模很小的时候就把边界定清楚。

## 5. 其他项目对照（本轮只核对了与决策直接相关的部分）

| 项目 | 核对内容 | 对 Nocturne 的影响 |
|---|---|---|
| Codex | `protocol/src/protocol.rs`：`Event { id, msg }`，`id` 关联提交的 Submission（提交 / 事件双队列）；`AskForApproval`（untrusted / on-request / granular / never）与 `SandboxPolicy`（read-only / workspace-write / danger-full-access / external-sandbox）正交。`history/src/lib.rs`：`RolloutItem`（SessionMeta、ResponseItem、Compacted、TurnContext、EventMsg 等）构成追加式会话记录。仓库 `AGENTS.md` 的上下文规则：不改写历史、避免破坏缓存、所有注入项有上限、单项不超过 1 万 token；并提醒"抵制向 codex-core 堆代码" | 事件日志作为事实来源（ADR-0003）；"权限不是沙箱"的明确区分（ADR-0004）；上下文原则（context.md） |
| OpenCode | `permission/index.ts` 的 `evaluate`：扁平规则、通配匹配、最后一条匹配生效、默认 ask；`tool/tool.ts`：工具通过 `ctx.ask` 自行请求权限；仓库 `AGENTS.md`：依赖方向 Schema → Core / Protocol → Server，客户端只依赖 Schema 与 Protocol；持久化输入准入与模型执行分离 | 规则求值模型（ADR-0004）；依赖方向（modules.md）；工具不自行请求权限（备选方案中说明） |
| Claude Code | 未核对源码 | Hook 事件命名在 ZCode 中与之一致，Phase 5 设计时再核对 |
| Aider、OpenHands | 本轮未研究 | Aider 的仓库地图可作为将来的上下文来源参考；需要时单独研究 |

## 6. 不确定项

- ZCode Message + Part 模型源自 OpenCode：依据是结构与字段高度一致（`ToolState` 四态、`step-start` / `step-finish` / `snapshot` / `patch` 部件），以及 `adapters/src/model/opencode-session.ts` 的文件名，未查证提交历史。
- ZCode 流中断恢复机制的完整行为只读了事件定义与部分调用点，未完整跟踪。
- 本评审未运行 ZCode，所有结论来自静态阅读。
