# 路线图

> 状态：已接受 v0.2 ｜ 每个阶段结束时执行 [workflow.md](../development/workflow.md) 第 2 节的文档同步清单，这是阶段完成的一部分。

原则：前一阶段的核心语义稳定后才开始下一阶段；每个阶段只做列出的内容，不提前实现后续阶段的能力，只保证不堵死接入点。

## Phase 0 — 文档与契约（已完成，2026-09-23 验收）

**内容**：项目定位、架构总览、模块边界、事件模型、Tool API、Provider API、权限模型、会话模型、上下文策略、仓库结构、AGENTS.md、文档索引、首批 ADR、ZCode 研究记录。

**验收**：

- 只读 `README.md`、`AGENTS.md`、`docs/README.md`、`docs/architecture/overview.md`，开发者能说清：Nocturne 是什么、为什么这样设计、有哪些主要模块、代码放在哪里、修改某个模块前应该读什么。
- 核心契约（事件、Tool API、Provider API、权限规则、会话生命周期）足够明确，可以开始实现，不需要重新讨论基础模块职责。
- 提议状态的 ADR 已由维护者确认或修改。

## Phase 1 — 最小 Runtime（已完成，2026-09-24 验收）

**内容**：pnpm workspace 与工具链；`protocol` 类型；`session`（JSONL 日志、先写后发、状态折叠）；`provider` 接口与 `openai-compatible` 适配器；`tools` 注册表与执行管线；内置 `read`、`grep`、`glob`；`agent` Loop（流式、多工具调用、中断、重试、步数上限）；权限层与资源解析接入执行管线（此阶段只有只读工具，固定策略为：工作区内读取允许、工作区外读取拒绝；含符号链接指向工作区外的情况）；依赖方向检查进入 CI。

**不做**：TUI、MCP、Subagent、Desktop、RPC、自动压缩。

**验收**：一个最简单的程序化客户端（测试脚本）能够：输入 prompt → 调用模型 → 收到流式输出 → 模型调用基础工具 → 工具结果回到模型 → Turn 完成；以上流程在脚本化假 Provider 下有确定性的集成测试，在真实 OpenAI 兼容服务上能跑通冒烟测试。测试明确覆盖工作区边界：读取工作区外路径、经符号链接指向工作区外、`..` 逃逸都被拒绝；grep / glob 结果不包含工作区外内容。

真实模型冒烟测试会把读取到的内容发给模型服务，只能在不含敏感信息的测试仓库中运行。

## Phase 2 — CLI（已完成，2026-09-24 验收）

**内容**：`nctrn` 命令、REPL、流式输出渲染、工具状态显示、`edit` / `write`（含先读后写检查）、`shell`（超时、进程树终止、输出截断）、`anthropic` 适配器、自动 L1 上下文修剪与手动 `/compact`、`/context` 查看上下文构成、`/model` 会话内切换模型（`setModel` 命令，效果事件 `session.config_changed`）、非交互模式（单次 prompt）；**最小权限**：固定使用 `default` 预设（工作区内读取允许，写入与 shell 需确认），CLI 提供"允许一次 / 拒绝"的确认，非交互模式下需确认的操作一律拒绝。

> 与最初设想的差异：原计划权限整体放在 Phase 3。但 Phase 2 就会引入写文件和执行命令，一个不经确认就执行 shell 的 CLI 不应交到用户手里，因此把最小的 ask 流程提前到 Phase 2；可配置规则、分层、信任、"记住选择"等仍在 Phase 3。

**验收**：`cd repo && nctrn` 能完成真实但简单的编程任务：阅读项目、定位一个 bug、修改文件、运行测试、报告结果。CLI 代码中没有 Agent 行为逻辑（通过依赖检查与代码评审确认）。

## Phase 3 — 权限与持久会话（已完成，2026-09-24 验收）

**内容**：完整的权限规则、全部预设、分层配置、项目配置信任、"本会话 / 本项目始终允许"；会话恢复、崩溃修复、会话锁、会话列表；自动 L2 摘要压缩；超出预算的工具输出落盘。

**验收**：退出 CLI 后重新启动，可以恢复会话并继续之前的对话与任务；模拟崩溃（中途杀进程）后恢复，历史完整、未完成的工具调用被正确标记；危险操作按规则 allow / ask / deny，且能解释命中了哪条规则。

## Phase 4 — TUI（已完成，2026-09-24 验收）

**内容**：`protocol` 派生视图 reducer（`SessionView`，entries 只由持久事件产生、流式产物经 `live` 晋升，重放等价不变量 V1–V8）；`apps/tui` Ink 客户端——回放区（`<Static>` 完结前缀）+ 活动区 + 权限对话框 + 弹层 + 输入行 + 状态栏；`nctrn --tui` 惰性入口；REPL/TUI 会话内 `/resume` 切换（打开逻辑只在 CLI 一份，回调注入 TUI）；窄终端与 NO_COLOR/ASCII 降级。

**验收**：CLI 与 TUI 驱动同一套 Runtime，行为一致；TUI 不包含 Agent 逻辑，只消费公开 API 与事件。已用假 OpenAI 兼容 SSE 端点驱动真实进程逐项核对：流式中文对话、read+edit 工具与 diff、权限五键（a/s/p/d/x，d 带反馈、session/project Grant 生效）、Ctrl+C 中断、`-c`/`--resume` 恢复、杀进程后 process_exited 收束、会话内 `/resume` 切换与视图重放、非 TTY 退出 2、40 列窄终端；界面在 Windows Terminal 与 conhost 实际查看（含中文输入与 resize），conhost 活动区重绘残影为已知限制（ADR-0010）。

## Phase 5 — MCP 与 Hooks（已完成，2026-09-24 验收）

**内容**：MCP 客户端（工具包装为 `ToolDefinition`，命名空间隔离，权限类别 `mcp`）；Hooks（PreToolUse、PostToolUse、权限相关 Hook、会话生命周期）；项目级 Hook 的信任机制；可观测性（请求、上下文构成、token、工具耗时、权限决定的调试输出）。

**设计**：[architecture/mcp.md](../architecture/mcp.md)、[architecture/hooks.md](../architecture/hooks.md)、[architecture/observability.md](../architecture/observability.md)、[ADR-0011](../decisions/ADR-0011-mcp-client.md)、[ADR-0012](../decisions/ADR-0012-hooks.md)。

**约束**：Hooks 是可选扩展，未配置时 Runtime 行为不变（事件序列与 Phase 4 逐项一致）；Hook 的 allow 不能越过规则中的 deny，且仅可信来源能放宽 ask；项目级 `mcp`/`hooks` 配置在未信任时整段不生效；Core 不依赖 `packages/mcp`。

**验收**：

- MCP：脚本化假 stdio 服务器（默认测试集完全离线）覆盖正常调用、`isError`、超时、崩溃与惰性重连；工具以 `mcp__<server>__<tool>` 出现在 `specs()` 与 `/context`，经与内置工具相同的管线执行；启动失败降级为"无该服务器工具"并经 `mcp.server` / `runtime.warning` 可见；权限主体 `mcp <server>/<tool>` 走完整确认流程；**子进程环境为白名单 + 显式 `env` 覆盖**（测试断言 MCP 子进程看不到未声明的宿主环境变量，如 `NOCTURNE_API_KEY`）；`tools/list_changed` 与重连后的工具集变化只在 Turn 边界生效（测试断言 Turn 进行中 `specs()` 不变）；恢复含 `mcp__*` 历史的会话且服务器缺席时，两个适配器发出的请求仍合法（假 Provider 断言请求形状）。
- Hooks：`PreToolUse` 拒绝与 `updatedInput` 修改后重新校验各一例；`PermissionRequest` 在 `ask` 时自动放行/拒绝；`PostToolUse` 反馈进入模型可见结果；超时、非零退出、输出过大均降级为"无效果 + `hook_failed` 警告"；**未配置 Hooks 时事件序列与 Phase 4 完全一致**（回归断言）；未信任项目的 Hook 不执行，信任后生效；**Hook 强制的 `ask` 不被 Grant 或 `--yes` 自动放行**（测试断言）。
- 可观测性：`--debug` / `NOCTURNE_DEBUG` 产出 JSONL，覆盖 provider 请求、context 构成、token、工具耗时、权限决定、hook/mcp 调用；日志中不出现凭据、`Authorization` 或 MCP `env` 值。
- 端到端：`Z:/nocturne-accept/` 的 fake-openai 驱动真实 `nctrn` 进程，CLI 与 TUI 各跑一遍（TUI 在 Windows Terminal 与 conhost 实际查看）：MCP 调用往返与权限确认、服务器崩溃后会话继续、`PreToolUse` 拒绝与修改输入、项目 Hook 信任前后差异、杀进程恢复后 MCP 调用标记 `interrupted`、诊断文件无密钥。
- 依赖与边界：`depcheck` 零违规；`packages/mcp` 只依赖 `@nocturne/core` 公开入口与 `@modelcontextprotocol/sdk`；ADR-0011/0012 转已接受。

**已知问题（遗留）**：

- Windows 上强杀 Nocturne 进程时，MCP stdio 子进程可能成为孤儿——当前未用 Job Object 把子进程生命周期绑定到父进程，仅靠 stdin 断开依赖服务器自行退出（[mcp.md](../architecture/mcp.md) 第 4 节）。

## Phase 6 — Subagent（进行中）

**前提**：Runtime、会话、事件、工具、上下文在前面阶段中已稳定。

**内容**：一个内置工具通过注入的 launcher 启动子会话，运行受控的 Turn（受限工具集、独立上下文、继承或收紧的权限），把结果作为工具结果返回；子会话有独立日志并记录父会话关联。

**设计**：[architecture/subagent.md](../architecture/subagent.md)、[ADR-0013](../decisions/ADR-0013-subagent.md)。

**约束**：`task` 是普通 `ToolDefinition`，走相同注册接口与执行管线（Agent Loop 不按工具名分支）；`tools` 不 import `agent`（launcher 接口在 `tools`、实现在 `agent`、`index` 装配）；权限判定只在权限层，子会话有效权限不宽于父会话（非交互收敛，ask 一律 non_interactive deny）；不新增事件类型，父子关联记 `session.created.parent`；`traceId` 维持推迟到 RPC 阶段（设计评审结论，见 ADR-0013）。

**验收**：

- 子代理往返（默认测试集完全离线，脚本化假 Provider 驱动父子两层会话）：`task` 调用 → 子会话受控 Turn → `finish` 提交 → 结果作为 `tool.completed` 回到父模型；结构化结果按 `outputSchema` 校验通过与失败各一例；缺 `finish` 时催促重试与末轮 `toolChoice` 强制、轮尽 `subagent_no_result`。
- 生命周期：父会话中断/超时取消子会话且父侧恰好一个 `tool.completed`；子会话 `error`/`max_steps` 正确映射；`maxDepth`（默认 1）与 `maxConcurrent`（默认 4）上限各有测试；强杀后 `-c` 恢复：父侧未结算 `task` 标记 `interrupted`，子日志完整且 `session.created.parent` 关联可读。
- 权限：子会话越权尝试被拒绝（拒绝消息指引子模型把受阻操作写进 `finish` 结果）；父会话 Grant 与 `--yes` 不会使子会话越过设计边界（ask 仍 non_interactive deny）；`subagent <preset>` 主体在父会话正常走确认流程，`explore` 在 `default`/`auto-edit` 下默认放行、`general`/`custom` 需确认；`subagent * → deny` 关闭特性。
- Provider：`toolChoice` 经适配器映射；「思考开启 + 强制 tool_choice」的已知冲突组合被适配器丢弃并在诊断中标注（适配器单测断言请求体不含 `tool_choice`）；Subagent 兜底轮不携带 `reasoningEffort`。
- 集成：子会话复用父会话 MCP 连接（断言不启动新服务器进程）；子会话 Hook 全点位触发且 `HookInput.subagent` 可区分；`--sessions`/`/resume` 默认不列出子会话；未使用 `task` 时事件序列与 Phase 5 逐项一致（回归断言）；`depcheck` 零违规无循环。
- 端到端：`Z:/nocturne-accept/` 的 fake-openai 驱动真实 `nctrn` 进程，CLI 与 TUI 各跑一遍（TUI 在 Windows Terminal 与 conhost 实际查看）：子代理往返与一行式进度显示、子会话中 ask 按设计被拒、Ctrl+C 中断子代理、强杀恢复、`--sessions`/`/resume` 可见性。
- 收尾：ADR-0013 转已接受；本文标注完成日期。

**不做**：Swarm、角色系统（含自定义 agent 定义文件）、Agent 间消息总线、分布式执行、后台/异步子任务、子代理常驻与唤醒、隔离工作区（worktree/overlay）、子会话权限冒泡、子代理独立模型。

## 之后（未排期）

RPC 服务端与远程客户端、OS 级沙箱、后台任务、会话分叉与回退、Web / Desktop / IDE 客户端、单文件分发。进入排期前各自先写设计文档。
