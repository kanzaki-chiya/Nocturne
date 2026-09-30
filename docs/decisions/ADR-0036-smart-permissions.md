# ADR-0036：智能权限审查与不询问的 full-access

- 状态：提议
- 日期：2026-10-01

## 背景

维护者实测时在 `full-access` 下仍被频繁询问，没法顺畅地测试。对 Inkloom 会话 `202609302136-0f0ffc28` 的确认请求逐条核对后，原因有三类：

1. **一个匹配缺陷，已修复（1ad8a02）**。shell 规则的通配符转成正则时没有加 `s` 标志，`*` 不跨换行。模型常写的多行 PowerShell 命令（每行一条 `git …`、`Write-Output …`）整条连 `full-access` 的 `shell * → allow` 都没命中，落到「默认询问（无规则匹配）」。这是该会话里绝大多数询问的来源。修复后多行命令先命中 `*`，再按 [permissions.md](../architecture/permissions.md) 5.3 逐段求值。
2. **按设计保留的询问**。现行 `full-access` 仍会问：工作区外的 `edit`、`.git/` 与 `.nocturne/` 内的 `edit`、高风险命令、`-EncodedCommand`、可能读取凭据的命令、修改 Nocturne 授权配置。其中最常碰到的是前两项（模型把路径拼错到工作区外、改 `.git/info/exclude` 之类）。
3. **只能二选一**。现有预设要么逐项问（`default`/`auto-edit`），要么几乎全放（`full-access`），缺少一个「让模型先替我看一眼、只把拿不准的交给我」的档位。[路线图](../roadmap/roadmap.md)已经写了智能权限与安全审计模型的设计要点，本 ADR 把它和「真正的 full-access」一起定下来。

权限层的边界不变：权限判定只发生在权限层（[permissions.md](../architecture/permissions.md) 第 1 节），权限不是沙箱，审查器是基于模型的判断，**不是安全边界**。

## 决定

### 1. 预设由四个变为六个

| 预设 | 放行范围 | 仍需确认的操作交给谁 |
|---|---|---|
| `read-only` | 不变 | 用户 |
| `default` | 不变 | 用户 |
| `auto-edit` | 不变 | 用户 |
| `smart`（新） | 同 `auto-edit` | 先交审查器：放行即执行；拦截与拿不准都询问用户，弹窗显示审查理由 |
| `auto`（新） | 同现行 `full-access` | 先交审查器：放行即执行；拦截直接拒绝，理由作为工具结果回给主模型；拿不准才询问用户 |
| `full-access` | 见第 2 条，基本不询问 | 用户（只剩第 2 条列出的少数情况） |

Alt+M 与 `/preset` 按上表顺序循环，六项都可达；`/settings` 的默认权限预设同步扩充。`smart` 适合减少打扰、最终决定仍在用户；`auto` 适合无人值守的长任务；`full-access` 适合维护者自己在受控环境里测试。

### 2. full-access 改为不询问

`full-access` 去掉以下降级，改为直接 `allow`：

- 工作区外的 `edit`（预设宽规则 `edit ** where=outside` 由 `ask` 改为 `allow`）；
- `.git/` 内部的 `edit`；
- 高风险命令表（`ShellDescriptor.risk`）与嵌套 shell 的高风险查找；
- `-EncodedCommand` 的不透明降级。

保留不变的只有下面几项，它们触发得很少，保护的是 Nocturne 自身而不是工作区：

- 凭据文件的内置硬拒绝（任何预设、规则、Grant 都不能放开）；
- 修改 Nocturne 授权数据（`config.json`、`settings.json`、`trust.json`、`grants/**`、`providers.json`）与 `.nocturne/` 项目配置目录：至少 `ask`；
- 可能读取 Nocturne 凭据的命令：至少 `ask`；
- 用户、可信项目与命令行里显式写的 `ask`/`deny` 规则照旧生效，不可信项目规则照旧只收紧。

原来由 `full-access` 承担的「放得宽但危险操作还要把关」这一档，由 `auto` 接手：`auto` 的规则序列就是现行 `full-access` 的规则序列（含高风险表、工作区外 `edit → ask` 等），只是这些 `ask` 先交给审查器。

### 3. 审查器接口与在求值中的位置

审查器是权限层内的一个可替换组件，接口：

```ts
interface SecurityReviewer {
  review(input: ReviewInput, signal: AbortSignal): Promise<ReviewResult>;
}
interface ReviewInput {
  subjects: ReviewSubject[];      // 需要确认的主体：kind、target（shell 为命令原文、路径类为路径、network 为 URL、mcp 为工具名与参数）、where
  cwd: string;
  recentUserMessages: string[];   // 最近 3 条用户消息，每条截断到 2000 字符
}
interface ReviewResult {
  verdict: "allow" | "block" | "unsure";
  reason: string;                 // 一两句中文或英文，显示给用户或回给主模型
}
```

审查器**不看**文件内容、工具输出与助手消息，只看上面这些字段，降低被提示注入操纵的机会。一次工具调用有多个主体需要确认时合成一次审查。

在 5.3 算法中的位置（仅 `smart`、`auto` 预设）：

```text
decision == ask 时：
  Grant 匹配            → allow（不调审查器）
  autoApproveAsk（--yes）→ allow（不调审查器）
  PermissionRequest Hook 有回答 → 按 Hook 结算
  主体属于「只由用户确认」集合 → 询问用户（不调审查器）
  否则调审查器：
    allow  → allow（source = "reviewer"）
    block  → smart：询问用户并附理由；auto：deny（source = "reviewer"），理由回给主模型
    unsure → 询问用户并附理由
```

「只由用户确认」集合：修改 Nocturne 授权数据与 `.nocturne/`、可能读取凭据的命令、Hook 强制的 `ask`。这些始终由用户本人决定，审查器放行也不算数。

审查器超时（默认 20 秒）、报错、输出无法解析，一律按 `unsure` 处理。审查进行中用户中止 Turn 时按现有 `cancelled` 结算。同一会话内对同一主体（精确目标，匹配方式同会话 Grant）的 `allow` 结果缓存到会话结束，避免同一条命令反复审查；`block` 与 `unsure` 不缓存。

### 4. 非交互模式与子代理

没有交互式客户端时（`interactive = false`）：审查器 `allow` 照常放行，`block` 与 `unsure` 都按 `deny` 结算（`source` 分别为 `reviewer` 与 `non_interactive`）。这样 `auto` 可以用于无人值守的非交互运行，拿不准的操作不会被默许。

子代理沿用父会话的预设与审查器实例；子会话本就是非交互的，按上一段处理。

### 5. 未配置审查器时

`smart` 按 `auto-edit` 行为，`auto` 按现行 `full-access`（即第 2 条之前的规则）行为：需要确认的操作全部询问用户。切到这两个预设且未配置审查器时，在对话区提示一次「未设置安全审查，去 /settings 设置」，状态栏的预设段照常显示预设名。

### 6. 审查器后端

先做安全审计模型这一种后端，TypeSafe Jev 作为第二种在同一接口下接入。

**安全审计模型（先做）**：`settings.json` 新增 `permission.reviewer`：

```json
{ "permission": { "reviewer": { "backend": "model", "model": { "provider": "deepseek", "model": "deepseek-v4.1-flash" } } } }
```

- 在 `/settings` 单独一行选择，与主对话模型分开选择、分开计费，不并入以后的「模型角色」。
- 经现有 Provider 层发一次不带工具的请求，思考档位固定为该模型支持的最低档（有 `off` 就用 `off`），`maxOutputTokens` 取 300。
- 提示词给出三个选项与判断口径（用户最近的消息是否授权了这类操作、是否超出工作区与任务范围、是否不可逆），要求第一行只写 `ALLOW`/`BLOCK`/`UNSURE`，第二行写理由；拿不准就选 `UNSURE`，不让模型自报置信度。
- 该请求的 token 用量计入会话用量，单独标注来源，不影响上下文占用。

**TypeSafe Jev（第二步）**：判定接口而非 chat completions，按路线图的描述做一个判定适配器，返回概率按阈值映射三档（默认 ≥0.9 放行、≤0.1 拦截、其余拿不准，阈值可配）。地址与密钥可配，密钥走现有凭据存储（[ADR-0015](ADR-0015-provider-setup-credentials.md)），默认变量 `TYPESAFE_API_KEY`。不引入官方 SDK：它只是一次 HTTP 调用，直接用 `fetch`。**接口的请求/响应字段在实现前按 TypeSafe 官方文档核对**，本 ADR 只定适配器形状与三档映射；核对结果与本文不符时在「修订」中记录。开启时明确告知命令与最近的用户消息会发往 TypeSafe。离线模型后端不在本 ADR 范围内。

### 7. 事件与界面

- 新增持久事件 `permission.reviewed`：`callId`、`requestId?`、`backend`、`model?`、`verdict`、`reason`、`durationMs`、`cached`。审查后需要询问用户时，它先于 `permission.requested` 发出，`permission.requested.reason` 带上审查理由；用户最终是否推翻审查结论由随后的 `permission.resolved` 体现。
- `permission.resolved.source` 新增 `"reviewer"`（审查器直接放行或 `auto` 下直接拒绝）。审查器放行的调用同样在 `tool.started.permission` 中记录来源。
- 新增持久事件会让旧版本 Runtime 无法恢复含这些事件的会话（[events.md](../protocols/events.md) 第 8 节），这是有意的：审查记录需要可追溯。
- TUI 与 CLI 在工具行上方显示一行：`审查：放行 — <理由>`、`审查：拦截 — <理由>`、`审查：拿不准 — <理由>`；确认弹窗里同样显示理由。

### 8. 高风险操作只给一次性选项

路线图中「高风险操作只给一次性选项」并入本 ADR：确认请求的主体命中高风险命令表、`-EncodedCommand` 或工作区外 `edit` 时（不论哪个预设、是否经过审查器，只要最终询问用户），`permission.requested.options` 只给 `allow_once`、`deny`、`deny_stop`，不提供会话内与项目级长期允许。选项集由权限层计算，客户端照 `options` 渲染，不自行判断。

## 后果

- `packages/core/src/permission/`：预设表与规则序列（`presets.ts`）、5.3 算法中的审查分支与缓存（`policy.ts` 或新文件）、选项集计算；`SecurityReviewer` 接口与两个后端的实现放在权限模块下，模型后端经 Provider 公开接口调用，不按服务商分支。
- `protocol`：`PermissionPresetName` 增加 `smart`、`auto`；新事件 `permission.reviewed`；`permission.resolved.source` 增加 `reviewer`；会话日志 schema 同步（注意 ADR-0031 那次漏改 schema 导致会话无法恢复的教训，新增枚举值要有往返测试）。
- 设置层：`permission.reviewer` 字段、`/settings` 新行与模型选择。
- TUI/CLI：预设循环、审查行、弹窗理由、未配置提示。
- 文档：[permissions.md](../architecture/permissions.md) 第 6、7 节与 5.3、[events.md](../protocols/events.md)、[config.md](../architecture/config.md)、[tui.md](../apps/tui.md)、[cli.md](../apps/cli.md)；路线图中「智能权限与安全审计模型」「高风险操作只给一次性选项」两项改为指向本 ADR。
- 实现排在 `apply_patch`（[ADR-0035](ADR-0035-apply-patch.md)）之后。建议分两轮：第一轮做第 1、2、8 条与审查框架和模型后端；第二轮接 Jev。

## 备选方案

- **full-access 保持现状，只修匹配缺陷**：缺陷修完后询问已大幅减少，但工作区外 `edit` 与高风险命令仍会打断测试；维护者明确要「真正的 full access」。保留风险把关这一需求改由 `auto` 满足。
- **full-access 连授权数据与凭据命令也放开**：这两类几乎不会在正常任务里出现，一旦出现往往意味着模型在试图改自己的权限或读密钥；保留询问的打扰很小。
- **审查器放在工具实现或 UI 里**：违反「权限判定只能发生在权限层」的约束。
- **让审查器自报置信度再按阈值分档**：LLM 的自报置信度不可靠；三选一加「拿不准就选拿不准」更直接。Jev 返回的是模型本身的概率，可以按阈值分档。
- **审查器看文件内容或工具输出以提高准确度**：扩大了提示注入面（工具输出正是注入的主要来源），不采用。

## 待确认

1. `full-access` 是否按第 2 条放开高风险命令与工作区外 `edit`（推荐放开，风险把关交给 `auto`）。
2. 预设顺序与名字：`smart`、`auto` 两个名字，以及六项都放进 Alt+M 循环（推荐都放）。
3. 非交互模式下审查器 `allow` 是否放行（推荐放行，否则 `auto` 无法用于无人值守的非交互运行）。
4. 审查超时 20 秒、最近 3 条用户消息、`allow` 结果按会话缓存这几个默认值。
