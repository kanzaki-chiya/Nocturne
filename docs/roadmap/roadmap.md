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
- 端到端：仓库外验收脚手架中的 fake-openai 驱动真实 `nctrn` 进程，CLI 与 TUI 各跑一遍（TUI 在 Windows Terminal 与 conhost 实际查看）：MCP 调用往返与权限确认、服务器崩溃后会话继续、`PreToolUse` 拒绝与修改输入、项目 Hook 信任前后差异、杀进程恢复后 MCP 调用标记 `interrupted`、诊断文件无密钥。
- 依赖与边界：`depcheck` 零违规；`packages/mcp` 只依赖 `@nocturne/core` 公开入口与 `@modelcontextprotocol/sdk`；ADR-0011/0012 转已接受。

**已知问题（遗留）**：

- Windows 与 POSIX 上强杀 Nocturne 时，不理会 stdin 关闭的 MCP 服务器可能成为孤儿；能在 EOF 后退出的服务器不残留，手动清理方法见 [mcp.md](../architecture/mcp.md) 第 4 节。

## Phase 6 — Subagent（已完成，2026-09-25 验收）

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
- 端到端：仓库外验收脚手架中的 fake-openai 驱动真实 `nctrn` 进程，CLI 与 TUI 各跑一遍（TUI 在 Windows Terminal 与 conhost 实际查看）：子代理往返与一行式进度显示、子会话中 ask 按设计被拒、Ctrl+C 中断子代理、强杀恢复、`--sessions`/`/resume` 可见性。
- 收尾：ADR-0013 转已接受；本文标注完成日期。

**不做**：Swarm、角色系统（含自定义 agent 定义文件）、Agent 间消息总线、分布式执行、后台/异步子任务、子代理常驻与唤醒、隔离工作区（worktree/overlay）、子会话权限冒泡、子代理独立模型。

服务端因不支持 `reasoning_effort` 等能力字段返回 400 时，错误提示尚不会指引用户关闭模型配置中的对应能力；v0.1.0 暂缓处理，不做自动删字段重试。（思考参数部分在"思考强度"一节处理。）

## v0.1.0 收尾

Phase 0–6 已验收；本轮把成果整理为可交付的 v0.1.0：公共流消费路径加入首事件与事件间空闲超时，Agent Loop 对无文本无工具调用的 `stop` 作有上限重试（[ADR-0014](../decisions/ADR-0014-stream-timeout-empty-response.md)）；统一工具进度片段的行渲染；补足 TUI 交互测试与真实进程验收；用测试工作区完成两个适配器的基础真实服务冒烟；整理用户指南、更新日志、版本号与第三方许可说明。`ModelRequest.reasoningEffort` 本版保留未使用，见 [provider-api.md](../protocols/provider-api.md) 第 3 节。

**已知限制**：主进程被强杀时，不响应 stdin EOF 的 MCP 服务器可能残留，Windows 与 POSIX 的手动清理方式见 [mcp.md](../architecture/mcp.md) 第 4 节；传统 conhost 的 TUI 活动区可能有残影，建议 Windows Terminal（[tui.md](../apps/tui.md)）；服务端因能力字段不支持而返回 400 时尚无针对性配置提示（思考参数部分由"思考强度"一节解决）。扩展思考 Anthropic 模型的 `finish` 兜底轮与 DeepSeek 推理历史回传专项只有在配置对应模型变量时才运行；未配置不作为已通过验收。

## v0.2 — 开箱配置（已完成，2026-09-25 验收）

**内容**：`nctrn setup` 首次配置向导与会话内 `/provider`（CLI 与 TUI）；机器维护的向导配置层 `providers.json`；凭据交给操作系统后端（Windows DPAPI、macOS 钥匙串、Linux Secret Service，无后端时不退回明文）与凭据解析顺序；模型上下文窗口与最大输出长度以上游声明为准（ADR-0016）；内置服务商预设（DeepSeek、OpenRouter、Anthropic 与自定义）；凭据文件的内置硬拒绝、`shell` 子进程剥离凭据变量；`runtime.updateProviders`；目录外模型套用默认能力时的提示；**TUI 全屏模型选择页**（`/model` 与不带参数的 `/provider` 打开，备用屏幕仅此一页，ADR-0017）与 CLI `/model` 编号表格（同列信息 + 关键词过滤）；上游声明的价格/推理/图片输入映射入 `providers.json` 与 `ModelInfo`；机器维护的 `recent-models.json`。设计见 [provider-setup.md](../architecture/provider-setup.md)、[ADR-0015](../decisions/ADR-0015-provider-setup-credentials.md)、[ADR-0017](../decisions/ADR-0017-model-picker-alternate-screen.md)。

**验收**：

- 全新的 `NOCTURNE_HOME` 下运行 `nctrn setup` 完成配置后，不设任何环境变量即可 `nctrn` 进入会话并完成一次工具往返（CLI 与 TUI）。
- 会话内 `/provider add` 添加第二个服务商并切换过去，不重启进程、不触发 `SessionEnd`/`SessionStart` Hook、不重启 MCP 服务器；`/provider key` 更新密钥后下一次请求即生效。
- 首次真实请求失败时，对错误密钥、错误地址、错误模型 id 分别给出对应提示；向导不发送模型请求。
- 在任何预设（含 `full-access`）、任何规则与 Grant、`--yes` 下，`read`/`edit`/`grep`/`glob` 都读不到 `credentials.json`；`shell` 子进程环境中不含已解析的凭据变量。
- `config.json` 在整个流程中字节级不变；手写条目覆盖同名向导条目，`/provider` 正确标注来源层。
- `credentials.json` 与 `providers.json` 中不出现任何密钥明文；三个平台的凭据写入与读取过程中密钥不出现在子进程命令行参数里（Windows 实测，macOS/Linux 在可用环境实测，否则如实标注未验证）。
- 上游声明了限额的模型（commandcode 的 `context_length`、OpenRouter 的 `max_completion_tokens`）按声明值生效；最大输出长度未知时 openai-compatible 请求不含 `max_tokens`。
- 只用环境变量的 v0.1 配置方式行为不变（回归测试）。
- **模型选择页**（Windows Terminal 与 conhost 逐个场景截图核对）：打开后进入备用屏幕、关闭后对话内容完整；`←`/`→` 左右栏切换、打字进入搜索框过滤、`PageUp`/`PageDown` 翻页；从 `○` 预设进入 `/provider add` 流程并返回选中；右栏 `Enter` 的内联选项条完成「仅本会话」切换与「设为默认」（后者写入 `providers.json`）；详情行正确标注「当前会话」「默认模型」；窄终端（<80 列隐藏左栏、<40 列降级）行为正确；连续开关与 `Ctrl+C` 不残留备用屏幕。CLI 侧 `/model` 表格列信息与 `/model <关键词>` 过滤核对。

当前进度：实现与自动化测试完成，真实终端核对在 Windows Terminal 与 conhost 上进行过一轮（全新 `NOCTURNE_HOME` 走 `nctrn setup` 后不设环境变量完成工具往返；模型选择页连续开关、`Ctrl+C`、窄终端降级）。实施中实测出 Windows 控制台 stdin 在多次 `suspendTerminal` 周期后饿死的平台问题，修复与约束已写入 [ADR-0017](../decisions/ADR-0017-model-picker-alternate-screen.md)。macOS 钥匙串与 Linux Secret Service 后端按同一接口实现，无对应环境，未实测。维护者已于 2026-09-25 确认验收。

## 思考强度（随 0.2.0 发布；已完成，2026-09-25 验收）

**内容**：把 `ModelRequest.reasoningEffort` 从保留字段接通为统一能力——七档中性档位（`off | minimal | low | medium | high | xhigh | max`，无 `auto`）；可用档位按声明解析（逐模型 `capabilities.reasoningEffort` > 服务商 `thinking.levels` 用户声明 > 上游能力标记推导 > 无）；适配器归一化（openai 格式 `reasoning_effort`、openrouter 格式 `reasoning.effort`、anthropic `thinking.budget_tokens` 预算表 + `max_tokens` 调整）；会话配置经 `session.config_changed` 持久化与恢复；`setReasoningEffort` 允许 Turn 进行中、对下一个 Turn 生效（本 Turn 请求固定为 Turn 开始快照）；就近降档；子代理继承与 `finish` 兜底轮关闭思考；向导思考声明勾选与 `/provider thinking`；TUI Shift+Tab 循环与状态栏档位段；CLI `/effort`；400 定向提示。设计见 [ADR-0018](../decisions/ADR-0018-reasoning-effort.md)。

**验收**：

- 三种格式每个档位的请求体断言（`off` 时请求体不含任何思考字段）；Anthropic 预算与 `max_tokens` 调整及边界（压预算、抬 `max_tokens` 封顶、低于下限不发送）。
- 就近降档、声明来源优先级、`/provider refresh` 不覆盖 `thinking.levels` 用户声明各有测试。
- `session.created`/`config_changed` 持久化与恢复；`setReasoningEffort` 在 Turn 进行中可切换；非法/不支持档位报 `invalid_command` 并列出可用档位。
- 子会话 `session.created` 继承父档位（按子模型集合降档）；`finish` 兜底轮请求体不含思考字段。
- TUI：Shift+Tab（`\x1B[Z`）循环 `[off,…]`、状态栏档位段显隐、权限框内 Shift+Tab 反向焦点不切换；CLI：`/effort` 列表与切换、`/provider thinking` 编号勾选（非法输入重问）。
- 真实服务实测：commandcode `deepseek/deepseek-v4.1-flash`（openai 格式）与 OpenRouter `openrouter/free`（openrouter 格式）各以 `off`/`low`/`high` 跑一次；不支持档位触发 400 时给出定向提示。Anthropic 无端点，只做单测并如实标注。
- 真实终端核对（Windows Terminal 与 conhost 截图）：Shift+Tab 循环时状态栏变化、权限框内 Shift+Tab 不切换、`/provider thinking` 勾选界面、CLI `/effort` 输出。

当前进度：实现、自动化测试与真实服务实测完成（commandcode 的 openai 格式与 OpenRouter 的 openrouter 格式；commandcode 的 deepseek 对 `minimal` 返回 400 并给出定向提示）。Turn 进行中切换档位只更新会话设置，下一个 Turn 生效。Anthropic 格式无可用端点，仅单测覆盖，未实测。维护者已于 2026-09-25 确认验收。

## v0.3 — TUI 视觉改造与服务商页重构（随 0.3.0 发布；已完成，2026-09-26 验收）

**前提**：v0.2.0 已打标签（含思考强度）。

**内容**：TUI 视觉统一（集中主题常量、紧凑欢迎区、分段彩色状态栏、宽度降级）；`/provider` 改为服务商管理页（模型选择收归 `/model`）；向导去除选模型步骤；首次配置两步流程；交互模式默认 TUI。全屏渲染（[ADR-0020](../decisions/ADR-0020-tui-fullscreen-rendering.md)）：启动即进入 Ink 备用屏幕，增量渲染，帧高为行数减 1，对话区只渲染可见行；页面与浮层不再逐页切屏；斜杠补全与逐行 readline completer 共用命令表。设计见 [ADR-0019](../decisions/ADR-0019-tui-visual-provider-page.md)。

**约束**：服务商页只编排界面，业务逻辑复用 Core `wizard.ts` 编排与 RuntimeConfig 公开 API；颜色集中为一套主题常量，组件不直接写死色值；图标只用 Windows Terminal 与 conhost 都能显示的字符（emoji 与 Nerd Font 实测后再定）；本地提交不打标签不推送。

**验收**：

- 服务商页（TUI，Windows Terminal 与 conhost 各截图核对）：顶部 Logo/标题/副标题；预设与 `providers.json` 已有条目混排，已配置条目显示绿色 `● 已配置` 与密钥来源；`↑`/`↓` 选择、直接打字过滤、长列表滚动条；选中未配置预设在同页就地展开步骤（自定义才问名称/服务地址 → 掩码密钥/回车走环境变量 → `GET /models` → 上游未声明时档位勾选 → 保存），底部显示结果行；已配置条目的四个操作（换密钥/刷新模型列表/调整思考档位/删除）与 `/provider key|refresh|thinking|remove` 子命令等价；删除需确认、当前会话所用拒绝删除、手写层条目只读并提示文件；底部按键提示；Esc 返回/完成、Ctrl+C 退出后终端不停在备用屏幕。
- 首次配置：全新 `NOCTURNE_HOME` 下 `nctrn setup`（TTY）打开服务商页（第 1 步，共 2 步），Esc 后无默认模型自动进模型页（第 2 步）可"设为默认"；未配置时 `nctrn` 同流程；`nctrn setup --cli` 与 `/provider add` 逐行向导不再询问模型与默认模型，配置完第一个服务商后提示"用 /model 选择模型"。
- 向导行为：fake fetch 断言全程只发 `GET /models`；上游未声明思考能力时出现档位勾选并写 `thinking.levels`（`source:"user"`）；401/403 提示密钥可能无效但不阻塞保存。
- TUI 视觉：欢迎框只画一次，左栏 Logo+当前模型/服务商，右栏操作提示/MCP 状态（失败标红含简短原因）/最近会话（≤3 条）；<80 列降级单栏、<40 列不显示；启动警告在欢迎框下方输入框上方分块醒目着色；输入框上下各一条横线；状态栏分段着色以 `·` 分隔（模型/思考档位/权限预设/目录/上下文占用"已用/上下文长度"，未知长度只显示已用），不含会话 id；Turn 中切档显示"旧档→新档"并变色，不显示"（下一轮生效）"；颜色全部来自主题常量。
- 模式选择：stdin/stdout 均 TTY 时 `nctrn`（含 `-c`/`--resume`）默认 TUI；`--cli` 逐行 REPL；`--tui` 与 `--cli` 互斥（退出码 2）；非 TTY 自动逐行模式不因默认选择报错；`-p` 行为不变；显式 `--tui` 在非 TTY 报错退出 2。
- 自动化测试：服务商页列表/过滤/就地步骤/四操作/删除保护/只读/Esc/Ctrl+C；首次"服务商页 → 模型页"衔接；欢迎框与状态栏多宽度降级；Turn 中切档状态段；TTY 与非 TTY 模式选择、互斥、`-p`；逐行向导不问模型；既有 `/model` 页与向导测试回归。
- 全屏：帧高为行数减 1；翻页与「有新内容」提示；退出路径恢复主屏并打印继续提示；浮层开关不丢输入；Shift+Tab / Alt+M 不插入对话条目；状态栏 `0.1% / 1M` 与模型段；补全排序、键位与三类参数补全；`--cli` completer。Windows Terminal 与 conhost 截图待维护者核对。
- 收尾：全量检查 `typecheck`/`lint`/`format:check`/`test`/`depcheck`/`build` 通过；文档同步完成。

当前进度：实现与自动化测试完成。真实终端核对：Windows Terminal 与 conhost 下用微软拼音实测主输入、`/model` 搜索、`/provider` 过滤三处候选窗跟随光标；欢迎区弯月两端截图；Windows Terminal 下粘贴真实多行需求原文。验收中发现并修复：浮层输入法光标被覆盖、长文本粘贴 `\r` 叠印（改为粘贴占位）、流式时正文开始后思考不再刷新、`full-access` 下带管道/重定向的命令整体降级为需确认（改为逐段求值）。ADR-0019、ADR-0020 转为已接受。上面列出的逐场景截图没有逐张拍摄，以维护者在真实配置下的上手验收代替。维护者已于 2026-09-26 确认验收。

这里记录的是 v0.3 验收时的行为；v0.4 的 [ADR-0021](../decisions/ADR-0021-tui-daily-usability.md) 在全屏上补了鼠标滚轮与拖动选中复制，并把普通屏幕回滚区方案保留为 `--inline` 备选。

## v0.4 — TUI 日常可用性（设计中）

**前提**：v0.3.0 已打标签并推送。

**内容**：全屏为默认并补上鼠标：滚轮滚动对话、拖动选中高亮并松开自动复制（系统剪贴板 + OSC 52）、退出时把对话打印到主屏；普通屏幕模式保留为 `--inline` 备选；`/new`（别名 `/clear`）；助手正文 Markdown 渲染；输入框编辑（Home/End、按词移动与删除、Ctrl+J 换行、最多 5 行的多行输入区）；Esc 中断当前 Turn；输入历史按工作区跨次保留；`/resume` 列表显示首句；`/preset`、`/effort` 不带参数时打开选择列表；思考默认折叠为一行、Ctrl+O 原位展开（由 v0.5 提前）；重写基础系统提示（工作方式、工具习惯、安全边界、沟通），环境信息补充 shell 语法说明，AGENTS.md 加优先级前言；清理 v0.3 遗留的过时文档。设计见 [ADR-0021](../decisions/ADR-0021-tui-daily-usability.md)（提议）。

**约束**：打开会话的逻辑仍只在 CLI 一份；输入历史读写经 Core 公开 API，客户端不直接读写 `NOCTURNE_HOME`；新增运行时依赖只有 `marked`（词法器）；剪贴板写入在 TUI 内完成、不经 Core；帧高（普通屏幕模式为活动区高度）不超过终端行数减 1；需要抢前台窗口的真实终端测试先征得维护者同意。

**验收**：

- `/new` 与 `/clear`：新会话沿用模型、档位、预设；旧会话可 `/resume` 找回；Turn 进行中拒绝；`--cli` 同样可用。
- 全屏（默认）：输入框与状态栏贴底；滚轮滚动对话，离开底部后不跟随并提示，滚回底部恢复；拖动选中高亮（含中文、跨折行、拖出视口边缘自动滚动），松开后粘贴到别处与所见一致；选区存在时 Ctrl+C 只复制不退出；打开关闭模型页与服务商页不丢输入；异常退出也关闭鼠标上报并恢复主屏；退出后主屏留有本次对话并打印继续提示。
- 普通屏幕（`--inline`）：说完的条目进入终端回滚记录，滚轮、拖动选中、终端搜索原生可用；长回复按块写入回滚区不丢字；模型页与服务商页开关后回到原位（Windows stdin 保护）。
- Markdown：标题、加粗、行内代码、代码块、列表、引用、表格（含窄终端退化）渲染正确；流式中未闭合结构不乱码、写进回滚区的都是完整块；中文与歧义宽度字符宽度正确。
- 输入框：各编辑键、Ctrl+J 与行尾 `\` 换行、多行区滚动与光标、首末行 ↑/↓ 回填历史、粘贴占位整体移动与删除；输入法候选窗在多行时跟随光标。
- Esc：按 ADR-0021 第 5 条的次序逐项生效；空闲 Esc 不退出不清空；Alt 组合不误中断。
- 历史：重启后 ↑ 可回填上次输入、只含当前工作区、超过 1000 条截断、粘贴原文还原为占位、写盘失败只告警。
- `/resume` 首句；`/preset`、`/effort` 选择列表（当前值高亮、不支持思考的模型给出说明）。
- 思考折叠：流式中一行计时加最多 4 行最新内容（块高固定不再增长）、结束后折叠为一行；同轮多段各自折叠；Ctrl+O 在对话区原位展开/收回全部思考（视口锚点不跳、状态栏提示）；`--inline` 下 Ctrl+O 打开完整记录页；退出导出跟随当前显示状态。
- 系统提示：真实模型对比新旧提示跑四类任务（修 bug、跨文件改动、只读问答、Windows 命令），记录是否先读后改、是否验证、shell 语法是否一次正确、回复语言是否跟随用户；上下文报告（`/context`）中基础提示与环境段字数更新。
- 全量检查通过；tui.md、cli.md、config.md、context.md、modules.md、view.md、THIRD-PARTY-NOTICES 同步；Windows Terminal 真实终端核对（conhost 不作为验收目标，见 ADR-0021）。

## v0.5 — Agent 能力补齐、智能权限与界面打磨（已排期，待设计）

**前提**：v0.4 验收。进入实现前先写 ADR。

**内容**：

- **任务清单工具**：长任务里模型列出步骤、逐项更新状态，界面显示进度；清单随会话持久化，恢复会话时还原。
- **向用户提问工具**：模型遇到需要用户拍板的问题时暂停并提问（可给选项），用户回答后继续；非交互模式下返回"无法提问"，由模型自行取默认。
- **网页抓取**：按 URL 抓取并转成文本交给模型，走权限层的 `network` 类；搜索不内置，交给 MCP。
- **`@文件` 引用**：输入框里 `@` 补全工作区路径，提交时把文件内容作为附件带入。
- **粘贴图片**：仅当当前模型声明支持图片输入时开放。
- **按模型提供 `apply_patch`**：为 GPT 系模型提供 Codex 格式的补丁工具，按模型能力声明选择给 `edit` 还是 `apply_patch`；优先级视维护者实际使用的模型而定。
- **智能权限预设 `auto`**：放行范围与 `full-access` 相同；原本需要用户确认的操作先交给审查模型判断，结果为放行、拒绝（理由回给主模型）或拿不准（照常询问用户）。
  - 审查模型只看命令、工作目录与用户最近几条消息，不看文件内容与工具输出（防提示注入）。
  - 内置硬拒绝与用户 `deny` 规则不可被放开；修改 Nocturne 授权配置（`config.json`、`trust.json`、Grant）始终由用户本人确认。
  - 审查模型超时、报错或输出格式不对时询问用户；非交互模式下拒绝。
  - 未配置审查模型时按 `full-access` 行为并提示一次去设置。
  - 每次审查决定写入会话日志（模型、理由），界面显示一行。文档写明这是基于模型的判断，不是安全边界。
  - 作为第五个独立预设，Alt+M 循环可达。
- **设置层与 `/settings` 页**：程序维护的 `settings.json`，与手写 `config.json` 分层合并、手写优先（程序仍不改写 `config.json`）。`/settings` 集中管理默认权限预设、默认思考档位、审查模型等偏好。
- **界面打磨**：
  - **配色**（先做，其余各项依赖它）：改用精确颜色值，一个主色、两到三档灰、低饱和的成功/警告/出错色仅用于表达状态；先做深色、浅色两套，用 `/theme` 打开选择页切换：页面下方用当前高亮的配色实时画一段示例（用户输入、带标题/代码/列表的回答、工具行、差异、权限提示、状态行），上下移动即预览，Enter 应用，Esc 恢复原配色；选择写入 `settings.json` 下次沿用；从未选过时默认深色。状态行统一为灰、只点亮最关键的一两项；Markdown 标题、代码、引用靠灰度与粗细区分。主色由维护者从预览页（候选配色分别放在浅色、深色背景上并排）中挑选。
  - **底部信息**：状态行补充生成速度（tokens/s）、缓存命中率、估算费用（服务商未返回对应数据或未声明价格时不显示该项），并加上下文用量条（已用/窗口与百分比）。
  - **思考折叠**：已提前到 v0.4（ADR-0021 第 11 条）。
  - **空会话欢迎区**：会话没有消息时，在活动区显示大号标识；首条消息发出后不再绘制，`/new` 后重新出现，`/resume` 恢复有历史的会话时不显示。放不下（标识、输入框与状态行合计超过终端行数减 1）时退化为单行标识。它不写入回滚区。
  - **对话节奏与会话标题**：用户输入前加 `❯`、助手回答前加 `●`；输入框边框显示会话标题（首句或自动生成），与 `/resume` 列表一致。

## v0.6 — 检查点与回退（已排期，待设计）

**前提**：v0.5 验收。进入实现前先写 ADR。

**内容**：

- **检查点**：每个 Turn 开始前记录本轮将被修改文件的原始内容（只覆盖经 `edit`/`write` 的改动；`shell` 造成的改动如实说明无法完整追踪）。
- **回退**：一条命令退回到某一轮之前，同时恢复对话与文件；回退前列出将被还原的文件。
- **会话分叉**：从某一轮岔出新会话尝试另一种做法，原会话不受影响。
- **用量与费用**：`/cost` 显示本会话 token 用量与按已知价格估算的费用（价格未声明时只显示用量）。

## v0.7 — 扩展与分发（已排期，待设计）

**前提**：v0.6 验收。进入实现前先写 ADR。

**内容**：

- **自定义斜杠命令**：项目 `.nocturne/commands/*.md` 注册为命令；**项目级自定义 agent**：复用 `trust.json` 的项目信任机制，设计定义文件的加载、权限收敛与提示词边界。
- **子会话 ask 冒泡**：按 [subagent.md](../architecture/subagent.md) 第 7.1 节方案 (a)，把子会话的确认请求路由到父客户端；**可展开的子代理进度**：结构化进度替代单行摘要。
- **MCP 强杀清理**：评估纯 Node 看护进程，detached 启动，主进程消失后清理 MCP 进程树；沿用会话锁的"开机时间 + PID"判定规避 PID 复用。**MCP 图片与二进制内容**正常显示。
- **分发**：npm 发布或单文件可执行，一行命令安装。
- **补验证**：macOS 钥匙串与 Linux Secret Service 实机验证；Anthropic 格式思考强度在真实端点验证。

## 之后（未排期）

RPC 服务端与远程客户端、OS 级沙箱、后台任务、Web / Desktop / IDE 客户端、模型选择页的本机实测首字延迟与吞吐列（tui.md 第 7 节预留列位）。进入排期前各自先写设计文档。
