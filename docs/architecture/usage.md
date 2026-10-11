# 用量与费用统计

依据 [ADR-0053](../decisions/ADR-0053-usage-and-cost.md)。`Runtime.usageStats({ days? })` 只读扫描会话目录全部 `.jsonl`（含子会话），不恢复会话、不取锁、不写文件。days 为包含今天的本地自然日数量，缺省全部；逐日序列始终包含全部日期，客户端负责一年窗口与范围外淡化。

## 事件口径

| 带 usage 的持久事件 | 处理 |
|---|---|
| message.assistant | 按事件模型计入每次请求 |
| session.titled | 按 provider/model 字符串计入标题请求 |
| attachment.described | 同上，计入图片描述请求 |
| permission.reviewed | 有模型与用量且 cached=false 时计入，缓存结果不重复收费 |
| context.compacted | 有模型与用量时计入摘要请求；旧日志与 prune 不贡献用量 |
| turn.completed | 不计入用量，避免重复；只计算对应 started 到 completed 的时长 |

回退只截断派生历史，不撤销实际消耗；扫描原始日志，回退前的事件仍计入。Turn 数按 started 统计，按开始事件的本地日期归类；各模型 Turn 数按该 Turn 开始时的模型归类。会话数为范围内有请求、Turn 或工具/技能使用的日志数，加上范围内创建的分叉会话（即使尚无新 Turn）。最长 Turn 仅取有完成事件的 Turn，使用日志标题或首条用户消息首行。

分叉日志首行有 `forkedFrom` 时，只统计信封 `sessionId` 等于本日志自身 id 的事件；复制的历史不计入用量、Turn、最长 Turn、工具、技能或逐日序列，分叉的分叉同样适用。复制的模型配置仅用于确定分叉新 Turn 的模型。来源会话删除后，复制部分不再计入，与已删除会话不计的口径一致；没有 `forkedFrom` 的日志不增加 sessionId 过滤。

工具次数按 tool.started.name；技能次数为 message.user.skill.name，加上 skill 工具 started.input.name，工具识别使用工具模块导出的常量，仅发生在只读统计模块。

## 请求数、逐日按模型与首末时间

请求数为范围内带 usage 的持久事件条数，即上表中计入用量的每一条各算一次（message.assistant 每步一次；标题、图片描述、未命中缓存的权限审查、摘要各一次）；没有 usage 的消息不算请求。`ModelUsageStats.requests` 与 `DailyUsageStats.requests` 同一口径。

逐日序列对 days 范围内的日期给出 `requests` 与按模型拆分的 `models: { model, tokens, requests }[]`（按 tokens 降序）。tokens 口径与 `daily.tokens` 相同（输入 + 输出），范围起点是本地零点，所以范围内日期的各模型之和等于当天合计。范围外日期只保留原有字段，热力图不受影响。

`firstUsedAt` / `lastUsedAt` 为该模型在范围内第一条与最后一条请求的事件时间（ISO 字符串）。

## 延迟与性能序列

只用带 `timing` 的 message.assistant（[events.md](../protocols/events.md) 第 4 节 `AssistantTiming`）；旧日志没有该字段，不参与延迟统计，但照常计入用量。其他角色请求不计时。

- `latency.samples`：范围内带 timing 的消息数；`avgDurationMs` 为其 `durationMs` 平均。
- `avgTtftMs`：有 `ttftMs` 的样本的平均；整条消息没有内容事件时没有 TTFT，不计入。
- `tokensPerSecond`：按合计算，`Σ outputTokens ÷ Σ (durationMs − ttftMs)`，不对逐条速度求平均。只取带 usage 且生成时长不小于 `MIN_GENERATION_MS`（500ms）的样本，与 TUI「不足 0.5 秒不显示」一致；`outputTokens` 含推理 token。`speedSamples` 为进入该值的样本数。
- 没有样本时 `latency` 省略，字段为空的子项同样省略。

`performance` 是每个模型的性能序列，只列有带 timing 请求的桶，按时间升序；每桶给出起点 `start`（本地桶起点的 ISO 字符串）、`samples`、`tokensPerSecond`、`avgTtftMs`（口径同上）。粒度由 days 决定，结果里的 `performanceGranularity` 给出本次所用：

| days | 粒度 | 常量 |
|---|---|---|
| ≤ 7 | 本地时间的小时 | `HOURLY_BUCKET_MAX_DAYS = 7` |
| 8–31 | 本地自然日 | `DAILY_BUCKET_MAX_DAYS = 31` |
| 更长或全部 | 本地自然周，周一 0 点起 | — |

每个模型至多保留最近 `PERFORMANCE_MAX_BUCKETS = 168` 个桶。常量与 `performanceGranularity`、`generationMs` 纯函数在 `protocol/usage.ts`。

错误率不做：`provider.retry` 是临时事件，不进日志，重试过的失败请求无法从日志计数；只数以服务商错误结束的 Turn 会把多次失败算成一次，数字有误导性（ADR-0053 修订 2026-10-11）。

## 费用与缓存

结果类型与纯函数 `estimateCost` 在 `protocol/usage.ts`。单位 USD / 每百万 token：

```text
max(0, 输入 − 缓存读 − 缓存写) × 输入价
+ 缓存读 × 缓存读价 + 缓存写 × 缓存写价 + 输出 × 输出价
```

按单次输入选择 aboveInputTokens 不超过输入的最高档；档位缺字段回落基础价，缓存价缺失回落输入价。对象存在但未声明的输入/输出价按零处理；整个价格对象缺失时不计费用、列入未计价模型。价格使用统计时当前运行时注册表，来源保留 config / upstream / models.dev / vendor。注册表给不出价格时（会话所用服务商已删除或改名，或模型不在当前清单），按模型 ID 走厂商价规则（[config.md](config.md) 价格一段），来源同为 vendor。厂商价按模型厂商官方 API 价估算，不代表代理或中转服务的实际收费；桌面用量页与 `/cost` 把来源显示为「厂商价」并写明这一点。订阅服务并不按此计费，以服务商账单为准。

`cacheSavings` 为（全部输入按输入价的费用 − 实际输入侧费用）÷ 全部输入按输入价的费用：两者都按 `estimateCost` 逐请求计算，前者把同一次请求的 inputTokens 视为未缓存（档位规则相同），后者取未命中输入、缓存读取与缓存写入三项之和。缓存写入价高于输入价时可能为负。未计价模型省略。

Runtime 内存按文件路径、大小、mtimeMs 缓存逐文件用量聚合（不是费用；计时样本一并缓存），只重读变化文件；删除文件时移除缓存。损坏或读取失败的文件整份跳过并计数，含未终止尾行；缓存失败文件直到元数据变化，不修复日志。

## 已知缺口

- 空模型步骤没有 message.assistant，用量只在 turn.completed 中，接受漏计。
- 摘要失败、超时、中断不写事件；旧日志摘要没有用量，均无法补算。
- 删除的会话不在目录中；外部 agent 账号费用不进入 Nocturne 日志。
- 既没有 modelsDevPricing 也没有 modelsDevProvider 的旧条目（例如早期写入的 grok）与本机代理按厂商价估算；厂商价与实际代理收费不同，需要准确价时在 providers.json 里补 modelsDevPricing 或手写 pricing。
- models.dev 确实没有价格的模型（例如 devin/swe-2-max），以及扁平表和厂商服务商里都匹配不到唯一规范 ID 的模型（带档位后缀的变体名、末段在多个厂商下重名）仍不计价。
- 只有 message.assistant 计时；标题、图片描述、权限审查与摘要请求没有计时，不进延迟统计。
- 旧日志的 message.assistant 没有 timing，不补算；用量页对这些模型显示「—」。
- 不统计错误率（见上文）。
- 当前会话视图仍累计 turn.completed.usage，不含角色请求，与跨会话统计口径不同。
- 并发写日志时观察到不完整尾行会暂时跳过该文件，下一次刷新元数据变化后重读。
