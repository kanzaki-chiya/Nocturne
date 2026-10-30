# 权限（Permission）

> 状态：已接受 v0.3 ｜ 前置阅读：[tools.md](tools.md)、[config.md](config.md) ｜ 决策：[ADR-0004](../decisions/ADR-0004-permission-rules.md)、[ADR-0008](../decisions/ADR-0008-project-trust-grants.md)

## 1. 定位

权限是一个独立的**策略层**：输入"这次工具调用会碰到什么"，输出 `allow` / `ask` / `deny` 以及理由。

- 它不属于工具实现：工具只声明自己会碰到什么，不决定是否需要确认。
- 它不属于 UI：需要确认时发出事件，由客户端展示并回复。
- 它不属于 Agent 推理：模型无法通过参数或提示词改变判定。
- `PermissionPolicy` 只做纯策略判断；文件系统信息由 Tool Executor 通过 `platform` 预先解析（第 4 节）。异步的 `PermissionGate` 同属权限层，负责 Hook、审查器、确认等待与取消；模型审查器经 Provider 公开接口调用。

**它不是沙箱。** 权限层在调用发生前做判定，无法约束一条已获准执行的 shell 命令实际做了什么（例如命令内部访问网络或写工作区外的文件）。操作系统级沙箱是后续独立议题，文档和界面都不应暗示当前版本具备这种隔离。

## 2. 概念

| 概念 | 是什么 | 谁产生 | 记录位置 |
|---|---|---|---|
| `SubjectRequest` | 工具声明的、未解析的主体：`{ kind, target, detail? }` | 工具的 `permissionSubjects(input)`（纯函数） | — |
| `PermissionSubject` | 解析后的主体：增加 `resolved`（真实路径）与 `where` | Tool Executor 解析 + 权限层计算 `where` | `tool.started`、`permission.requested` |
| `PermissionRule` | 一条规则：`{ kind?, pattern, action, where?, label? }`；`kind` 缺省或 `*` 匹配全部类别；`label` 是给人看的短说明，命中时进入解释文本 | 预设、用户配置、项目配置、命令行参数 | 配置文件 |
| `Grant` | 用户在确认时授予的授权："本会话内允许"或"在此项目中始终允许"，形状 `{ kind, target, createdAt }`（5.4） | 客户端回复 | 会话内存 / 用户数据目录 |
| `PermissionDecision` | 求值结果：`{ action, matchedRule?, source, reason }` | `PermissionPolicy.evaluate` | `tool.started.permission`、`permission.resolved` |
| `PermissionRequest` | `ask` 时发给客户端的待确认请求，有 `requestId` | `PermissionGate` | `permission.requested` |
| `PermissionReply` | 客户端的回答：允许 / 拒绝、是否授予 Grant、可选反馈 | 客户端 | `permission.resolved` |

规则是静态配置；Grant 是用户对具体请求的回答，**只能把 `ask` 变成 `allow`，永远不能改变 `deny`**；决定是一次求值的解释；请求是需要等待与取消的运行时对象。把它们分开，才能分别定义排序与信任。

## 3. 权限类别

| `kind` | `target` | 由哪些工具产生 |
|---|---|---|
| `read` | 路径 | read、grep、glob（以搜索根目录为主体，枚举结果另行过滤，见 4.4） |
| `edit` | 路径 | write、edit |
| `shell` | 完整命令字符串 | shell |
| `network` | 小写 hostname；非协议默认端口带 `:端口`，不含协议与路径 | `web_fetch` |
| `mcp` | `<server>/<tool>`（服务器与工具的**原始名**，不做规范化） | MCP 工具（Phase 5，见 [mcp.md](mcp.md)） |
| `subagent` | 工具集预设名（`general`/`explore`）、`"custom"`（显式白名单）或 `external:<name>`（外部 agent） | `task` 工具，见 [subagent.md](subagent.md)；`subagent * → deny` 关闭全部委派 |
| `schedule` | `动作:任务名`。`create` 用任务名（如 `create:relay 错误日志巡检`）；`update` / `pause` / `delete` 用任务 id（权限主体是纯函数，那时入参里只有 id） | `schedule` 工具的写入动作；`list` 无主体。见 [tools.md](tools.md) 第 6 节 |

shell 主体另携带可选的 `shell` 字段（执行该命令的 shell 种类，ADR-0022）：`pwsh` / `powershell` / `bash` / `cmd` / `sh`，以及 `shellRisk` 字段——生效 `ShellDescriptor` 上的高风险命令元数据、`shellRiskByDialect` 字段——各方言的高风险表（检查嵌套 shell 调用的命令体用，见第 6 节第 6 项）（第 6 节的按种类表以纯数据形式集中在 platform 层，随主体透传进来；权限层执行匹配判定，platform 不含权限逻辑）。`shell` 只影响方言化判定（5.3 的组合命令拆段），`shellRisk` 只影响第 6 节的高风险匹配，两者都不参与规则 `pattern` 匹配——用户规则始终按命令原文匹配；缺省或未知一律按 POSIX 保守处理。

`SubjectRequest` 与 `PermissionSubject` 可带 `detail?: string`，是只供人阅读的补充说明：执行器保留它，写入 `tool.started` 与 `permission.requested`，但规则匹配、Grant 键与 Hook 判定都不读取它。`PermissionRequest` Hook 的 subjects 会移除 detail；其他工具 Hook 不接收主体。`web_fetch` 的 detail 为完整 URL，授权目标仍是主机，因此「本会话允许」覆盖同主机后续页面；非默认端口有独立授权目标。network 可用 `docs.python.org`、`*.github.com` 等规则匹配。`schedule` 的 detail 是多行纯文本（名称、计划、工作区、模型 · 档位 · 权限、指令全文），确认界面保留换行；长指令可以折叠，但要能展开看全。不新增结构化字段。

localhost 与内网地址同样经过权限求值，不做特殊限制；**guarded 下模型可以访问本机与内网服务**。重定向仅自动访问相同授权主机，跨主机需要重新调用与求值（[tools.md](tools.md) 第 6 节）。

用户的 `@文件` 引用由 Core 在提交时读取，是用户自己的操作，不经过权限层或工具 Hooks，工作区外路径也可引用；读取规则见 [tools.md](tools.md#用户文件引用)。

## 4. 路径主体的解析

### 4.1 由谁解析

```text
工具.permissionSubjects(input, scope)  → SubjectRequest[]      纯函数，按 cwd 做词法规范化
Tool Executor 调用 platform.resolve()   → 真实路径（resolved）  唯一做 I/O 的一步
PermissionPolicy.evaluate()             → 计算 where，匹配规则   纯函数
```

会话打开时，`workspaceRoot` 本身也解析为真实路径并缓存，比较时两边都使用真实路径。

### 4.2 解析规则

- **已存在的路径**：解析全部符号链接；Windows 上同样解析 junction 与目录符号链接。
- **尚不存在的路径**（新建文件）：解析最近的已存在祖先目录的真实路径，再拼接剩余的路径段。剩余段中含 `..` 时先做词法规范化。
- **比较**：`where = workspace` 当且仅当 `resolved` 等于真实 `workspaceRoot` 或位于其下。大小写是否敏感由 `platform` 按当前文件系统提供（Windows 与 macOS 默认不敏感），不在权限层硬编码。
- **规则匹配**：路径类规则的 `pattern` 同时与 `target`（词法路径）和 `resolved`（真实路径）比较，任一匹配即命中。这样用户对某个路径写的 deny 不能通过链接绕过。

### 4.3 批准之后路径发生变化

判定与执行之间存在时间差，符号链接可能被替换。处理方式：

- Executor 把批准时的解析结果传给工具（`ctx.subjects`）。
- 会修改文件的工具在写入前重新解析目标路径；若与批准时的 `resolved` 不同，返回 `error(code = "resource_changed")`，不执行写入。
- 这只能缩小而不能消除竞争窗口，属于"权限不是沙箱"的范围，如实记录。

### 4.4 枚举类工具（grep、glob）

以搜索根目录为主体只能说明"允许在这里搜索"，不能保证其中单独被拒绝的文件不出现在结果里。因此：

- 枚举时**不跟随符号链接**，结果路径都在已解析的根目录之下，可以用词法路径判定。
- 每个结果路径都用 `ctx.permissions.check({ kind: "read", target })` 过滤：只保留求值为 `allow` 的条目；为 `ask` 或 `deny` 的条目不出现在结果中，也不触发确认。
- 结果中注明"N 个条目因权限规则被省略"，让模型知道结果不完整。

## 5. 求值

"规则排序"与"信任边界"分开定义。

### 5.1 规则排序（可信规则内部）

可信规则按层叠加，后面的层覆盖前面的层；同一层内后写的规则优先（last match wins）：

```text
内置预设 < 用户配置 < 可信项目配置 < 命令行参数
```

一条规则匹配一个主体，当且仅当 `kind` 相同（或规则为 `*`）、`pattern` 匹配（见下）、`where` 未指定或相同。没有任何可信规则匹配时，结果为 `ask`。

`pattern` 的匹配语义按 `kind` 区分：

- **路径类**（`read` / `edit`）：glob——`*` 不跨目录分隔符，`**` 跨任意层级，`?` 匹配单个字符。模式先规范化（`/`，大小写规则同平台）；相对模式拼接到 `workspaceRoot` 之下再匹配。同一个规范化模式同时与 `target`（词法路径）和 `resolved`（真实路径）比较，任一命中即算命中（4.2）。
- **shell**：对完整命令字符串做通配符匹配——`*` 匹配任意字符序列（含换行，无路径段概念；多行命令整条先命中再按 5.3 逐段求值），`?` 匹配单字符；大小写敏感，不做词法变形。
- **network / mcp / subagent**：与 shell 相同的字符串通配符匹配。

"命令行参数"层为逐条规则预留（Phase 3 的命令行只提供预设名与 `--yes` 提升，不逐条写规则）。

### 5.2 信任边界

项目配置来自仓库，默认**不可信**。不可信的项目规则不参与 5.1 的排序，而是与可信结果**取更严格者**（`deny` > `ask` > `allow`）：

- 不可信项目规则中的 `allow` 被忽略；
- 它们的 `ask` / `deny` 只能让结果更严格，**永远不能让结果更宽松**。例如用户规则 deny 某路径、项目规则 ask 同一路径，结果仍是 deny。

用户在用户配置中把某个工作区标记为可信后，该工作区的项目规则才进入 5.1 的排序（位于用户配置之后）。

### 5.3 完整算法

内置硬拒绝先于下面的算法（v0.2，[provider-setup.md](provider-setup.md) 第 4 节；[ADR-0042](../decisions/ADR-0042-provider-oauth.md) 第 9 节）：

- 主体命中 `<NOCTURNE_HOME>/credentials.json`（含用户显式选择的明文账号记录）或任一生效 `external-file` 鉴权路径的词法路径或真实路径时，`read`/`edit` 直接 `deny`（`source: "rule"`）。任何规则、Grant、`--yes`、预设与 Hook 都不能放开它。
- shell 命令字符串出现 `credentials.json` 或这些外部凭据文件名时至少 `ask`，且不交给模型审查器自动批准。
- `oauth-host.json` 与 `locks/oauth-*.lock` 不是机密，不纳入硬拒绝。

对每个主体：

```text
trusted   = lastMatch(内置预设 ++ 用户 ++ [可信项目] ++ 命令行, subject) ?? ask
untrusted = 项目不可信 ? lastMatch(项目规则中的 ask/deny, subject) : 无
decision  = stricter(trusted, untrusted)
if decision == ask:
  if 有 Grant 匹配 subject:      decision = allow   # source = "grant"
  elif autoApproveAsk（--yes）:  decision = allow   # source = "rule"，理由注明命令行提升
```

Hook 的先后关系（Phase 5，完整语义见 5.5 与 hooks.md）：

- `PreToolUse` 的 `deny` 在本算法之前直接结算为 `deny`，不求值。
- `PreToolUse` 的 `ask`（强制确认）：`decision` 为 `deny` 时仍 `deny`；否则一律进入确认流程——**跳过上面的 Grant 匹配与 `autoApproveAsk` 提升**（Hook 的收紧不能被既有授权或命令行提升抵消），先经 `PermissionRequest` Hook，无回答才询问客户端。
- `PermissionRequest` Hook 对任何到达 `ask` 的请求（规则判定的或 Hook 强制的）先回答：`allow`/`deny` 直接结算（`source: "hook"`）；无回答时按上表继续（Hook 强制来的 `ask` 除外——它始终停在"询问"）。

一次调用有多个主体时：任一主体为 `deny` 则 `deny`；否则任一为 `ask` 则 `ask`；否则 `allow`。

#### smart 审查分支（ADR-0036）

**送审范围（ADR-0057）**：`smart` 的预设规则里 shell、network、mcp 都是 `ask`（read、工作区内 edit、subagent 不变），预设级的 `ask` 在 policy 里再按下面三条通道分流；用户 / 项目 / CLI 的显式规则命中时原样生效，不进入分流：

1. **直接放行**：shell 命令每一段都命中**只读白名单**（`permission/smart-shell.ts` 的纯数据表，按方言逐段匹配；写文件重定向、变量展开、凭据类文件名都不算命中；命中描述「预设 smart 只读命令」），或属于会运行工作区代码的命令（`pnpm`/`npm`/`yarn` 的 `test`、`typecheck`、`lint`、`build`、`run`，`cargo check`/`test`，`tsc`，`vitest`，`node <文件>`）且未被污染；`readOnlyHint: true` 的 MCP 工具（主体字段 `readOnly`，信任服务器自我声明）。**污染**指本会话放行过对任何 `package.json` 的 edit，或 `node` 执行的文件在本会话被放行过 edit（路径按会话 cwd 词法解析，解析不了或在工作区外也算）；污染的命令改为送审。「放行过的 edit 目标」由 gate 在 edit 主体最终放行时记录，经 `EvaluateOptions.session` 以只读视图传给 policy，只在内存里，会话恢复后清空。
2. **直接交人**：不送审，按 `userOnly` 处理。递归删除（目标在工作区外、无法确定位置或不是 `dist`/`build`/`out`/`node_modules`/`target`/`.turbo`/`.cache`/`coverage`）、`dd`/`mkfs`/`format`/`diskpart`/`shutdown`/`reboot`/`Stop-Computer`/`Restart-Computer`、删除或覆盖类命令的目标含 `$VAR`/`%VAR%`/`$env:X`/`$(…)`/反引号、`-EncodedCommand`、`iex`/`Invoke-Expression`/`eval`（嵌套 shell 命令体按内层方言再查，最多三层）。同一 Turn 里用户拒绝过的调用，主体集合相同的后续调用也直接问用户（gate 按 turnId 记录，新 Turn 恢复送审）。
3. **送审**：其余全部，包括 network 和高风险表的其余条目（命中描述「预设 smart 高风险命令」）。

代码运行器白名单不接受可指定输出位置的参数：`tsc` 的 `--outDir`、`--outFile`、`--out`、`--declarationDir`、`--tsBuildInfoFile`、`--generateTrace`，以及 `vitest` 的 `--outputFile`、`--coverage.reportsDirectory`（包括 `--参数=值` 形式）。这些命令改为送审，避免直接写入工作区外；`tsc --noEmit` 与 `vitest run` 仍可放行。

规则的 `deny` 不进入审查；规则直接 `allow`、Grant 与 `autoApproveAsk`（`--yes`）先结算。剩余 `ask` 先交给 `PermissionRequest` Hook，再只在 `smart` 下调用 `SecurityReviewer.review(input, signal)`。审查结果只有两档：

- `allow`：放行，`permission.resolved.source` 与 `tool.started.permission.source` 为 `reviewer`。
- `unsure`（交给你确认）：交互模式询问用户；非交互模式拒绝。内置审查器不再产生 `block`；gate 对自定义审查器返回的 `block` 仍按拒绝处理，旧会话的 `block` 记录照常重放。

**只由用户确认**集合不调用审查器：修改 Nocturne 授权数据、`.nocturne/` 内 edit、可能读取凭据的命令、`schedule` 主体、直接修改定时任务文件、用户/项目/CLI 的显式 ask，以及 `PreToolUse` 强制 ask。Grant、`--yes` 与 PermissionRequest Hook 的原有优先级不变；强制 ask 仍跳过 Grant 与 `--yes`。一次调用中任一 ask 主体在该集合内，整个调用跳过审查。预设中的授权数据、`.nocturne/` 与定时任务规则用结构化 `userOnly` 标记表达该限制，`label` 只用于显示。

**审查输入**（`ReviewInput`，ADR-0057）：ask 主体的类别、授权目标、位置与命中规则，当前 cwd；`userMessages`——全部用户消息按时间顺序给出，单条最多 2000 字，总预算 8000 字，超出时保留第一条和尽量多的最近几条，中间插入「（省略 N 条）」（来自完整会话历史，不受压缩影响，不含 `@` 引用的文件快照）；`projectNotes`——已加载的项目指令文件（AGENTS.md 等，复用 context 模块已加载的结果）拼接后的前 2000 字；`trustedRemotes`——会话创建时读一次 `git remote -v` 的结果（每项 `name url`，拿不到为空列表；smart 会话立即读取，其他预设首次需要时再读）；`facts`——由 runtime 注入的异步函数预先查好、权限层只消费结果：`git reset --hard` / `git clean` / `git checkout -- .` 附 `git status --porcelain` 的行数，推送类命令附目标 remote、分支以及是否在可信列表里，查询失败就不给、不影响审查；`environment`（工作目录与 Nocturne 数据目录）和 `reviewerRules`（用户追加规则）写进提示词环境段。不带原始工具参数、工具输出、agent 自己说的话或文件正文。20 秒超时（含事实查询）、报错或格式无效按 `unsure` 处理；Turn 中止则取消审查。缓存只保存本会话的 allow，使用与 Grant 相同的精确主体键，恢复后清空；缓存命中也记审查事件。

**靠你授权换来的放行不缓存**：内置后端只有 Q2–Q7 全否的放行可缓存（`ReviewResult.cacheable: true`）；有风险题为是、依赖 Q1 授权的放行设为 `cacheable: false`，同一 Turn 或下一 Turn 的同样调用都重新送审，避免后来追加的限制被旧缓存绕过。自定义审查器省略该字段时视为 `true`，保持原行为；该字段不写入 `permission.reviewed` 事件。

未配置审查器时，原本要送审的调用直接询问用户（非交互拒绝；白名单与 `readOnlyHint` 的放行不受影响），每个会话提示一次。子会话使用父会话的同一审查器实例，仍为非交互。模型后端不带工具，不传思考参数，思考档位沿用模型默认，`maxOutputTokens=8192`。主流模型默认思考且多数关不掉，思考和回答共用这一个输出上限，因此预留充足预算、审查质量优先，不为审查专门降低思考档位；20 秒超时不变。

**七道是非题与纯函数判定**（ADR-0057 §6）：审查器不给结论，只回答七道题——Q1 `requested`（用户的话是否点名要求了这个动作且目标一致；用户说过且没有撤回的限制命中时答否）、Q2 `destroys`、Q3 `credentials`、Q4 `exfiltrates`、Q5 `weakens`、Q6 `crosses`、Q7 `opaque`。题干与判断依据在共享模块 `permission/reviewer-questions.ts`，模型后端与 Jev 后端共用，环境段（工作目录、可信 remote、数据目录）运行时填入。**结论由权限层的纯函数 `decideFromAnswers(answers)` 计算**：Q2–Q7 全否放行；有任一为是，只有 Q1 为是时才放行；其余交人。交人的理由列出答「是」的题和模型给的 `reason`。用户追加规则（`permission.reviewerRules`，见 [config.md](config.md)）以「用户追加：以下情况交人」「用户追加：以下情况放行」两段原样拼进提示词，单段最多 1000 字。

模型后端要求输出一个 JSON 对象（七个布尔字段加 `reason`），容忍 Markdown 代码块包裹；流以 `length` 结束，或只有思考没有正文（思考内容或 `reasoningTokens` 表明发生过思考）时按 `unsure` 交人，理由「安全审查输出被截断」，即使截断时已有可解析 JSON 也不放行。其他字段缺失或不是布尔值的输出仍交人，理由「审查输出格式错误」。审查用量写入 `permission.reviewed.usage`，计入 Turn 与会话总用量，不进入对话历史。设置方式见 [config.md](config.md)。

Jev 后端与模型后端并列放在权限层，直接 `POST <baseURL>/systemone`。请求传 `{ model, state, questions }`，`state` 即上述审查输入（环境与追加规则已写进题干，不在 state 里重复）；`questions` 是七个编号 `1`–`7` 的 `choice` 问题，每题 `criteria` 为 `yes` / `no`，`instructions` 带环境段、该题的判断依据和追加规则，并声明 state 不可信。`answers` 以对象（键为题号）或数组两种形式返回都接受，每题的 `confidence` 必须为 0–1 数值；低于 `minConfidence`（默认 0.7）时往保守方向取值（Q1 取否，Q2–Q7 取是），再由 `decideFromAnswers` 判定。理由显示答「是」的题与置信度情况；低置信度、缺失密钥、密钥无效、模型不可用、超时、HTTP 或解析失败显示相应原因，一律按 `unsure` 处理。用户中止仍按取消结算。

Jev 的 `usage.input_tokens/output_tokens` 转为 `ReviewResult.usage`，沿用 `permission.reviewed.usage` 持久化与恢复记账，标注接入点/模型来源；缓存命中不重复记账。接入点表、模型列表与凭据解析位于 config 层，权限后端只接收解析后的连接信息；借用密钥按服务商 id 从凭据库取，环境变量只读所选变量，独立密钥取索引 id `reviewer`。OpenCode 网关沿用条目的 `sessionHeader`，缺省为 `x-opencode-session`，值为会话 id。配置与列表退回行为见 [config.md](config.md)。

### 5.5 Hook 建议的合并（Phase 5）

`PreToolUse` Hook 与 `PermissionRequest` Hook 的输出作为**建议**进入求值，不改变规则排序本身（完整契约见 [hooks.md](hooks.md) 第 3、6 节）：

- `PreToolUse` `deny`：该调用直接结算为 `deny`（`source: "hook"`），不进入规则求值。
- `PreToolUse` `ask`：求值结果为 `allow` 或 `ask` 时强制走确认流程；规则已是 `deny` 时仍为 `deny`——Hook 只能收紧。**强制的 `ask` 跳过 Grant 与 `autoApproveAsk`**（5.3），但仍先经 `PermissionRequest` Hook 回答，无回答才询问客户端。
- `PreToolUse` 没有 `allow`：该点位在主体解析之前运行，看到的是未解析输入；放宽只能由 `PermissionRequest` 完成（它拿到解析后的主体）。
- `PermissionRequest` Hook：对到达 `ask` 的请求先回答，`allow`/`deny` 直接结算（`source: "hook"`）；无回答则继续原流程。其 `allow` 永远不能越过 `deny`（它只在 `ask` 分支内运行），且条目本身要求可信来源（未信任项目的 Hook 整段不执行，hooks.md 第 5 节）。
- Hook 不产生 Grant；`Grant`/`autoApproveAsk` 只对规则判定的 `ask` 生效，不对 Hook 强制的 `ask` 生效。

附加约束：

- **shell 组合命令**：命令包含 `&&`、`||`、`;`、`|`、换行、反引号、`$(`、重定向等控制符时，基于模式的 `allow` 规则不适用（规则照常匹配，但 `allow` 结果按 `ask` 对待，`deny` 仍为 `deny`）；Grant 对命令本来就只能精确匹配完整字符串（5.4），不受此影响。这避免 `git status*` 放行 `git status && rm -rf .`。例外是全放行规则（`pattern` 为 `*`，如 `guarded` 的 shell 规则）：它本来就放行任何命令，降级只会让带管道、`2>&1` 的普通命令全部来问，所以改为把命令按控制符拆段、逐段求值，任一段得到 `ask`/`deny`（如第 6 节的高风险命令、用户的 `deny` 规则）就取最严格者。拆段按原始文本切分、刻意不做引号感知：`sh -c "cd x; rm -rf build"` 里引号内的命令同样会执行，要切出 `rm -rf build"` 才能命中高风险表；组合判定同样看原始文本。拆分边界随主体 `shell` 字段的方言（ADR-0022）：PowerShell 系额外把脚本块 `{` `}` 视为边界（`&` 在两种方言里都切——调用运算符与后台运算符后面的内容照常成段求值），cmd / POSIX 保持原集合。shell 工具的末尾分页预检用另一个引号感知的词法器（`lexShellCommand`，[tools.md](tools.md) 第 6 节），它只用于提示，不参与权限判定。拆段是基于模式的提示，不是 shell 解析器，与第 6 节高风险命令一样不构成安全边界。
- **`--yes` 的边界**：`autoApproveAsk` 只把最终求值结果为 `ask` 的调用提升为 `allow`（`source` 记 `rule`，理由注明来自命令行）。它不覆盖显式 `deny`（包括不可信项目规则的 `deny`），不绕过输入校验、主体解析或工具自身边界；转换在权限层完成，CLI 与工具实现不得自行放行。
- **可解释**：决定中记录命中的规则及其来源：`matchedRule = { origin, index?, rule?, description, grant? }`；授权命中时 `grant = { scope: "session" | "project", createdAt }`，原样写入 `tool.started.permission` 和 `permission.resolved`（旧日志缺省），`origin` 取 `preset` / `user` / `project` / `project-untrusted` / `cli` / `grant` / `default`（兜底 ask，无规则本体）；人读说明形如"预设 default 第 3 条""用户配置第 1 条""项目配置第 2 条（不可信，仅收紧）""Grant（项目）"。没有命中任何规则而落到 `ask` 时 `origin` 为 `default`，说明为"默认询问"。

### 5.4 Grant 的形状与匹配

```ts
interface Grant {
  kind: SubjectKind;
  /** 授权目标：路径类为解析后的真实路径（canonical），shell 为完整命令字符串 */
  target: string;
  createdAt: string;
}
```

Grant 只精确匹配：`kind` 相同且 `target` 与主体的授权键相等。`kind` 直接复用权限主体的全部类别（含 `subagent`，如 `external:omp`），不再维护第二份枚举，以后新增主体类型不会漏。授权键：路径类取 `resolved`（缺失时取规范化 `target`），shell 取完整命令字符串，`network` / `mcp` / `subagent` / `schedule` 取 `target` 原值。`schedule` 的 target 含动作，所以「本会话允许」只覆盖同一任务的同一动作，不看指令内容；因此确认选项不提供「在此项目中始终允许」（见第 7 节）。"允许整个目录 / 某类命令"这类粗粒度授权不在确认选项中提供——需要时由用户显式写规则（配置文件的 `permissions.rules`），而不是在确认框里随手放权。

- **会话 Grant**：保存在会话内存中，会话关闭即失效，恢复后不保留。其作用域是**会话树**：子会话（[subagent.md](subagent.md) 第 7 节）以只读方式继承父会话的会话 Grant（同一授权集），子会话自身不产生新的授权。
- **项目 Grant**：写入 `<NOCTURNE_HOME>/grants/<workspaceKey>.json`（见 [config.md](config.md) 第 4 节），按会话的 `workspaceRoot` 归属；策略每次判定时实时读取存储（传 store 或 getter，不传快照），同一会话内新增的项目授权下一次同目标调用直接放行；写盘失败时降级为会话 Grant 并发出 `runtime.warning`。
- 客户端回复 `PermissionReply.remember = "session" | "project"` 时生成对应 Grant；`remember` 与 `decision: "deny"` 组合无意义，忽略 `remember`。
- **坏条目与损坏文件**：加载时逐条校验，跳过无效条目并发一次警告，其余照常生效；只有 JSON 解析失败、版本不符或 `workspaceRoot` 不符时才把整份文件按空处理。这种情况下第一次 `add` 之前先把原文件改名备份为 `<原名>.corrupt-<时间戳>.json`，不得直接覆盖。
- **`add` 去重**：`kind` 和 `target` 都相同的授权已存在时不再追加，也不重写文件。
- **管理与撤销**（[ADR-0068](../decisions/ADR-0068-grants-management.md)）：`GrantStore.remove(kind, target)`、`clear()` 与 `add` 共用串行原子写，写盘成功后才更新内存，失败抛错且列表不变；全部撤销保留空数组文件。同一进程内按 NOCTURNE_HOME 与真实工作区共享 store，重新加载配置不重建（[config.md 第 4 节](config.md#4-grant-的持久化)），权限层每次求值读取最新集合；撤销从下一次调用生效，不改变等待中或执行中的调用。
- `RuntimeSession.listGrants/revokeGrant/revokeAllGrants` 管理会话树共享的内存集合。活动子会话没有 RuntimeSession，因此 Runtime 另提供 `listSessionGrants({ sessionId })`、`revokeSessionGrant({ sessionId, kind, target })`、`revokeAllSessionGrants({ sessionId })`，在 Core 内沿活动登记簿解析到根，供 RPC 原有 `session.*` 方法转发；已关闭的树无内存授权。根和子会话的下一次判定同时生效。管理入口不是模型工具，授权数据保护规则不变。

## 6. 预设

为本会话已发现技能的真实根目录生成 `read allow <root>/**` 规则，与本会话落盘目录规则一起在宽规则之后求值。技能实现不做权限判定；链接到根目录外的支持文件仍按解析后真实路径求值。写入、shell 与技能目录外读取不放宽，详见 [skills.md](skills.md) 第 3 节。

预设提供一组有序规则；权限层还按第 6 项对命令做保守降级，`bypass` 跳过其中的高风险与编码命令降级。用户可以追加显式规则。预设构造时拿到 `workspaceRoot`、`sessionsDir`、`sessionId` 与 `nocturneHome`（据此生成具体的路径模式）；求值时预设与其他层规则没有任何差别。

| 预设 | read（工作区） | read（外部） | edit（工作区） | edit（外部） | shell | network / mcp | 内置 subagent | `subagent external:*` | `schedule` |
|---|---|---|---|---|---|---|---|---|---|
| `read-only` | allow | ask | deny | deny | ask | ask | ask | ask | ask |
| `default`（默认） | allow | ask | ask | ask | ask | ask | `explore` allow，其余 ask | ask | ask |
| `auto-edit` | allow | ask | allow | ask | ask | ask | `explore` allow，其余 ask | ask | ask |
| `guarded` | allow | allow | allow | ask | allow | allow | allow | ask | ask |
| `smart` | allow | allow | allow | ask | 只读白名单 allow，其余 ask / 送审 | ask / 送审（`readOnlyHint` 的 MCP allow） | allow | ask | ask（不送审） |
| `bypass` | allow | allow | allow | allow | allow | allow | allow | ask | ask |

`full-access` 是 `guarded` 的输入别名，配置、命令及旧日志读入时归一化；循环、补全和设置页只显示六个新名称。`smart` 与 `guarded` 的规则序列只在 shell / network / mcp 三条宽规则上不同（ADR-0057）。`bypass` 不降级工作区外 edit、`.git/` edit、高风险命令与 `-EncodedCommand`；保留凭据硬拒绝、授权数据与 `.nocturne/` edit、凭据相关命令和显式 ask/deny。见 [ADR-0036](../decisions/ADR-0036-smart-permissions.md)。

**忙时切换预设**（ADR-0036 修订）：`setPermissionPreset` 在 Turn 进行中、压缩进行中都可调用——立即校验并持久化、重建策略，从**下一次权限求值**起按新预设判定，已执行的操作不受影响。切换时正等待确认的权限请求保持原样，仍由用户决定，不按新预设重新判定，也不会因切到更宽松的预设而自动放行。模型切换仍要求空闲。

`subagent` 一列的分化理由：`explore` 子代理只含只读工具，它能得到的 `allow` 都是父会话本来就会自动放行的操作，唯一代价是 token；`general`/`custom` 可能写文件、跑命令，保留逐项把关（[subagent.md](subagent.md) 第 7 节）。

外部入口 `external:<name>` 在全部交互式预设下默认 `ask`（包括 `guarded`、`smart`、`bypass`）；用户可用 `subagent external:<name>` 显式规则或 Grant 授权，`--yes` 沿既有规则提升。执行期 ACP 主体映射见 [ADR-0049 第 3 节](../decisions/ADR-0049-external-agent-subagent.md#3-权限入口把关加上外部请求进权限层)：用父策略与只读会话 Grant 构造非交互 gate，smart 审查照常，剩余 ask 拒绝，不新增授权。此把关只覆盖外部 agent 主动请求的操作，不是沙箱。

`schedule` 在全部交互式预设下默认 `ask`（包括 `bypass`），且 `userOnly`：`smart` 不送审、直接问人。理由与 `external:*` 相同——创建、修改、暂停或删除定时任务会留下以后无人值守执行的东西。用户可写显式规则 `schedule * → allow` 放行，或 `schedule * → deny` 关闭；`--yes` 沿既有规则把这类 `ask` 提升为 `allow`。确认不提供项目级 Grant，见第 7 节。

表中没有覆盖到的组合落到"无规则匹配 → `ask`"。所有预设的规则序列都按以下次序排列（后写优先）：

1. 宽规则（按上表，如 `default` 的 `read ** where=workspace → allow`）；
2. **本会话落盘目录可读**：`read <sessionsDir>/attachments/<sessionId>/** → allow`——只放行**当前会话**的落盘输出（包含图片、文件附件与工具落盘输出，模型回读不触发确认，见 [ADR-0072](../decisions/ADR-0072-file-attachments.md)），读其他会话的附件仍走正常求值（`default` 下即 `ask`）；
3. **受保护路径**：对 `.git/` 内部与 `.nocturne/` 配置目录的 `edit` 保证"至少 ask"——在 `read-only`（`edit` 一律 `deny`）中不生成这两条 ask 规则，受保护路径保持 `deny`；其余预设中生成 `ask` 且排在宽 `allow` 之后；`bypass` 只保留 `.nocturne/` 的保护，不生成 `.git/` 的 ask；
4. **Nocturne 授权数据**：对 `<NOCTURNE_HOME>/config.json`、`settings.json`（ADR-0034）、`trust.json`、`grants/**`、`providers.json`（v0.2）、`mcp.json`（ADR-0047）、`external-agents.json`（ADR-0049 第 2 步）的 `edit` 保证"至少 ask"（同上，`read-only` 保持 `deny`），`label` 为"修改 Nocturne 授权配置"，命中时出现在确认提示与 `permission.resolved.rule` 中。`<NOCTURNE_HOME>/schedules.json` 与 `schedules/**` 的 `edit` 同样至少 ask（`label` 为"修改定时任务"，`userOnly`）：直接改文件会绕过 `schedule` 主体的确认。**如实说明**：这是提示而非安全边界——`--yes` 会把这类 `ask` 提升为 `allow`，`guarded` 预设下的 `shell` 也可以绕过（权限不是沙箱，见第 1 节）；
5. **可能读取凭据的命令**（v0.2，全部预设含 `bypass`）：命令字符串含 `credentials.json`、生效 `external-file` 的凭据文件名，或凭据后端命令（`security …-generic-password` 族、`secret-tool`、`ProtectedData`）的 `shell` 至少 `ask`，`label` 为"可能读取 Nocturne 凭据"，同样只是基于模式的提示（5.3、[provider-setup.md](provider-setup.md) 第 4 节）；
6. **高风险命令**（`guarded`、`smart`）：一组已知高风险命令模式保持 `ask`。按种类表集中在 `platform/shells.ts` 的 `ShellDescriptor.risk`（ADR-0022 第 1 节），经主体 `shellRisk` 字段透传到权限层；主体未携带元数据时按 POSIX 基础表保守处理。基础表各 shell 共用——`rm -rf *`、`rm -fr *`、`sudo *`、`git push --force*`、`git push -f *`、`git reset --hard*`；`cmd` 追加 `rd /s`、`rmdir /s`、`del /s`、`erase /s`、`format`；PowerShell 系追加 `Remove-Item` 及其别名（`rm`/`ri`/`del`/`erase`/`rd`/`rmdir`）同时带递归与强制参数（`-Recurse`+`-Force`，允许 PowerShell 参数前缀缩写与任意顺序）、`Format-Volume`、`Clear-Disk`、`Stop-Computer`、`Restart-Computer`、`Invoke-Expression`/`iex`。PowerShell 与 cmd 的内建匹配不区分大小写；用户规则仍按命令原文匹配、大小写敏感（5.1）。嵌套 shell 调用（`pwsh -c "…"`、`powershell -Command …`、`cmd /c "…"`、`bash -c`/`-lc`、`sh -c` 等）的命令体按内层 shell 的方言与表再查一遍（最多三层）：段首词是 shell 时高风险表只看得到 `pwsh`/`cmd`/`bash`，认不出引号里交出去的命令；各方言的表经主体 `shellRiskByDialect` 字段透传，命令体取到整条文本末尾并去掉一层外引号，多取只会多查。元数据只描述"命令词 + 通配符/开关/参数组合"这类纯数据（通配符表达不了"两个标志共存/参数前缀缩写"的匹配语义在权限层执行），只把**预设级宽规则的 allow** 降级为 `ask`——用户/项目/命令行的显式规则照旧覆盖。另外：命令文本中出现 `pwsh`/`powershell` 搭配 `-EncodedCommand`（含 `-ec` 等前缀缩写、含嵌套调用）时，编码负载无法做内容审查，除 `bypass` 外任何 `allow` 都降级为 `ask`（Grant 与 `--yes` 仍可在 `ask` 层批准）。这是基于模式的提示，不是可靠的危险检测。`smart` 下该表不再降级宽规则（宽规则已是 `ask`），而是让这些命令在送审时带上「预设 smart 高风险命令」的命中描述。

## 7. 需要确认时（ask）

```text
PermissionGate.check(subjects, signal)
  → emit permission.requested { requestId, callId, subjects, reason, options }
  → 等待 session.respondPermission(requestId, reply)，或 signal 中止
  → emit permission.resolved { requestId, action, source: "user" | "cancelled", remember }
```

`ask` 分支在发出 `permission.requested` 之前先经 `PermissionRequest` Hook（Phase 5，见 [hooks.md](hooks.md) 第 6 节）：Hook 给出 `allow`/`deny` 时直接结算并发出 `permission.resolved{source:"hook"}`，不再询问客户端；无回答时维持上述流程。

| 选项 | `PermissionOption` | 效果 |
|---|---|---|
| 允许一次 | `allow_once` | 仅本次调用 |
| 本会话内允许 | `allow_session` | 生成会话 Grant（5.4 精确目标），保存在内存中，会话关闭即失效 |
| 在此项目中始终允许 | `allow_project` | 生成项目 Grant，写入**用户数据目录**中按工作区区分的记录（[config.md](config.md) 第 4 节），而不是仓库内的项目配置 |
| 拒绝 | `deny` | 工具结果为拒绝，可附带反馈给模型，Turn 继续 |
| 拒绝并停止 | `deny_stop` | 工具结果为拒绝，并中止当前 Turn |

选项集由权限层计算：任一主体命中高风险命令表、`-EncodedCommand` 或工作区外 edit 时，只给 `allow_once`、`deny`、`deny_stop`；任一主体为 `schedule` 时不提供 `allow_project`（Grant 只按 `动作:任务名` 精确匹配、不看指令，项目级授权会放行以后同名任务的不同指令），其余为 `allow_once`、`allow_session`、`deny`、`deny_stop`；其他请求给出上表五项。客户端照 `permission.requested.options` 渲染，权限层也拒绝回复里不在选项集中的长期授权；`PermissionReply.remember` 与所选 Grant 的持久化由权限层完成，客户端只表达意图。

两种 Grant 都只在求值结果为 `ask` 时生效（5.3）。没有交互式客户端时（Runtime 选项 `interactive = false`，或定时会话还没被接手——见 [schedule.md](schedule.md) 第 4 节：`message.user` 少于 2 条），审查后的剩余 `ask` 视为 `deny`（`source: "non_interactive"`，不发 `permission.requested`）；`smart` 的审查 allow 执行，交给你确认（`unsure`）走上述非交互拒绝；要在无人值守场景放行使用 `--yes`（5.3 的命令行提升）或预写规则，不提供"非交互默认允许"的配置项。非交互拒绝的提示文案可由调用方注入（`nonInteractiveDenyHint`）——子会话用它告诉子模型"无法请求用户确认，需要写入或执行的操作在 `finish` 结果中说明，由父代理执行"（[subagent.md](subagent.md) 7.3），CLI 非交互模式沿用通用文案。

等待回复期间 `signal` 中止：记 `permission.resolved(action="deny", source="cancelled")`，该调用按 `cancelled` 结算。

## 8. 与其他模块的关系

- Tool Executor 负责解析资源并调用 `PermissionGate`，见 [tools.md](tools.md) 第 3 节。
- Hooks 在权限求值前后给出建议：`PreToolUse` 的建议在第 5 步前合并，`PermissionRequest` 在 `ask` 分支内优先回答；`allow` 不能越过 `deny`，且仅可信来源能放宽 `ask`（5.5、[hooks.md](hooks.md)）。
- 规则的配置格式与加载由 `config` 负责；本模块只接收已合并、已标注来源与信任状态的规则列表。
- **子会话（Phase 6）**：子代理会话的有效策略用与父会话相同的输入重建（同一预设、合并规则、项目 Grant、共享的会话 Grant、`autoApproveAsk` 与审查器实例），但 gate 恒为非交互——剩余 `ask` 一律 `deny(source: "non_interactive")`，`smart` 的审查 allow 可执行。子会话不能向用户弹确认；完整论证与机制行为表见 [subagent.md](subagent.md) 第 7 节。
