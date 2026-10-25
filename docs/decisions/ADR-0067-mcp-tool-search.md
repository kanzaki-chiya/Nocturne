# ADR-0067：MCP 工具按需加载

- 状态：已接受（维护者 2026-10-26 确认：搜索 + 代理调用；切换阈值 1 万 token，每次搜索最多 5 个结果）
- 日期：2026-10-25
- 修订：[mcp.md](../architecture/mcp.md) 第 5–8 节、[tools.md](../architecture/tools.md) 执行管线第 1 步、[tool-api.md](../protocols/tool-api.md) `ToolTraits`、[events.md](../protocols/events.md) `tool.started`

## 背景

- 2026-10-25 一个编码会话的 `/context`：工具定义 34,010 token、79 个工具，其中内置工具十三四个，约 65 个来自 MCP，估计占 2.4 万左右。Magpie 网关给这批会话打的标签里也有「MCP 偏重」。
- 这部分每一步都随请求发出。缓存让它不贵，但它占着上下文，而大多数 MCP 工具一个会话里一次都用不到。
- Claude Code：MCP 工具定义超过阈值后不再写进请求，换成一个 ToolSearch 工具按需加载；依赖 Anthropic API 的服务端 `defer_loading`，换成自定义 base URL 时默认关闭。第三方实测 65 个 MCP 工具时首个请求从 27,184 降到 9,722 token。Codex CLI 2026 年 6 月起默认开启 MCP 工具搜索，按名称、说明和参数做 BM25 检索后返回完整定义。
- Nocturne 要兼容所有服务商，不能依赖服务端延迟加载。如果用到时才把工具加进工具列表，而工具列表在请求最前面，每加载一个工具整段缓存就失效一次，与「同会话每次请求是下一次的严格前缀」的原则冲突。

## 决定

### 1. 两个固定的入口工具

MCP 工具进入「按需」模式时，它们不再各自出现在工具列表里，改为两个内置工具：

- **`mcp_search({ query, server? })`**：在当前会话可用的 MCP 工具里按名称、说明、参数名做关键词匹配（不区分大小写，CJK 按字匹配，不引入检索库），返回最多 5 个结果：完整工具名、说明、完整 `inputSchema`（JSON）。`query` 写完整工具名时精确返回该工具。
- **`mcp_call({ tool, arguments })`**：`tool` 是完整工具名（`mcp__<server>__<tool>`），`arguments` 是该工具的参数对象。

`mcp_search` 的说明里按服务器列出全部工具名（只有名字，每个约几 token），模型知道有什么可用；完整定义只在搜索结果里出现。搜索结果作为普通工具结果追加，不改前缀。模型也可以不搜索、直接 `mcp_call`：参数不合法时错误信息附带该工具的 `inputSchema`，下一步改正即可。

### 2. 代理调用按目标工具执行

不在执行器里写 MCP 分支。新增通用的工具特性 `ToolTraits.dispatch(input) → { tool, input }`：执行管线第 1 步（查找）之后，带这个特性的工具把调用解析为目标工具和目标输入，之后的校验、Hook、权限、调用、超时、结果预算全部按目标工具进行：

- 参数按目标工具的 `inputSchema` 校验，失败 `invalid_input`；
- 权限主体照旧是 `mcp <server>/<tool>`，已有规则和授权继续生效；
- Hook 的 `PreToolUse` / `PostToolUse` 看到的工具名是目标工具名，现有按 `mcp__*` 写的匹配不用改；
- 目标工具不在本会话工具池里（未配置、启动失败、子会话池不含）时 `error`，附可用服务器列表。

发给模型的历史里，这次调用仍是 `mcp_call`（服务商要求调用名与声明的工具一致）。

### 3. 事件与客户端

- `tool.started` 增加可选字段 `target: { name, input }`，记录解析后的目标工具。旧版本忽略该字段；旧日志没有它，照原样显示。
- 客户端（桌面端、手机、TUI、CLI）有 `target` 时按目标工具显示名称与参数，和直接调用 MCP 工具看起来一样；`mcp_search` 显示为「搜索 MCP 工具：<query>」。
- 权限确认卡片按目标工具显示，不出现 `mcp_call`。

### 4. 什么时候进入按需模式

- 配置 `mcp.toolSearch`：`"auto"`（默认）| `"always"` | `"never"`。
- `auto`：本会话 MCP 工具定义的估算合计超过 10,000 token 时按需，否则照旧全量列出。判定在 Turn 边界（MCP 工具集本来就只在 Turn 边界变化），Turn 内不切换。
- 模式切换、`tools/list_changed` 导致 `mcp_search` 说明里的名单变化，都和现在工具集变化一样，在下一个 Turn 边界生效，会让那一次请求的缓存重新开始。
- 子会话沿用父会话的模式与 MCP 工具快照；explore 等受限工具池照旧按目标工具判断是否可用。
- `/context` 的「工具定义」一行在按需模式下注明「MCP 按需，N 个工具未列出」。

### 5. 不变的部分

- MCP 连接、生命周期、结果映射不变；`mcp__*` 直接调用的旧历史照常回放。
- 不新增持久事件类型；`target` 是可选字段。

## 验收

- `auto` 阈值两侧：低于 10k 全量列出，高于 10k 只有两个入口工具；`always` / `never` 生效。
- `mcp_search`：关键词命中名称、说明、参数名；完整名精确返回；最多 5 个；中文命中。
- `mcp_call`：参数按目标 schema 校验；权限主体是 `mcp server/tool`，现有规则与授权生效；Hook 看到目标名；目标不存在或不在池里时报错并列出可用服务器。
- 请求前缀：同一会话多次搜索和调用后，工具列表逐字节不变（假 Provider 断言）。
- `tool.started.target` 写入；客户端按目标显示（桌面端 vitest、TUI 快照）；旧日志无 `target` 照原样显示。
- 子会话沿用模式；受限池不能经 `mcp_call` 调到池外工具。

## 后果

- MCP 工具多的会话，每一步少发约 2 万 token 的工具定义；第一次用到某个工具时多一步搜索（或一次带 schema 的报错）。
- 参数不再受服务商原生工具 schema 约束（部分服务商的严格模式），只靠 Runtime 校验后让模型重试；常用的工具调用一两次后模型会照着已有结果写对。
- 执行管线多一个通用的 `dispatch` 特性，以后其他代理类工具也可以复用。

## 备选方案

- **加载后把工具加进工具列表**：调用最自然，但每加载一个工具整段缓存失效一次，长会话里会反复发生；放弃。
- **依赖服务商的服务端延迟加载**（Anthropic `defer_loading` 等）：只有个别服务商支持，要在适配器之外按服务商分支；放弃。
- **BM25 检索**：几十个工具的规模下关键词匹配够用，不引入依赖；工具数量到几百个时再考虑。
- **不列工具名、只靠搜索**：模型不知道有什么可用，容易不去搜；名单很便宜，保留。

## 实现记录（2026-10-25）

- **`ToolTraits.dispatch` 与执行管线**：`packages/core/src/tools/types.ts` 新增 `ToolDispatchResult` 与 `ToolTraits.dispatch`；`packages/core/src/tools/executor.ts` 在管线第 1 步查找后执行 `dispatch(input)` 解析目标工具与目标输入，后续 `inputSchema` 校验（失败时附带目标工具 `inputSchema`）、`PreToolUse` / `PostToolUse` Hook、权限主体求值与 `PermissionGate.check`、超时、调用及结果预算全部按目标工具执行；`tool.started` 写可选 `target: { name, input }`，`tool.completed` 保持 `mcp_call` 以满足服务商协议。
- **`mcp_search` / `mcp_call` 与按需模式切换**：`packages/core/src/tools/mcp-on-demand.ts` 实现关键词检索（匹配工具名、说明、参数名，不区分大小写，CJK 按单字拆分，支持 `server` 限定与完整工具名精确命中，最多 5 条；`mcp_search` 说明按服务器列出全部工具名）与 `mcp_call` 分派；配置 `mcp.toolSearch: "auto" | "always" | "never"`（默认 `"auto"`，阈值 10,000 token）在会话打开与每个 Turn 边界（`applyMcp`）判定，Turn 内不切换，保证请求 `tools` 前缀逐字节不变；子会话沿用父会话模式，受限池（如 `explore`）只搜得到、调得到池内工具；`/context` 的 `tools` 段在按需模式下注明「MCP 按需，N 个工具未列出」。
- **客户端显示**：桌面端与手机网页（`apps/desktop/src/Conversation.tsx`、`context-panel.tsx`）、TUI（`apps/tui/src/lines.ts`、`format.ts`）与 CLI（`apps/cli/src/render.ts`）在存在 `target` 时按目标工具显示名称、参数与权限确认卡片，`mcp_search` 显示为「搜索 MCP 工具：<query>」，无 `target` 的旧日志照原样显示。

