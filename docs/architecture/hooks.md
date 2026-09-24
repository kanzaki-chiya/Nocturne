# Hooks

> 状态：提议 v0.1（Phase 5 设计）｜ 前置阅读：[tools.md](tools.md) 第 3 节、[permissions.md](permissions.md)、[config.md](config.md)、[ADR-0008](../decisions/ADR-0008-project-trust-grants.md) ｜ 决策：[ADR-0012](../decisions/ADR-0012-hooks.md)

Hook 是**配置驱动的外部命令**：Runtime 在固定事件点上启动一个子进程，stdin 传入 JSON 上下文，读取 stdout 的 JSON 结果（或退出码语义），把结果作为**输入/建议**合并进既有管线。Hook 不是事件系统插件——它不能调用 Runtime 内部 API，只能在自己的事件点上做契约允许的有限动作。

## 1. 事件点

| 事件点 | 触发时机 | 目的 | 可用的效果 |
|---|---|---|---|
| `PreToolUse` | 管线第 2 步（输入校验）通过之后、第 3 步（权限主体计算）之前 | 拦截或改写工具输入 | `deny` 直接拒绝；`ask` 强制走确认；`updatedInput` 修改输入后**重新校验**。没有 `allow`：此点在主体解析之前运行，看到的是未解析的原始输入（如 `foo/link`），放行等于批准一个解析后才知道目标的操作——放宽只走 `PermissionRequest` |
| `PermissionRequest` | 规则求值为 `ask` 之后、发出 `permission.requested` 之前 | 把确认自动化（如 CI 策略、审批网关） | `allow` / `deny` 直接结算（无输出字段 = 继续询问用户）；唯一能放宽 `ask` 的 Hook 点，因为它能看到已解析的权限主体 |
| `PostToolUse` | 工具执行返回之后、结果归一化（第 8 步）之前 | 追加反馈给模型 | `feedback` 追加进 `modelContent`（有上限，见第 4 节）；不能改结果状态 |
| `TurnStart` | `turn.started` 与 `message.user` 写入之后、Agent Loop 开始前 | 提交级拦截 | `block: true` + `reason` → Turn 以 `error`（`hook_blocked`）结算 |
| `TurnEnd` | `turn.completed` 写入之后 | 审计/统计 | 无效果（仅通知） |
| `SessionStart` | 会话打开完成后（新建与恢复都触发） | 环境准备、外部记账 | 无效果（仅通知） |
| `SessionEnd` | `session.close()` 内、清理开始前 | 清理、审计 | 无效果（仅通知） |

取哪些点的理由：

- `PreToolUse` / `PostToolUse` 是 tools.md 预留的两个点位，覆盖绝大多数用途。
- `PermissionRequest` 解决真实需求：团队想在 `ask` 时自动放行"安全"操作、自动拒绝"危险"操作，而不是每次问人。它与 `PreToolUse` 有重叠但语义不同——前者在**权限主体已解析**之后运行，能拿到精确的权限请求内容（`mcp github/push` 而不是模糊的工具名）。
- `SessionStart` / `SessionEnd` 是生命周期里唯二不耦合 turn 节奏的点（恢复会话时也会触发 `SessionStart`，便于"恢复后继续"场景）。
- `TurnStart` / `TurnEnd` 提供提交级拦截与审计；`TurnStart` 放在 `message.user` **之后**是有意的——被拦截的输入仍然落进持久日志，可审计。
- **不做**：`ModelRequest`/`ModelResponse`（采样级 Hook 会把模型上下文暴露给外部进程，信任与脱敏问题另议）、`Compact`（Phase 6 上下文压缩的接入点，届时设计）。

## 2. Hook 的形态与契约

每个 Hook 条目是一条外部命令：

```jsonc
// config 中 hooks 段
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "mcp_*|shell", "command": "node", "args": ["./hooks/guard.js"], "timeoutMs": 5000 }
    ]
  }
}
```

| 字段 | 说明 |
|---|---|
| `matcher` | 字符串通配符（与权限规则同一套匹配，permissions.md 5.1），仅 `PreToolUse`/`PostToolUse`/`PermissionRequest` 有效，匹配工具名（`mcp__github__push`）；缺省 `"*"` |
| `command` / `args` | 可执行文件与参数数组，**不经 shell 解释**（平台差异可预期；要写 shell 逻辑自己 `cmd /c` 或 `sh -c`） |
| `timeoutMs` | 默认 5000，上限 60000 |

运行契约（每个被触发的条目一次调用 = 一个进程）：

- **stdin**：单个 JSON 对象，`Content-Type` 隐含 UTF-8，写完关闭。字段：
  - 公共：`point`（事件点名）、`sessionId`、`cwd`、`workspaceRoot`、`turnId?`
  - `PreToolUse`/`PermissionRequest`/`PostToolUse`：加 `callId`、`tool`、`input`；`PermissionRequest` 加 `subjects`（已解析权限主体数组）与 `permission`（当前求值结果 `{action, reason, rule?}`）；`PostToolUse` 加 `result`（工具返回的 `{status, modelContent 前 4000 字符, error?}`）
  - `TurnStart`：加 `text`（用户提交原文）；`TurnEnd`：加 `reason`、`steps`、`usage`；`SessionStart`：加 `resumed`（是否恢复会话）；`SessionEnd`：加 `reason`
- **stdout**：单个 JSON 对象（可选；空输出视为"无效果"）。允许字段按点位限定，多写字段忽略；无法解析为 JSON 记失败。
- **stderr**：进诊断日志（observability.md），不进会话事件。
- **退出码**：`0` = 成功（按 stdout 的 JSON 生效）；非零 = 失败，stdout 忽略。
- **环境**：继承 Runtime 进程环境（Hook 是用户自己写的脚本，定位与本地工具一致），另注入 `NOCTURNE_HOOK_EVENT`、`NOCTURNE_SESSION_ID`、`NOCTURNE_WORKSPACE_ROOT`、`NOCTURNE_CWD`。注意这与 MCP 服务器不同——MCP 子进程只拿白名单环境（mcp.md 第 3 节），因为第三方服务器不该默认看到 Provider 凭据；Hook 进程经 `platform.spawnPipe` 启动，超时/失败时进程树终止——与 MCP 同一套 platform 能力。

按点位的输出契约：

| 点位 | stdout JSON 允许的字段 |
|---|---|
| `PreToolUse` | `{ "decision": "ask" \| "deny", "reason"?: string, "updatedInput"?: unknown }`（无 `allow`，理由见第 1、3 节；`decision` 缺省 = 无意见） |
| `PermissionRequest` | `{ "action": "allow" \| "deny", "reason"?: string }`（无字段/无输出 = 继续询问） |
| `PostToolUse` | `{ "feedback"?: string }`（追加进 `modelContent`，上限 4000 字符，超出截断） |
| `TurnStart` | `{ "block"?: boolean, "reason"?: string }` |
| `TurnEnd` / `SessionStart` / `SessionEnd` | 忽略所有输出 |

同一事件点多个条目**按配置顺序串行执行**：`PreToolUse`/`PostToolUse` 后续条目看到前一个条目的 `updatedInput`（链式修改）；`deny` / `block` 结算后短路，不再执行后续条目。

## 3. PreToolUse 的权限边界

`PreToolUse` 的输出合并进管线第 5 步的权限求值，规则是**只能收紧**：

- Hook `deny`：立即拒绝。发出 `permission.resolved{action:"deny", source:"hook"}`（`source` 枚举新增 `"hook"`），然后 `tool.completed{status:"denied", error.code:"hook_denied"}`——拒绝始终有持久记录。
- Hook `ask`：求值结果不是 `deny` 时强制走确认流程（规则已是 `deny` 则仍 `deny`），请求原因标注来自 Hook。**由 Hook 强制的 `ask` 不走 Grant 匹配与 `--yes`/`autoApproveAsk` 提升**（permissions.md 5.3、5.5）——否则 Hook 的收紧会被既有授权或命令行提升静默抵消；它仍先经 `PermissionRequest` Hook，无回答才询问用户。
- `updatedInput`：替换输入后**重新走第 2 步校验**；校验失败按 `invalid_input` 结算（模型看到"Hook 修改后的输入不合法"）；修改后的输入进入后续步骤与 `tool.completed.input`。Hook 只能改 input 的值，不能换工具、不能改 callId/turnId。

**为什么没有 `allow`**：PreToolUse 在权限主体解析（管线第 3、4 步）之前运行，它看到的 `input` 是未解析的原始值——`foo/link` 可能解析到工作区外。允许它在这里放行，等于根据未解析输入批准了一个解析后才知道目标的操作。唯一能放宽 `ask` 的点位是 `PermissionRequest`（第 1 节），它拿到的是解析后的主体。

PreToolUse **不能**做的事（设计边界）：

- 不能生成 Grant（`remember` 语义只属于用户确认路径）；
- 不能放宽权限（无 `allow`，见上）；
- 不能注入模型上下文（`updatedInput` 是工具参数，不是提示词）；SessionStart 同理（本阶段 Hook 无上下文注入通道，见第 8 节）。

## 4. 超时、失败、输出过大

| 情况 | 处理 |
|---|---|
| 超时（`timeoutMs` 到点） | 进程树强杀；本次 Hook 记失败 |
| 非零退出 / stdout 无法解析为 JSON | 记失败 |
| stdout 超上限（64KB） | 截断读取后按"无法解析"记失败 |
| 进程 spawn 失败（命令不存在等） | 记失败 |

**Hook 失败 = 无效果 + 警告**，不阻塞管线：发 `runtime.warning{code:"hook_failed"}` 并把命令、退出码、stderr 尾部写进诊断日志。理由：Hook 是可选的自动化增强——若因 Hook 故障而让内置工具全部不可用，等于把 Runtime 的可用性绑在脚本正确性上；`deny`/`block` 该拦截的场景下，Hook 若执行失败则该条目"没有说话"，后续规则与人工确认照常兜底。唯一例外是 `PermissionRequest`：Hook 失败 = 没有回答 = 继续询问用户，天然闭环。

Hook 调用的耗时计入诊断（`hook.run` 记录），不占 `tool.exec` 的计时（工具执行时长不含 Hook 耗时；`tool.permission`/`tool.exec` 分界见 observability.md）。

## 5. 信任与权限的关系

- **配置来源与分层**：`hooks` 段出现在用户配置与项目配置；按事件点分组合并，同名点位**追加**（用户级在前，项目级在后，执行顺序即此顺序）。
- **项目级 Hook 的信任**：复用 `trust.json` / ADR-0008——`.nocturne/config.json` 的 `hooks` 段在**未信任时整段不执行**（不只是输出受限），并随 `project_config_untrusted` 警告提示。理由：Hook 条目是任意命令，"运行但把输出 clamp 到收紧"并不安全——进程一旦运行就能做任何事（网络外传、改文件），输出语义约束不了它。"未信任的 Hook 只能收紧"在本设计中具体化为：**未信任的 Hook 没有机会产生任何影响**；而放宽 `ask` 的能力只属于 `PermissionRequest`（且其 `allow` 永远越不过 `deny`）。
- 用户级 `hooks` 永远可信（用户配置本来就等同于用户意图）。
- 命令的相对路径按 `workspaceRoot` 解析——项目 Hook 里 `./hooks/guard.js` 是可移植写法。

## 6. 与权限管线的接线

```text
执行器（tools/executor.ts）
  2. 校验 input
  2.5 PreToolUse: runner.run("PreToolUse", {callId, tool, input})
        deny  → permission.resolved(source:"hook") + tool.completed(denied, hook_denied)
        ask   → 记 hookAdvice，进第 5 步强制确认（跳过 Grant/--yes 提升）
        updatedInput → 重新校验后继续
  3-4. 主体计算、资源解析（不变）
  5. 权限求值（permission.evaluate，不变）
        规则 deny → deny（hookAdvice 无效）
        hookAdvice=ask 且非 deny → 强制确认：先经 PermissionRequest Hook，
                  无回答则走既有 interactive 询问 / 非交互拒绝；Grant 与
                  autoApproveAsk 提升不适用（permissions.md 5.3）
        规则 ask → PermissionRequest Hook：allow/deny 直接结算(source:"hook")；
                  无回答 → Grant / --yes 提升 → interactive 询问 / 非交互拒绝
  6-7. tool.started、执行（不变）
  7.5 PostToolUse: runner.run("PostToolUse", {...，result 摘要})
        feedback 追加进 modelContent（含在归一化预算内）
  8-9. 归一化、tool.completed（不变）
```

`HookRunner` 接口（`run(point, input, signal?) → Promise<HookOutput | undefined>`）定义在 `tools`，实现在 `packages/core/src/hooks/`（依赖 protocol、platform、diagnostics；见 modules.md）。`hooks` 配置在 `forWorkspace` 解析时带入会话，`wrapSession` 构造 runner 并注入执行器、gate 与会话生命周期；`runner` 为 `undefined` 或点位无匹配条目时行为与 Phase 4 完全一致。

**不变量**：未配置任何 Hook 时，事件序列、管线步序、权限结果与 Phase 4 逐项一致（测试断言）；配置了 Hook 但未匹配到条目时同样不产生任何可观测差异。

## 7. 事件与诊断

- 不为 Hook 新增持久事件：Hook 是运行态自动化，其效果已经体现在既有持久事件里（`permission.resolved`、`tool.completed`、`turn.completed`）；写 Hook 专属持久事件会提高恢复兼容成本而无对应收益。
- `PermissionSource` 增加 `"hook"`；`permission.resolved.source = "hook"` 是 Hook 决策的唯一持久痕迹（`rule` 字段记 Hook 描述：`hook PreToolUse <command>`）。
- 每次 Hook 执行（含失败）写诊断记录 `hook.run` / `hook.done`（observability.md），包含点位、命令、耗时、退出码、效果摘要。

## 8. 暂不设计

- **上下文注入**（SessionStart 返回"附加系统提示"、UserPromptSubmit 改写提示词）：需要上下文构成协议的扩展，等上下文压缩阶段一并设计；本阶段 Hook 只做控制流与反馈。
- **ModelRequest / 采样级 Hook**：把模型请求暴露给外部进程涉及凭据与内容边界，另议。
- **Hook 内嵌脚本**（`command: "inline"`）：外部文件已经够用；内嵌会引入引号/转义与平台差异。
- **并行执行同一事件点**：串行顺序可预期且便于链式 `updatedInput`；并行没有迫切场景。
- **Hook 长驻进程**（一次性 spawn 每次调用的成本可接受；守护进程协议复杂度不值当）。
