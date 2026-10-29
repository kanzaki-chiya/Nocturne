# ADR-0071：MCP 服务器不可用时告诉模型

- 状态：已接受
- 日期：2026-10-29
- 修订：[mcp.md](../architecture/mcp.md)、[context.md](../architecture/context.md)、[events.md](../protocols/events.md)、[sessions.md](../architecture/sessions.md)

## 背景

MCP 服务器启动失败（`failed`）或中途崩溃（`crashed`）时，Runtime 只发临时事件 `mcp.server` 和 `runtime.warning` 给界面，模型上下文里没有任何信息。失败服务器的工具从未进入注册表，模型连它存在都不知道；用户说「用 X 打开网页」时，模型只能猜。

实际遇到过：BrowserOS neo 没有运行（连接被拒绝），模型把原因猜成「会话开始后才连上、工具池没刷新」，并建议用户新开会话。按 [mcp.md](../architecture/mcp.md) 第 4 节，每个主 Turn 开始都会对失败的 HTTP 服务器自动重连，新开会话既没必要，也解决不了「服务器没在运行」。

已有先例：shell 切换（ADR-0022）和文件回退（ADR-0041）都在持久事件的位置折叠出一条 `note` 历史条目，Context Builder 以 user 消息注入，前缀只追加、恢复后原样重建。

## 决定

### 1. 何时记录

只在**主会话的 Turn 边界**记录，时机是 MCP 准备结束之后、首次模型请求之前：首 Turn 在 `startup(signal)` 等待结束后，其后的 Turn 在 `prepareTurn(signal)` 结束后。这时本 Turn 的工具集已确定，记录与模型看到的工具集一致。

Runtime 比较每台已配置服务器「对模型是否可用」与上一条记录，只记录变化：

- **变为不可用**：`failed`、`crashed`，或等待结束时仍在 `starting`（启动超时）。
- **恢复可用**：此前记录为不可用、现在是 `ready`。

基线是「全部可用」：服务器一直正常就从不产生记录；第一次出问题才记。因用户改配置而停用、删除或新增的服务器不记录：这是用户的操作，工具集变化本身已经反映出来。

Turn 内的变化不立即记录：崩溃时在途调用已经以 `mcp_unavailable` 结算，模型从工具结果里就能知道。下一个 Turn 边界再按上面的规则比较。

子会话、压缩与标题等后台请求不记录：子会话沿用父会话的工具快照，父会话的记录已在历史里。

### 2. 存放：`session.config_changed` 的可选字段

在已知事件 `session.config_changed` 上增加可选字段：

```ts
mcp?: Array<{
  server: string;                       // 配置中的服务器 id
  available: boolean;
  reason?: string;                      // 仅 available=false：McpServerStatus.error 的人读原因（截到 200 字符）
  autoRetry?: boolean;                  // 仅 available=false：Runtime 之后是否还会自动重试
}>;
```

一个 Turn 边界的全部变化合成一条事件。这是兼容扩展：旧版本忽略未知字段，照常恢复会话，不提升 `formatVersion`。`reason` 用 `McpSession.status()` 已有的人读原因（mcp.md 第 4 节的分类，如连接被拒绝、请求超时、HTTP 502），不另带原始错误、地址、请求头或凭据；启动超时、仍在 `starting` 时记为启动超时。`autoRetry` 由 McpSession 按传输与重连次数给出（`McpServerStatus` 增加同名字段：HTTP 恒为 true，stdio 未达重连上限为 true），在事件里记下当时的值，重建说明时不再查询运行态。

不新增持久事件类型：那样旧版本 Runtime 会拒绝恢复含它的会话（[events.md](../protocols/events.md) 第 8 节），这里没有对应收益。字段挂在 `config_changed` 上，是因为它和 shell 一样表达「模型所处环境的变化」，折叠与注入路径完全相同。

### 3. 给模型的说明

折叠时在事件位置生成 `note` 历史条目，文字由代码按字段生成（与 shell 说明同样的做法，措辞随版本更新，旧事件按新措辞重建）。英文，以 `[Environment change]` 开头，基础提示已说明这类说明来自 Runtime。示例：

```text
[Environment change] MCP server "browseros" is unavailable (connection refused); its tools are not loaded. Nocturne retries it automatically at the start of each turn, so a new session will not help. If the user needs it, ask them to check that the server is running.
[Environment change] MCP server "browseros" is available again; its tools are loaded.
```

`autoRetry` 为 false（stdio 重连达到上限）时，第一句的后半改为说明本会话不会再自动重试，需要用户重新加载配置或重开会话。Context 只看事件字段，不按服务器类型写分支。

### 4. 上下文与缓存

说明位于本 Turn 的 `message.user` 之后、首个 `message.assistant` 之前，只追加，不改已有前缀，缓存不受影响。投影规则、L1 修剪与压缩后的处理与 shell 说明相同（[context.md](../architecture/context.md) 第 3 节）。

MCP 按需加载模式（[ADR-0067](ADR-0067-mcp-tool-search.md)）下，`mcp_call` 的目标属于不可用服务器时，`unknown_tool` 的说明指出该服务器当前不可用，而不是只说找不到工具。

### 5. 界面

客户端不显示这类 note：界面已经有 `mcp.server` 状态与警告，重复显示会造成噪音。现有客户端本来就不渲染 `note` 历史条目（shell 切换说明同样不显示），保持不变。

## 后果

- 模型在 Turn 开始时就知道哪些服务器用不了、原因和是否会自动恢复，不必猜，也不会让用户做无用操作。
- 每次状态变化多一小段 user 消息（几十 token）。服务器反复抖动时每个 Turn 可能各记一条，规模有限，不做合并。
- `session.config_changed` 不再只表示用户配置变更，events.md 说明它也承载环境状态。
- 没有 Turn 进行时服务器状态变化不写日志，空闲会话不会因为后台重连产生事件。

## 备选方案

- **每次请求在末尾注入当前状态**：不写日志，但下一次 Turn 去掉或改动它会让前缀从那里开始失效，破坏缓存；不采用。
- **写进 system 提示或环境信息段**：状态变化会改写前缀，同样破坏缓存；不采用。
- **新增持久事件类型 `mcp.availability`**：语义最清楚，但旧版本 Runtime 将无法恢复含它的会话；不采用。
- **只在调用失败时告知**：失败服务器的工具不在注册表里，模型根本不会调用，问题依旧；不采用。
