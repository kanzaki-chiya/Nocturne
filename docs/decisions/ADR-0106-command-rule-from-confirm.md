# ADR-0106：确认卡片里把命令改成规则

- 状态：已接受
- 日期：2026-11-21
- 修订：[ADR-0068](ADR-0068-grants-management.md)、[permissions.md](../architecture/permissions.md)（第 5.3、5.4、7 节）、[events.md](../protocols/events.md)（`permission.requested`、`permission.resolved`、`tool.started`、`subagent.permissions`）、[rpc.md](../protocols/rpc.md)（第 3.11、7 节）、[config.md](../architecture/config.md)（第 1、4 节）、[desktop.md](../apps/desktop.md)（第 5.2、5.5、11 节）、[tui.md](../apps/tui.md)（第 3、4.1 节）、[roadmap.md](../roadmap/roadmap.md)

## 背景

在 `default`、`auto-edit`、`smart` 等预设下，模型经常在同一项目里反复执行参数略有不同的同类普通 shell 命令（例如 `git status --short`、`npx vitest run a.ts`、`pnpm test ...`）。此前的「本项目允许」只按整条命令原文做精确 Grant 匹配，换一个参数或文件名就得重新确认；而要按通配符放行某类命令，只能切出对话去手写 `config.json` 的 `permissions.rules`。

需要支持在桌面端的权限确认卡片里就地把当前 shell 命令改成一条可编辑的模式规则，但必须同时守住以下约束：

- 不能覆盖用户手写的 `deny` 或显式 `ask` 规则，也不能改写用户手写的 `config.json`；
- 不能放宽组合命令、高风险命令、不透明 PowerShell、凭据类命令、`PreToolUse` Hook 强制确认或安全审查直接交人的操作；
- 不能破坏已有客户端（手机网页、安卓 App、TUI）以及历史会话日志、旧版授权文件的兼容性。

## 决定

### 1. 存成项目级模式授权，不写 `config.json`

- `Grant` 新增可选字段 `match?: "pattern"`：缺省时维持精确匹配；值为 `"pattern"` 时仅允许用于 `kind: "shell"`，此时 `target` 为 shell 通配符模式。
- 模式授权存入 `<NOCTURNE_HOME>/grants/<workspaceKey>.json`，与「本项目允许」共用项目 Grant 存储与「设置 › 授权」页的查看与撤销流程，不改写用户手写的 `config.json`。
- 存为 Grant 而不是 `permissions.rules` 的核心理由：Grant 只能在最终规则求值为 `ask` 时提升为 `allow`，永远不会覆盖用户手写的 `deny`（避免了向 `config.json` 追加规则时同层后写优先覆盖既有规则的问题）；同时只作用于当前工作区，与「本项目允许」的作用范围一致。
- 仅提供项目范围，不做会话范围模式授权，也不做全局（所有项目）范围模式授权。
- **兼容退化与校验**：`config/grants.ts` 原有 `grantSchema` 是非严格 `z.object`。旧版本读取包含 `match: "pattern"` 的授权文件时会剥离未知字段 `match`，将其当作精确 Grant（目标为含 `*` 的模式原文，几乎不会被精确命中）；若旧版本随后重写该文件，则 `match` 字段丢失、该条模式授权退化失效。这是可接受的退化，因此不提升授权文件 `version`（仍为 `1`）。新版本加载时校验 `match` 只能缺省或为 `"pattern"`，且 `match === "pattern"` 只能配 `kind === "shell"`；不合法的条目按既有坏条目逻辑跳过并告警，不影响其余合法条目。

### 2. 提供时机（`permission.requested.ruleSuggestion`）

- 不新增 `PermissionOption` 枚举值，改为在 `permission.requested` 事件（以及 `SubagentPendingPermission` / `PendingPermission`）上附加可选字段 `ruleSuggestion?: { pattern: string }`。旧客户端自然忽略该未知字段，旧日志没有该字段照常解码回放，不提升日志 `formatVersion`。
- 仅在以下 **6 个条件全部满足** 时，由权限层 `PermissionGate` 附带 `ruleSuggestion`：
  1. 单一主体，且 `kind === "shell"`；
  2. 非组合命令（`isCompositeShell` 按主体 `shell` 方言判定）；
  3. 本次请求的 `options` 包含 `allow_project`（自然排除高风险命令、不透明 PowerShell `-EncodedCommand`、工作区外 `edit`、`schedule`、`app` 等）；
  4. `evaluation.userOnly !== true`（排除 `smart` 直接交人、可能读取凭据的命令、预设 `userOnly` 规则，以及用户 / 项目 / CLI 层的显式 `ask` 规则）；
  5. 非 `PreToolUse` Hook 强制确认（`forceAsk` 本就跳过 Grant，保存 Grant 不会生效）；
  6. 处于交互模式（`interactive === true`）。
- 桌面端在请求带 `ruleSuggestion` 且未隐藏持久授权时渲染按钮「改成规则…」，排在「本项目允许」之后。

### 3. 模式校验与预填纯函数

- 新增两个纯函数，因模块依赖方向规定 `protocol` 不依赖任何模块而 `permission` 依赖 `protocol`（见 [modules.md](../architecture/modules.md)），两者与相关 shell 方言/通配符辅助函数统一放在 `@nocturne/core/protocol`（`packages/core/src/protocol/shell-pattern.ts`）导出，由权限层与桌面端共用同一份实现：
  - `validateShellRulePattern(pattern, command, dialect)`：
    1. 去除首尾空白后必须非空且长度 `≤ 200` 字符；
    2. 不得包含组合命令控制符（对原串与 trim 后字符串均以 `isCompositeShell(..., dialect)` 检查，覆盖 `&&`、`||`、`;`、`|`、换行、反引号、`$(`、重定向，PowerShell 方言额外包含 `{` `}`）；
    3. 按空白切分的首词不得包含 `*` 或 `?`，且必须与当前命令首词完全相同；
    4. 按 shell 通配符语义（`*` 匹配含换行的任意字符、`?` 匹配单字符、大小写敏感）必须能匹配当前命令。
  - `suggestShellRulePattern(command, dialect)`：
    - 从命令开头连续提取「普通词」（不以 `-` 开头，不含 `/`、`\`、`.`、引号、`=`、`*`、`?` 及组合命令控制符），最多取 3 个；
    - 当取到至少 2 个连续普通词且其后紧跟空格并还有非空白内容时，预填 `<已取前缀> *`（且经 `validateShellRulePattern` 确认合法）；否则预填完整命令。
    - 示例：`git status --short` → `git status *`；`npx vitest run --maxWorkers=2 a.ts` → `npx vitest run *`；`pnpm -s typecheck` → `pnpm -s typecheck`；`cat foo.txt` → `cat foo.txt`；`ls` → `ls`；`git status` → `git status`。

### 4. 回复、生效、去重与工具行标注

- **回复与持久化**：`PermissionReply` 新增 `remember: "pattern"` 与 `pattern?: string`。`PermissionGate.respond` 仅在请求本身带有 `ruleSuggestion`（且满足单一 `shell` 主体与 `options` 含 `allow_project`）时接受 `remember: "pattern"`，并对 `reply.pattern` 调用 `validateShellRulePattern` 做二次校验；不通过直接返回 `false`（请求保持等待、不写任何授权）。校验通过后写入项目 Grant `{ kind: "shell", target: validated.pattern, createdAt, match: "pattern" }`；写盘失败时沿用既有降级策略，退化为写入当前命令的会话精确 Grant、结算 `remember: "session"` 并发出 `runtime.warning(code: "grant_persist_failed")`。
- **求值与排除边界**：规则求值结果为 `ask`（且未跳过审批）时，精确 Grant（会话优先于项目）仍最先匹配且行为完全不变；未命中精确 Grant 时再匹配项目模式 Grant，且仅当同时满足以下条件才参与匹配：
  1. 主体为 `shell`；
  2. 非组合命令（`!isCompositeShell`）；
  3. 未命中高风险命令段（`findRiskySegment === undefined`）；
  4. 非不透明 PowerShell（`!isOpaquePowerShellCommand`）；
  5. 非 `userOnly`（尤其不绕过用户 / 项目 / CLI 的显式 `ask` 规则，例如已有 `git *` 模式 Grant、用户配置了 `git push * → ask`，执行 `git push origin main` 仍返回 `ask`）。
  未命中模式 Grant 时再继续执行 `autoApproveAsk`（`--yes`）等后续分支。
- **去重与撤销**：项目与会话 Grant 的去重键与撤销键均由 `(kind, target)` 扩展为三元组 `(kind, target, match)`，同一 `target` 的精确 Grant（`match === undefined`）与模式 Grant（`match === "pattern"`）互不冲突、各自独立撤销。
- **事件与工具行标注**：`permission.resolved.remember` 支持 `"pattern"`；`RuleHit.grant`、`tool.started.permission.grant` 与 `permission.resolved.grant` 增加可选字段 `match?: "pattern"` 与 `pattern?: string`（仅模式 Grant 命中时填充，精确 Grant 保持原有形状）。桌面端工具行「已授权」标签悬停时，对模式 Grant 显示「命令规则 · <时间>」及模式原文。

### 5. 桌面端确认卡片

- 当确认请求带 `ruleSuggestion` 且未设置 `hidePersistentPermissions` 时，在「本项目允许」之后渲染按钮「改成规则…」，数字键 `1–N` 与 `KeyHint` 按实际按钮顺序顺延。
- 点击「改成规则…」原地切换为内联表单：
  - 标签「命令规则」，等宽输入框预填 `ruleSuggestion.pattern` 并自动聚焦；
  - 输入框下方列出本会话中将会被该模式匹配的命令（最多 5 条，当前命令固定排在第一条，复用同一排除条件过滤组合命令、高风险命令与不透明 PowerShell）；
  - 底部按钮为「允许并保存」与「返回」。
- 输入变化时实时调用 `validateShellRulePattern` 校验：不通过时输入框描红，下方列表替换为单行错误原因，并禁用「允许并保存」。错误原因严格限定为三句固定文案：「不匹配当前命令」「开头要是 `<命令名>`」「不能包含 &&、|、; 等连接符」（空串与超过 200 字归入「不匹配当前命令」）。
- 按 `Esc` 或点击「返回」退回选项按钮视图（不直接拒绝当前权限请求）。
- 手机网页（`.phone` / `hidePersistentPermissions`）本轮不显示「改成规则…」。

### 6. 其他客户端与 RPC

- **TUI**：权限确认框本轮忽略 `ruleSuggestion`，沿用既有五项按钮；`/grants` 授权管理页对模式 Grant 的类别显示「命令规则」，并按 `(kind, target, match)` 撤销。
- **桌面 / 手机网页 / CLI 授权管理**：桌面端与手机网页「设置 › 授权」页对模式 Grant 类别显示「命令规则」，按 `(kind, target, match)` 撤销；CLI `nctrn grants` 将模式 Grant 标注为 `shell [模式]`，撤销时透传 `match`。
- **RPC**：协议与服务端同步支持 `permission.requested.ruleSuggestion`、`PermissionReply.remember: "pattern"` / `pattern`、`permission.resolved.remember: "pattern"`、`grant.match` / `grant.pattern`，以及 `grants.revoke` / `session.revokeGrant` 的可选 `match?: "pattern"` 参数。远程连接（`origin: "remote"`）与外部 agent 连接（`origin: "agent"`）同样将 `reply.remember === "pattern"` 视为持久授权并直接拒绝（`remote_not_allowed` / `agent_not_allowed`），不调用 Core 且保持请求等待。

## 后果

- 用户在桌面端确认常规 shell 命令时，可以一次编辑并预览匹配范围后存为项目级「命令规则」，减少重复弹窗，同时不碰手写 `config.json`。
- 权限边界保持清晰：模式 Grant 只能放行 `ask`、不能覆盖 `deny` 或显式 `ask`、不适用于组合/高风险/编码/凭据类命令；全部校验与排除逻辑由 `@nocturne/core/protocol` 与权限层统一兜底，UI 校验仅作即时反馈。
- 会话日志 `formatVersion` 与项目授权文件 `version` 均保持为 `1`，**新版可以直接回放旧日志**；旧客户端实时连接时可忽略新增的可选 `permission.requested.ruleSuggestion` 字段（不会渲染空按钮）。反向兼容上，旧版 `schema.ts` 的 `permission.resolved.remember` 是封闭枚举（不含 `"pattern"`），因此**旧版二进制**回放包含 `remember: "pattern"` 结算的新日志时会解码失败；旧版二进制若读写新授权文件，也会剥离模式条目的 `match` 字段使其退化失效。
- 复用 [ADR-0068](ADR-0068-grants-management.md) 的授权管理界面、`grants.changed` 通知与工具行「已授权」标注，不另起第二套规则管理页。

## 备选方案

- **追加用户规则到 `config.json`**：同层规则遵循后写优先（last match wins），在 `permissions.rules` 末尾追加一条 `allow` 会直接覆盖用户此前手写的 `deny` 或 `ask` 规则，破坏安全边界；同时用户级 `config.json` 作用于所有项目而非当前工作区，且会改写用户手写文件。不采用。
- **会话范围模式授权**：关闭会话即失效，下次打开同一项目仍需重复确认同一批命令；仅需临时放宽时已有「本会话允许」或切换权限预设可用。不采用。
- **所有项目范围模式授权**：不同仓库下同名命令或脚本的含义与风险差异很大，跨项目生效范围过宽，也与确认卡片里「本项目允许」的作用域心智不一致。不采用。
- **新增一个 `PermissionOption` 枚举值**：手机网页与安卓 App 的版本常落后于桌面端，旧客户端在每次收到确认请求时都会遇到未知 `PermissionOption` 而渲染空按钮或异常项；同时每次触发确认（即使用户只选「允许一次」或拒绝）都会把新枚举写入 `permission.requested.options`，导致旧版 `schema.ts` 拒绝恢复整条日志。改用可选 `ruleSuggestion` 后，旧客户端实时连接完全不受影响，旧版回放风险也被收窄到实际保存了 `remember: "pattern"` 结算的新日志。不采用。
