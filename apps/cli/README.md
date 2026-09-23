# @nocturne/cli — `nctrn`

Nocturne 的命令行客户端：交互 REPL 与非交互单发模式。只负责输入采集、
事件渲染与权限确认提示；Agent 行为、权限判定与上下文构建全部在
`@nocturne/core` 中完成，本包不含这些逻辑。

## 入口

- `src/main.ts`：`nctrn` 的可执行入口（`bin: dist/main.js`）。
- 构建：`pnpm build`；开发运行：`pnpm build && node apps/cli/dist/main.js`。

## 文档

设计与行为约定见 [docs/apps/cli.md](../../docs/apps/cli.md)。
