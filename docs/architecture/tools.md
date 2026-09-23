# 工具运行时（Tools）

> 状态：已接受 v0.2 ｜ 前置阅读：[overview.md](overview.md) ｜ 接口契约：[tool-api.md](../protocols/tool-api.md) ｜ 权限：[permissions.md](permissions.md)

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
└── builtin/         read、write、edit、grep、glob、shell
```

内置工具与将来的 MCP 工具、插件工具走完全相同的注册接口和执行管线，没有特权通道。

## 3. 执行管线

```text
execute(call, ctx):
  1. 查找      registry.get(call.name)
               不存在 → 结果 error(code="unknown_tool")，列出可用工具名，交给模型自我修正
  2. 校验      按 inputSchema 校验并规范化输入
               失败 → error(code="invalid_input")，附带校验信息
  3. 权限主体  requests = tool.permissionSubjects(input, scope)   # 纯函数：本次调用会碰到什么
  4. 解析资源  subjects = platform.resolve(requests)               # 唯一做 I/O 的准备步骤：真实路径
               解析失败（如权限不足无法访问父目录）→ error(code="resource_unavailable")
  5. 权限      decision = permissionGate.check(subjects, signal)
               deny → error(code="permission_denied")，附理由与用户反馈
               ask  → 发出 permission.requested，等待客户端回复（可被中断）
  6. 开始      emit tool.started（含解析后的 subjects 与权限决定），写入成功后才继续
  7. 执行      tool.execute(input, ctx)，ctx.subjects = 已批准的解析结果，携带 AbortSignal 与超时
               工具抛出的异常 → error(code="tool_failed")；超时 → error(code="timeout")
  8. 归一化    按结果预算截断模型可见内容；保留结构化输出供客户端渲染
  9. 完成      emit tool.completed（持久化），返回 ToolResult
```

要点：

- 每个工具调用无论在哪一步结束，都**必须**产生恰好一个 `tool.completed`，这是模型请求中工具调用与结果能够配对的前提。调用以 Runtime 分配的 `callId` 标识。
- 权限在第 5 步由执行器统一处理，工具实现拿到执行机会时权限已经确定。工具不能自己弹确认，也不能跳过这一步。资源解析与权限求值的分工见 [permissions.md](permissions.md) 第 4 节。
- 会修改文件的工具在写入前重新解析目标路径，与 `ctx.subjects` 中批准时的结果不一致时返回 `resource_changed`，不写入。
- 枚举类工具（grep、glob）不跟随符号链接，并用 `ctx.permissions.check` 过滤每个结果条目，只保留求值为 allow 的条目，省略数量写入结果。
- 将来的 Hooks 插入点：PreToolUse 位于第 2、3 步之间（可以拒绝或修改输入，修改后重新校验），PostToolUse 位于第 7、8 步之间。未配置 Hooks 时管线行为不变。

## 4. 结果预算

模型可见的工具输出必须有界：

- 每个工具声明 `maxModelChars`（默认 30,000 字符，约 7,500 token）。超出时保留开头与结尾，中间替换为"已省略 N 字符"的说明。
- 结构化 `output`（供客户端渲染，例如 diff、退出码）与模型可见的 `modelContent` 分开；前者也有独立上限，防止事件与日志膨胀。
- 后续阶段加入"完整输出落盘"：超出预算的完整内容写入会话目录下的附件文件，模型收到路径与预览，可以用 `read` 按需查看。

## 5. 超时、中断与并发

- 每个工具声明默认超时；`shell` 允许调用方在上限内指定超时。
- 中断信号来自 Turn 的 `AbortController`。工具应尽快停止；超过宽限期后执行器放弃等待并记为 `cancelled`。`shell` 尝试终止整个进程树（Windows 与 POSIX 的实现不同，由 `platform` 负责）；Nocturne 自身异常退出时子进程是否随之结束不作保证，见 [sessions.md](sessions.md) 第 6 节。
- **各平台进程树终止的实现与验证**：Windows 用 `taskkill /pid <pid> /T /F` 终止整棵树；POSIX 在 `spawn` 时以 `detached: true` 使子进程成为进程组组长，用 `kill(-pid, SIGKILL)` 整组终止。这两条的**实际效果在 Phase 2 实现 `shell` 时必须在 Windows 上实测**（命令派生孙子进程后中断，验证整树消失），结果记录在第 6 节 `shell` 行下；无法在当前平台验证的部分如实标注。
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

"先读后写"与过期检测防止模型基于过时内容覆盖文件，是低成本、高收益的保护。已读状态保存在运行时内存中，会话恢复后需要重新读取。判定细则：

- 写入工具以 `ctx.subjects` 中已批准的**解析后路径**为准；写入前重新 `stat`/`realpath`：解析结果与批准时不一致 → `resource_changed`；已存在文件在 `readState` 中无记录 → `error(code="not_read")`；记录的 `mtimeMs`/`size` 与当前不一致 → `error(code="stale_file")`（要求重新 `read`）。
- `write` 创建尚不存在的文件不要求先读；写入瞬间文件恰好出现（竞态）按已存在文件处理，即要求先读。
- `edit`/`write` 覆盖时在 `output` 中携带行级 unified 风格 diff（公共前后缀作上下文，中段为 `-`/`+` 行）；`modelContent` 是简短摘要，不含完整 diff。

`shell` 的约定（Phase 2 定案）：

- **shell 选择**：Windows 用 `%COMSPEC%`（通常为 `cmd.exe`）加 `/d /s /c`；POSIX 用 `/bin/sh -c`。两者都可由 `NOCTURNE_SHELL` 环境变量覆盖为其他 shell 可执行文件。选择理由：cmd 在 Windows 上必有、无 profile 副作用；`sh` 在 POSIX 上必有，`bash` 不保证存在。
- **输入**：`{ command, timeoutMs?, cwd? }`。`cwd` 省略时会话 cwd；指定时必须解析后位于工作区内，否则 `invalid_input`。
- **输出合并与截断**：stdout 与 stderr 在工具内按到达顺序合并为单一输出流（不等价于 shell 重定向，由 ProcessRunner 的两条流归并）；逐块经 `tool.progress` 上报（带 `stream` 标记），累积内容按 `maxModelChars` 截断。进程持续输出超过缓冲上限时丢弃中间部分但继续排空管道，防止子进程阻塞。
- **结果**：`output` 携带 `exitCode`、`signal`、`timedOut`、`killed`、`durationMs`；`timedOut` 时 `status="error"`、`code="timeout"`。
- **进程树终止实测记录**（tools.md 第 5 节要求，实现时填写）：Windows（`taskkill /T /F`）：＿待实现时实测填写＿；POSIX（detached 进程组 + `kill(-pid)`）：＿未在当前平台验证＿。

`apply_patch`（多文件补丁格式）不在 MVP 中。若后续发现某些模型使用它明显更可靠，再作为额外工具加入，与 `edit` 并存。

## 7. 暂不设计

MCP 工具适配、工具别名、Provider 原生工具（如服务端网页搜索）、后台运行的 shell、工具结果中的图片。接入时均通过 `ToolDefinition` 与注册表完成，不修改执行管线的步骤。
