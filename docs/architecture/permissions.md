# 权限（Permission）

> 状态：已接受 v0.2 ｜ 前置阅读：[tools.md](tools.md) ｜ 决策：[ADR-0004](../decisions/ADR-0004-permission-rules.md)

## 1. 定位

权限是一个独立的**策略层**：输入"这次工具调用会碰到什么"，输出 `allow` / `ask` / `deny` 以及理由。

- 它不属于工具实现：工具只声明自己会碰到什么，不决定是否需要确认。
- 它不属于 UI：需要确认时发出事件，由客户端展示并回复。
- 它不属于 Agent 推理：模型无法通过参数或提示词改变判定。
- 它不做 I/O：需要查询文件系统的信息（真实路径、是否存在）由 Tool Executor 通过 `platform` 预先解析，权限层只对解析结果做纯策略判断（第 4 节）。

**它不是沙箱。** 权限层在调用发生前做判定，无法约束一条已获准执行的 shell 命令实际做了什么（例如命令内部访问网络或写工作区外的文件）。操作系统级沙箱是后续独立议题，文档和界面都不应暗示当前版本具备这种隔离。

## 2. 概念

| 概念 | 是什么 | 谁产生 | 记录位置 |
|---|---|---|---|
| `SubjectRequest` | 工具声明的、未解析的主体：`{ kind, target }` | 工具的 `permissionSubjects(input)`（纯函数） | — |
| `PermissionSubject` | 解析后的主体：增加 `resolved`（真实路径）与 `where` | Tool Executor 解析 + 权限层计算 `where` | `tool.started`、`permission.requested` |
| `PermissionRule` | 一条规则：`{ kind, pattern, action, where? }` | 预设、用户配置、项目配置、命令行参数 | 配置文件 |
| `Grant` | 用户在确认时授予的授权："本会话内允许"或"在此项目中始终允许" | 客户端回复 | 会话内存 / 用户数据目录 |
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
| `network` | URL 或主机 | 将来的网页类工具 |
| `mcp` | `<server>/<tool>` | 将来的 MCP 工具 |

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

一条规则匹配一个主体，当且仅当 `kind` 相同（或规则为 `*`）、`pattern` 以 glob 方式匹配（路径类见 4.2）、`where` 未指定或相同。没有任何可信规则匹配时，结果为 `ask`。

### 5.2 信任边界

项目配置来自仓库，默认**不可信**。不可信的项目规则不参与 5.1 的排序，而是与可信结果**取更严格者**（`deny` > `ask` > `allow`）：

- 不可信项目规则中的 `allow` 被忽略；
- 它们的 `ask` / `deny` 只能让结果更严格，**永远不能让结果更宽松**。例如用户规则 deny 某路径、项目规则 ask 同一路径，结果仍是 deny。

用户在用户配置中把某个工作区标记为可信后，该工作区的项目规则才进入 5.1 的排序（位于用户配置之后）。

### 5.3 完整算法

对每个主体：

```text
trusted   = lastMatch(预设 ++ 用户 ++ [可信项目] ++ 命令行, subject) ?? ask
untrusted = 项目不可信 ? lastMatch(项目规则中的 ask/deny, subject) : 无
decision  = stricter(trusted, untrusted)
if decision == ask and 有 Grant 匹配 subject:
  decision = allow        # source = "grant"
```

一次调用有多个主体时：任一主体为 `deny` 则 `deny`；否则任一为 `ask` 则 `ask`；否则 `allow`。

附加约束：

- **shell 组合命令**：命令包含 `&&`、`||`、`;`、`|`、换行、反引号、`$(`、重定向等控制符时，基于模式的 `allow` 规则不适用，结果至少为 `ask`；对这类命令的 Grant 只能精确匹配完整命令字符串。这避免 `git status*` 放行 `git status && rm -rf .`。
- **可解释**：决定中记录命中的规则及其来源（如"用户配置第 3 条""项目配置第 1 条（不可信，仅收紧）"）。

## 6. 预设

预设只是一组规则，没有隐藏逻辑，用户可以在其上追加规则覆盖。

| 预设 | read（工作区） | read（外部） | edit（工作区） | edit（外部） | shell | network / mcp |
|---|---|---|---|---|---|---|
| `read-only` | allow | ask | deny | deny | ask | ask |
| `default`（默认） | allow | ask | ask | ask | ask | ask |
| `auto-edit` | allow | ask | allow | ask | ask | ask |
| `full-access` | allow | allow | allow | ask | allow | allow |

所有预设额外包含：

- **受保护路径**：对 `.git/` 内部与 `.nocturne/` 配置目录的 `edit` 一律 `ask`。
- **高风险命令**：`full-access` 中对一组已知高风险命令模式（如 `rm -rf *`、`git push --force*`、`git reset --hard*`）保持 `ask`。这是基于模式的提示，不是可靠的危险检测。

## 7. 需要确认时（ask）

```text
PermissionGate.check(subjects, signal)
  → emit permission.requested { requestId, callId, subjects, reason, options }
  → 等待 session.respondPermission(requestId, reply)，或 signal 中止
  → emit permission.resolved { requestId, action, source: "user" | "cancelled", remember }
```

| 选项 | 效果 |
|---|---|
| 允许一次 | 仅本次调用 |
| 本会话内允许 | 生成会话 Grant（精确目标或用户选定的前缀），保存在内存中，会话关闭即失效 |
| 在此项目中始终允许 | 生成项目 Grant，写入**用户数据目录**中按工作区区分的记录，而不是仓库内的项目配置 |
| 拒绝 | 工具结果为拒绝，可附带反馈给模型，Turn 继续 |
| 拒绝并停止 | 工具结果为拒绝，并中止当前 Turn |

两种 Grant 都只在求值结果为 `ask` 时生效（5.3）。没有交互式客户端时，`ask` 视为 `deny`（`source: "non_interactive"`），该行为可在配置中显式修改。

## 8. 与其他模块的关系

- Tool Executor 负责解析资源并调用 `PermissionGate`，见 [tools.md](tools.md) 第 3 节。
- 将来的 Hooks 可以在权限求值前给出建议，但 Hook 的 `allow` 不能越过 `deny`，并按不可信来源处理（只能收紧），除非用户显式信任该 Hook。
- 规则的配置格式与加载由 `config` 负责；本模块只接收已合并、已标注来源与信任状态的规则列表。
