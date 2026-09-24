# @nocturne/tui

Nocturne 的终端 UI 客户端（Ink + React，见 `docs/decisions/ADR-0010-tui-rendering.md`）。

由 `nctrn --tui` 惰性加载；本包只依赖 `@nocturne/core` 与 `@nocturne/core/protocol`
的公开 API，不包含 Agent 逻辑或自有事件投影（SessionView 来自 protocol reducer）。

布局与交互语义见 `docs/apps/tui.md`。
