# MCP（Model Context Protocol）客户端

> 状态：已接受 v0.1（Phase 5 已验收）｜ 前置阅读：[modules.md](modules.md)、[tools.md](tools.md)、[permissions.md](permissions.md)、[config.md](config.md) ｜ 决策：[ADR-0011](../decisions/ADR-0011-mcp-client.md)

Nocturne 作为 MCP **客户端**接入外部 MCP 服务器：把服务器提供的工具包装成 `ToolDefinition`，经与内置工具完全相同的注册接口与执行管线运行。本阶段只接入 MCP 的 **tools** 能力；resources、prompts、sampling 等其余能力见第 9 节"暂不设计"。

## 1. 定位与原则

- MCP 工具不是特权通道：`ToolDefinition` 接口、执行管线九步、权限求值、结果预算对它一视同仁，Agent Loop 与执行器中不出现任何 MCP 分支（`mcp__` 前缀只是工具名）。
- **Core 不依赖 MCP 实现**：客户端代码在独立包 `packages/mcp`（`@nocturne/mcp`，引入官方 SDK 的代价不落到 `@nocturne/core` 上，见 [repository-layout.md](../development/repository-layout.md) 第 2 节与 ADR-0011）。Core 只通过 `RuntimeOptions.mcp` 接收一个符合 `McpConnector` 接口的对象（接口类型定义在 `tools`，见第 8 节），由客户端（`apps/cli`）负责装配。
- MCP 服务器是**会执行的配置**：`command` + `args` 意味着启动任意进程，因此项目级 MCP 配置的信任复用 ADR-0008 的 `trust.json` 语义（第 3 节），不另起一套机制。

## 2. 传输

| 传输 | 本阶段 | 理由 |
|---|---|---|
| **stdio**（子进程 + 换行分隔 JSON-RPC） | **做** | Coding Agent 场景的绝对主流形态（`npx`/`uvx`/本地脚本）；进程生命周期由 platform 统一管理，崩溃清理、进程树终止与 `shell` 工具同一套保证 |
| Streamable HTTP（远程服务器） | **做** | SDK 1.30.0 的 `StreamableHTTPClientTransport`，支持静态请求头和凭据库引用；不做 OAuth、旧版 SSE 和自动重连（ADR-0047） |
| SSE（旧版 HTTP+SSE） | 不做 | 已被 Streamable HTTP 取代，不为已废弃传输投入 |

stdio 传输**不**使用 SDK 自带的 `StdioClientTransport`（它内部自行 `spawn`，进程管理绕过 platform）：`packages/mcp` 实现一个符合 SDK `Transport` 接口的自定义传输，底层走 platform 新增的 `spawnPipe` 能力（第 8 节），从而获得与 `shell` 一致的进程树终止（Windows `taskkill /T /F`、POSIX 进程组）与 `windowsHide` 行为。

## 3. 配置格式与分层

`ConfigFile` 新增 `mcp` 段（[config.md](config.md) 第 2 节的共用 schema）：

```jsonc
{
  "mcp": {
    "servers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
        "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
        "cwd": ".",
        "enabled": true,
        "startupTimeoutMs": 15000,
        "callTimeoutMs": 60000
      }
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `type` | `stdio` / `http`，省略为 `stdio`。两类专属字段不能混写，无效条目逐条忽略并警告 |
| `url` | HTTP 必填；只允许 HTTPS 或回环 HTTP（localhost、127.0.0.0/8、::1），拒绝内联凭据 |
| `headers` | HTTP 专属；字符串或 `mcp.json` 专属的 `{ stored: true }`，字符串支持 `${NAME}`，疑似字面凭据拒绝 |
| `command` | 可执行文件（必填）。经 `platform.spawnPipe` 启动，不经 shell 解释——参数用 `args` 数组，不做引号解析 |
| `args` | 参数数组，原样传递 |
| `env` | 显式传给该服务器的变量，叠加在**白名单默认环境**之上（见下）。值中的 `${NAME}` 启动时从 Nocturne 进程环境展开；引用的变量不存在时展开为空字符串并记警告（`mcp_env_missing`）。**禁止内联凭据**：与 `providers` 条目同规则，env 值只应引用环境变量名（`${NAME}` 形式），出现疑似凭据字面量的字段按 `config_credential_rejected` 拒绝该层文件——见 config.md 第 2 节的既有约定扩展 |

**子进程环境 = 白名单 + `env` 覆盖**：MCP 服务器默认**不继承** Nocturne 的完整进程环境——第三方服务器（`npx` 拉起的包等）不该默认拿到 `NOCTURNE_API_KEY`、`ANTHROPIC_API_KEY` 这类 Provider 凭据。白名单参照 SDK `getDefaultEnvironment()` 的平台基线：`PATH`、`HOME`/`USERPROFILE`、`APPDATA`、`SystemRoot`/`SYSTEMDRIVE`、`TEMP`/`TMP`、`ComSpec`、`TERM`、`LANG`/`LC_*`、`NODE_*` 之外不含任何 `*_KEY`/`*_TOKEN`/`*_SECRET` 形变量；用户要传更多变量必须经 `env` 显式声明（值可用 `${NAME}` 引用宿主环境）。这与 Hook 不同：Hook 是用户自己写的本地脚本，继承完整环境（hooks.md 第 2 节）。
| `cwd` | 服务器工作目录；缺省会话 `cwd`。相对路径按 `workspaceRoot` 解析 |
| `enabled` | 缺省 `true`；`false` 时跳过该服务器（保留配置便于切换） |
| `startupTimeoutMs` | spawn + initialize + tools/list 的超时，默认 15000 |
| `callTimeoutMs` | 单次 `tools/call` 默认超时，映射为 `ToolTraits.timeoutMs`，默认 60000 |

分层与合并：

- **来源**：程序维护的 `<NOCTURNE_HOME>/mcp.json`（`{ version: 1, servers: {...} }`，origin 为 `app`），与 `providers.json` 同级，低于所有手写配置；用户 `config.json` 与项目 `.nocturne/config.json` 分别为 `user` / `project`。环境与 CLI 层不提供 MCP 配置。写入使用共享串行队列与临时文件 + rename，损坏文件忽略并警告，单条无效只忽略该条。
- **合并**：按服务器 id 浅合并；同 id 的 `type` 不同时，高层整条替换低层，不继承另一种传输的字段。
- **凭据**：只有 `mcp.json` 的 `env` / `headers` 允许 `{ stored: true }`。启动前从注入的 CredentialStore 取 `mcp/<serverId>/<name>`（请求头名转小写）；缺失时 failed 并警告 `mcp_secret_missing`，不包含值。`none` 后端拒绝保存 stored；删除条目、移除 stored 或切换类型同步删除旧凭据。密钥不进入合并配置、事件、诊断或错误。
- **信任**：项目配置的 `mcp` 段是**可执行内容**——未信任时整段忽略（不是收紧语义；规则可以只收紧，但"启动哪个进程"没有收紧方向），并随 `project_config_untrusted` 警告一并提示。`nctrn trust` 后生效。用户级配置始终可信。
- 合并产物进入 `ResolvedConfig.mcpServers`（`origin: "app" | "user" | "project"`），由 `forWorkspace` 按工作区与信任状态输出。相对 cwd 按会话工作区解析。

## 4. 服务器生命周期

HTTP 的启动是连接 → initialize → tools/list，受启动超时约束；停止时有 session id 先 DELETE，再关闭传输。使用 Node 内置 fetch，遵循入口 `configureEnvProxy()` 的全局代理。fetch 注入点逐跳检查同源重定向，跨域拒绝为 `http_redirect`；401/403 为 `auth_required`。HTTP 不自动重连，中途请求失败或连接断开记 failed，发 `mcp.server`，在途工具调用返回错误；可停用后再启用。

每次配置重载都对已打开会话调用 `McpSession.reconcile(servers)`。按 id 比较规范化配置与当前 stored 值的摘要：新增/启用启动，删除/停用停止，内容变化先停再启，无变化不动。空闲立即执行；Turn 内暂存到结束边界，更新注册表供下一 Turn 使用，子会话仍持父 Turn 的工具快照。广播逐会话隔离：配置已落盘，某个会话应用失败时只在该会话发 `runtime.warning(code="config_apply_failed")` 并记诊断 `session.config_apply_failed`，其余会话照常生效，请求本身不因此失败；技能、外部 agent 与服务商的广播同样处理。

```text
会话打开（wrapSession，新建与恢复同样处理）
  → open() 立即返回 McpSession，各服务器 starting，后台并行启动（不超过各自 startupTimeoutMs）
    ├── spawn（platform.spawnPipe）→ initialize 握手 → tools/list → staged 暂存工具
    └── 失败/超时 → 服务器记 failed，发临时事件 mcp.server + runtime.warning，不写打开时 warnings
会话运行中
  ├── 主 Turn 已开始、首次请求前 startup(signal) 等待初始启动结束，可中断
  │   → 复用 applyMcp / applyPendingTools，将暂存工具并入注册表
  ├── tools/call 经执行管线（第 5、6 节）
  ├── tools/list_changed 通知 → 重新 tools/list 并**暂存**，下一个 Turn 边界才切换
  │   注册表（Turn 内工具集与上下文前缀保持稳定，不打断进行中的请求，也保住
  │   Provider 侧提示缓存命中）；崩溃重连后重新拉到的工具列表同样按此规则
  └── 进程退出/传输错误 → crashed；在途调用以 mcp_unavailable 结算
会话关闭（session.close，含 failed 路径）
  → 并行关闭全部连接：先给至多 2 秒让对端响应 stdin EOF/自行退出，随后进程树强杀
```

- **作用域是会话**：服务器集合由会话的 `workspaceRoot` 与信任状态决定（不同会话的项目配置可以不同），进程随会话关闭终止。同一 Runtime 下两个会话各自持有自己的服务器进程，不共享。
- **并行启动、不阻塞打开**：McpSession.startup(signal?: AbortSignal): Promise<void> 等待所有初始启动结束，每台从开始启动算起限时 startupTimeoutMs，不从调用等待算起；中止仅停止等待，后台继续。成功工具走 staged / applyPendingTools 暂存切换路径；超时服务器记 failed、不注册工具，mcp.server 与 runtime.warning 照常发出，/mcp 可见。主 Turn 持久化用户消息后、首次请求前等待与切换；子代理与压缩不等待。关闭取消仍在启动的连接并沿用进程树清理，不等待后台启动超时。
- **崩溃与重连**：进程在会话中途退出 → 状态 `crashed`，发 `mcp.server` + `runtime.warning(code="mcp_server_crashed")`；在途 `tools/call` 以 `mcp_unavailable` 失败。**惰性重连**：对崩溃服务器的下一次调用触发一次重连尝试（重新 spawn + initialize + tools/list），成功后恢复；每个会话每台服务器至多重连 3 次，超过后记 `failed` 不再尝试——避免反复拉起一个必崩的进程。
- **Runtime 关闭清理**：`session.close()` 关闭本会话全部 MCP 连接（含 `failed`/`crashed` 状态的残留进程）。**已知限制（Windows、POSIX 均适用）**：Nocturne 主进程被强杀时，无法执行主动清理；MCP 服务器的 stdin 管道会关闭。若服务器响应 EOF 自行退出，就不会残留；若服务器忽略 EOF 并继续运行，就可能成为孤儿进程。Windows 当前没有用 Job Object 绑定生命周期；POSIX 虽用独立进程组，但主进程强杀后也不会自动向该组发信号。手动清理前先核对服务器命令行及 PID：Windows 使用 `taskkill /PID <PID> /T /F`；POSIX 使用 `kill -TERM <PID>`，必要时逐一清理其子进程。真实 `nctrn` 进程与假 MCP 服务器的强杀验收见 `apps/cli/test/mcp-parent-kill.accept.mjs`；后续方案见 [roadmap](../roadmap/roadmap.md)。
- **子会话复用（Phase 6）**：Subagent 子会话的工具集直接取父会话 `mcpSession.tools()` 的快照——同一连接、同一批服务器进程，**不为子会话启动新的 MCP 服务器**，也不做第二次 initialize（[subagent.md](subagent.md) 第 10 节）。
- 服务器主动发来的请求（`sampling/createMessage`、`elicitation/create`、`roots/list` 等）：我们不声明对应 capability，一律回 JSON-RPC `method_not_found`；`ping` 由 SDK 自动应答。

## 5. 工具包装

每个 MCP 工具包装为一个 `ToolDefinition`：

```ts
{
  name: "mcp__<server>__<tool>",          // 命名见下
  description: `[<server>] <服务器给的描述>`,
  inputSchema: <服务器 inputSchema 原样>,   // AJV 编译失败 → 跳过该工具并警告
  traits: {
    mutates: !(annotations?.readOnlyHint === true),
    concurrencySafe: annotations?.readOnlyHint === true && annotations?.destructiveHint !== true,
    timeoutMs: server.callTimeoutMs ?? 60_000,
  },
  permissionSubjects: () => [{ kind: "mcp", target: "<server>/<tool>" }],
  execute: (input, ctx) => /* tools/call 调用与结果映射（第 6 节） */,
}
```

**命名规范化**（工具名字符集为 `[a-z0-9_]`，见 [tool-api.md](../protocols/tool-api.md)）：

1. `server` id 与 `tool` 名各自：转小写、非法字符替换为 `_`；结果为空则跳过该工具（记警告）。
2. 拼接后总长超过 **64 字符**（Provider 常见上限）时，工具段截断并追加 `_<8 位散列>` 保证确定性唯一。
3. 规范化后撞名（不同原始名映射到同一名字）：先注册者保留，后到的工具跳过并记警告——不静默覆盖（注册表既有约定）。
4. `server` id 在配置层校验：`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$`，不合规的条目拒绝该层（用户配置报错 / 项目配置忽略并警告）。

工具集合随会话注册表存在：本会话的 `ToolRegistry` = 内置工具 ∪ 本会话 MCP 工具（`specs()` 进入 `buildContext` 与 `/context` 的口径不变）。`tools/list_changed` 与崩溃重连重新拉到的工具列表都**先暂存、在下一个 Turn 开始时一次性切换**——保证单个 Turn 内 `specs()` 稳定（模型看到的工具集不中途变化，请求前缀不变）。会话关闭后 MCP 工具随注册表一起消失。

## 6. 调用与结果映射

`execute` 把一次 `tools/call` 的结果映射为 `ToolResult`：

| MCP 结果 | 映射 |
|---|---|
| `content[].type = "text"` | 文本按序拼接进 `modelContent` |
| `content[].type = "image"` | `modelContent` 中追加占位 `[image <mimeType>, <N> bytes]`；`output` 只保留元数据（mimeType、字节数），**不带 base64 数据**——`ContentBlock` 尚无图片类型，图片不发给模型（第 9 节） |
| `content[].type = "resource"` | 带 `text` 的按文本拼接（前缀标注 `[resource <uri>]`）；带 `blob` 的记占位 `[resource <uri> (<mimeType>, <N> bytes)]` |
| `content[].type = "audio"` | 占位 `[audio <mimeType>, <N> bytes]` |
| `structuredContent` | 进 `ToolResult.output.structured`（受 `output` 独立上限约束） |
| `isError: true` | `status: "error"`，`error.code = "mcp_error"`，`modelContent` 为拼接出的错误文本 |
| 传输错误 / 服务器不可用 | `error.code = "mcp_unavailable"`（崩溃、连接断开、重连失败） |
| 服务器返回 JSON-RPC error | `error.code = "mcp_error"`，message 带服务器给的 message |

其余约定：

- **结果预算**：`modelContent` 超 `maxModelChars`（默认 30,000）时走执行器既有路径——截断 + 完整内容落盘 `<sessionsDir>/attachments/<sessionId>/<callId>.txt`（tools.md 第 4 节），MCP 无特殊通道。
- **超时**：以 `traits.timeoutMs` 为准由执行器统一计时；到达即中止信号。
- **取消**：`ctx.signal` 中止时向服务器发送 `notifications/cancelled`（带本次 `requestId`，best-effort），随后不等对端确认即按 `cancelled` 结算；对端不理会取消时进程仍在跑，会话关闭时统一清理。MCP 的取消只是通知不是保证，文档如实说明。
- **服务器→客户端的通知**（`notifications/message` 日志等）：进诊断日志（[observability.md](observability.md)），不进会话事件。

## 7. 权限与可见性

设置页的连接探测由用户主动操作，不经权限层；未信任项目的条目拒绝探测。stdio 走 spawn → initialize → tools/list → 清理进程树，HTTP 走连接 → initialize → tools/list → 结束会话。草稿未指定 `credentialServerId` 时只使用本次传入的 `secrets`，不查询凭据库；缺少 stored 对应值时失败为 `mcp_secret_missing`。探测结果只保存在界面内存，含耗时、服务器信息、工具和分类错误；stdio 附脱敏的最多 20 行 stderrTail，HTTP 附 httpStatus。精确字段与错误码见 [rpc.md](../protocols/rpc.md#35-mcp)。

- **主体**：`{ kind: "mcp", target: "<server>/<tool>" }`（target 用**服务器原始名**与**工具原始名**，不做规范化——规则匹配与确认框显示的都是用户配置里的名字）。
- **求值**：与 shell 相同的字符串通配符匹配（permissions.md 5.1），`mcp github/*`、`mcp *` 等模式可用；预设中 `network / mcp` 列已就位——`read-only`/`default`/`auto-edit` 为 `ask`，`guarded`/`smart`/`bypass` 为 `allow`；无匹配落 `ask`。
- **Grant**：`mcp` 授权键取 `target` 原值（permissions.md 5.4），"本会话允许 / 本项目始终允许"对该服务器工具精确生效。
- **不可信项目配置**：`mcp` 段整体忽略（第 3 节）——它定义的是要启动的进程，没有"收紧方向"可用。
- 权限确认框展示 `mcp <server>/<tool>`，与既有主体展示一致；`--yes`、非交互拒绝等规则照常。

**状态可见性**：

- 临时事件 `mcp.server`：`{ server, state: "starting"|"ready"|"failed"|"crashed"|"stopped", toolCount?, error? }`，在状态转移时发出。选**临时**而非持久事件：服务器进程是本次打开的运行态，恢复时重新拉起，写进日志只会让旧版本 Runtime 拒绝恢复（events.md 第 8 节）。
- 失败同时发 `runtime.warning`（`mcp_server_failed` / `mcp_server_crashed` / `mcp_tool_conflict` / `mcp_env_missing`），客户端走既有警告渲染。
- `session.mcpServers(): McpServerStatus[]`（只读查询，不产事件）：供 `/mcp` 命令列出每台服务器的状态、工具数与失败原因（[apps/cli.md](../apps/cli.md)）。
- **部分失败降级**：启动失败的服务器不阻塞会话——其工具不存在，模型调用到不存在的工具名时得到 `unknown_tool`（列出可用工具名，与工具名漂移的既有自愈路径一致）。
- **恢复兼容**：历史中含 `mcp__*` 调用、本次打开时该服务器未配置或启动失败——历史回放不受影响（`tool.completed` 是按 `callId` 配对的消息记录，发给 Provider 的请求不校验历史工具名是否仍在 `specs()` 中；openai-compatible 与 anthropic 两个适配器都要在验收中验证这一点，见 roadmap Phase 5）。

## 8. 与 Core 的接线

Runtime 管理方法为 `describeMcpServers`、`saveMcpServer`、`deleteMcpServer`、`setMcpServerEnabled`、`probeMcpServer`；只修改 `app` 来源。保存先更新凭据再原子写配置，失败回滚凭据，成功自动重载并 reconcile。创建时任何来源同 id（不区分大小写）均报字段错误；手写来源只读。RPC 同名映射在 `mcp.*`；桌面端为单后台（ADR-0051），服务端重载即覆盖全部已打开会话，无跨后台传播。

```text
apps/cli:  createPlatform() → createMcpConnector(platform)（@nocturne/mcp）
           → createRuntime({ ..., mcp: connector })
core:      wrapSession 中 options.mcp 存在时（空集合也建会话以支持热添加）
           → connector.open({ servers, cwd, workspaceRoot, sessionId, events, diagnostics })
           → McpSession { tools(), status(), reconcile(), applyPendingTools(), close() }
           → 会话注册表 = 内置 ∪ mcpSession.tools()
           → session.mcpServers() 查询；close() 时连接全部关闭
```

- `McpConnector` / `McpSession` / `McpServerConfig` / `McpServerStatus` 接口类型定义在 `tools`（注册接口的消费方），经 `@nocturne/core` 公开导出；`@nocturne/mcp` 只依赖 `@nocturne/core` 的两个公开入口与 `@modelcontextprotocol/sdk`，depcheck 与 `apps/*` 同规则（只允许 `index` / `protocol/index` 两个入口）。
- `RuntimeOptions.mcp` 缺省时整个 MCP 路径不存在（行为与 Phase 4 一致）；测试可注入假 connector 或直接用 `RuntimeOptions.mcpServers` + 假 connector。
- `platform` 的 `spawnPipe(command, args, opts)`：`stdin` 可写、`stdout` 原始字节流（MCP 是换行分隔 UTF-8 JSON-RPC，不走控制台代码页解码）、`stderr` 按控制台编码解码，经脱敏后只进入探测尾部、`kill()` 走进程树终止。这是 platform 的通用能力，`hooks` 也使用它。
- Core 侧的公开导出：`ToolDefinition`、`ToolResult`、`ToolContext`、`ToolScope`、`ToolTraits`、`McpConnector` 等类型经 `@nocturne/core` 导出（纯类型，兼容变更；platform 的 `FileSystem`/`ProcessRunner`/`PathOps` 等类型同理）。
- 外部 agent 的 ACP 接入沿用同类 connector 注入与 `spawnPipe` 进程树清理，但作为 `task` 委派而不是 MCP 工具集合；见 [subagent.md](subagent.md#17-外部-agentacp)。
- `PipeProcess.exited()` 可提前检测根进程退出；`detachOutput()` 可结束被后代占用的本地管道，原 `wait()` 仍等待 close 以保留完整协议尾部。Windows `.cmd`/`.bat` 由平台按 PATH/PATHEXT 解析并引用参数，不按具体命令名称分支。

## 9. 暂不设计

- **OAuth**：本轮只支持静态请求头，不传 authProvider；需要登录的端点提示本版本暂不支持。
- **旧版 SSE**：导入时明确提示暂不支持并跳过。
