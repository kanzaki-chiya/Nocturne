# ADR-0001：使用 TypeScript + Node.js 实现

- 状态：已接受
- 日期：2026-09-23

## 背景

Nocturne 需要：大量调用各家模型服务的流式 HTTP 接口；接入 MCP；在 Windows、macOS、Linux 上运行子进程与文件操作；未来提供 TUI、RPC 乃至 Web / Desktop 客户端；吸引开源贡献者。

## 决定

- 语言：TypeScript（严格模式）。
- 运行时：Node.js 当前 LTS（24.x）。不依赖 Bun 或 Deno 专有 API。
- 包管理：pnpm workspace。
- 数据跨进程、跨存储、跨模型边界时使用可运行时校验的 schema（具体库在 Phase 1 选定并记录在 [repository-layout.md](../development/repository-layout.md)）。

## 后果

- 可以直接使用成熟的 MCP SDK 与各模型服务的 SDK；参考项目 ZCode、OpenCode 同栈，研究成果可直接对照。
- Web / Desktop / IDE 客户端将来可以共享 `protocol` 类型。
- 分发需要 Node.js 环境；单文件可执行分发（Node SEA 等）作为后续可选项。
- 启动速度与内存占用不如 Rust / Go，需要在 CLI 启动路径上控制依赖加载。

## 备选方案

- **TypeScript + Bun**：启动快、工具链一体；但 Windows 与原生模块兼容性风险更高，且容易引入运行时锁定。
- **Rust**（Codex 路线）：性能与分发最好；开发和贡献门槛高，Provider / MCP 生态需要更多自建。
- **Go**：单二进制分发简单；LLM 与 MCP 生态弱于 TypeScript。
