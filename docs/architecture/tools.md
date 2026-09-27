# 工具运行时（Tools）

> 状态：已接受 v0.3 ｜ 前置阅读：[overview.md](overview.md) ｜ 接口契约：[tool-api.md](../protocols/tool-api.md) ｜ 权限：[permissions.md](permissions.md)

## 1. 原则

- 工具是一等公民：每个工具独立定义、独立注册、有输入 schema、声明自身特性、返回结构化结果。
- **运行时与工具实现分离**：Tool Runtime 负责注册、校验、权限、调用、中断、超时、结果归一化和生命周期事件；具体工具只负责"做这件事"。
- Agent Loop 只调用 `ToolExecutor.execute(call, ctx)`，从不按工具名分支；所有工具差异都通过 `ToolDefinition` 的声明表达。

## 2. 结构

```text
tools/
├── Tool Runtime
│   ├── registry     注册、查找、导出模型可见的工具规格
│   ├── executor     执行管线（第 3 节）
│   └── budget       结果大小预算与截断
└── builtin/         read、write、edit、grep、glob、shell、task（Phase 6）
```

内置工具与 MCP 工具（`packages/mcp`，见 [mcp.md](mcp.md)）、将来的插件工具走完全相同的注册接口和执行管线，没有特权通道。`task`（子代理，Phase 6）同样如此：它是普通 `ToolDefinition`，启动子会话的能力经 `SubagentLauncher` 接口注入，见 [subagent.md](subagent.md)。

## 3. 执行管线

```text
execute(call, ctx):
  1. 查找      registry.get(call.name)
               不存在 → 结果 error(code="unknown_tool")，列出可用工具名，交给模型自我修正
  2. 校验      按 inputSchema 校验并规范化输入
               失败 → error(code="invalid_input")，附带校验信息
  2.5 PreToolUse Hook   见 hooks.md 第 3 节：deny → permission.resolved(source:"hook")
                        + error(code="hook_denied")；ask 记入第 5 步的合并（强制确认，
                        不经 Grant/--yes 提升）；updatedInput 替换输入并重新走第 2 步校验；
                        无 allow（此点在主体解析前运行）
  2.6 输入预检  可选 tool.validateInput(input)：纯函数（无 I/O），作用在 Hook
               修改后的最终输入上；返回错误说明 → error(code="invalid_input")，
               不请求权限、不发 tool.started（tool-api.md 第 1 节）
  3. 权限主体  requests = tool.permissionSubjects(input, scope)   # 纯函数：本次调用会碰到什么
  4. 解析资源  subjects = platform.resolve(requests)               # 唯一做 I/O 的准备步骤：真实路径
               解析失败（如权限不足无法访问父目录）→ error(code="resource_unavailable")
  5. 权限      decision = permissionGate.check(subjects, signal)
               deny → error(code="permission_denied")，附理由与用户反馈
               ask  → 先过 PermissionRequest Hook（hooks.md 第 6 节）；无回答则
                      发出 permission.requested，等待客户端回复（可被中断）
  6. 开始      emit tool.started（含解析后的 subjects 与权限决定），写入成功后才继续
  7. 执行      tool.execute(input, ctx)，ctx.subjects = 已批准的解析结果，携带 AbortSignal 与超时
               工具抛出的异常 → error(code="tool_failed")；超时 → error(code="timeout")
  7.5 PostToolUse Hook  见 hooks.md：feedback 追加进 modelContent（参与第 8 步预算）
  8. 归一化    按结果预算截断模型可见内容；保留结构化输出供客户端渲染
  9. 完成      emit tool.completed（持久化），返回 ToolResult
```

要点：

- 每个工具调用无论在哪一步结束，都**必须**产生恰好一个 `tool.completed`，这是模型请求中工具调用与结果能够配对的前提。调用以 Runtime 分配的 `callId` 标识。
- 权限在第 5 步由执行器统一处理，工具实现拿到执行机会时权限已经确定。工具不能自己弹确认，也不能跳过这一步。资源解析与权限求值的分工见 [permissions.md](permissions.md) 第 4 节。
- 会修改文件的工具在写入前重新解析目标路径，与 `ctx.subjects` 中批准时的结果不一致时返回 `resource_changed`，不写入。
- 枚举类工具（grep、glob）不跟随符号链接，并用 `ctx.permissions.check` 过滤每个结果条目，只保留求值为 allow 的条目，省略数量写入结果。
- Hooks 插入点：PreToolUse 位于第 2、3 步之间（可以拒绝或修改输入，修改后重新校验），PermissionRequest 在第 5 步 ask 分支内，PostToolUse 位于第 7、8 步之间。Hook 输出是建议——只能收紧（`deny`/`ask`/`updatedInput`/`feedback`/`block`），唯一放宽 `ask` 的点位是 `PermissionRequest`（看到解析后的主体），且越不过 `deny`；完整语义与信任规则见 [hooks.md](hooks.md)。**未配置 Hooks 时管线行为与事件序列和 Phase 4 完全一致**。

## 4. 结果预算

模型可见的工具输出必须有界：

- 每个工具声明 `maxModelChars`（默认 30,000 字符，约 7,500 token）。超出时保留开头与结尾，中间替换为"已省略 N 字符"的说明。
- 结构化 `output`（供客户端渲染，例如 diff、退出码）与模型可见的 `modelContent` 分开；前者也有独立上限，防止事件与日志膨胀。
- **完整输出落盘**：`modelContent` 因超预算被截断时，执行器把截断前的完整文本写入附件文件，模型可见内容中注明文件路径，可用 `read` 按需查看：
  - 位置：`<sessionsDir>/attachments/<sessionId>/<callId>.txt`（`sessionsDir` 来自 `RuntimeOptions`，默认 `<NOCTURNE_HOME>/sessions`；不写入被操作的仓库）；文件随会话数据一起由用户管理，运行时不做自动清理。
  - 落盘本身有上限（默认 1 MB）：再大的输出只写头部并在文件末尾注明截断，避免无限写盘。
  - 落盘写失败时降级为普通截断（模型可见内容注明未落盘），不影响 `tool.completed` 的结算。
  - `tool.completed` 增加可选字段 `spillPath`（落盘文件的绝对路径，兼容新增）；客户端据此显示"输出已截断，完整内容在 \<path\>"，模型可见的 `modelContent` 中同样注明路径与预览。
  - 权限协同：所有预设都内置 `read <sessionsDir>/attachments/<sessionId>/** → allow`（[permissions.md](permissions.md) 第 6 节），**只放行当前会话**的落盘目录——读其他会话的附件仍走正常权限求值。

## 5. 超时、中断与并发

- 每个工具声明默认超时；`shell` 允许调用方在上限内指定超时。
- 中断信号来自 Turn 的 `AbortController`。工具应尽快停止；超过宽限期后执行器放弃等待并记为 `cancelled`。`shell` 尝试终止整个进程树（Windows 与 POSIX 的实现不同，由 `platform` 负责）；Nocturne 自身异常退出时子进程是否随之结束不作保证，见 [sessions.md](sessions.md) 第 6 节。
- **各平台进程树终止**：Windows 用 `taskkill /pid <pid> /T /F` 终止整棵树；POSIX 在 `spawn` 时以 `detached: true` 使子进程成为进程组组长，用 `kill(-pid, SIGKILL)` 整组终止。正常中断与主进程被强杀是不同场景；后者对 MCP 服务器的已知限制见 [mcp.md](mcp.md) 第 4 节。
- 工具声明 `concurrencySafe`。MVP 串行执行所有调用；以后可以并行执行连续的 `concurrencySafe` 调用，不需要修改工具。

## 6. 内置工具（MVP）

| 工具 | 作用 | 副作用 | 关键约定 |
|---|---|---|---|
| `read` | 读取文本文件，支持起始行与行数 | 无 | 带行号输出；检测二进制文件；记录"已读状态"（路径、修改时间） |
| `write` | 创建或整体覆盖文件 | 写文件 | 覆盖已存在的文件前必须在本会话读过它，且文件自读取后未被外部修改；`output` 携带 `path`、`created`、`lines`，覆盖时附 `diff` |
| `edit` | 精确字符串替换 | 写文件 | `old` 必须在文件中唯一出现（或显式 `replaceAll`）；同样要求先读且未过期；`output` 返回 unified 风格 `diff` 供客户端显示 |
| `grep` | 按正则搜索文件内容 | 无 | 优先使用 ripgrep；遵守 `.gitignore`；不跟随符号链接；结果逐条经权限过滤；数量有上限 |
| `glob` | 按模式匹配文件路径 | 无 | 遵守 `.gitignore`；不跟随符号链接；结果逐条经权限过滤；按修改时间排序；数量有上限 |
| `shell` | 执行非交互式命令 | 执行命令 | 指定工作目录与超时；合并输出流并截断；返回退出码；shell 与进程树终止见下 |
| `task` | 启动一个子代理会话执行独立任务（Phase 6） | 运行一个受控子 Turn | 输入 `task`/`preset`/`tools`/`outputSchema`/`timeoutMs`；受限工具集、独立上下文、继承或收紧的权限；结果上限与落盘走第 4 节既有路径；完整契约见 [subagent.md](subagent.md) |

另有只在**子会话**注册表中出现的 `finish` 工具：子代理用它提交结果结束 Turn（[subagent.md](subagent.md) 第 2 节）；它不是内置工具表的成员。

"先读后写"与过期检测防止模型基于过时内容覆盖文件，是低成本、高收益的保护。已读状态保存在运行时内存中，会话恢复后需要重新读取。判定细则：

- 写入工具以 `ctx.subjects` 中已批准的**解析后路径**为准；写入前重新 `stat`/`realpath`：解析结果与批准时不一致 → `resource_changed`；已存在文件在 `readState` 中无记录 → `error(code="not_read")`；记录的 `mtimeMs`/`size` 与当前不一致 → `error(code="stale_file")`（要求重新 `read`）。
- `write` 创建尚不存在的文件不要求先读；写入瞬间文件恰好出现（竞态）按已存在文件处理，即要求先读。
- `edit`/`write` 覆盖时在 `output` 中携带行级 unified 风格 diff（公共前后缀作上下文，中段为 `-`/`+` 行）；`modelContent` 是简短摘要，不含完整 diff。

`shell` 的约定（Phase 2 定案）：

- **shell 选择**：Windows 用 `%COMSPEC%`（通常为 `cmd.exe`）加 `/d /s /c`；POSIX 用 `/bin/sh -c`。两者都可由 `NOCTURNE_SHELL` 环境变量覆盖为其他 shell 可执行文件。选择理由：`cmd /c` 把其余参数原样当作命令行，语义与 POSIX `sh -c` 最接近、启动开销最小；PowerShell 亦可胜任（用 `-NoProfile` 避免 profile 副作用），但其引号解析与流语义不同，需要单独的参数形态，故不作默认。
- **shell 子进程环境**（v0.2）：继承进程环境，但剥离全部已解析服务商的 `apiKeyEnv` 变量名以及 `NOCTURNE_API_KEY`、`ANTHROPIC_API_KEY`，避免模型通过命令读到密钥（[provider-setup.md](provider-setup.md) 第 4 节）。
- **输入**：`{ command, timeoutMs?, cwd? }`。`cwd` 省略时会话 cwd；指定时经符号链接 / junction 解析后必须位于工作区内，否则 `invalid_input`。**注意：`cwd` 限制约束的只是执行起点，不是沙箱**——被批准的 `command` 本身仍可访问批准范围之外的资源；命令文本才是被确认的主体。
- **末尾分页拒绝**（v0.4，[ADR-0021](../decisions/ADR-0021-tui-daily-usability.md) 第 9 条）：模型有时给命令接上 `| more`/`| less` 分页——Windows 上 `more.com` 会改坏 UTF-8 输出（中文尤甚）且可能等待按键挂住。shell 工具声明了 `validateInput` 预检（tool-api.md 第 1 节）：`command` 经与权限层共享的轻量词法器（`lexShellCommand`，见 [permissions.md](permissions.md) 5.3）切分后，任一独立命令（`&&`、`||`、`&`、`;`、换行、`$(`、反引号、`(`/`)` 均为边界）的管道末段若以可执行名 `more`/`more.com`/`less` 开头（basename 比较、大小写不敏感、允许引号包裹的路径如 `"C:\Windows\System32\more.com"`、忽略段首赋值与重定向），调用即以 `status:"error"`、`code:"invalid_input"` 结算——发生在权限求值与进程派生之前：不请求权限、不发 `tool.started`、不启动进程、不改写命令文本，模型收到的补救说明原文为：

  > 命令以分页工具结尾（more/less）。分页工具会改坏输出编码、可能等待按键卡住；输出会被自动收集，去掉末尾的 `| more` 后直接执行即可。需要筛选时先重定向到文件再用 grep 工具。

  管道中间段的分页工具（`more | sort`）、`more.txt`/`findstr more`、引号内的字样不误伤。词法器是提示性分词而非完整 shell 解析器：引号一律按 POSIX 习惯识别——`'` 在 cmd 中本不是引号符，单引号写法按 POSIX 语义近似处理（如 `'a | more'` 不判为管道）；引号内的 `$(…)`/反引号不展开，`^` 转义、here-doc 等复合语法不处理。
- **输出合并与截断**：stdout 与 stderr 在工具内按到达顺序合并为单一输出流（不等价于 shell 重定向，由 ProcessRunner 的两条流归并）；逐块经 `tool.progress` 上报（带 `stream` 标记），累积内容按 `maxModelChars` 截断。进程持续输出超过缓冲上限时丢弃中间部分但继续排空管道，防止子进程阻塞。
- **结果**：`output` 携带 `exitCode`、`signal`、`timedOut`、`killed`、`durationMs`；`timedOut` 时 `status="error"`、`code="timeout"`。命令已退出但输出管道仍被占用时另带 `outputDetached=true`（见下条），`modelContent` 末尾追加一行提示（ok 时落在 `[exit code …]` 之前）：`命令已退出，但仍有后台进程占用输出管道，之后的输出未读取；如果启动了服务器等后台进程，它可能仍在运行。`
- **退出与输出管道分离**：`spawnShell` 的 `wait()` 在直接子进程（cmd/sh 本体）`exit` 时结算，而不是等 stdio 全部关闭的 `close`——`close` 会被继承了输出管道的后台孙进程无限期拖住（`start`、`nohup`、`detached` 派生等）。子进程退出后输出流最多再等 500ms 自然收尾；仍被占用则经 `SpawnedProcess.detachOutput()` 销毁读取端，已捕获输出按原解码规则冲刷后保留，读取方正常结束而非报错。通用 `spawn`/`spawnPipe`（MCP stdio、Hooks）仍按 `close` 结算，行为不变。
- **孤儿进程遗留**：中断/超时只保证终止进程树——Windows `taskkill /T` 沿父子链终止，中间进程已退出的 detached 孙进程会脱离链条杀不到；POSIX 进程组终止对已 `setsid` 逃逸的进程同理。分离输出后仍存活的后台进程需用户按提示自行清理。
- **输出解码**：Windows 取 `chcp` 代码页映射为 WHATWG 编码（如 CP936 → GBK），其余平台与未识别代码页按 UTF-8。探测到非 UTF-8 代码页时，stdout、stderr 各自按换行分段：整段字节能以 fatal UTF-8 解码就使用 UTF-8，否则按控制台编码解码，原样保留 `\r\n`。未换行尾巴超过 8KB 或空闲 50ms 后也按同一规则冲刷；末尾截断的 UTF-8 多字节字符（最多 3 字节）留待下一块。流结束时解码剩余字节。`NOCTURNE_CONSOLE_ENCODING` 可显式指定任意 WHATWG label（如 `utf-8`、`gbk`），设置后完全按该编码流式解码，不再逐行判定。残留风险：极短的 GBK 字节串偶然也是合法 UTF-8 时，会被识别为 UTF-8。
- **进程树终止实测记录**（tools.md 第 5 节要求）：Windows（`taskkill /pid /T /F`）：已实测——测试在 `cmd /c` 下启动 Node 父进程并派生孙进程，中断后孙进程消失（`packages/core/src/tools/write-edit-shell.test.ts` "中断：终止整个进程树"用例）；POSIX（`detached` 进程组 + `kill(-pid, SIGKILL)`）：未在当前平台验证，CI/其他平台需复跑该用例。

`apply_patch`（多文件补丁格式）不在 MVP 中。若后续发现某些模型使用它明显更可靠，再作为额外工具加入，与 `edit` 并存。

## 7. 暂不设计

工具别名、Provider 原生工具（如服务端网页搜索）、后台运行的 shell、工具结果中的图片（MCP 返回的图片目前按占位符处理，见 [mcp.md](mcp.md) 第 6 节）。接入时均通过 `ToolDefinition` 与注册表完成，不修改执行管线的步骤。
