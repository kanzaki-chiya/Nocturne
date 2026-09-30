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
│   ├── budget       结果大小预算与截断
│   ├── image        图片文件头识别与尺寸解析（sniffImageMime / parseImageSize，纯函数）
│   └── attachments  AttachmentStore：图片附件的会话内落盘与按 sha256 校验的读回（第 4 节）
└── builtin/         read、write、edit、grep、glob、shell、task、web_fetch 等
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
- **图片附件**（ADR-0023）：`ToolResult.attachments` 携带的图片字节由执行器经 `AttachmentStore` 落盘到**同一目录** `<sessionsDir>/attachments/<sessionId>/`，用户提交的 `attachments` 也由 Core 落盘（`source: "paste"`）。文件名 `img-<n>.<ext>`（`n` 从该目录已有文件的最大编号续起，并发保存串行化、撞名让号）；事件与历史只写 `ImageAttachment` 引用（events.md 第 4 节），字节绝不进事件。读回时校验 sha256，文件缺失或不符按缺失处理。会话级字节缓存以 sha256 为键，按总字节数做 64 MB LRU；淘汰后再次读取文件并重新校验。附件存储按会话独立：子会话使用自己的 `sessionId` 目录与实例（index.ts / subagent.ts 各建一份，挂在 `ExecutionEnvironment.attachments` 上）。保存失败的语义见 [tool-api.md](../protocols/tool-api.md) 第 3 节；字节如何进入模型请求见 [context.md](context.md) 第 3 节。

## 5. 超时、中断与并发

- 每个工具声明默认超时；`shell` 允许调用方在上限内指定超时。
- 中断信号来自 Turn 的 `AbortController`。工具应尽快停止；超过宽限期后执行器放弃等待并记为 `cancelled`。`shell` 尝试终止整个进程树（Windows 与 POSIX 的实现不同，由 `platform` 负责）；Nocturne 自身异常退出时子进程是否随之结束不作保证，见 [sessions.md](sessions.md) 第 6 节。
- **各平台进程树终止**：Windows 用 `taskkill /pid <pid> /T /F` 终止整棵树；POSIX 在 `spawn` 时以 `detached: true` 使子进程成为进程组组长，用 `kill(-pid, SIGKILL)` 整组终止。正常中断与主进程被强杀是不同场景；后者对 MCP 服务器的已知限制见 [mcp.md](mcp.md) 第 4 节。
- 工具声明 `concurrencySafe`。MVP 串行执行所有调用；以后可以并行执行连续的 `concurrencySafe` 调用，不需要修改工具。

## 6. 内置工具（MVP）

| 工具 | 作用 | 副作用 | 关键约定 |
|---|---|---|---|
| `read` | 读取文本文件与 PNG、JPEG、GIF、WebP 图片，支持起始行与行数 | 无 | 带行号输出；记录"已读状态"（路径、修改时间）；图片约定见下 |
| `web_fetch` | 抓取公开网页、文档与图片 | 无 | 按主机申请 network 权限；HTML 转 Markdown；请求与结果约定见下 |
| `write` | 创建或整体覆盖文件 | 写文件 | 覆盖已存在的文件前必须在本会话读过它，且文件自读取后未被外部修改；`output` 携带 `path`、`created`、`lines`，有变化时附 `diff`（含新建） |
| `edit` | 精确字符串替换 | 写文件 | `old` 必须在文件中唯一出现（或显式 `replaceAll`）；同样要求先读且未过期；未命中只诊断、不写入；`output` 返回 unified 风格 `diff` 供客户端显示 |
| `grep` | 按正则搜索文件内容 | 无 | 优先使用 ripgrep；遵守 `.gitignore`；不跟随符号链接；结果逐条经权限过滤；数量有上限 |
| `glob` | 按模式匹配文件路径 | 无 | 遵守 `.gitignore`；不跟随符号链接；结果逐条经权限过滤；按修改时间排序；数量有上限 |
| `shell` | 执行非交互式命令 | 执行命令 | 指定工作目录与超时；合并输出流并截断；返回退出码；shell 与进程树终止见下 |
| `task` | 启动一个子代理会话执行独立任务（Phase 6） | 运行一个受控子 Turn | 输入 `task`/`preset`/`tools`/`outputSchema`/`timeoutMs`；受限工具集、独立上下文、继承或收紧的权限；结果上限与落盘走第 4 节既有路径；完整契约见 [subagent.md](subagent.md) |
| `todo_write` | 完整替换当前会话任务清单 | 只改变会话派生状态 | 输入最多 20 项的完整 `items`；空数组清空；无文件、配置或网络 I/O。输入与结果契约见 [tool-api.md](../protocols/tool-api.md)，状态来源见 [sessions.md](sessions.md) |
| `ask_user` | 需要用户拍板时暂停并提问（ADR-0032） | 无 | 输入与结果契约见 [tool-api.md](../protocols/tool-api.md)；等待经临时事件 `question.requested` 与会话命令 `respondQuestion`（[events.md](../protocols/events.md) 第 3、7 节）；声明 `needsUser`，子代理可选池按特性排除 |

另有只在**子会话**注册表中出现的 `finish` 工具：子代理用它提交结果结束 Turn（[subagent.md](subagent.md) 第 2 节）；它不是内置工具表的成员。

"先读后写"与过期检测防止模型基于过时内容覆盖文件，是低成本、高收益的保护。已读状态保存在运行时内存中，会话恢复后需要重新读取。判定细则：

- 写入工具以 `ctx.subjects` 中已批准的**解析后路径**为准；写入前重新 `stat`/`realpath`：解析结果与批准时不一致 → `resource_changed`；已存在文件在 `readState` 中无记录 → `error(code="not_read")`；记录的 `mtimeMs`/`size` 与当前不一致 → `error(code="stale_file")`（要求重新 `read`）。
- `write` 创建尚不存在的文件不要求先读；写入瞬间文件恰好出现（竞态）按已存在文件处理，即要求先读。
- `edit` 未命中仍返回 `no_match`，仅在路径和先读状态检查通过后，用已读的目标文本有界地诊断换行符、缩进、空白差异，或给出一处至多 5 行、带实际行号的相近片段；没有可信候选或文本过大时给简短提示。诊断只供模型修正精确的 `old`，绝不用于自动替换。
- `edit` 与 `write` 创建/覆盖在有变化时于 `output.diff` 携带行级 unified 风格差异，头部为 `@@ -旧起始行,旧行数 +新起始行,新行数 @@`，路径由 `output.path` 提供；行尾 CRLF/LF 与末尾换行变化按变更行表达。`modelContent` 是简短摘要，不含完整 diff；结构化 `output` 超过 100,000 字符时仍按第 4 节的预算省略。

`read` 的图片约定（ADR-0023）：

- **识别方式**：读出字节后先做魔数嗅探（PNG `89 50 4E 47…`、JPEG `FF D8 FF`、GIF `GIF87a/89a`、WebP `RIFF…WEBP`），命中则从文件头解析宽高（`tools/image.ts` 纯函数）；识别在二进制判定之前，因此扩展名与内容不一致时按内容为准——`.png` 扩展名的文本文件仍按文本读取，SVG（纯文本格式）走文本路径，BMP 等未识别二进制仍报 `binary_file`（其说明中列出支持的图片格式）。
- **限制**：单张原始文件不超过 5 MB、每边不超过 8000 px（`IMAGE_MAX_BYTES`/`IMAGE_MAX_EDGE`），超限报 `image_too_large`；文件头损坏或截断到无法解析尺寸报 `image_corrupt`。
- **结果**：成功时忽略 `offset`/`limit`、**不写 readState**（图片不解除"先读后写"）；`modelContent` 为一行 `Image file: <path> (<mime>, <宽>×<高>, <大小>)`；字节作为 `attachments` 交给执行器落盘（第 4 节），经 Context Builder 按当前模型 `imageInput` 投影进请求（[context.md](context.md) 第 3 节）——工具本身不判断模型能力。

### `web_fetch`

契约见 [ADR-0033 §1](../decisions/ADR-0033-web-fetch-file-refs.md)。输入仅 `{ url: string }`，拒绝未知字段、非 HTTP(S) 协议、超过 2000 字符的 URL 和用户名密码段。只发 GET，User-Agent 使用共享版本基值 `nocturne/<version>`，Accept 为 `text/html, text/markdown, text/plain, application/json, */*;q=0.5`，沿用进程级 `configureEnvProxy`，不登录、不带 Cookie、不执行脚本，也没有搜索能力。

声明 `mutates: false`、`concurrencySafe: true`、`timeoutMs: 30_000`、`maxModelChars: 30_000`。超时和中断由执行器结算，响应体读取同时监听取消信号。响应体超过 5 MB 时取消流，只处理前 5 MB 并注明截断；长结果走第 4 节的预算与完整输出落盘。重定向手动处理，至多跟随 5 次，每个目标重新校验协议、长度与凭据。授权主机相同才跟随：默认端口不写入主机，允许默认端口 HTTP → HTTPS 升级；非默认端口变化视作跨主机。跨主机以 `ok` 返回新地址，要求模型再次调用，由权限层批准新的主机。

HTML/XHTML 删除 `script/style/noscript/svg/iframe/nav/header/footer/aside/form`，优先取 `main`，其次 `article`，否则取页面内容；提取 `<title>`，用 `node-html-markdown` 转 Markdown。`text/*`、JSON、XML 与 `+json`/`+xml` 原文返回。字符集优先取响应头 charset，HTML 未声明时查看前 1024 字节的 meta charset，未知编码回退 UTF-8；仅使用 WHATWG TextDecoder。PNG/JPEG/GIF/WebP 复用 `read` 的魔数、尺寸与大小校验，经附件通道落盘（`source: "read"`），由上下文按模型能力投影，不写 readState。其他内容返回 `unsupported_content` 并说明类型与已读取大小。

2xx 的 `modelContent` 首行为 `URL: <最终地址>`，有标题时第二行为 `标题: <title>`，空行后是正文；HTTP 错误返回 `http_error`、状态码及正文前 2000 字符；连接、DNS、TLS 与无效重定向返回 `network_error`，超时仍为执行器的 `timeout`。`output` 只含 `{ url, finalUrl, status, contentType, title?, chars, truncatedBytes? }`，其中 chars 是预算截断前的模型结果字符数，不含正文。跨主机结果的 finalUrl 保留实际访问地址。

权限目标为小写 hostname（非默认端口带 `:端口`），完整 URL 放在只供显示的 `detail`。同主机的会话授权与 explore 子会话继承见 [permissions.md](permissions.md) 第 3、5.4 节和 [subagent.md](subagent.md) 第 6、7 节；工具不自行判断访问权限。

`shell` 的约定（Phase 2 定案）：

- **shell 选择**（[ADR-0022](../decisions/ADR-0022-shell-selection.md)）：支持五种 shell——`pwsh`（PowerShell 7+，Windows/POSIX）、`powershell`（Windows PowerShell 5.1，只探测不自动入选）、`bash`（Windows 为 Git Bash，POSIX 为 bash）、`cmd`、`sh`（POSIX）。每种由 `platform/shells.ts` 的 `ShellDescriptor` 描述调用形态与随主体透传的元数据（分页器名单 `pagers`/`flagPagers`、高风险命令表 `risk`——纯数据，匹配判定在权限层，见 [permissions.md](permissions.md) 第 6 节）：PowerShell 系用 `-NoLogo -NoProfile -NonInteractive -EncodedCommand <UTF-16LE Base64>` 执行包装脚本——前奏把 `[Console]::OutputEncoding`/`$OutputEncoding` 置为 UTF-8 无 BOM 并静默 `$ProgressPreference`，退出码语义为末句是原生命令（AST 判定，`&`/`.` 调用运算符解引用）取 `$LASTEXITCODE`、非原生命令成功 0 / 出错 1；`bash`/`sh` 用 `-c`；`cmd` 用 `/d /s /c`（仅 cmd 走 Windows verbatim 传参，其余走 Node 常规参数转义）。探测只做文件存在性判断、结果进程内缓存：Git Bash 由 PATH 上的 `git.exe` 推导 `..\bin\bash.exe`，其次常见安装目录，刻意不取 PATH 上的裸 `bash`（`C:\Windows\System32\bash.exe` 是 WSL 入口）；pwsh 查 PATH 与 `%ProgramFiles%\PowerShell\7`。生效选择按 `NOCTURNE_SHELL` > `config.json`（`shell`/`shellPath`）> `settings.json` > 自动（Windows：pwsh → Git Bash → cmd；POSIX：sh）合成（[config.md](config.md) 第 2、5 节）；非法 `NOCTURNE_SHELL` 在装配时警告一次（收入 `runtime.warnings` 便于 CLI/TUI 启动时展示）并回退自动，显式选择但可执行文件不存在时该次调用以 `error` 结算并列出已探测到的可选项。选择是**会话级可变**的：`session.setShell` 在写 `settings.json` 前先校验目标可执行——未安装（或 `auto` 无可解析结果）以 `invalid_command` 拒绝并列出可选项、不产生事件；校验通过后写入 `settings.json`，从**下一次** shell 调用生效——执行环境在每次工具调用时逐次解析，不在 Turn 开始快照，已执行的命令不受影响。工具 `description` 保持中性稳定（"种类与语法见环境信息"），模型看到的语法说明由环境信息 Shell 行与会话内切换说明承担（[context.md](context.md) 第 3 节）。
- **shell 子进程环境**（v0.2）：继承进程环境，但剥离全部已解析服务商的 `apiKeyEnv` 变量名以及 `NOCTURNE_API_KEY`、`ANTHROPIC_API_KEY`，避免模型通过命令读到密钥（[provider-setup.md](provider-setup.md) 第 4 节）。
- **输入**：`{ command, timeoutMs?, cwd? }`。`cwd` 省略时会话 cwd；指定时经符号链接 / junction 解析后必须位于工作区内，否则 `invalid_input`。**注意：`cwd` 限制约束的只是执行起点，不是沙箱**——被批准的 `command` 本身仍可访问批准范围之外的资源；命令文本才是被确认的主体。
- **末尾分页拒绝**（v0.4，[ADR-0021](../decisions/ADR-0021-tui-daily-usability.md) 第 9 条）：模型有时给命令接上 `| more`/`| less` 分页——Windows 上 `more.com` 会改坏 UTF-8 输出（中文尤甚）且可能等待按键挂住。shell 工具声明了 `validateInput` 预检（tool-api.md 第 1 节）：`command` 经引号感知的轻量词法器（`pattern.ts` 的 `lexShellCommand`；权限层拆段不用它，见 [permissions.md](permissions.md) 5.3）切分后，任一独立命令（`&&`、`||`、`&`、`;`、换行、`$(`、反引号、`(`/`)` 均为边界）的管道末段若以分页器可执行名开头（basename 比较、大小写不敏感、允许引号包裹的路径如 `"C:\Windows\System32\more.com"`、忽略段首赋值与重定向），调用即以 `status:"error"`、`code:"invalid_input"` 结算。分页器名单随当前 shell 的描述符（`pagers`/`flagPagers`，ADR-0022）：`cmd`/`powershell`/`pwsh` 为 `more`/`more.com`，`bash`/`sh` 另加 `less`；PowerShell 系额外把 `Out-Host -Paging`/`oh -Paging`（允许参数前缀缩写）判为分页。该预检发生在权限求值与进程派生之前：不请求权限、不发 `tool.started`、不启动进程、不改写命令文本，模型收到的补救说明原文为：

  > 命令以分页工具结尾（more/less/Out-Host -Paging）。分页工具会改坏输出编码、可能等待按键卡住；输出会被自动收集，去掉末尾的分页命令后直接执行即可。需要筛选时先重定向到文件再用 grep 工具。

  管道中间段的分页工具（`more | sort`）、`more.txt`/`findstr more`、引号内的字样不误伤。词法器是提示性分词而非完整 shell 解析器：引号一律按 POSIX 习惯识别——`'` 在 cmd 中本不是引号符，单引号写法按 POSIX 语义近似处理（如 `'a | more'` 不判为管道）；引号内的 `$(…)`/反引号不展开，`^` 转义、here-doc 等复合语法不处理。
- **输出合并与截断**：stdout 与 stderr 在工具内按到达顺序合并为单一输出流（不等价于 shell 重定向，由 ProcessRunner 的两条流归并）；逐块经 `tool.progress` 上报（带 `stream` 标记），累积内容按 `maxModelChars` 截断。进程持续输出超过缓冲上限时丢弃中间部分但继续排空管道，防止子进程阻塞。
- **结果**：`output` 携带 `exitCode`、`signal`、`timedOut`、`killed`、`durationMs`；`timedOut` 时 `status="error"`、`code="timeout"`。命令已退出但输出管道仍被占用时另带 `outputDetached=true`（见下条），`modelContent` 末尾追加一行提示（ok 时落在 `[exit code …]` 之前）：`命令已退出，但仍有后台进程占用输出管道，之后的输出未读取；如果启动了服务器等后台进程，它可能仍在运行。`
- **退出与输出管道分离**：`spawnShell` 的 `wait()` 在直接子进程（cmd/sh 本体）`exit` 时结算，而不是等 stdio 全部关闭的 `close`——`close` 会被继承了输出管道的后台孙进程无限期拖住（`start`、`nohup`、`detached` 派生等）。子进程退出后输出流最多再等 500ms 自然收尾；仍被占用则经 `SpawnedProcess.detachOutput()` 销毁读取端，已捕获输出按原解码规则冲刷后保留，读取方正常结束而非报错。通用 `spawn`/`spawnPipe`（MCP stdio、Hooks）仍按 `close` 结算，行为不变。
- **孤儿进程遗留**：中断/超时只保证终止进程树——Windows `taskkill /T` 沿父子链终止，中间进程已退出的 detached 孙进程会脱离链条杀不到；POSIX 进程组终止对已 `setsid` 逃逸的进程同理。分离输出后仍存活的后台进程需用户按提示自行清理。
- **输出解码**：Windows 取 `chcp` 代码页映射为 WHATWG 编码（如 CP936 → GBK），其余平台与未识别代码页按 UTF-8。探测到非 UTF-8 代码页时，stdout、stderr 各自按换行分段：整段字节能以 fatal UTF-8 解码就使用 UTF-8，否则按控制台编码解码，原样保留 `\r\n`。未换行尾巴超过 8KB 或空闲 50ms 后也按同一规则冲刷；末尾截断的 UTF-8 多字节字符（最多 3 字节）留待下一块。流结束时解码剩余字节。`NOCTURNE_CONSOLE_ENCODING` 可显式指定任意 WHATWG label（如 `utf-8`、`gbk`），设置后完全按该编码流式解码，不再逐行判定。残留风险：极短的 GBK 字节串偶然也是合法 UTF-8 时，会被识别为 UTF-8。PowerShell 系 shell 的前奏已把输出编码固定为 UTF-8（ADR-0022），逐行判定主要用于 cmd 与输出 GBK 的旧程序。
- **进程树终止实测记录**（tools.md 第 5 节要求）：Windows（`taskkill /pid /T /F`）：已实测——测试在 `cmd /c` 下启动 Node 父进程并派生孙进程，中断后孙进程消失（`packages/core/src/tools/write-edit-shell.test.ts` "中断：终止整个进程树"用例）；POSIX（`detached` 进程组 + `kill(-pid, SIGKILL)`）：未在当前平台验证，CI/其他平台需复跑该用例。

`apply_patch`（多文件补丁格式）不在 MVP 中。若后续发现某些模型使用它明显更可靠，再作为额外工具加入，与 `edit` 并存。

## 7. 暂不设计

工具别名、Provider 原生工具（如服务端网页搜索）、后台运行的 shell。工具结果图片已有落地通道（`ToolResult.attachments` → `AttachmentStore` → 按 `imageInput` 投影，ADR-0023）；MCP 返回的图片目前仍按占位符处理（见 [mcp.md](mcp.md) 第 6 节），接入时转换为 `ToolResult.attachments`，不修改执行管线的步骤。
