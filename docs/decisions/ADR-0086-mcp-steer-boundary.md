# ADR-0086：用户插话作为 MCP 边界

- 状态：已接受
- 日期：2026-11-11
- 修订：[mcp.md](../architecture/mcp.md) 第 4、5、8 节、[agent-loop.md](../architecture/agent-loop.md) 第 2 节与第 3.10 节、[context.md](../architecture/context.md) 第 3 节；扩展 [ADR-0071](ADR-0071-mcp-availability-notes.md) 的记录时机，修订 [ADR-0067](ADR-0067-mcp-tool-search.md) 里「全量模式只在 Turn 开始切换」

## 背景

[ADR-0067](ADR-0067-mcp-tool-search.md) 的 2026-11-10 修订只覆盖按需模式：`mcp_search` / `mcp_call` 可以在 Turn 内重连失败的 HTTP 服务器。全量模式把 MCP 工具直接放进请求的工具列表。`tools/list_changed` 和重连拿到的新工具都先暂存，下一个 Turn 开始才一次性切换（[mcp.md](../architecture/mcp.md) 第 5 节）。Turn 进行中，模型没有办法用上中途启动的服务器。

会话启动时如果所有 MCP 服务器都失败，`auto` 估算的 MCP 工具 token 为 0。会话处于全量模式，请求里也没有 `mcp_search` / `mcp_call`。按需模式的 Turn 内恢复覆盖不到这条路径，同样要等下一个 Turn。

实际场景：BrowserOS 没开就开了会话，中途打开 BrowserOS，再用插话让模型继续。模型看不到 BrowserOS 的工具。

## 决定

把用户插话写入会话当作一次 MCP 边界。这里的插话只指用户输入写入的 `message.user(steer: true)`，不含后台子代理结果、后台命令结果，也不含 `continueTurn` 写入的插话。

插话写入之后、下一次模型请求之前，执行与主 Turn 开始时相同的 MCP 准备，不另写一套重连：

1. `prepareTurn(signal)`：对过冷却的失败 HTTP 服务器并行重连，最多等 3 秒，超时后台继续。
2. `applyMcp` / `applyPendingTools()`：应用暂存的工具变化，并按 Turn 边界同样的规则重新判定 `auto` 的全量/按需模式。
3. 追加可用性环境说明（[ADR-0071](ADR-0071-mcp-availability-notes.md)），只记录变化。

崩溃重连的 3 次上限、30 秒冷却和连续失败计数全部沿用第 4 节已有实现。中断信号照常生效：等待中收到中止立即放弃等待，不取消后台重连。子会话、压缩和后台请求不触发。

Agent Loop 不认识 MCP，也不按工具名或插话来源分支。`takeSteers` 写完插话后调用通用钩子 `afterSteers(signal)`；`continueTurn` 不经过这个钩子。Runtime 在钩子里看本批取出的条目是否含有用户插话（`mode: "steer"`），有才复用 Turn 开始的 `prepareMcpBoundary`。

### 没有变化时前缀不变

插话本身是追加在历史末尾的用户消息。提示缓存要保住的是这条消息之前的 system、工具定义和已有消息。

工具集合与全量/按需模式都没变时：

- 不写 `session.config_changed`，不追加环境说明；
- `applyPendingTools()` 的 diff 为空，注册表重放同一批定义，请求里的工具定义与上述前缀逐字节相同。

有变化时，这次插话之后的请求改用新的工具列表，并在插话之后追加可用性说明。说明不改写更早的前缀。这一次工具列表变化会使提示缓存未命中，但只发生在用户主动插话、且 MCP 确实有变化时。

## 后果

- 全量模式，以及启动时全部服务器失败、请求里没有任何 MCP 入口的会话，都可以在用户插话后的下一步用上新工具；工具定义超过 `auto` 阈值时同时切到按需模式。
- 插话时 MCP 没有变化，不付出缓存失效。
- 后台子代理结果、后台命令和目标模式的 `continueTurn` 不会因为送达而刷新工具列表。
- 进行中的模型请求不被打断；变化最早出现在下一个安全点之后的请求。

## 备选方案

- **Turn 内任意请求前都刷新**：服务器抖动或 `tools/list_changed` 会让工具列表在连续请求之间反复变化，提示缓存频繁失效。不采用。
- **只在按需模式做**：全部服务器启动失败时 `auto` 估算为 0，会话处于全量模式且没有搜索入口，用户的 BrowserOS 场景正好落在这里。不采用。
- **在 Agent Loop 里识别 MCP 或插话来源**：违反 Core 的编排约束。不采用。
