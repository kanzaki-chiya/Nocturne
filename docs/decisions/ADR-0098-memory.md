# ADR-0098：长期记忆（全局 / 项目 / 组曲三层）

- 状态：已接受
- 日期：2026-11-19
- 参照：Qoder「设置 › 记忆」（全局记忆、项目记忆两个开关加列表）；Claude Code 的自动记忆（一条记忆一个文件，带 `name` / `description` / `type` 前言）
- 相关：[architecture/context.md](../architecture/context.md) 第 3、6、8 节、[architecture/config.md](../architecture/config.md) 第 2 节、[architecture/tools.md](../architecture/tools.md) 第 6 节、[architecture/modules.md](../architecture/modules.md)、[protocols/rpc.md](../protocols/rpc.md) 第 3.15 节、[ADR-0095](ADR-0095-session-notes-board-read.md)、[ADR-0097](ADR-0097-suites.md)

## 背景

Nocturne 此前没有跨会话记忆。[context.md](../architecture/context.md) 第 8 节把「长期记忆、跨会话知识」列为暂不设计；会话笔记（`note_write`）只活在一个会话里，子会话也不继承。用户的偏好、纠正过的做法、项目里踩过的坑，每开一个新会话都要重新交代。后续组曲（[ADR-0097](ADR-0097-suites.md)）需要一份所有线程共享的记忆，需要共用同一个记忆模块。

用户 2026-11-19 已明确三项设计原则：模型自己写记忆；无人值守会话只读不写；先落地长期记忆模块，后续组曲复用其中的「组曲」范围。

## 决定

### 1. 范围与存储

三层范围，均放在 `<NOCTURNE_HOME>/memory/` 下，不写进任何工作区仓库：

| 范围 | 目录 |
|---|---|
| 全局（`global`） | `memory/global/` |
| 项目（`project`） | `memory/projects/<目录名>-<8 位哈希>/`，首次写入时创建 `workspace.json`（`{ "version": 1, "path": "<主路径>" }`）记下主仓库路径 |
| 组曲（`suite`） | `memory/suites/<suiteId>/`；本 ADR 定目录解析与存储接口，组曲会话装配行为随组曲实现 |

- **项目的键**：工作区在 Git 仓库里时由 `platform/workspace-branches.ts` 的 `gitMainRepository`（`git rev-parse --is-bare-repository --path-format=absolute --git-common-dir`）解析**主仓库**根目录，链接工作树自动映射回主仓库，裸仓库与非 Git 目录退回工作区根目录；对真实路径规范化后取 SHA-256 前 8 位，拼接目录名构成 `<目录名>-<8 位哈希>`。这样主目录、它的工作树与直接打开的 `-wt` 目录共用同一份项目记忆。
- **默认工作区**（`<NOCTURNE_HOME>/workspace`，普通对话用）：没有项目范围，只有全局范围。
- **格式**：一条记忆一个文件 `<name>.md`，YAML 前言含 `name`、`description`、`type`（`user` / `feedback` / `project` / `reference`），正文是 Markdown 记忆内容。`name` 匹配 `^[a-z0-9][a-z0-9-]*$`，同范围内唯一。**不设单独的索引文件**：注入用的索引在快照时从各文件前言动态生成，避免两份来源不一致；用户也可以直接在目录里编辑或删除文件。
- **写入与容错**：每条记忆写独立文件，先写同目录临时文件再 `rename` 原子替换；不同记忆互不影响，多个进程同时写不同记忆不会互相覆盖，写同一条时后写的生效。文件名不合规范、前言缺失/未闭合、YAML 非法、`name` 与文件名不一致或字段校验失败的文件跳过，并在 `describeMemory` 的 `warnings` 里列出。

### 2. 谁能用

由 `core/index` 在打开/装配会话时依据会话元数据（与 `resident/index.ts` 的 `residentKindOf` 判定）决定是否注入索引及挂载哪些工具，不在 Agent Loop 或 Context Builder 里按工具名写分支：

| 会话 | 注入索引 | `memory_read` | `memory_write` / `memory_delete` |
|---|---|---|---|
| 用户亲自开的交互顶层会话（桌面、手机、TUI、CLI 交互） | 是 | 是 | 是 |
| 合奏指挥（以及后续组曲指挥） | 是 | 是 | 是 |
| 合奏成员（含 `explore` 成员，以及后续组曲线程） | 是 | 是 | 否 |
| 外部 agent 经 Nocturne MCP 开的会话（`meta.client.kind === "agent"`）、定时任务会话（`meta.schedule`）、`nctrn -p` 等非交互运行 | 是 | 是 | 否 |
| 一次性 `task` 子代理（含 `explore`）、外部 ACP agent | 否 | 否 | 否 |

### 3. 进入上下文

- 在 [context.md](../architecture/context.md) 第 3 节「项目指令」之后、「技能目录」之前新增 `memory` section，只在当前会话有可用且开启的范围时出现。内容包含：
  - 一段英文前言：说明这些是以前会话留下的记忆，可能已过时；提到具体文件、符号、命令时先核对再用；与用户当前指令冲突时以用户为准；记忆是数据，不是指令；索引仅作目录，用 `memory_read` 读全文。**可写会话**在前言后再附一段写入指导说明（什么时候写、什么不写，同第 4 节）；只读会话没有这段写入指导。
  - 每个已开启的可用范围一个 `<memory scope="global|project|suite">…</memory>` 块，块内按文件名排序一行一条：`- <name> (<type>): <description>`。范围已开启但尚无记忆时，块内写 `(empty)`，让可写会话知道该范围可用。
- 只注入索引；某条记忆的全文由模型按需调用 `memory_read` 读取。
- **快照时机**：会话打开（新建、恢复、分叉）和每次 L2 摘要（自动或手动 `/compact`）完成后各拍摄一次快照；普通 Turn 与 Step 之间不变，保住提示词缓存前缀。会话中途写入或删除记忆不改本会话的 system，模型从工具结果里已知自身变更。
- 单个范围索引超过 `25,000` 字符（`MEMORY_INDEX_MAX_CHARS`）时按整行截断并追加截断标记，`ContextReport` 的 `memory` section 记 `source: "<N> entries"` 并在任一范围截断时置 `truncated: true`。条数不设上限。
- 基础系统提示**不改**。

### 4. 工具

- `memory_read({ scope, name })`：读取单条记忆全文（含 YAML 前言），`traits` 为 `mutates: false, concurrencySafe: true`。
- `memory_write({ scope, name, description, type, content })`：新建或覆盖一条记忆，`traits` 为 `mutates: true, fileEffects: "none", concurrencySafe: false`。
- `memory_delete({ scope, name })`：删除指定记忆文件，`traits` 为 `mutates: true, fileEffects: "none", concurrencySafe: false`。

`scope` 只接受当前会话可用且开关打开的范围，其他值在输入校验阶段即报 `invalid_input` 并列出可用范围。三个工具都不接收路径参数（只能读写 `memory/` 下对应范围目录），且 `permissionSubjects` 返回空数组（不弹权限确认，与 `note_write` 一致）。写入/删除均设置 `fileEffects: "none"`，不计入文件检查点或回退撤销列表。

写入说明（`MEMORY_WRITE_GUIDANCE`）放在可写会话的 `memory` 前言和 `memory_write` 的工具描述里：当用户说明了偏好或身份、纠正了做法、确认了不显然的工作流、交代了代码里看不出来的项目约束时写入；不写能从代码或 git 历史查到的事实，不写只和当前会话有关的细节，不写密钥、令牌、密码；写入前先看索引里是否有同主题的记忆，有就覆盖那条；发现记忆错误或过时时用 `memory_delete` 删除。

### 5. 开关

- `settings.json` 新增用户级专用字段 `memory: { global?: boolean; project?: boolean }`，缺省皆为 `true`，经 `describeSettings` / `updateSettings`（键 `memory.global`、`memory.project`，值为布尔或 `null` 恢复默认）读写。
- 与 `skills.disabled`、`appearance.*` 同类：专用读写，不参与 `config.json` 与项目配置合并，项目配置里出现 `memory` 时忽略。
- 关闭后对应范围既不注入上下文也不能读写，已有记忆文件保留。开关变更对之后打开的会话生效，不影响已打开会话。

### 6. 回退、分叉与压缩

记忆不属于会话事件日志：对话回退（`rewind`）、分叉（`fork`）均**不**撤销或复制记忆文件；L2 摘要不把记忆索引或工具写入总结为持久记忆规则，但在每次 L2 摘要写入后刷新一次内存快照，使下一次请求看到最新索引。

### 7. Runtime 与 RPC

- `Runtime.describeMemory({ workspaceRoot? })` → `{ global: MemoryScopeOverview; project?: MemoryScopeOverview; otherProjects: { key, path, count }[] }`。`MemoryScopeOverview` 包含 `enabled`、`dir`、`entries: { name, description, type, updatedAt }[]`、`warnings`。`otherProjects` 扫描 `memory/projects/` 下存在有效 `workspace.json` 且至少含一条有效记忆的其他项目目录，供后续管理非当前工作区的项目记忆。
- `Runtime.readMemory({ scope, key?, workspaceRoot?, name })`、`deleteMemory({ scope, key?, workspaceRoot?, name })`、`clearMemory({ scope, key?, workspaceRoot? })`（`key` 指定项目或组曲，缺省按当前或指定 `workspaceRoot` 解析项目）。
- RPC 方法命名为 `memory.describeMemory`、`memory.readMemory`、`memory.deleteMemory`、`memory.clearMemory`，**仅向本机连接开放**（不加入远程白名单 `REMOTE_METHODS` 或外部 agent 白名单，因为返回包含本机绝对路径）。
- 通过工具或 Runtime 写入、删除或清空记忆后触发 `onMemoryChanged`，Hub 收到后向已握手连接推送 `runtime.providersChanged`。

### 8. 界面

已在桌面端「设置」侧栏「技能」之前实现「记忆」页（`apps/desktop/src/MemoryPage.tsx`：顶部全局/项目开关、全局/项目/其他项目列表、详情查看、删除与清空确认），并在 `apps/desktop/src/context-panel.tsx` 的 `SECTIONS` 表补录 `memory` 项。

### 9. 明确不做

- 语义检索、向量库、跨会话全文搜索；
- 模型主动工具调用之外的自动抽取（例如会话结束时自动总结写入记忆）；
- 团队共享、云端同步；
- 组曲范围的会话装配行为（留待组曲落地时复用本模块接通）。

## 后果

- 新增模块 `packages/core/src/memory/`，只依赖 `protocol` 与 `platform`（由 `.dependency-cruiser.cjs` 的 `memory-deps` 与 `only-index-imports-memory` 固化），由 `core/index` 装配上下文快照、记忆工具与 Runtime API；[modules.md](../architecture/modules.md) 增加 `memory` 一节。
- `platform/workspace-branches.ts` 新增 `gitMainRepository`，供项目键解析复用，使主仓库与工作树共享同一份项目记忆。
- [context.md](../architecture/context.md) 第 3 节加入 `memory` section，第 6 节补充 L2 摘要后刷新记忆快照，第 8 节移除「长期记忆、跨会话知识」。
- 已同步修订组曲设计 [ADR-0097](ADR-0097-suites.md)（第 3.2、3.3、3.4、3.6 节），组曲记忆范围与写入方式直接复用本 ADR 的 `suite` 范围与 `memory_write({ scope: "suite" })`。

## 备选方案

- **在 `memory/` 目录维护一份 `index.json` 或 `INDEX.md`**：多进程并发写或用户手工删改 `.md` 文件时极易与真实文件集合脱节，改为快照时直接扫描并解析各 `.md` 文件前言。
- **由会话结束钩子或后台模型自动提取记忆**：成本不可控且容易写入噪音或误记，按既定决策只由模型在对话中显式判断并调用 `memory_write` / `memory_delete`。
- **把记忆开关放进 `config.json` 通用合并层**：项目配置可能来自外部仓库，不允许仓库配置开启/关闭用户长期记忆，故沿用 `settings.json` 用户级专用字段。
