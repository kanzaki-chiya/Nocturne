# ADR-0013：Subagent——注入式 launcher、非交互权限收敛、普通会话日志

- 状态：提议
- 日期：2026-09-24

## 背景

Phase 6 引入子代理：父会话的模型调用一个工具，启动一条独立的子会话运行受控 Turn，结果作为工具结果返回。三个决定相互咬合、影响多个模块且难以事后逆转：

1. **编排能力如何到达工具层**：启动子会话需要 `runTurn`（agent 模块），而 `tools` 不得 import `agent`（modules.md 第 5 节的预留约束）。
2. **子会话的权限边界**：子会话可能执行写文件、跑命令。需要保证它的有效权限不宽于父会话，并决定 `ask` 在没有人可问的子会话里如何处理。
3. **子会话的持久化形态**：是新建一种"子会话"实体，还是复用普通会话日志。

## 决定

1. **注入式 launcher**：`SubagentLauncher` 接口定义在 `tools`（与 `HookRunner`/`McpConnector` 同一手法），内置 `task` 工具以 `createTaskTool(launcher)` 工厂构造；实现 `createSubagentLauncher` 放在 `agent`（它是唯一能 import `runTurn` 的地方），由 `core/index` 的 `wrapSession` 装配并注册。依赖方向不变，无循环。
2. **非交互权限收敛**：子会话的 `PermissionGate` 以 `interactive: false` 构造——`ask` 一律 `deny(source: "non_interactive")`，没有冒泡到父会话客户端的确认通道。子策略用与父会话相同的输入重建（同一预设、合并规则、项目 Grant、共享的会话 Grant 数组、`autoApproveAsk`），`presetContext.sessionId` 换为子会话 id。由此子会话的每个 `allow` 都等于父会话的自动判定，唯一差异是"需要人确认"在子会话里直接拒绝。
3. **子会话就是普通会话**：一条独立 JSONL 日志 + 锁，同一个 `runTurn`，同一个执行管线，恢复修复语义沿用。父子关联以 `session.created` 新增的兼容可选字段 `parent: { sessionId, callId }` 持久记录。**不新增任何事件类型**；子会话进度经 `tool.progress(stream:"info")` 一行式转发到父会话。
4. **结束协议**：子会话注册表内含仅其可见的 `finish` 工具；launcher 通过 `TurnDeps.shouldFinish` 注入的谓词结束子 Turn；缺 `finish` 时有上限的催促轮次，末轮以 `ModelRequest.toolChoice` 强制调用。
5. **`traceId` 推迟到 RPC 阶段**：父子关联已由 `parent` 字段覆盖，进程内没有第二个消费方；events.md 原预留措辞相应改写。

## 后果

- 子会话在 `default` 等交互式预设下**无法执行需要确认的操作**（写文件、shell、多数 MCP 调用），`explore` 预设（只读工具集）不受影响；`--yes`、预写规则、会话/项目 Grant 与 `PermissionRequest` Hook 是既有且足够的放行通道。这是"安全默认"的有意取舍，见 [subagent.md](../architecture/subagent.md) 第 7 节的方案比较。
- 事件协议表面零增长（只有一个可选字段），重放等价与旧版本兼容不受影响；子会话日志自洽闭合，崩溃后按既有惰性修复处理。
- `tools`/`agent`/`session`/`permission`/`provider-api` 各有一处小扩展点，全部为可选新增；`runTurn` 增加 `shouldFinish`/`toolChoice`/`basePrompt` 注入点，语义仍与工具无关。
- 默认 `maxDepth = 1`：子代理默认不能嵌套派生，上限可由 `RuntimeOptions.subagent` 调整。
- 以后若要支持"子会话 ask 冒泡到父客户端"，在 `PermissionGate` 增加 `forwardAsk` 委托即可，不需要推翻本决定（[subagent.md](../architecture/subagent.md) 7.1）。

## 备选方案

- **ask 冒泡到父会话客户端**（subagent.md 7.1 方案 a）：能力最完整，但需要跨会话的请求路由与事件呈现（外来 `callId` 进父日志，或新事件类型 + reducer 扩展），为一组新失败模式付出持久协议成本；当前阶段用收紧语义已可覆盖目标场景。
- **父会话批准 `task` 即授权整个子任务**（oh-my-pi 的 `approvalMode: yolo` 式做法）：子会话内不再逐项把关，与"继承或收紧"的硬约束冲突，拒绝。
- **子会话作为特殊实体类型**（独立的生命周期与恢复代码）：违反"子会话是普通会话"原则，等于复制第二套会话机制，拒绝。
- **现在就引入 `traceId`**：没有消费方的信封字段属于为假想需求设计；父子关联已由类型化字段表达，推迟到 RPC 阶段。
