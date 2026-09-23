# @nocturne/core

Nocturne 的 Runtime：会话、Agent Loop、上下文、工具、权限、Provider。

负责：Agent 的全部行为与状态。
不负责：任何界面、终端渲染、参数解析。

入口：`src/index.ts`（公开 API，`createRuntime` 等）、`src/protocol/`（客户端可用的类型，经 `@nocturne/core/protocol` 导出）。

详见：[`docs/architecture/overview.md`](../../docs/architecture/overview.md)、[`docs/architecture/modules.md`](../../docs/architecture/modules.md)
