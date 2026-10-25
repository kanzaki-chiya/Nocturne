# ADR-0063：重复调用保护与修剪不足时升级摘要

- 状态：已接受（维护者 2026-10-25 确认；压缩阈值不在本 ADR 内调整）
- 日期：2026-10-25

## 背景

审查窗口分析了 2026-10-18 至 10-24 在 `Z:\nocturne` 工作区跑的 12 个会话（报告 `Z:\nocturne-mockups\session-log-analysis-report.md`，不在仓库内）。有两个问题需要改动 Agent Loop 和 Context Builder 的行为，所以单独立 ADR：

1. **没有任何机制发现模型在原地打转。** `202610220716-f0136a6d` 摘要压缩后，从 seq 926 到 965 连发了 14 次完全相同的 `git status` 调用，输出一字不差，直到模型自己放弃。另一个会话里，桌面自动化的同一个按键连续发了 5–16 次（共 11 组）。这类循环每一步都要重读 100k–200k 的上下文。
2. **修剪回收不够时，上下文停在阈值附近。** 一周 8 次修剪里有 2 次压完仍有约 200k（预算约 330k），几乎马上又要压缩；而按 [context.md](../architecture/context.md) §6.5，同一 Turn 里修剪之后要等估算再次超过摘要阈值 `S` 才会摘要。

压缩阈值本身不在本 ADR 内调整。它已经可以通过 `compaction.threshold` 设为绝对值（例如 `"200k"`），需要更短上下文的用户直接配置即可。

## 决定

### 1. 重复调用保护

- **签名**：每次工具调用完成后，计算签名 = 工具名 + 规范化后的入参（JSON 键排序）+ 结果正文的哈希。只看签名，**不按工具名分支**。
- **判定**：同一个 Turn 里，签名完全相同的调用**连续**出现（中间没有其他工具调用；只穿插模型的文本或推理不算打断）。按 `tool.completed` 的顺序计数；同一步里并行发出的多个相同调用各算一次。
  - 第 3 次：紧跟这次工具结果，附上一条系统说明（英文，进系统提示的约定范围），大意是「这个调用连续 3 次返回了完全相同的结果，继续重复不会得到新信息，请换一种做法，或者停下来向用户说明情况」。不写事件；说明的位置和内容由历史确定性地推出，**之后每次构建上下文都在同一位置带上它**（回放同理），保证提示缓存前缀不变。只在一次请求里出现、下一次消失的做法会打断缓存，不采用。
  - 第 6 次：以 `turn.completed { reason: "error", error.code: "loop_detected" }` 结束 Turn，消息说明重复的工具和次数。沿用现有的 `error` 结束原因，不新增 `TurnEndReason` 取值，旧客户端照常显示。
- **范围**：只看同一 Turn 内的连续调用；跨 Turn、不连续的重复不算。轮询类工具（例如等待某个状态的命令）结果变化时签名就不同，不会误判。子会话同样适用：子代理在自己的 Turn 里触发 `loop_detected` 时，按现有规则作为 `task` 的错误结果返回给父会话。
- **配置**：`turn.loopGuard`，默认 `{ warnAt: 3, stopAt: 6 }`，`false` 关闭。按通用分层合并（config.md）。
- **客户端**：`loop_detected` 在 TUI、CLI、桌面端和手机端都按普通错误显示，文案说明「检测到重复调用，已停止这一轮」。不需要新的界面元素。

### 2. 修剪不足时升级为摘要

- 修剪执行后，如果估算仍然超过修剪阈值 `P`（压完还在修剪线以上），同一 Turn 里接着执行摘要，不必等下一次超过 `S`。
- 这修订 §6.5 的执行顺序，「每个 Turn 每种压缩至多执行一次」不变：这一次摘要算作本 Turn 的那一次。
  - 2026-10-25 修订（[ADR-0065](ADR-0065-compaction-per-request.md) §3）：压缩配额改为按「两次模型请求之间」计，此处判定随之改为看「本次模型请求之前是否刚执行过修剪」，即同一个配额窗口里修剪之后紧接着摘要。
- 摘要失败的处理沿用 §6.6，不额外重试。

### 兼容

- 两项都不新增事件类型或字段；`turn.loopGuard` 是新的可选配置，旧版本读到时按 config.md 的规则处理（它不在 `settings.json` 白名单内，只会出现在手写的 `config.json` 里）。
- 旧日志在新版本下按新规则重建上下文：循环说明只依赖历史，可以确定性地重建。

## 不在本 ADR 内

同一份日志分析里的另外几项，各自修订对应 ADR 或直接改实现，另行安排：

- 外部子代理默认不允许模型自行发起（修订 ADR-0049）；
- `ask_user` 增加超时或非阻塞模式（修订 ADR-0032）；
- 事件日志瘦身（影响回放兼容，需要单独的 ADR）；
- 压缩阈值：维持 `90%` 默认，用户按需配置绝对值。

## 验收

- 单元测试：
  - 签名：相同入参、键顺序不同视为相同；结果不同视为不同；中间穿插其他工具调用会重置计数；同一步并行的相同调用各算一次；
  - 第 3 次附上说明、第 6 次以 `loop_detected` 结束；`turn.loopGuard: false` 时不生效；
  - 说明一旦触发，后续每次构建上下文都在同一位置带上，前缀保持不变；
  - 子代理触发 `loop_detected` 时父会话拿到错误结果；
  - 修剪后仍超过 `P` 时同一 Turn 内接着摘要；修剪后低于 `P` 时不摘要。
- 回放：旧日志在新版本下按新规则重建上下文，不报错。
- 用 `f0136a6d` 的事件序列做一条回归测试，确认会在第 6 次重复时结束。

## 后果

- 循环最多浪费 5 步就会被拦下，第 3 步起模型就能看到提示。
- 已知局限：只拦「同一调用原样连续重复」。A、B、A、B 这样交替的循环，以及每次结果都略有不同的循环（例如每次截图都不一样的界面操作）拦不住，留给以后按需扩展。
- 修剪后仍然很大的情况会多做一次摘要，代价是一次摘要请求（日志里每次约 US$0.02–0.08）和压缩后丢信息的风险；后者由 v0.14.0 的「摘要保住任务状态」缓解。

## 备选方案

- **按价格档位自动设压缩阈值**：起草时考虑过，放弃。订阅制服务商不按档位计费，节省主要停留在估算上；规则要绑定价格数据，还要为 32k 一类的低档位加下限，复杂度和收益不相称。需要更短上下文的用户直接配置绝对阈值即可。
- **循环检测只看工具名和入参，不看结果**：会误伤轮询类调用（等待构建完成、反复查进程状态），这些调用入参相同但结果在变化。
- **检测到循环就立刻结束 Turn**：一次误判的代价是整轮白跑；先提示、再停止，给模型自己纠正的机会。

## 实现记录（2026-10-25）

- **代码位置**：`packages/core/src/protocol/loop-guard.ts` 是唯一的实现——签名（`canonicalLoopInput` / `loopGuardSignature` / `hashLoopResult`，cyrb53）、计数（`advanceLoopGuard`）、说明文案（`loopGuardNoteText`）与从持久事件重建（`loopGuardWarnings` / `loopGuardNotes`）。纯函数、无 Node 依赖，`protocol` 模块的依赖规则不变。Agent Loop（`agent/turn.ts`）与 Context Builder（`context/build.ts`）都用它，两边算出的签名与计数因此必然一致。
- **签名口径**：入参取 `message.assistant.toolCalls` 里的 `input`（键排序、丢 `undefined`、数组保序），参数解析失败时退回 `rawInput`；结果正文取 `tool.completed.modelContent`，即执行器交给模型的那份（已含截断说明、落盘提示等）。`cancelled`/`interrupted` 的结算不算工具返回的结果，两边都跳过。
- **判定点**：Agent Loop 第 4 步每次 `tool.completed` 写入之后（`execution` 返回后）。达到 `stopAt` 立即 `finish("error", { code: "loop_detected" })`，不再发下一次请求；未执行的调用由 `finish` 按既有规则结算为 `cancelled`。不按工具名分支。
- **说明落点**：Builder 在投影时按 `tool.completed` 的 seq 把说明追加到该条 `tool` 消息的 `content` 末尾（前导空行 + 英文段落），L1 修剪成占位后同样保留。因为是从持久事件重建的，同一份历史每次构建逐字节相同，下一次请求是上一次的严格前缀。
- **配置**：`turn.loopGuard` 的 schema 为 `false | { warnAt ≥ 2, stopAt > warnAt }`，缺省 `{ warnAt: 3, stopAt: 6 }`，分层整值覆盖（`false` 也是整值）。`RuntimeOptions.turn` 与 `config.json` 两处同源装配。
- **子代理**：`turnConfig` 原样传给子 Turn，子 Turn 触发时按既有规则映射为 `subagent_turn_failed`，父模型拿到普通错误结果与已有产出清单。
- **客户端**：没有改动。`loop_detected` 走既有的 `turn.completed { reason: "error" }` 渲染路径（TUI / CLI / 桌面端 / 手机网页共用），显示 `error.message`。
- **修剪升级摘要**：判定放在 Builder 的压缩计划里——`compactionState.pruneAttempted` 为真且重建后估算仍 `> P` 时给出 `summary` 计划；`S = B` 时预防性压缩整体停用，不升级。Agent Loop 只按计划执行，「每 Turn 每种压缩至多一次」与 §6.6 的失败处理不变。
- **验收对照**：`packages/core/src/protocol/loop-guard.test.ts`（签名、键序、结果变化、穿插、并行、跨 Turn、取消、阈值、确定性、f0136a6d 形状）、`packages/core/src/context/context.test.ts`（说明位置、前缀不变、修剪占位保留、关闭开关、修剪升级摘要三例）、`packages/core/test/runtime.test.ts`（第 6 次停止、`false` 关闭、入参变化不累计、自定义阈值、恢复后重建、修剪升级摘要）、`packages/core/test/subagent.test.ts`（子会话 `loop_detected` → 父会话错误结果）、`packages/core/test/config.test.ts`（schema 与整值覆盖）。
