# ADR-0068：授权管理

- 状态：已接受（维护者 2026-10-26 确认：信任与授权同页；手机可单项和全部撤销；不做过期、使用统计、升级成规则）
- 日期：2026-10-26
- 修订：[permissions.md](../architecture/permissions.md) 第 5.4、7 节，[config.md](../architecture/config.md) 第 4 节，[rpc.md](../protocols/rpc.md)，[events.md](../protocols/events.md) `tool.started.permission` / `permission.resolved`，[desktop.md](../apps/desktop.md)、[tui.md](../apps/tui.md)、[cli.md](../apps/cli.md)，[ADR-0052](ADR-0052-remote-web-client.md) 远程边界

## 背景

- 确认时选「本项目允许」会写进 `<NOCTURNE_HOME>/grants/<workspaceKey>.json`，之后同一目标直接放行。但任何客户端都看不到这些记录，也撤销不了，只能手动去删文件，而删文件本身又会触发「修改 Nocturne 授权配置」的确认。
- 「本会话允许」只在内存里，同样看不到、撤销不了，只能关掉会话。
- 被授权直接放行的工具行没有任何标注，事后看对话分不清这一步是规则放行、授权放行还是审查放行（审查已经有「审查：放行」的标注）。
- 桌面端没有信任项目的入口：`setWorkspaceTrusted` 不经 RPC，未信任的项目只能回到终端执行 `nctrn trust`（[desktop.md](../apps/desktop.md) 会话区提示一段已写明「永久授权管理另行规划」）。
- 这个缺口从 2026-10-17 起挂在待办里。现在有了 MCP 代理调用和定时任务，经授权放行的调用更多，问题更明显。

## 决定

### 1. 设置页新增「授权」

设置页左侧导航在「MCP」之后加一项「授权」，内容是一个双栏页（`page3`，和 MCP、技能页同一骨架）：

- **左栏：工作区列表**。列出有项目授权记录或信任记录的工作区，以及当前已打开会话所在的工作区；每行显示目录名、授权条数和信任状态。普通对话的工作区排在最前，标「普通对话」。
- **右栏：所选工作区**，从上到下三块：
  1. **信任**：显示「已信任 / 未信任 / 没有项目配置」。有项目配置时可以信任或取消信任。点「信任」先弹确认，列出信任后会生效的内容：项目配置里的 MCP 服务器（名字和命令）、Hook 条数、放宽的权限规则条数，说明「这些配置来自仓库，信任后会在打开会话时执行」。取消信任不用确认（收紧）。
  2. **项目授权**：一张表，列为「类别 · 目标 · 授予时间 · 撤销」。类别用界面现有的用词（读取、修改、命令、网络、MCP、子代理）；目标完整显示，命令用等宽字体，过长时折叠、可展开；按授予时间倒序。每行一个「撤销」，表头一个「全部撤销」（再点一次确认，和删除定时任务一样）。没有记录时显示「还没有项目授权。确认时选『本项目允许』会出现在这里。」
  3. **说明**一行：规则（例如「允许所有 git 命令」）写在 `config.json` 的 `permissions.rules`，不在这里编辑；这里只管确认时点出来的授权。
- 撤销立即生效：权限层每次判定都实时读授权存储（[permissions.md](../architecture/permissions.md) 5.4），下一次同目标调用就会重新询问；正在等待确认或执行中的调用不受影响。

### 2. 本会话授权

- 状态栏的权限预设菜单底部加一段「本会话已允许 N 项」，展开列出本会话授权（类别、目标），每项可撤销，另有「全部撤销」。N 为 0 时不显示这一段。
- 会话授权作用于整棵会话树（子会话只读继承），撤销后父子会话同时生效。
- 会话授权仍然只在内存里，关闭会话即失效，不变。

### 3. 工具行标注

- 由授权放行的调用，在工具行状态位置旁显示小标签「已授权」，悬停或长按显示「本项目允许 · 2026-10-20 14:03」或「本会话允许」，以及授权目标。
- 为了不靠解析人读文案（`rule` 里的「Grant（本项目）…」）区分，`RuleHit` 在 `origin: "grant"` 时增加可选字段 `grant: { scope: "session" | "project", createdAt }`；`tool.started.permission` 与 `permission.resolved` 各加同名可选字段 `grant?`。旧日志没有这个字段，照旧按 `source: "grant"` 显示「已授权」，不区分范围。
- 规则直接放行的调用不标注（太多，没有信息量）；审查放行的现有标注不变。

### 4. Core 与 RPC

- `GrantStore` 增加 `remove(kind, target)` 与 `clear()`，原子重写文件，失败抛错由调用方报给客户端。
- Runtime 公开 API，经 RPC 新增 `grants.*`（[rpc.md](../protocols/rpc.md) 新节）：
  - `grants.workspaces`：`{}` → 工作区列表（真实路径、项目授权条数、信任状态、是否有项目配置）；来源是 `grants/` 下各文件的 `workspaceRoot` 字段、`trust.json` 和当前已打开会话的工作区；损坏或版本不符的文件不列入，发 `runtime.warning`；
  - `grants.list`：`{ workspace }` → `Grant[]`；`grants.revoke`：`{ workspace, kind, target }` → `null`；`grants.revokeAll`：`{ workspace }` → `null`；
  - `grants.describeProject`：`{ workspace }` → 信任确认框要列的内容（MCP 服务器名与命令、Hook 条数、放宽规则条数），只读解析，不执行任何东西；
  - `grants.setTrusted`：`{ workspace, trusted }` → `null`，即现有 `setWorkspaceTrusted` 开放到 RPC。
- 会话方法：`session.listGrants`、`session.revokeGrant`（`{ sessionId, kind, target }`）、`session.revokeAllGrants`；作用于会话树的根，子会话调用等同于根会话。
- 服务端通知 `grants.changed { workspace?, sessionId? }`：新增或撤销授权、改信任后发出，设置页和状态栏据此重拉。易失，不写日志，广播给所有已握手连接（同 `schedule.changed`）。
- 这些都是用户操作入口，不是工具；模型改不了授权数据的规则（`grants/**`、`trust.json` 的 edit 至少 ask，[permissions.md](../architecture/permissions.md) 第 7 节）不变。

### 5. 手机网页

手机只能收紧，不能放宽。这细化了 [ADR-0052 修订 2026-10-15](ADR-0052-remote-web-client.md) 的边界「远程连接不能改动撤销手机后仍然生效的东西（……持久授权、项目信任）」：那条要防的是手机被盗或配对泄露后留下的放宽；撤销授权只会让之后多问几次，不留后患，因此放开。

- 远程白名单放行 `grants.workspaces`、`grants.list`、`grants.revoke`、`grants.revokeAll`，以及 `session.listGrants`、`session.revokeGrant`、`session.revokeAllGrants`。
- `grants.setTrusted`、`grants.describeProject` 不进白名单（后者会把仓库里的命令行发到手机，没有必要）；手机上的信任状态只显示，按钮禁用并提示「请在电脑上操作」。
- 修订 ADR-0052 文末与 [rpc.md](../protocols/rpc.md) 第 7 节的边界说明：「持久授权」改为「新增持久授权」。
- 手机入口：会话页的权限菜单里有「本会话已允许 N 项」；首页的设置区加「授权」，复用同一页面的窄屏布局。工具行标注共用渲染，自然生效。

### 6. TUI 与 CLI

- TUI：`/grants` 打开全屏页（`PageShell`），左栏工作区、右栏信任状态和授权列表，`d` 撤销所选、`D` 全部撤销（二次确认），`t` 切换信任（信任同样先显示确认内容）。工具行末尾加「（已授权）」。
- CLI：`nctrn grants [list] [--workspace <dir>]`、`nctrn grants revoke <编号|--all> [--workspace <dir>]`；会话内 `/grants` 列出本会话与本项目授权、`/grants revoke <编号>`。`nctrn trust` / `nctrn untrust` 不变。

### 7. 不做的

- 不在这里编辑规则（`permissions.rules`）；不提供把一条授权「升级」成规则的按钮。
- 不记录授权的使用次数或最近使用时间（要在每次判定时写盘，代价不值）。
- 不给授权加过期时间。
- 不提供「新增授权」入口：授权只在确认时产生。

## 验收

- 撤销项目授权后，同一会话下一次同目标调用重新询问；全部撤销清空文件；写盘失败时界面报错、列表不变。
- 撤销会话授权对子会话同时生效。
- 信任确认框列出项目配置里的 MCP 服务器、Hook 条数、放宽规则条数；信任后新开的会话加载项目配置，取消信任后新开的会话不加载。
- `matchedRule.grant` 写入 `tool.started.permission` 与 `permission.resolved`；工具行按范围显示标签；旧日志只显示「已授权」。
- `grants.changed` 在新增、撤销、改信任时发出，设置页与状态栏刷新。
- 手机：能查看和撤销；信任按钮禁用并提示；`setWorkspaceTrusted` 经远程调用被拒。
- TUI `/grants` 与 CLI `nctrn grants` 的列表、撤销、全部撤销。
- 桌面端截图（深浅）：授权页（有记录 / 空）、信任确认框、状态栏「本会话已允许」、工具行标签；手机两张。

## 后果

- 授权从「写进去就看不见」变成可查看、可撤销，用户敢放心点「本项目允许」。
- 桌面端补上信任入口，不必再回终端执行 `nctrn trust`。
- 新增一组 RPC 方法和一个可选事件字段；授权文件格式不变。

## 备选方案

- **只做查看，不做撤销**：看得见删不掉，问题只解决一半。
- **把授权和规则放在同一张表里编辑**：规则是手写配置、可能带注释和顺序语义，授权是程序维护的记录；混在一起要么破坏手写文件，要么让界面承担规则编辑器的复杂度。分开，规则继续手写。
- **手机也能信任项目**：信任会让仓库里的 MCP 命令和 Hook 在电脑上执行，属于放宽；远程通道只给收紧能力。
