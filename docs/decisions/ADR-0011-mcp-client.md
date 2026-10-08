# ADR-0011：MCP 客户端——独立包 + 官方 SDK + 自定义 stdio 传输

- 状态：已接受
- 日期：2026-09-24
- 相关：[architecture/mcp.md](../architecture/mcp.md)、[modules.md](../architecture/modules.md)、[repository-layout.md](../development/repository-layout.md)

## 背景

Phase 5 要把 MCP 工具接入 Runtime。需要回答三个问题：客户端代码放哪、是否依赖官方 SDK、stdio 传输怎么实现。

## 决定

1. **独立包 `packages/mcp`（`@nocturne/mcp`）**：MCP 客户端不进入 `@nocturne/core`，Core 只通过 `RuntimeOptions.mcp` 接收符合 `McpConnector` 接口的对象（接口类型定义在 `tools`）。装配在 `apps/cli` 完成。
2. **依赖 `@modelcontextprotocol/sdk`，固定 `1.30.0`**（`1.30.1` 发布于 2026-09-23，不满足仓库"优先 ≥7 天"惯例）。用到的是 `Client` 类、`Transport` 接口与协议类型。
3. **自定义 stdio Transport**：不用 SDK 的 `StdioClientTransport`（内部自行 `spawn`），自己实现 `Transport` 接口，底层走 platform 新增的 `spawnPipe`，使 MCP 子进程获得与 `shell` 相同的进程树终止（`taskkill /T /F`）与 `windowsHide` 语义。

## 备选方案

| 方案 | 评价 |
|---|---|
| SDK + `StdioClientTransport`（SDK 默认用法） | 传输内部自 spawn，进程管理脱离 platform：进程树终止、`windowsHide`、崩溃清理语义都要再实现一遍，且与 `shell` 的保证不一致——放弃 |
| 手写 JSON-RPC stdio 客户端（零依赖） | 我们只用 initialize / tools/list / tools/call / cancelled 这个子集，约几百行可实现；零依赖与 depcheck 友好。代价是协议演进（版本协商、capability、分页、取消语义）要自己跟进，且握手细节错了很难发现。**作为兜底方案记录在案**：若 SDK 的版本兼容或依赖体积成为实际问题，替换实现不影响 Core（`McpConnector` 接口不变） |
| 客户端代码直接进 `packages/core` | SDK 的依赖树（express/hono/jose 等服务器侧依赖，见下）会污染 Core 的依赖面，违反"Core 保持最小依赖"的方向——放弃 |

## SDK 依赖代价（如实记录）

`@modelcontextprotocol/sdk` 是客户端与服务器合一的包，依赖约 15 个直接包（express、hono、jose、cors、eventsource、zod 等）。我们只用它的一小部分，这些依赖全部被安装但大部分是死重。缓解方式：

- 依赖收敛在 `packages/mcp` 一个包里，Core 依赖面不变；
- 版本精确固定（不浮动），license MIT，GPL-3.0 兼容无问题；
- 若未来觉得不可接受，"手写传输 + 手写 JSON-RPC"的兜底路径不需要改 Core 与接口。

## 后果

- `apps/cli` 增加对 `@nocturne/mcp` 的依赖（装配点）；`packages/mcp` 只允许依赖 `@nocturne/core` 的两个公开入口 + SDK（depcheck 规则与 `apps/*` 相同）。
- Core 公开导出需要增补 `ToolDefinition`/`ToolResult`/`ToolContext`/`ToolTraits`/`McpConnector`/`McpServerConfig` 等类型（纯类型导出，兼容变更）。
- platform 新增 `spawnPipe` 能力，后续 hooks 也复用它。
- 远程传输（Streamable HTTP）与凭据管理在本阶段范围之外，见 mcp.md 第 2、9 节。

## 修订

- 2026-10-08：会话打开不等待 MCP 启动。原先会话打开（新建与恢复）要等全部 MCP 服务器启动完成，最多等 startupTimeoutMs。远程 HTTP 服务器每次打开都要重新做 TLS 握手、initialize 和 tools/list，实测约 1 秒，桌面端每次切到空闲会话都要多等这么久。改为：会话打开立即返回，MCP 服务器照常并行启动 mcp.server 事件与 /mcp 可见；服务器启动完成后工具先暂存，下一个 Turn开始时并入注册表，复用 tools/list_changed 的暂存与切换路径，Turn 内工具集与上下文前缀保持稳定的规则不变；Turn 开始构建请求前，如果还有服务器处于 starting，等待它们结束（从开始启动算起最多 startupTimeoutMs，超时记 failed），保证模型第一轮看到完整工具集，等待期间可以中断；失败与超时的处理不变（工具不注册，发 runtime.warning，会话继续）；会话关闭时取消仍在启动的连接并沿用现有进程树清理。不采用多个会话共享连接：stdio 服务器的进程按会话隔离，作用域由会话的 workspaceRoot 与信任状态决定（mcp.md 第 4 节），共享需另行设计。
