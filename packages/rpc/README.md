# @nocturne/rpc

Nocturne 的 RPC 层：把 Runtime 的公开 API 通过 JSON-RPC 2.0 提供给进程外客户端（桌面端、IDE 插件等）。

负责：方法与事件的序列化映射、订阅回放、错误码映射、一个类型化客户端。
不负责：任何 Agent 行为、权限判定、配置加载与 MCP 装配、网络监听与鉴权。

入口：

- `@nocturne/rpc/server`：`createRpcServer(...)`，给定 Runtime 与一条按行收发的传输即可服务一个客户端；附 `createStdioTransport`。
- `@nocturne/rpc/client`：`createRpcClient(transport, { clientName })`，类型化的 `runtime.*` / `session.*` 调用、`trackSessionView`；运行时只依赖 `@nocturne/core/protocol`。

详见：[`docs/protocols/rpc.md`](../../docs/protocols/rpc.md)、[`docs/decisions/ADR-0044-rpc-stdio.md`](../../docs/decisions/ADR-0044-rpc-stdio.md)
