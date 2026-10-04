# @nocturne/desktop

Nocturne 的桌面端：Tauri 外壳（`src-tauri/`）管理 `nctrn rpc --stdio` 后台进程并按行转发，前端（`src/`，React + Vite）经 `@nocturne/rpc/client` 驱动全部会话功能。

负责：后台进程生命周期、Node 查找、按行传输、窗口、会话树、对话渲染与交互。
不负责：任何 Agent 行为、权限判定、RPC 语义（都在 `@nocturne/rpc` 与 `@nocturne/core`）。
入口：`src/main.tsx`（前端）、`src-tauri/src/lib.rs`（外壳）。
详见：docs/apps/desktop.md、docs/decisions/ADR-0046-desktop-tauri.md
