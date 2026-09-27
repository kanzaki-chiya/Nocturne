# CLI（`nctrn`）

> 状态：已接受 v0.3；v0.3 修订（[ADR-0019](../decisions/ADR-0019-tui-visual-provider-page.md)，提议，待验收）｜ 前置阅读：[modules.md](../architecture/modules.md) 第 4 节、[events.md](../protocols/events.md)、[config.md](../architecture/config.md) ｜ 代码位置：`apps/cli/`

本文是 `nctrn` 命令行客户端的设计文档：命令行参数、REPL、事件渲染、权限确认、退出码与 Provider 配置。

## 1. 定位与边界

`nctrn` 是 Runtime 的进程内客户端：采集输入、渲染事件、把权限确认交给用户。**它不包含任何 Agent 行为、会话状态、权限判定或上下文构建逻辑**，只使用 `@nocturne/core` 的公开入口与 `@nocturne/core/protocol` 的类型；该约束由 dependency-cruiser 规则强制（见第 8 节），不是靠代码评审自觉。

## 2. 命令行

```text
nctrn                        # 交互模式：TTY 时进入 TUI（v0.3 起），非 TTY 进逐行 REPL
nctrn --cli                  # 交互模式：逐行 REPL（v0.3 新增）
nctrn --tui                  # 交互模式：终端界面（兼容参数，等价默认形态）
nctrn -p "<prompt>"          # 非交互模式：执行一次 Turn 后退出
nctrn -p                     # 非交互模式：prompt 从 stdin 读取（stdin 非 TTY 时）
nctrn --continue             # 恢复当前目录最近的会话后进入所选模式
nctrn --resume <id>          # 恢复指定会话后进入所选模式
nctrn --sessions             # 列出会话后退出（只读）
nctrn trust | untrust        # 把当前目录加入/移出用户配置的 trustedWorkspaces 后退出
nctrn setup                  # 服务商配置向导（TTY 打开服务商页，provider-setup.md）
```

| 参数 | 说明 |
|---|---|
| `-p, --print [prompt]` | 非交互模式。值可省略：省略时从 stdin 读全部输入作为 prompt |
| `-c, --continue` | 恢复绑定到当前目录（`workspaceRoot` 相同）的最近会话；没有时按"新建会话"处理 |
| `--resume <id>` | 恢复指定会话；支持 `-p` 组合（恢复后直接执行该 prompt）与 `--model` 组合（见下） |
| `--sessions` | 列出全部顶层会话（id、创建时间、绑定目录、模型、锁状态），按修改时间倒序，随后退出（退出码 0）；子代理会话（`session.created.parent` 存在者）默认不列出（[subagent.md](../architecture/subagent.md) 第 5 节） |
| `--force-unlock` | 与 `--resume` / `--continue` 搭配：先删除残留锁再打开（[sessions.md](../architecture/sessions.md) 第 4 节） |
| `--preset <name>` | 会话权限预设：`read-only` \| `default` \| `auto-edit` \| `full-access`，写入 `session.created`；恢复会话时该参数拒绝（预设以日志为准，改用 `/preset`） |
| `--model <id>` | 模型 id（当前 Provider 内），覆盖 `NOCTURNE_MODEL` 与配置文件；`provider/model` 写法在前缀等于当前 Provider 时剥掉前缀，前缀是另一种 api-type 时拒绝；其余含斜杠的值（如 `deepseek/deepseek-v4.1-flash` 这类命名空间 id）按模型 id 原样使用 |
| `--api-type <type>` | `openai-compatible`（默认）或 `anthropic`，覆盖 `NOCTURNE_API_TYPE` |
| `--base-url <url>` | Provider 端点，覆盖 `NOCTURNE_BASE_URL`；`anthropic` 类型省略时用官方端点 |
| `--api-key-env <NAME>` | 读取凭据的环境变量名。默认：`anthropic` → `ANTHROPIC_API_KEY`，其余 → `NOCTURNE_API_KEY` |
| `--cli` | 以逐行 REPL 启动交互模式（v0.3）；与 `--tui` 互斥（用法错误，退出码 2） |
| `--tui` | 以终端界面（TUI）启动交互模式（[apps/tui.md](tui.md)）；与 `-p`/`--print`/`--cli`/`--sessions` 互斥（退出码 2）；显式给出且 stdin/stdout 非 TTY 时报错退出 2 |
| `--inline` | TUI 走普通屏幕模式（已完结内容进终端回滚区，见 [tui.md](tui.md) §2 末节）；与 `-p`/`--print`/`--cli`/`--sessions` 互斥（退出码 2） |
| `-y, --yes` | 把需要确认的操作按"允许一次"自动批准（第 6 节）；对两类模式都生效 |
| `--debug` | 启用诊断日志（JSONL；[observability.md](../architecture/observability.md)），等价 `NOCTURNE_DEBUG=1` |
| `--debug-file <path>` | 诊断输出文件；`-` 表示 stderr。缺省写 `<NOCTURNE_HOME>/logs/debug-<时间戳>-<pid>.jsonl` |
| `-h, --help` | 打印用法后退出（退出码 0） |
| `-v, --version` | 打印版本后退出（退出码 0） |

**交互模式选择**（v0.3，ADR-0019）：

| 条件 | 模式 |
|---|---|
| stdin 与 stdout 均为 TTY | 默认 TUI（全屏）；`--cli` 选逐行 REPL；`--tui` 显式选 TUI（与默认等价）；`--inline` 选普通屏幕 TUI |
| stdin 或 stdout 非 TTY | 自动逐行 REPL（不因默认选择 TUI 报错）；显式 `--tui` 报错退出 2 |
| `-p/--print` | 非交互模式，与界面参数互斥，行为不变 |

- `-c`/`--resume` 等恢复参数按同一规则选择模式；`--sessions`、`trust`/`untrust` 是只读命令，不参与模式选择。
- 没有任何已配置服务商时，TTY 下的交互模式先走首次配置流程（服务商页 → 模型页，[provider-setup.md](../architecture/provider-setup.md) 第 1 节），选完模型才创建会话；有服务商但没有可解析默认模型时直接进入模型选择页。`-c`/`--resume` 的恢复失败语义不变。

规则：

- 工作目录即进程 cwd；`workspaceRoot` 取 cwd 的真实路径。
- **恢复与会话目录绑定**：`--resume` / `--continue` 打开的会话记录了它自己的 `cwd`/`workspaceRoot`（sessions.md 第 7 节）。会话目录与进程 cwd 不一致时：交互模式提示并默认拒绝（显式确认后继续，工具仍以会话记录的目录为准）；非交互模式直接报错（退出码 2）。
- **锁冲突**：会话被其他进程占用时报 `session_locked` 并显示锁内容（pid、主机名、启动时间），退出码 2；确认持有者已退出时用 `--force-unlock`。
- **恢复失败的其余情形**（不存在、`session_log_corrupt`、`session_log_newer`）同样以退出码 2 退出并打印原因。
- **模型已不可解析**（Provider 清单或配置变了）也拒绝恢复，提示中给出用法：加 `--model <id>` 恢复并切换——Runtime 在取锁、修复之后先写入 `session.config_changed { model }` 再进入空闲（sessions.md 第 4 节），组合写法：`nctrn --resume <id> --model <id>`。
- 恢复成功后打印一行恢复摘要（`session.recovery`：截断尾部、补齐的中断调用与 Turn 计数；无修复则不打印）。
- 凭据来自环境变量或用户级凭据文件（v0.2，[provider-setup.md](../architecture/provider-setup.md) 第 3 节），**不接受命令行上的密钥值**；`--api-key-env` 指定的是变量名。
- 启动时校验配置：缺 `baseURL`（openai-compatible）、缺凭据、缺模型 id，都打印缺失项并以退出码 2 退出，两种模式一致；stdin/stdout 均为交互终端时提示可运行 `nctrn setup`——完全没有任何服务商来源（无 `providers.json` 条目、无 `config.json` providers、无环境变量/命令行合成）时该提示置首，环境变量与手写说明退为次要；非 TTY 输出不变，不含向导提示。
- 未知参数、参数缺值：打印用法并以退出码 2 退出。
- `trust` / `untrust` 子命令原子写 `<NOCTURNE_HOME>/trust.json`（[config.md](../architecture/config.md) 第 3 节），打印结果后以退出码 0 退出；程序不改写手写的 `config.json`。
- `setup` 子命令：TTY 下打开服务商页（第 1 步），完成后无默认模型时自动进入模型选择页（第 2 步），流程结束即退出；`setup --cli` 走逐行向导（v0.3 起向导不再包含选模型步骤，配置完第一个服务商后提示"用 /model 选择模型"）；非 TTY 以退出码 2 退出并提示手写配置方式。密钥输入不回显，**不存在**把密钥放在命令行参数上的形式（provider-setup.md 第 1、8 节）。

## 3. 交互模式（REPL）

启动后进入 `nctrn>` 提示符循环：

- 普通输入：`session.submit({ text })`，期间渲染事件流（第 5 节）。
- `/` 开头的输入：斜杠命令（第 4 节），不进入模型上下文。
- 空行忽略；Ctrl+D（EOF）退出；空闲时 Ctrl+C 退出，Turn 进行中 Ctrl+C 调用 `session.interrupt()`。退出后打印「会话 \<id\> 已保存，nctrn -c 继续」（与 TUI 同一句，TUI 在恢复主屏之后打印，见 [tui.md](tui.md)）。
- 逐行模式用 readline 的 `completer`，候选与 TUI `/help` 共用同一张命令表（`@nocturne/tui/slash-catalog`，该模块不加载 Ink）。覆盖范围相同：命令名前缀/包含匹配；`/effort`、`/provider`、`/preset` 在命令名加空格后做参数补全。
- `--cli` 的 TTY readline ↑/↓ 从当前工作区的持久输入历史回填，切换会话后改用新会话的工作区；历史经 Core 公开 API 保存，明文文件与保留规则见 [config.md](../architecture/config.md)。`/help` 同样提示明文存储。
- EOF 发生在 Turn 进行中时：先 `session.interrupt()` 中断并等待该 Turn 收束后再退出；readline 关闭后任何异步回调不得再显示提示符。
- Turn 进行中不接受新的输入行（只响应中断）；权限确认提示出现时优先处理（第 6 节）。
- Phase 2 单行输入；多行与粘贴不作特殊处理。

## 4. 斜杠命令

| 命令 | 行为 | 对应 Runtime 能力 |
|---|---|---|
| `/help` | 列出命令与快捷键 | — |
| `/model` | 编号表格列出可用模型：`服务商/模型 id`、推理/图片输入标记、上下文长度、价格（`$输入/输出` 每百万 token）；未声明的列留空，不编造数据。标注「当前会话」「默认模型」（v0.2，列信息与 TUI 模型选择页一致，见 [apps/tui.md](tui.md) 第 7 节） | `runtime.listModels()`、`session.state().config.model`、`runtime.defaultModel()`、`runtime.listRecentModels()` |
| `/model <关键词>` | 同上表格按关键词过滤后列出 | 同上 |
| `/model <id>` | 会话内切换模型 | `session.setModel(ref)` → `session.config_changed` |
| `/effort` | 列出当前思考档位与该模型的可用档位（ADR-0018）；模型未声明档位时提示如何声明 | `session.reasoningEffortInfo()`（只读） |
| `/effort <档位>` | 切换会话思考档位：`off` 或当前模型声明的档位；不支持时报错并列出可用档位 | `session.setReasoningEffort(level)` → `session.config_changed` |
| `/preset` | 显示当前权限预设 | `session.state().config.permissionPreset` |
| `/preset <name>` | 会话内切换权限预设 | `session.setPermissionPreset(name)` → `session.config_changed` |
| `/context` | 显示若现在构建请求，上下文由什么组成 | `session.describeContext()` → `{ report: ContextReport; overBudget: boolean }`（见下） |
| `/compact` | 手动触发 L2 摘要压缩 | `session.compact()` → `context.compacted(kind="summary")` |
| `/resume` | 列出会话（编号、id、创建时间、绑定目录、模型、锁状态），输入编号切换，空行取消 | `runtime.listSessions()` + 会话打开逻辑（见下） |
| `/resume <id>` | 直接切换到指定会话 | 同上 |
| `/new`、`/clear` | 新建空会话并切换，沿用当前模型、思考档位与权限预设；旧会话仍可恢复，`/clear` 不是清屏 | CLI 注入的 `newSession` 回调 |
| `/mcp` | 列出本会话各 MCP 服务器的状态（`starting`/`ready`/`failed`/`crashed`/`stopped`）、工具数与失败原因；未配置 MCP 时打印提示 | `session.mcpServers()`（Phase 5，只读查询不产事件，[mcp.md](../architecture/mcp.md) 第 7 节） |
| `/provider` | 列出服务商：名称、类型、服务地址主机名、密钥来源（`凭据文件` / `环境变量 <NAME>` / `缺失`）、来源层（向导 / `config.json` / 项目 / 环境变量），标记当前会话所用，不显示密钥；TUI 中打开全屏服务商页（[tui.md](tui.md) 第 8 节）。`/provider add` 走与 `nctrn setup --cli` 相同的逐行向导（v0.3 起不再询问模型，保存后提示用 `/model`）；`key <name>` / `refresh <name>` / `thinking <name>` / `remove <name>` 是服务商页四个操作的快捷方式，见 [provider-setup.md](../architecture/provider-setup.md) 第 1 节 | `describeProviders()`、`saveSetupProvider` 等 + `runtime.updateProviders` |
| `/exit`、`/quit` | 关闭会话并退出 | `session.close()` |

- 未知命令打印提示（不报错退出）。命令在 Turn 进行中给出"会话忙"提示（`setModel` / `compact` 的前置条件是空闲，见 events.md 第 7 节）。
- `/model` 参数先按模型 id 精确匹配：匹配到已知 id（含 `provider/model` 归一化后）时直选切换，行为与 v0.1 一致；未匹配时按关键词过滤列表（子串、大小写不敏感），不切换。
- `/model <id>` 在 Provider 内切换：裸 id 与 `provider/model` 写法都按 `--model` 同规则归一化（前缀等于当前 Provider 时剥掉、是另一种 api-type 时报错、其余含斜杠的值按模型 id 原样），再以 `<当前 Provider>/<id>` 调 `session.setModel`。CLI 的 Provider 配置以 `allowUndeclaredModels` 创建（`strictModels=false`），清单外的模型 id 也可切换，能力回退内置目录/保守默认（见 provider-api.md）。
- `/context` 渲染 `ContextReport`：各 section 的名称、来源、字符数、估算 token，加上合计 `estimatedTokens / budgetTokens` 与 `overBudget`。查询只读，不构建请求也不产生事件。
- `/compact` 输出结果摘要（`throughSeq`、摘要字符数）；没有可压缩内容或摘要失败时打印原因，返回码不产生——REPL 命令的错误只显示，不影响进程。
- **`/resume` 会话内切换**：复用第 2 节的会话打开语义（锁冲突 `session_locked`、日志损坏、跨目录默认拒绝需 `y/N` 确认）。Turn 进行中拒绝并提示先中断；**先打开新会话**——失败时报错并留在原会话；打开成功后才 `session.close()` 旧会话（释放锁），打印一行"已切换到会话 \<id\>"与恢复摘要（`session.recovery`，若有修复）。该打开逻辑由 CLI 统一实现并以回调注入 TUI（[apps/tui.md](tui.md) 第 6 节）。
- **`/new` 会话内新建**：Turn 进行中拒绝；按当前会话配置创建并换入新会话，创建失败保留旧会话，成功后才关闭旧会话。逐行模式打印新会话分隔行；`/clear` 是同义别名，不删除旧日志也不清屏。

## 5. 事件渲染

行式输出，无全屏 UI。渲染层是把 `RuntimeEvent` 映射为"写哪个流、写什么文本"的纯函数集合，便于离线测试；颜色经 `node:util` 的 `styleText`（终端不支持或 `NO_COLOR` 时自动降级为纯文本）。

| 事件 | 渲染（交互模式） |
|---|---|
| `message.assistant.delta`（text） | 原样流式写到 stdout |
| `message.assistant.delta`（reasoning） | 暗淡样式写 stdout |
| `tool.started` | `● <name>(<参数摘要>)`，参数摘要取 input 的短 JSON，截断约 100 字符 |
| `tool.input.delta` | 不渲染（Phase 4 的 TUI 才需要增量展示） |
| `tool.progress` | `stdout`/`stderr` 的片段按顺序拼接，只在原始换行处结束行；`info` 每次调用是一行独立摘要，渲染层补换行。两类输出均缩进两格（约定见 [tool-api.md](../protocols/tool-api.md) 第 2 节） |
| `tool.completed` | `└ <status>` + 耗时；`error`/`denied`/`cancelled`/`interrupted` 附 `error.code` 与原因；`edit`/覆盖 `write` 的 `output.diff` 以 unified diff 着色渲染（`+` 绿、`-` 红、上下文默认色）；`truncated` 为真时附一行"输出已截断，完整内容在 \<path\>"（落盘路径见 [tools.md](../architecture/tools.md) 第 4 节） |
| `permission.requested` | 第 6 节的确认提示 |
| `permission.resolved` | `└ 权限：<allow\|deny>（<source>：<rule\|reason>）` 一行——命中规则时展示 `rule`（如"用户配置第 3 条 {…}"），无规则时展示原因 |
| `context.compacted` | `◇ 上下文已压缩（<kind>，至 seq <throughSeq>）` |
| `session.config_changed` | `◇ 模型已切换为 <provider>/<model>`；`reasoningEffort` 变化时 `◇ 思考档位已切换为 <档位>` |
| `provider.retry` | `! Provider 错误（<kind>），<delayMs>ms 后第 <n>/<max> 次重试` |
| `runtime.warning` / `runtime.error` | `! <code>: <message>` |
| `mcp.server` | `ready` 以外状态的转移打印一行 `! MCP <server>：<state>（<error?，含工具数>）`；`starting`/`ready` 不打扰（Phase 5） |
| `runtime.status` | 不逐条渲染；`compacting` 时显示一行"压缩中" |
| `turn.completed` | 收尾：`reason` 非 `done` 时打印原因与 `error.message`；交互模式附一行用量摘要（input/output token） |

输出分流：**非交互模式下**模型文本写 stdout，其余一切（工具状态、diff、诊断、用量）写 stderr，使 `nctrn -p "..." > out.txt` 得到纯模型输出。**交互模式**全部写 stdout；进程级致命错误（无法启动、配置缺失）写 stderr。

换行规则：渲染结果分为**流式片段**（模型文本、shell 输出，原样拼接）与**整行**（其余一切状态行与提示块）。写出层按流记录当前是否停在行首，整行输出前若上一段流式内容停在半行，先补一个换行，因此两种模式下状态行都各占一行、不会与模型文本粘连；非交互模式的 stdout 只含流式模型文本，不被插入额外换行。

## 6. 权限确认

预设与规则由配置决定（第 7 节、permissions.md 第 6 节），`--preset` 或 `/preset` 切换会话预设。ask 走协议流程：`permission.requested` → `session.respondPermission(requestId, reply)` → `permission.resolved`。

- **交互模式**：提示块列出主体（kind、target、解析后路径）、原因与命中的规则（`reason` 与规则来源），提供完整选项：

  | 按键 | 选项 | reply |
  |---|---|---|
  | `a` | 允许一次 | `{ decision: "allow" }` |
  | `s` | 本会话内允许 | `{ decision: "allow", remember: "session" }` |
  | `p` | 在此项目中始终允许 | `{ decision: "allow", remember: "project" }` |
  | `d` | 拒绝（可附一句反馈给模型） | `{ decision: "deny", feedback? }` |
  | `x` | 拒绝并停止本 Turn | `{ decision: "deny", stop: true }` |

  回复经 `respondPermission` 送回；回复到达前 Turn 挂起（Ctrl+C 可中断，该请求记 `cancelled`）。
- **非交互模式**：不产生等待——`ask` 一律拒绝，`permission.resolved` 记 `source: "non_interactive"`。CLI 以 `RuntimeOptions.interactive` 告知 Runtime 是否有回复能力（交互 `true`，非交互 `false`，默认 `false`）。
- **`-y, --yes`**：只把**最终判定为 `ask`** 的调用提升为 `allow`（`source: "rule"`，理由注明来自命令行参数）；不覆盖显式 `deny`（包括不可信项目规则的 `deny`），不绕过输入校验、路径限制或工具边界，转换在权限层完成（permissions.md 第 5.3 节）。是用户主动选择的自动批准能力（非交互批处理等场景），默认不开启；程序化的测试也可以注入限定范围的 `policy`，不必依赖它。
- `deny` 后模型会收到带理由的工具结果并可自我修正。

## 7. 配置来源（config 模块）

CLI 不再自己拼装 Provider 配置：启动时调用 Core `config` 模块的分层加载（[config.md](../architecture/config.md)），把 `ResolvedConfig` 注入 `createRuntime`；命令行参数构成最高优先级的一层。

| 环境变量 | 参数覆盖 | 说明 |
|---|---|---|
| `NOCTURNE_API_TYPE` | `--api-type` | `openai-compatible`（默认）\| `anthropic` |
| `NOCTURNE_BASE_URL` | `--base-url` | 端点；anthropic 缺省用官方端点 |
| `NOCTURNE_API_KEY` | — | 凭据（默认变量名，可由 `--api-key-env` 改） |
| `NOCTURNE_MODEL` | `--model` | 模型 id |
| `NOCTURNE_HOME` | — | 数据目录（已有约定，repository-layout.md 第 5 节） |
| `NOCTURNE_SHELL` | — | shell 工具使用的 shell（tools.md 第 6 节） |
| `NOCTURNE_CONSOLE_ENCODING` | — | 子进程输出解码的 WHATWG 编码覆盖（tools.md 第 6 节） |
| `NOCTURNE_ASCII` | — | TUI 下框线/徽标退回 ASCII（[apps/tui.md](tui.md) 第 5 节） |
| `NOCTURNE_DEBUG` | `--debug` | 诊断日志开关（[observability.md](../architecture/observability.md)） |
| `NOCTURNE_DEBUG_FILE` | `--debug-file` | 诊断输出文件；`-` 表示 stderr |

约定：

- 用户配置 `<NOCTURNE_HOME>/config.json` 可声明多个 Provider 与默认模型；`--api-*`/`--model` 参数与 `NOCTURNE_*` 变量按 [config.md](../architecture/config.md) 第 5 节合成为一个环境变量/命令行层的 Provider 条目参与按 id 合并。只有环境变量、没有配置文件时行为与 Phase 2 一致。
- 凭据只进入 Provider 配置：不出现在诊断信息、持久化事件、日志或配置回显中；`--api-key-env` 回显的是变量名而非值。
- 配置文件错误（用户配置解析失败/不合 schema）、缺失或无效的配置在启动时快速失败（退出码 2），不带着半截配置进入会话。
- 项目配置存在但未信任时打印一行提示（对应 `runtime.warning(code="project_config_untrusted")`）：其收紧方向的权限规则仍生效，其余字段（含 `mcp`、`hooks`——可执行配置一律不生效，见 [config.md](../architecture/config.md) 第 3 节）被忽略，可用 `nctrn trust` 信任当前目录。
- `NOCTURNE_DEBUG` / `NOCTURNE_DEBUG_FILE`（上表）：诊断日志开关与输出位置；未指定文件时写 `<NOCTURNE_HOME>/logs/` 下按时间戳命名的 JSONL。
- 冒烟测试用独立的 `NOCTURNE_SMOKE_*` / `NOCTURNE_SMOKE_ANTHROPIC_*` 变量（workflow.md 第 5 节），与 CLI 运行变量分离。

## 8. 工程约束

- **目录**：`apps/cli/`，包名 `@nocturne/cli`，`bin: { nctrn: dist/main.js }`；`tsdown` 构建 ESM。
- **第三方运行时依赖：零**（npm registry 依赖；workspace 包 `@nocturne/mcp`、`@nocturne/tui` 除外——MCP 装配点在 CLI，`--tui` 惰性加载 TUI，见下）。参数解析用 `util.parseArgs`，行输入用 `node:readline`，颜色用 `util.styleText`。非 Node 内置的新依赖需要理由，并在本文登记。该约定按包生效：`apps/tui` 经 [ADR-0010](../decisions/ADR-0010-tui-rendering.md) 单独批准终端依赖，不影响本包。
- **MCP 装配**：`createRuntime` 时构造 `createMcpConnector(platform)`（`@nocturne/mcp`）注入 `RuntimeOptions.mcp`；`--debug*` 参数映射到 `RuntimeOptions.debug`。TUI 路径（`nctrn --tui`）由 CLI 完成装配后把 `Session` 交给 `runTui`，MCP/Hook/诊断对 TUI 透明。
- **依赖方向**（dependency-cruiser 固化）：
  - 规则 `no-deep-import-from-outside-core` 的语义收紧为：`apps/` 解析到 `packages/core/src/` 的 import 只允许命中 `index.ts` 或 `protocol/index.ts`——即只有 `@nocturne/core` 包入口与 `@nocturne/core/protocol` 两个入口可用，任何内部路径（包括 `protocol/` 下的散文件）一律禁止。
  - 根 `depcheck` 脚本扫描 `packages apps`；CLI→TUI 的两种允许边及命令表零依赖约束见 [modules.md](../architecture/modules.md) 第 1 节。逐行路径只加载纯命令表，不加载 Ink。
  - 解析方式：`tsconfig.base.json` 的 `paths` 把 `@nocturne/core` 映射到 `packages/core/src/index.ts`、`@nocturne/core/*` 到 `packages/core/src/*`，使 depcheck 与 typecheck 在源码层工作；运行期经 pnpm workspace 链接解析到 `dist`。
- **测试分层**：
  - `apps/cli/test/*.test.ts`：离线单测——参数解析、渲染映射、配置收集、命令分发（注入假会话，不需要 `dist`；vitest 用 `resolve.alias` 把 `@nocturne/core` 指到 core 源码）。
  - `apps/cli/test/*.smoke.ts`：真实服务验收（fixture 仓库 + 非交互 `nctrn --yes -p`），只在设置 `NOCTURNE_SMOKE_*` 时运行；根 `test:smoke` 先 `pnpm build` 再跑各包冒烟。
  - 涉及写文件与 shell 的测试一律在 `tmpdir` 下新建的临时目录中执行，不得触碰仓库与用户目录。
- **dev 运行**：`pnpm build` 后 `node apps/cli/dist/main.js`；不改写 Node 的 `.ts` 直跑假设。

## 9. 退出码（非交互模式与进程级）

| 退出码 | 场景 |
|---|---|
| 0 | Turn 以 `done` 结束；`--help` / `--version` / `--sessions` / `trust` / `untrust` 正常输出 |
| 1 | Turn 非 `done` 结束：`error`、`max_steps`、`truncated`、`refused`；会话进入 `failed` |
| 2 | 用法或配置错误：未知参数、缺 `baseURL`/凭据/模型、模型未配置；恢复失败：会话不存在、被锁占用、日志损坏或版本过高、跨目录恢复被非交互模式拒绝 |
| 130 | 被中断（SIGINT → `aborted`） |

交互模式的斜杠命令错误与 Turn 失败只显示，不退出进程。

## 10. 暂不设计

多行输入与粘贴模式、输出分页、`--output-format`、stdin 以外的非交互输入源。Phase 4 的 TUI 复用同一 Runtime 与事件流，不重用本 CLI 的渲染代码；`--tui` 入口与界面设计见 [apps/tui.md](tui.md)。
