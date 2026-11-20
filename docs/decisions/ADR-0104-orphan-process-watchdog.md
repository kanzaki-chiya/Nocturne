# ADR-0104：主进程被强杀后的子进程清理

- 状态：已接受
- 日期：2026-11-21
- 修订：[mcp.md](../architecture/mcp.md)（第 4 节 Runtime 关闭清理与已知限制）、[tools.md](../architecture/tools.md)（第 6 节后台命令）、[modules.md](../architecture/modules.md)（`platform` 模块）、[roadmap.md](../roadmap/roadmap.md)（Phase 5、v0.1、v0.7 强杀清理条目）

## 背景

Nocturne 会长期持有两类需要随会话结束的子进程：stdio MCP 服务器（[ADR-0011](ADR-0011-mcp-client.md)）和后台命令（[ADR-0083](ADR-0083-background-shell.md)）。正常关闭会话时，`session.close()` 与 `BackgroundShells.discard()` 会主动终止并清理它们的进程树；但主进程被强杀（如 `taskkill /F`、`SIGKILL`、崩溃或桌面外壳超时强杀后台）时，清理逻辑来不及执行：

- **CLI / TUI**：此前没有任何保护；忽略 stdin EOF 的 MCP 服务器和仍在运行的后台命令会成为孤儿进程。
- **桌面端**：Tauri 外壳（`apps/desktop/src-tauri/src/job.rs`）已创建带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的全局 Job Object，将 `nctrn rpc --stdio` 后台与面板终端加入其中，外壳退出时所有后代会随 Job 关闭一起结束。但外壳仍在运行、仅后台进程被强杀时（`backend.rs` 中 stdout 单行超限的两处 `child.kill()` 以及 `close_with_timeout` 超时强杀），后台拉起的 MCP 服务器和后台命令会一直残留到外壳退出。

`mcp.md` 原先写着「Windows 当前没有用 Job Object 绑定生命周期」，对桌面外壳已过时，且 CLI / TUI 与桌面单后台强杀场景仍缺少统一保护。

## 决定

### 1. 看门狗进程

由 Core 的 `platform` 模块（`packages/core/src/platform/watchdog.ts`）统一实现，CLI、TUI 与桌面后台共用同一套机制：

- **按需启动**：本进程第一次启动需要登记的子进程时才拉起看门狗，一个 Nocturne 进程最多运行一个（进程级共享单例）。不启用 MCP、不启动后台命令的会话不多任何进程。
- **启动与分发**：以 `process.execPath` 配合 `--input-type=commonjs -e <源码>` 启动看门狗脚本。脚本源码直接内联随 Core 打包，无需外部脚本文件或路径查找，在仓库开发态、npm 包 `nctrn` 与桌面安装包单文件后台 `nctrn.mjs` 三种形态下一致可用。进程以 `detached: true`、`windowsHide: true`、`cwd: os.tmpdir()` 启动，剥离 `NODE_OPTIONS` / `NODE_DEBUG` / `V8_COVERAGE` / `NODE_V8_COVERAGE` 等宿主调试与覆盖率变量；stdin 为父进程写入管道，stdout 与 stderr 为 `ignore`；父进程对子进程句柄及 stdin 均调用 `unref()`，不拖住父进程自然退出。
- **登记协议**：父进程通过 stdin 管道按行写入 `+<pid>\n` 登记、`-<pid>\n` 注销（重复登记、注销不存在或非法 PID 均幂等忽略）。经 `SpawnOptions.guardOrphan: true` 接入，登记对象限定为两类：
  1. stdio MCP 服务器进程（`packages/mcp/src/connector.ts`）；
  2. 后台命令进程（`packages/core/src/tools/background-shell.ts`，ADR-0083）。
  子进程正常退出（`exit` / `error`）或被 Nocturne 主动 `kill()` 结束后，立即发送 `-<pid>` 注销。
- **父进程死亡判定**：看门狗监听 stdin 读到 EOF（`end` / `close` / `error`）。无论父进程正常退出还是被强杀，操作系统都会关闭管道写端；不轮询父 PID，也不依赖进程创建时间。管道写端不被 MCP 服务器、后台命令或其派生的孙进程继承，确保父进程死亡后看门狗立即可读到 EOF。
- **EOF 后清理**：看门狗冲刷未分行缓冲后，对登记表中所有仍未注销的 PID 并行终止整棵进程树，完成后退出：
  - **Windows**：沿用 `packages/core/src/platform/process.ts` 的 `killTree` 规则，先检查存活再执行 `taskkill /PID <pid> /T /F`（15 秒超时兜底，失败或超时后对根进程 `SIGKILL` 兜底）。
  - **POSIX**：这些子进程本来就是独立进程组（`detached: true`），先对进程组（`-pid`，回退 `pid`）发 `SIGTERM`，轮询等待至多 2 秒，仍在运行则发 `SIGKILL`。
- **正常关闭**：会话与 Runtime 照现有流程关闭子进程并注销 PID。主进程正常退出时，看门狗读到 EOF 时登记表为空，直接退出，不残留进程。

### 2. 桌面端不加嵌套 Job

不为桌面端的每个 `nctrn rpc --stdio` 后台再套一层嵌套 Job Object：

- 模型通过同步 `shell` 启动的外部程序（例如 `code .` 打开的编辑器、用户要求拉起的本地工具）也是后台进程的后代；若按嵌套 Job 整体清理，在后台崩溃重启或超长行重置时会把用户正在使用的外部程序一并关掉。
- 看门狗只清理显式登记的 MCP 服务器和后台命令进程树，作用范围精确可控。
- 桌面外壳 `job.rs` 的全局 `KILL_ON_JOB_CLOSE` Job Object 保持不变，继续作为整个桌面应用退出时的最终兜底。

### 3. 限制

- **Windows 根进程先崩溃时的孤儿后代**：Windows 上 `taskkill /T` 依赖根进程枚举后代。如果 MCP 服务器或后台命令的根进程已经自行崩溃退出，它预先脱离留下的后代无法通过该方式清理（与 [ADR-0049](ADR-0049-external-agent-subagent.md) 的清树限制一致）。
- **看门狗自身被强杀**：如果看门狗进程本身也被外部强杀，则不再有孤儿清理保护。
- **极短窗口与 PID 复用边界**：从父进程死亡到看门狗动手清理之间存在极短时间窗口；由于已退出或已主动结束的子进程会立即注销，已注销的 PID 不会被结束，因此不会误杀之后复用了旧 PID 的无关进程。

## 后果

- CLI、TUI 与桌面后台三种形态在主进程被强杀后获得一致的子进程清理保护，不再因单个后台崩溃或强杀遗留忽略 EOF 的 MCP 服务器和后台命令。
- 不使用 MCP、不启动后台命令的轻量会话零额外进程开销；开启后每个 Nocturne 进程最多增加一个空闲等待 stdin EOF 的轻量 Node 进程。
- 内联看门狗脚本无需改动构建产物布局、`scripts/bundle-nctrn.mjs`、`scripts/pack-npm.mjs` 或 Tauri 资源清单。
- Rust 外壳代码（`apps/desktop/src-tauri`）无需修改。

## 备选方案

- **每个后台套一层嵌套 Job Object**：仅覆盖 Windows 桌面端，CLI / TUI 和 POSIX 仍无保护；更重要的是会把后台下同步 `shell` 启动的用户程序（如 `code .`）在后台重启时一并杀掉，误伤范围不可接受。不采用。
- **轮询父 PID 加进程创建时间**：看门狗需要定时唤醒轮询进程表，既带来持续空转开销和清理延迟，又要在 Windows（WMI / PowerShell / 原生 API）与 POSIX（`/proc` / `ps`）各自维护进程创建时间读取逻辑，复杂度高且受安全软件拖慢。利用管道写端随进程死亡由 OS 立即关闭触发 EOF，零轮询、跨平台一致且毫秒级感知。不采用。
- **下次启动时扫描清理残留**：如果用户不再启动 Nocturne，孤儿进程会一直占着资源、端口和文件锁；而且下次启动时还要持久化 PID 与启动时间并在高风险下判断 PID 是否被复用，既不能及时释放，又增加误杀风险。不采用。
