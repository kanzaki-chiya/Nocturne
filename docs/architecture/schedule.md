# 定时任务

> 状态：已接受 v0.1 ｜ 前置阅读：[ADR-0064](../decisions/ADR-0064-scheduled-tasks.md) ｜ 接口：[rpc.md](../protocols/rpc.md) 第 3.10 节

定时任务只在桌面端打开时运行。到点时新开一个无人值守的会话，把任务指令作为第一条用户消息提交。关机或关窗期间错过的，只补最近一次。

实现在 `packages/core/src/schedule/`。它不依赖 agent、tools 或任何 UI；开会话并提交由 `createRuntime` 注入。`tools` 经 `ToolContext.schedule` 读写，不 import 这个模块。

## 1. 存什么

程序维护的文件，和 `mcp.json` 一样：逐条校验、临时文件加 rename、同进程写入串行。不进配置分层，项目配置不能覆盖。

- `<NOCTURNE_HOME>/schedules.json`：`{ version: 1, tasks: [...] }`。单条无效只忽略并记 `schedule_config` 警告；整份损坏时，下一次写入前先留 `schedules.json.corrupt-<时间>` 副本。最多 100 个任务。
- `<NOCTURNE_HOME>/schedules/history/<taskId>.jsonl`：每个任务一份。同一次触发可以写多行（开始、拿到会话、结束），读取时按 `id` 合并，后写的字段覆盖先写的。保留最近 200 条，超过 400 行压实。任务删除后不再写它的历史，已产生的会话留下。
- `<NOCTURNE_HOME>/schedules/scheduler.lock`：复用会话锁。拿不到锁就不启动调度循环，并发出 `schedule_locked`；增删改照常。进程崩溃后陈旧锁按 pid 接管。

任务字段：`id`、`name`、`prompt`、`workspace`（`null` 为普通对话）、可选的 `model`（`provider/model`）、`reasoningEffort`、`permissionPreset`、`schedule`、`enabled`、`maxDurationMinutes`（缺省 60，上限 1440）。文件里另有两个不出现在对外类型中的记账时刻：`createdAt`，以及 `anchorAt`（创建、改计划、从暂停恢复时重置；此前的计划时间不算错过）。

## 2. 计划

七种，本地时区，最小间隔 30 分钟：

| 类型 | 字段 | 含义 |
|---|---|---|
| `interval` | `minutes`（≥ 30） | 从 `anchorAt` 起每隔这么多分钟 |
| `hourly` | `minute`（0–59） | 每小时的这一分钟 |
| `daily` | `time`（`HH:mm`） | 每天这个时刻 |
| `weekdays` | `time` | 周一到周五 |
| `weekly` | `day`、`time` | 每周这一天；`day` 为 `mon`…`sun` |
| `manual` | — | 不自动触发，只在「立即运行」时跑 |
| `cron` | `expr` | 五段 cron，见下 |

时区只用 `Intl.DateTimeFormat` 换算，不读进程的 `TZ`。夏令时跟 JS `Date`：不存在的本地时间落在空档之后，重复的本地时间取第一次。

cron 自己实现，不引入依赖。支持 `*`、数字、范围、步长、列表、月和星期的英文缩写；星期 `0` 和 `7` 都是周日；日和星期都限定时取「或」。不支持 `@daily`、`?`、`L`、`W`、`#` 和秒字段。最小间隔按未来 800 天内任意相邻两次触发校验。

## 3. 调度循环

只有 `nctrn rpc --stdio --scheduler` 启用循环。桌面端拉起后台时带这个参数；TUI、`nctrn -p` 和普通 `rpc` 不带，避免两个进程重复触发。

每分钟检查一次「(游标, 此刻]」里到期的计划时间。启动和睡眠恢复后的第一次检查就是补跑检查，不另测墙钟跳变。只补最近一次，更早的记 `skipped` / `missed`（单次最多 20 条），回看 7 天，更早的丢掉。晚于计划 2 分钟以上记 `trigger: catchup`。

上一次还没结束记 `previous_running`。同时运行满 2 个记 `concurrency`。手动运行受同样的并发限制，但不改下一次计划时间。`maxDurationMinutes` 到点中止这一轮，历史记 `aborted`。上个进程留下的「运行中」行，启动时收成 `aborted`。

一次运行：

1. `createSession({ interactive: false, schedule: { taskId, scheduledAt, trigger } })`。模型、档位、预设、工作区取任务上的值；缺省用当时的默认。普通对话用后台启动时的工作目录。
2. 写 `session.titled`（「任务名 · 月-日 时:分」，补跑用实际运行时刻），侧栏有标题，不再调模型起标题。
3. 提交指令。补跑时正文前加一行「原计划 10-24 周五 09:00，当时 Nocturne 没开，现在补跑。」
4. 等这一轮结束。按 `turn.completed` 映射 `done` / `aborted` / `error`。`permission.resolved` 里 `source: "non_interactive"` 的条数写入历史的 `denied`（「有非交互拒绝」从这里数，客户端不扫日志）。然后关闭会话。

保存时未知模型报 `invalid_model`，非法字段报 `invalid_field`（`data.field` 指出哪一项）。

变化经 RPC 通知 `schedule.changed` 广播（含远程），并顺带触发一次 `runtime.sessionsChanged`。不新增 `RuntimeEvent`。

## 4. 无人值守与恢复交互

定时会话创建时 `interactive: false`。权限 gate 和提问通道读的是可变值，不重建会话。

判定只看日志里的 `message.user` 条数（回退不删事件）：少于 2 条时按非交互——调度器提交的就是第 1 条。出现第 2 条（人在客户端接着说）之后转为交互，并且不再变回去。关闭再打开也按这个条数。没有 `meta.schedule`、只是 Runtime 本身非交互的会话，重新打开后按 Runtime 的缺省，不单独记住。

非交互时，审查后仍要确认的操作直接拒绝（`source: "non_interactive"`），不发 `permission.requested`；`ask_user` 以 `not_interactive` 结算。审查放行的照常执行。拒绝文案告诉模型：把没做成的部分写进最终回复。分叉会清掉 `schedule`，分叉出来的是人开的交互会话。

`schedule` 工具在定时会话和子代理里都不可见（`mutatesSchedule`）。直接改 `schedules.json` 至少要确认，见 [permissions.md](permissions.md)。

## 5. 客户端

桌面端页面、侧栏分组和手机只读范围见 [desktop.md](../apps/desktop.md) 第 5 节。手机可以 `schedule.list`、`schedule.history`、`schedule.runNow`；`save` 和 `delete` 只在本机。
