# 会话（Session）

> 状态：提议 v0.3（锁与恢复修复的 Phase 3 实现细节，评审中）｜ 前置阅读：[overview.md](overview.md) ｜ 相关契约：[events.md](../protocols/events.md) ｜ 决策：[ADR-0003](../decisions/ADR-0003-session-event-log.md)、[ADR-0009](../decisions/ADR-0009-session-lock.md)

## 1. Session 与 Agent 分离

- **Session** 是持久的数据实体：一条事件日志加上从中派生的状态。它不会"思考"。
- **Agent Loop** 是无状态的执行过程：每次 Turn 读取会话状态、写入事件。它不保存会话数据。

分离的收益：恢复会话只需加载日志；同一个 Agent 实现可以驱动任何会话；将来的子会话（Subagent）只是另一条日志。

## 2. 事件日志

- 每个会话一个 JSONL 文件，每行一个**持久化事件**，以换行符结束。第一行永远是 `session.created`。
- 只追加，不修改已有记录。压缩上下文、切换模型、修复中断，都以新事件的形式追加。唯一的例外是打开时对损坏尾部的截断（第 4 节），它只移除从未成为有效记录的字节。
- 持久化事件的 `seq` 从 1 连续递增，由日志决定；临时事件不写日志、不占用 `seq`（见 [events.md](../protocols/events.md) 第 2 节）。

`SessionState` 由持久化事件按顺序折叠得到，不单独存储：

```text
SessionState = fold(durableEvents)
  ├── meta：id、cwd、workspaceRoot、创建时间、标题
  ├── config：当前模型、权限预设（取最近一次 session.config_changed）
  ├── history：用户消息、assistant 消息、工具调用与结果、压缩记录（按顺序）
  ├── usage：累计 token 用量
  ├── lastSeq
  └── openTurn / unsettledCalls：未结束的 Turn 与未结算的工具调用
```

存储位置：`<NOCTURNE_HOME>/sessions/<sessionId>.jsonl`，锁文件 `<sessionId>.lock` 与之同目录。`NOCTURNE_HOME` 默认为用户主目录下的 `.nocturne`（Windows 为 `%USERPROFILE%\.nocturne`）。会话数据不写入被操作的仓库。

MVP 不做快照；若将来出现加载瓶颈，再追加 `session.snapshot` 事件作为折叠起点。存储介质若需替换（例如 SQLite），只替换 `SessionStore` 实现，事件模型与本文的保证不变。

## 3. 生命周期

```text
            create                         submit
  (none) ─────────▶ open/idle ◀────────────────────────┐
                     │  ▲                              │
              submit │  │ turn.completed               │
                     ▼  │                              │
                   running ── interrupt ──▶（见 agent-loop.md 第 3.3 节）
                     │
                     │ 日志写入失败
                     ▼
                   failed ──close──▶ closed
  open/idle ──close──▶ closed ──resume──▶ open/idle（按第 4 节打开）
```

| 操作 | 行为 |
|---|---|
| `create` | 生成时间有序的会话 ID → 以排他方式创建锁文件 → 写入 `session.created`（`seq = 1`）→ 生成 `runId` → 开放 |
| `resume` | 按第 4 节打开 |
| `submit` | 仅在 `idle` 时接受，启动一个 Turn |
| `interrupt` | 中止当前 Turn；Turn 以 `aborted` 结束，会话回到 `idle` |
| `close` | 若有运行中的 Turn 先中断并等待其结束（`failed` 状态下不再写入）；释放锁。日志保留，可随时恢复 |

## 4. 打开会话（恢复）的顺序

顺序不能调换：**先取得锁，再读取和修改日志**。否则两个进程同时恢复时，可能各自追加修复事件后才发现对方存在。

1. **取得排他锁**：以"文件不存在才创建"的原子方式创建锁文件 `<sessionId>.lock`（`writeFile` 的排他创建），内容为 `{ pid, hostname, startedAt }` JSON。锁已存在时按失效判定处理（ADR-0009）：锁的 `startedAt` 早于本机最近一次开机（`Date.now() - os.uptime() * 1000`）→ 失效；主机名相同且该 pid 已不存在 → 失效；两者皆判为失效时删除后重试一次，重试仍撞上锁则拒绝；主机名不同、pid 存活或无法判定 → 拒绝打开，`SessionError(code = "session_locked")`；`resumeSession(id, { force: true })`（CLI `--force-unlock`）先删锁再走正常流程。网络文件系统上的会话目录不受支持；锁的已知限制（pid 复用、非强制性）见 ADR-0009。
2. **读取并校验**：逐行解析。
   - 检查 `session.created.formatVersion` 与全部事件类型；遇到高于自身支持的版本或不认识的持久化事件类型，拒绝恢复（`session_log_newer`），见 [events.md](../protocols/events.md) 第 8 节。
   - 检查 `seq` 从 1 连续递增。
   - 恢复时校验会话记录的模型仍能在当前 Provider 清单中解析；不能解析时按调用方意图分流：`resumeSession(id, { model })` 携带替代模型（CLI `--resume`/`--continue` 与 `--model` 组合）时，在修复事件之后、开放之前写入 `session.config_changed { model }`，使新模型成为会话事实的一部分；未携带替代模型则拒绝恢复（`invalid_model`），错误信息中给出"加 `--model` 指定替代模型"的用法提示。恢复出来的会话不能带着一个无法工作的模型进入 `idle`。
3. **处理损坏尾部**：只有**最后一行**可以被视为损坏尾部（文件不以换行符结束，或最后一行无法解析为合法事件——即使它看起来是合法 JSON，没有结尾换行符也说明写入中断过）。处理方式是把这部分字节另存为同目录的 `<sessionId>.jsonl.tail-<时间戳>` 以便诊断，然后**物理截断**日志到最后一个完整记录之后。只在读取时忽略是不够的：下一次追加会接在坏字节后面，把一条好记录也变成坏记录。
4. **中间损坏**：任何非最后一行无法解析、`seq` 不连续或倒序，都视为日志损坏，拒绝打开（`session_log_corrupt`），不自动修复、不跳过。用户可以用只读方式查看可解析的部分（只读查看工具暂缓实现）。
5. **追加修复事件**：见第 6 节。
6. **开放**：生成新的 `runId`，下一个 `seq = lastSeq + 1`，会话进入 `idle`。本次打开发生的修复（截断的尾部、补齐的调用与 Turn）以只读字段 `session.recovery` 提供给客户端展示（第 6 节末）。

## 5. 写入与持久性

- 所有持久化事件经由会话的单一写入通道按顺序追加；一个事件的写入调用完成后，才分发给订阅者（先写后发），才执行依赖它的动作（`tool.started` 写入后才执行工具）。
- **持久性承诺**：MVP 保证**进程崩溃级**持久性——写入调用返回即数据已交给操作系统，Nocturne 进程崩溃不会丢失已发布的持久化事件。**不保证断电或操作系统崩溃级持久性**：此时可能丢失最后若干事件或留下损坏尾部，第 4 节的尾部处理保证会话仍能打开。Turn 结束时执行一次 fsync 以缩小这个窗口，但不作为承诺。
- **写入失败**（磁盘满、I/O 错误、权限变化）时会话立即进入 `failed` 状态：
  - 中止当前 Turn 的中断信号，停止读取模型流；
  - 不再发起模型请求，**不再开始任何工具执行**；正在执行的工具收到中断信号；
  - 不再尝试写入日志（避免在不确定状态下追加），通过临时事件 `runtime.error` 通知客户端；
  - 会话只接受 `close`。之后重新恢复时，第 6 节的修复逻辑会补齐未结束的 Turn 与未结算的调用。

## 6. 恢复修复

打开时（第 4 节第 5 步）检查整条日志，而不只是最后一个 Turn：

1. 对每个出现在 `message.assistant.toolCalls` 中但没有 `tool.completed` 的 `callId`，追加 `tool.completed`，`status = "interrupted"`。若该调用已有 `tool.started`，结果文本注明"该工具可能已部分执行，请先检查当前状态再继续"，因为文件写入或命令的副作用可能已经发生；若没有 `tool.started`，注明"工具未执行"。
2. 对每个有 `turn.started` 而无 `turn.completed` 的 Turn，追加 `turn.completed`，`reason = "error"`，`error.code = "process_exited"`，`recovered: true`。
3. 正常运行时不应出现"已结束的 Turn 中存在未结算调用"。若恢复时发现，同样按第 1 条修复，并记录诊断日志，因为它意味着 Agent Loop 存在缺陷。

修复本身也是事件，日志仍然是完整、可审计的历史。打开会话时实际执行的修复汇总为 `session.recovery`（只读字段）：

```ts
interface SessionRecovery {
  /** 被截断的损坏尾部另存到的文件名；未发生截断时缺省 */
  truncatedTail?: string;
  /** 补齐为 interrupted 的工具调用数 */
  interruptedCalls: number;
  /** 以 process_exited 收束的未完成 Turn 数 */
  recoveredTurns: number;
}
```

| 能恢复 | 不能恢复 |
|---|---|
| 所有完整的用户消息、assistant 消息 | 崩溃时正在流式输出、尚未持久化的文本 |
| 所有已完成的工具调用与结果 | 崩溃时正在运行的子进程的输出与状态 |
| 权限决定、压缩记录、模型切换 | 当时待确认的权限请求（对应调用记为 interrupted） |
| 累计用量 | 会话级临时授权（重启后需要重新确认） |

关于子进程：Nocturne 在正常关闭与中断时会终止它启动的进程树，但在进程被强制结束或崩溃时，子进程是否随之结束取决于平台与进程组设置，**不作保证**。恢复逻辑不假设它们已经停止；上面第 1 条的提示文本正是为此。各平台的实际行为在 Phase 2 实现 `shell` 时验证并记录在 [tools.md](tools.md)。

## 7. 设计问题的结论

| 问题 | 结论 |
|---|---|
| Session 是否由事件重建？ | 是。持久化事件是唯一事实来源，状态由折叠得到 |
| 是否需要快照？ | MVP 不需要；保留以追加事件方式引入的空间 |
| 是否绑定工作目录？ | 是。`session.created` 记录 `cwd` 与 `workspaceRoot`；在其他目录恢复时，CLI 交互模式提示并默认拒绝，用户显式确认后继续；非交互模式直接报错退出（工具始终以会话记录的目录为准） |
| 是否允许切换模型？ | 允许。切换写入 `session.config_changed`；Context Builder 负责丢弃与新 Provider 不兼容的内容，见 [context.md](context.md) 第 7 节 |
| 是否允许不同 Client 接管？ | 同一时刻只有一个进程持有会话锁并写日志。接管 = 前一个进程关闭后由新进程恢复。多个客户端同时观察同一会话，在引入 RPC 时由持锁进程广播事件实现 |
| 如何中断？ | 见 [agent-loop.md](agent-loop.md) 第 3.3 节 |

## 8. 会话列表

读取每个日志的第一行（`session.created`）和文件修改时间列出会话，可按工作目录过滤；每条摘要附带 `locked`（锁文件存在且持有者看起来存活），供客户端标注"正在使用/残留锁"。列表是只读操作，不取得锁、不解析日志主体。会话数量增长到影响启动时间时，再加入可随时从日志重建的索引文件。

## 9. 暂不设计

分叉、回退、跨设备同步、会话分享、断电级持久性选项。它们都可以在事件日志模型上实现，届时单独写设计。
