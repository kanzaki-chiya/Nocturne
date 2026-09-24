# 可观测性（调试输出）

> 状态：已接受 v0.1（Phase 5 已验收）｜ 前置阅读：[events.md](../protocols/events.md)、[modules.md](modules.md)、[sessions.md](sessions.md)

诊断日志（diagnostics）是**开发/排障面的观察通道**：JSONL 格式的详细记录，覆盖模型请求、上下文构成、token、工具耗时、权限决定、Hook 与 MCP 调用。它与会话事件的分工：

- **会话事件**是协议事实与客户端渲染流（持久事件进会话日志，是恢复的事实源；临时事件驱动 UI），不承载调试细节。
- **诊断日志**是本地排障用的 verbose 记录，默认关闭，不持久化到会话日志，不影响恢复与事件序列。

## 1. 开关与输出位置

| 开关 | 说明 |
|---|---|
| `NOCTURNE_DEBUG=1` | 启用诊断（等价 `--debug`） |
| `--debug`（CLI 参数） | 启用诊断 |
| `NOCTURNE_DEBUG_FILE=<path>` | 输出文件（等价 `--debug-file`） |
| `--debug-file <path>` | 输出文件；`<path>` 为 `-` 时写 stderr |

优先级与行为：

- 未启用时零开销（空 sink，无 I/O）。
- 启用且未指定文件 → 写 `<NOCTURNE_HOME>/logs/debug-<yyyymmdd-HHmmss>-<pid>.jsonl`（每次进程启动一个文件）。
- 写文件失败 → `runtime.warning{code:"debug_sink_failed"}`，诊断降级为空 sink，Runtime 不受影响。
- `--debug` / `NOCTURNE_DEBUG` 只负责开关，文件位置永远由 `--debug-file` / `NOCTURNE_DEBUG_FILE` 或默认路径决定。

## 2. 记录格式

每行一个 JSON 对象：

```jsonc
{ "kind": "tool.exec", "time": "...", "sessionId": "...", "turnId": "...", "callId": "...", "durationMs": 123, ... }
```

公共字段：`kind`、`time`、`sessionId`；`turnId`/`callId` 按点位存在。单条记录字符串字段上限 16KB（超出截断并记 `truncated: true`），避免一个超大响应撑爆日志。

记录种类（按模块列）：

| kind | 模块 | 内容 |
|---|---|---|
| `config.load` | config | 各来源路径、信任状态、警告数（不记文件全文） |
| `session.open` | index | sessionId、cwd、workspaceRoot、resumed、加载耗时 |
| `provider.request` | agent | 完整 `ModelRequest`（messages、tools、参数）。请求头由 Provider 适配器构造、不含在 `ModelRequest` 里，天然不会进来 |
| `provider.result` | agent | finishReason、usage（token 明细）、耗时、text/toolCalls 概要 |
| `provider.error` | agent | ProviderError kind、message、retryable、attempt |
| `context.build` | context | 各段落名与字符/token 数、estimatedTokens、预算、是否裁剪/压缩（进 `context.section` 明细） |
| `tool.permission` | tools/gate | callId、工具名、subjects、action、source、命中规则描述、耗时 |
| `tool.exec` | tools/executor | callId、工具名、status、耗时、是否截断/落盘 |
| `hook.run` / `hook.done` | hooks | 点位、command、退出码、耗时、效果摘要（deny/allow/feedback 长度等）、stderr 尾部 |
| `mcp.event` | mcp | server、state、toolCount、error |
| `mcp.call` | mcp | server、tool、耗时、isError、结果大小 |
| `subagent.launch` / `subagent.attempt` / `subagent.done` | agent（subagent） | Phase 6：子 sessionId、`parentSessionId`/`parentCallId`、preset/tools、depth、turnIndex、status、usage、耗时（[subagent.md](subagent.md) 第 13 节） |

子会话内的记录（provider.*、tool.*、hook.* 等）照常携带它自己的 `sessionId`——按 `sessionId` 过滤即得子会话视角，按 `parentSessionId`/`parentCallId` 关联到父调用。

`hook.*` 与 `mcp.*` 由对应模块写入：`hooks` 用注入的 diagnostics；`packages/mcp` 通过 `McpOpenScope.diagnostics` 拿到同一个 sink。

## 3. 脱敏规则

写入前对每条记录做递归清洗：

1. **键名匹配** `/key|token|secret|password|authorization|credential|cookie/i` 的值一律替换为 `"***"`。
2. MCP 服务器配置的 `env`：只记变量名集合，值全部 `"***"`（无论键名——env 值是按配置进入子进程的敏感物）。
3. `Provider` 适配器内部的请求头不经过 `ModelRequest`，不落诊断；API key 加载路径（`NOCTURNE_API_KEY` 等）只记"是否存在"。
4. Hook/MCP 的 stderr、stdout 片段先清洗再写。

与会话事件相同的底线：**凭据不得出现在诊断文件里**（events.md 第 5 节同一条规则适用于此通道）。注意诊断日志会记录工作区内容（文件读写、提示词、工具输入输出）——它是给本机排障用的，开启即接受这一点；文件按本地默认 ACL 创建，不上传。

## 4. 模块位置与接线

- 实现：`packages/core/src/diagnostics/`（内部模块）。依赖 `protocol`、`platform`；向上被 `agent`、`context`、`tools`、`hooks`、`index` 使用；`packages/mcp` 通过注入拿到 `Diagnostics` 接口（协议类型定义在 `tools`，与 `McpConnector` 同处）。
- 接线：`createRuntime` 读 `RuntimeOptions.debug?: { enabled?: boolean; file?: string }` 构造 sink（文件 sink 用 `platform.fs` 追加写），经 `TurnDeps`/`ExecuteEnv`/`HookRunner`/`McpOpenScope` 传入各模块。未启用时传 noop。
- CLI：`--debug`、`--debug-file` 映射到 `RuntimeOptions.debug`；env 变量在 `apps/cli/src/config.ts` 解析。

## 5. 暂不设计

- **traceId / 分布式追踪**：RPC 化之后再引入，届时 `kind` + `sessionId` + `callId` 已能串起本次链路。Phase 6 评审过这个口径：父子会话关联已由 `session.created.parent` 的类型化字段覆盖，进程内没有第二个消费方，决定维持推迟（[subagent.md](subagent.md) 第 13 节）。
- **日志轮转/保留策略**：每次启动一个文件、由用户清理；日志量随使用增长，待有实际负担再做。
- **诊断事件进 TUI**：`/doctor` 式的状态面板属于客户端功能，诊断文件本身不驱动 UI。
