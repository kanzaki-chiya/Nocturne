# ADR-0036：权限预设重排——guarded / smart / bypass 与安全审查

- 状态：已接受（维护者 2026-10-01 确认）
- 日期：2026-10-01

## 背景

维护者实测时在 `full-access` 下仍被频繁询问，没法顺畅地测试。对 Inkloom 会话 `202609302136-0f0ffc28` 的确认请求逐条核对后，原因有三类：

1. **一个匹配缺陷，已修复（1ad8a02）**。shell 规则的通配符转成正则时没有加 `s` 标志，`*` 不跨换行。模型常写的多行 PowerShell 命令（每行一条 `git …`、`Write-Output …`）整条连 `full-access` 的 `shell * → allow` 都没命中，落到「默认询问（无规则匹配）」。这是该会话里绝大多数询问的来源。修复后多行命令先命中 `*`，再按 [permissions.md](../architecture/permissions.md) 5.3 逐段求值。
2. **按设计保留的询问**。现行 `full-access` 仍会问：工作区外的 `edit`、`.git/` 与 `.nocturne/` 内的 `edit`、高风险命令、`-EncodedCommand`、可能读取凭据的命令、修改 Nocturne 授权配置。其中最常碰到的是前两项（模型把路径拼错到工作区外、改 `.git/info/exclude` 之类）。
3. **缺少中间档**。现有预设要么把危险操作交给用户逐个确认，要么没有真正「不问」的档位；也没有「先让审查器看一眼，只把拿不准的交给我」的档位。[路线图](../roadmap/roadmap.md)已经写了智能权限与安全审计模型的设计要点，本 ADR 把它和预设重排一起定下来。

权限层的边界不变：权限判定只发生在权限层（[permissions.md](../architecture/permissions.md) 第 1 节），权限不是沙箱，审查器是基于模型的判断，**不是安全边界**。

## 决定

### 1. 六个预设

按放行程度从低到高：

| 预设 | 放行范围 | 仍需确认的操作交给谁 |
|---|---|---|
| `read-only` | 不变 | 用户 |
| `default` | 不变 | 用户 |
| `auto-edit` | 不变 | 用户 |
| `guarded`（原 `full-access` 改名） | 同原 `full-access`：读写工作区、外部读、shell、network、mcp、subagent 放行 | 用户：高风险命令、工作区外 `edit`、`.git/` 内 `edit`、`-EncodedCommand` 等由分类规则（第 2 条）拦下的操作 |
| `smart`（新） | 同 `guarded` | 分类规则拦下的操作先交审查器（Jev 或小模型）：放行即执行；拦截直接拒绝，理由作为工具结果回给主模型；拿不准才询问用户 |
| `bypass`（新） | 全部放行，相当于 Claude Code 的 bypass permissions | 几乎不问，只剩第 3 条列出的少数情况 |

Alt+M 与 `/preset` 按上表顺序循环，六项都可达；`/settings` 的默认权限预设同步扩充。`guarded` 适合日常放手但危险操作自己把关；`smart` 适合长任务、减少打扰；`bypass` 适合维护者在受控环境里测试或完全信任的任务。

**旧名兼容**：`full-access` 不再出现在循环、补全与设置页里，但 `config.json`、`settings.json`、`--preset` 与 `/preset` 中写 `full-access` 仍然接受，按 `guarded` 处理（与改名前行为一致），不报错。

### 2. 分类规则（guarded 与 smart 共用）

「分类规则」就是现行 `full-access` 在宽 `allow` 之上保留的那些降级，规则本身不变，只是改了归属：

- 工作区外的 `edit`（`edit ** where=outside → ask`）；
- `.git/`、`.nocturne/` 内部的 `edit`（受保护路径）；
- 高风险命令表（`ShellDescriptor.risk`）与嵌套 shell 的高风险查找；
- `-EncodedCommand` 的不透明降级；
- 可能读取 Nocturne 凭据的命令、修改 Nocturne 授权数据（这两类见第 4 条，不交审查器）。

`guarded` 下这些 `ask` 询问用户；`smart` 下先交审查器。

### 3. bypass 不询问

`bypass` 去掉第 2 条中前四项降级，改为直接 `allow`：工作区外 `edit`、`.git/` 内 `edit`、高风险命令、`-EncodedCommand` 都放行。保留的只有下面几项，它们触发得很少，保护的是 Nocturne 自身而不是工作区：

- 凭据文件的内置硬拒绝（任何预设、规则、Grant 都不能放开）；
- 修改 Nocturne 授权数据（`config.json`、`settings.json`、`trust.json`、`grants/**`、`providers.json`）与 `.nocturne/` 项目配置目录：至少 `ask`；
- 可能读取 Nocturne 凭据的命令：至少 `ask`；
- 用户、可信项目与命令行里显式写的 `ask`/`deny` 规则照旧生效，不可信项目规则照旧只收紧。

### 4. 审查器接口与在求值中的位置

审查器是权限层内的一个可替换组件，接口：

```ts
interface SecurityReviewer {
  review(input: ReviewInput, signal: AbortSignal): Promise<ReviewResult>;
}
interface ReviewInput {
  subjects: ReviewSubject[];      // 需要确认的主体：kind、target（shell 为命令原文、路径类为路径）、where、命中的分类规则
  cwd: string;
  recentUserMessages: string[];   // 最近 3 条用户消息，每条截断到 2000 字符
}
interface ReviewResult {
  verdict: "allow" | "block" | "unsure";
  reason: string;                 // 一两句，显示给用户或回给主模型
}
```

审查器**不看**文件内容、工具输出与助手消息，只看上面这些字段，降低被提示注入操纵的机会。一次工具调用有多个主体需要确认时合成一次审查。

在 5.3 算法中的位置（仅 `smart`）：

```text
decision == ask 时：
  Grant 匹配            → allow（不调审查器）
  autoApproveAsk（--yes）→ allow（不调审查器）
  PermissionRequest Hook 有回答 → 按 Hook 结算
  主体属于「只由用户确认」集合 → 询问用户（不调审查器）
  否则调审查器：
    allow  → allow（source = "reviewer"）
    block  → deny（source = "reviewer"），理由回给主模型
    unsure → 询问用户并附理由
```

「只由用户确认」集合：修改 Nocturne 授权数据与 `.nocturne/`、可能读取凭据的命令、Hook 强制的 `ask`、用户或项目显式写的 `ask` 规则。这些始终由用户本人决定，审查器放行也不算数。

审查器超时（默认 20 秒）、报错、输出无法解析，一律按 `unsure` 处理。审查进行中用户中止 Turn 时按现有 `cancelled` 结算。同一会话内对同一主体（精确目标，匹配方式同会话 Grant）的 `allow` 结果缓存到会话结束，避免同一条命令反复审查；`block` 与 `unsure` 不缓存。

### 5. 非交互模式与子代理

没有交互式客户端时（`interactive = false`）：审查器 `allow` 照常放行，`block` 与 `unsure` 都按 `deny` 结算（`source` 分别为 `reviewer` 与 `non_interactive`）。这样 `smart` 可以用于无人值守的非交互运行，拿不准的操作不会被默许。

子代理沿用父会话的预设与审查器实例；子会话本就是非交互的，按上一段处理。

### 6. 未配置审查器时

`smart` 按 `guarded` 行为：分类规则拦下的操作全部询问用户。切到 `smart` 且未配置审查器时，在对话区提示一次「未设置安全审查，去 /settings 设置」，状态栏的预设段照常显示预设名。

### 7. 审查器后端

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

### 8. 事件与界面

- 新增持久事件 `permission.reviewed`：`callId`、`requestId?`、`backend`、`model?`、`verdict`、`reason`、`durationMs`、`cached`。审查后需要询问用户时，它先于 `permission.requested` 发出，`permission.requested.reason` 带上审查理由；用户最终是否推翻审查结论由随后的 `permission.resolved` 体现。
- `permission.resolved.source` 新增 `"reviewer"`（审查器直接放行或拦截）。审查器放行的调用同样在 `tool.started.permission` 中记录来源。
- 新增持久事件会让旧版本 Runtime 无法恢复含这些事件的会话（[events.md](../protocols/events.md) 第 8 节），这是有意的：审查记录需要可追溯。
- TUI 与 CLI 在工具行上方显示一行：`审查：放行 — <理由>`、`审查：拦截 — <理由>`、`审查：拿不准 — <理由>`；确认弹窗里同样显示理由。

### 9. 高风险操作只给一次性选项

路线图中「高风险操作只给一次性选项」并入本 ADR：确认请求的主体命中高风险命令表、`-EncodedCommand` 或工作区外 `edit` 时（不论哪个预设、是否经过审查器，只要最终询问用户），`permission.requested.options` 只给 `allow_once`、`deny`、`deny_stop`，不提供会话内与项目级长期允许。选项集由权限层计算，客户端照 `options` 渲染，不自行判断。

## 后果

- `packages/core/src/permission/`：预设表与规则序列（`presets.ts`，`full-access` 改名 `guarded` 并保留别名解析、新增 `smart`/`bypass`）、5.3 算法中的审查分支与缓存、选项集计算；`SecurityReviewer` 接口与两个后端的实现放在权限模块下，模型后端经 Provider 公开接口调用，不按服务商分支。
- `protocol`：`PermissionPresetName` 改为 `read-only | default | auto-edit | guarded | smart | bypass`，读取配置与旧会话日志时 `full-access` 映射为 `guarded`；新事件 `permission.reviewed`；`permission.resolved.source` 增加 `reviewer`；会话日志 schema 同步（吸取 ADR-0031 漏改 schema 导致会话无法恢复的教训：新增与改名的枚举值都要有往返测试，含旧日志里的 `full-access`）。
- 设置层：`permission.reviewer` 字段、`/settings` 新行与模型选择。
- TUI/CLI：预设循环、补全、审查行、弹窗理由、未配置提示。
- 文档：[permissions.md](../architecture/permissions.md) 第 6、7 节与 5.3、[events.md](../protocols/events.md)、[config.md](../architecture/config.md)、[tui.md](../apps/tui.md)、[cli.md](../apps/cli.md)、用户指南中出现 `full-access` 的地方；路线图中「智能权限与安全审计模型」「高风险操作只给一次性选项」两项改为指向本 ADR。
- 实现排在 `apply_patch`（[ADR-0035](ADR-0035-apply-patch.md)）之后。分两轮：第一轮做第 1、2、3、9 条（改名、别名、`bypass`、一次性选项）与审查框架和模型后端；第二轮接 Jev。

## 备选方案

- **保留 `full-access` 名字、只修匹配缺陷**：缺陷修完后询问已大幅减少，但工作区外 `edit` 与高风险命令仍会打断测试，且「full access」这个名字暗示不问，与实际行为不符。改名为 `guarded` 把名字和行为对上，真正不问的档位叫 `bypass`。
- **`smart` 以 `auto-edit` 为放行范围、审查所有需确认的操作**（本 ADR 初稿）：普通 shell 命令每条都要经审查器，延迟与费用高；改为只审查分类规则拦下的少数操作，审查器调用次数少得多。
- **不询问的档位叫 `auto`**：与 `auto-edit` 同前缀、放行程度却相差最远，Alt+M 循环里容易按错；Claude Code 的 auto mode 指分类器审查（相当于本 ADR 的 `smart`），同名反义会让用户误以为有审查兜底。
- **`bypass` 连授权数据与凭据命令也放开**：这两类几乎不会在正常任务里出现，一旦出现往往意味着模型在试图改自己的权限或读密钥；保留询问的打扰很小。
- **审查器放在工具实现或 UI 里**：违反「权限判定只能发生在权限层」的约束。
- **让审查器自报置信度再按阈值分档**：LLM 的自报置信度不可靠；三选一加「拿不准就选拿不准」更直接。Jev 返回的是模型本身的概率，可以按阈值分档。
- **审查器看文件内容或工具输出以提高准确度**：扩大了提示注入面（工具输出正是注入的主要来源），不采用。

## 修订

### 2026-10-01：Jev 接口已核实，可经 OpenCode Zen 调用

第 7 条要求实现前核对 TypeSafe 接口。已用维护者的 OpenCode 密钥实测：

- **地址**：OpenCode Zen 网关提供 `POST https://opencode.ai/zen/v1/systemone`，模型 `jev-1.13`（付费）与 `jev-1.13-free`，`GET https://opencode.ai/zen/v1/models` 可列出；OpenCode Go（`/zen/go/v1`）的模型列表里没有 Jev，调用报 `Model is unavailable`。直连 TypeSafe 为 `POST https://api.typesafe.ai/v1/systemone`，模型名 `jev-latest` 或 `jev-1.13.0`。两者请求格式相同。
- **请求**：`{ model, state, questions }`。`state` 可以是字符串或 JSON 对象，审查器直接传 `{ command 或 path, cwd, recentUserMessages }`；`questions` 是以自定 id 为键的问题表，题型 `choice`（`instructions` + `criteria` 选项表）、`noul`（是/否，返回概率）、`score`。
- **响应**：`{ model, answers, usage }`；`choice` 答案含 `choice`、`probabilities`、`confidence`，`noul` 答案为 `noul` 概率。
- **实测结果**：`choice` 三选项（allow / block / unsure）对 `git status --short` 判 allow（confidence 0.99），对用户只要求改 README 时的 `Remove-Item -Recurse -Force …\Documents` 判 block（confidence 1）；单次延迟约 0.5 秒（付费）至 1 秒（免费）。

据此调整第 7 条的 Jev 后端：

- 直接用一个 `choice` 问题，选项即三档结论，取 `choice` 为结论；`confidence` 低于阈值（默认 0.7，可配）时按 `unsure` 处理。不再用「概率阈值映射三档」的做法。
- 配置除直连 TypeSafe 外，允许复用已有服务商的密钥：`permission.reviewer = { backend: "jev", baseURL, model, credential }`，`credential` 写服务商 id（如 `opencode-go`，同一个 OpenCode 密钥在 Zen 上可用）或环境变量名（默认 `TYPESAFE_API_KEY`）。经 OpenCode 网关时附带会话头，与该服务商条目的 `sessionHeader` 一致。
- 开启时告知：命令、工作目录与最近的用户消息会发送到 OpenCode 与 TypeSafe（或直连 TypeSafe）。

### 2026-10-01：审查器设置的形状与 /settings 交互

审查器在设置中独立成一项，不进入服务商与模型体系：Jev 不是对话模型，放进服务商列表会混入 `/model` 选择页；它的协议也与对话请求不同，硬塞会让对话链路变复杂。取代第 7 条与上一条修订中的配置写法。

**settings.json**：

```json
"permission": {
  "reviewer": {
    "backend": "jev",
    "endpoint": "opencode-zen",
    "model": "jev-1.13-free",
    "credential": { "provider": "opencode-go" },
    "minConfidence": 0.7
  }
}
```

- `endpoint`：内置接入点 id。接入点是 config 层的一张纯数据表（与服务商预设同一做法）：`opencode-zen` → `https://opencode.ai/zen/v1`，附 OpenCode 会话头；`typesafe` → `https://api.typesafe.ai/v1`。`custom` 时另写 `baseURL`（OpenRouter decisions 接口或自建兼容服务）。每个接入点带默认模型（`opencode-zen` 为 `jev-1.13-free`，`typesafe` 为 `jev-latest`）与模型筛选条件（id 包含 `jev`）。
- `credential`：三选一，settings.json 不保存密钥。`{ "provider": "<服务商 id>" }` 借用已有服务商的密钥；`{ "env": "<变量名>" }` 读环境变量（`typesafe` 默认 `TYPESAFE_API_KEY`）；`{ "stored": true }` 单独存入系统凭据库（ADR-0015，索引 id 为 `reviewer`）。
- `minConfidence`：`choice` 答案的 `confidence` 低于它时按 `unsure` 处理，默认 0.7。
- 小模型后端写 `{ "backend": "model", "model": { "provider": "...", "model": "..." } }`，引用已有服务商下的模型。
- 未设置或 `backend` 为 `"off"` 即未配置审查器（第 6 条）。

**模型列表**：选择模型时对接入点调用 `GET <baseURL>/models` 实时拉取，按筛选条件过滤；拉取失败时退回接入点的默认模型，并允许手动输入。

**/settings 交互**：新增一行「安全审查：<后端> · <接入点> · <模型>」，回车打开对话框（ADR-0030 样式）：

1. 后端：关闭 / Jev / 小模型；
2. Jev：选接入点 → 选拉取到的模型 → 凭据，默认借用 baseURL 主机与之匹配的已有服务商（如已有 OpenCode 服务商即自动选中），可改为环境变量或单独输入；
3. 小模型：复用 `/model` 选择页，选定后返回对话框。

首次开启 Jev 时提示一次：命令、工作目录与最近的用户消息会发往所选接入点（OpenCode 与 TypeSafe，或直连 TypeSafe）。

**不做连接测试按钮**：与 v0.2 去掉服务商连接测试的决定一致。配置错误时第一次审查失败、按 `unsure` 处理，界面的审查行显示失败原因（密钥无效、模型不可用等）。

### 2026-10-01：审查用量持久化

`ReviewResult` 与 `permission.reviewed` 增加可选 `usage: Usage`。原接口与事件字段未包含用量；若仅在内存记账，恢复后会漏记安全审查开销，也无法标注来源。用量随审查事件持久化，计入 Turn 和会话累计，不加入模型历史；缓存命中不重复计费。模型后端引用沿用公开 `ModelRef`（provider/model），与上一条修订一致。Jev 配置与后端不在第一轮实现范围。
