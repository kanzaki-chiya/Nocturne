# ADR-0053：用量统计与费用估算——统一统计接口、缓存价格、桌面用量页与 /cost

- 状态：已接受（维护者 2026-10-09 确定：价格增加缓存读写、用量页与 `/cost` 一起做、统计含子代理）
- 日期：2026-10-09
- 修订：[ADR-0024](ADR-0024-model-settings-editor.md) 中「`pricing` 只用于显示」——`pricing` 现在也用于费用估算，但仍不在模型设置对话框里编辑；[ADR-0038](ADR-0038-transcript-polish.md) 把 `/cost` 留到以后，本 ADR 落地

## 背景

状态栏只显示当前会话的累计缓存命中率，看不到「这段时间一共用了多少、花了多少钱、钱花在哪个模型上」。维护者长期同时使用多个服务商与模型，需要一个汇总页面，以及 TUI/CLI 里一条只读命令。

费用估算缺两样东西：

- 价格数据：`ModelInfo.pricing` 只有输入价和输出价，来源只有 OpenRouter 清单和手写配置。缓存读取占输入的大头（本机会话累计命中率常在 80% 以上），价格通常只有输入价的十分之一，按输入价算会高估数倍。models.dev 的 `api.json` 按服务商给出 `cost`（每百万 token 美元价，含 `cache_read`、`cache_write`，部分模型有按上下文长度的 `tiers`），现有快照没有收录。
- 统计入口：用量散落在各会话日志的持久事件里，没有跨会话汇总的接口。

## 决定

### 1. 价格：`pricing` 增加缓存读写与分档

```ts
pricing?: {
  input?: number;        // 每百万 token USD，下同
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** 按单次请求输入 token 数分档；取 aboveInputTokens 不超过本次输入的最高一档，缺的字段回落到基础价 */
  tiers?: { aboveInputTokens: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }[];
}
```

- 配置 schema、`ModelInfo`、`ModelOverrideShape` 同步扩展；分层合并仍把 `pricing` 作为整体值替换（config.md）。
- **来源优先级**：配置文件里手写的 `pricing` > 服务商上游清单（OpenRouter 等）> models.dev。三者都没有时视为「未声明价格」，不编造。
- **models.dev 价格**：快照与缓存（ADR-0031 §4 的同一份 `providers` 数据）为白名单服务商键增加逐模型 `cost`（只裁剪 `input`/`output`/`cache_read`/`cache_write`/`tiers`）。服务商条目用新字段 `modelsDevPricing`（models.dev 服务商键）声明按哪个服务商取价；它只用于价格，不参与 ADR-0031 的协议推断，因此给内置预设补上它不会改变任何请求行为。内置预设按官方 API 补键（deepseek → `deepseek`、grok → `xai`、anthropic → `anthropic`、chatgpt → `openai` 等，以 models.dev 实际键为准）；自定义服务商可在配置里写。模型 ID 匹配沿用现有 models.dev 匹配规则。
- 模型设置对话框仍不编辑价格（ADR-0024）；需要时在配置文件里写 `pricing`。

### 2. 统计：Core 提供只读的跨会话汇总

- `Runtime.usageStats(input: { days?: number }): Promise<UsageStats>`，`days` 缺省为全部。扫描会话目录下全部会话日志（含子会话；已删除的会话自然不在其中），只读，不打开会话、不取会话锁。
- **计量口径**：
  - 用量取自带 `usage` 的持久事件，按事件里的模型归类：`message.assistant`（每步一条）为主，标题、图片描述、权限审查、压缩等角色请求若事件带 `usage` 与模型也计入，在模型表里与主对话合并。不再叠加 `turn.completed.usage`，避免重复。
  - 已知缺口：没有内容的空步骤不写 `message.assistant`，其用量只在 `turn.completed` 里；差额很小，接受并写进文档。
  - 按事件时间的本地日期分天。
- **费用**：按统计时的当前价格表，对每个带用量的请求计算：`(输入 − 缓存读取 − 缓存写入) × 输入价 + 缓存读取 × 缓存读取价 + 缓存写入 × 缓存写入价 + 输出 × 输出价`；缺缓存读取价或缓存写入价时该部分按输入价计；有分档时按本次请求的输入 token 数选档。没有价格的模型只计 token，不计费用，结果里列出这些模型。费用是「按 API 价格的估算」，订阅制服务商并不按此计费，界面要写明。
- **结果形状**（字段名以实现为准，进 protocol 类型）：总计（输入、缓存读取、缓存写入、输出、预估费用及其按未命中输入/缓存读取/缓存写入/输出的拆分）、会话数与 Turn 数（及其中子会话的 Turn 数）、最长 Turn（时长、日期、所在会话标题）、逐日序列（日期、tokens、费用、Turn 数）、按模型（服务商、模型、Turn 数、四类 token、命中率、生效价格与来源、预估费用）、工具调用次数（按工具名）、技能使用次数（用户 `/技能` 与模型调用 skill 工具合计）、未计价模型列表。
- **性能**：按日志文件路径 + 大小 + 修改时间在 Runtime 内存里缓存逐文件的聚合结果，只重扫变化的文件；第一版不落盘。
- 只是统计归类，不改变 Agent Loop、权限或工具行为；按工具名分组只发生在这个只读统计模块里。

### 3. 客户端

- **RPC**：`runtime.usageStats`，参数与结果同上（rpc.md）。
- **桌面端**：设置侧栏新增「用量」（在「外观」与「后台日志」之间）。页面按效果图：时间范围 7 天 / 30 天 / 全部；概览五格（累计 tokens、预估费用、缓存命中率、会话/Turn、最长 Turn）；一年每日活跃热力图（可按 tokens 或费用着色，悬停看当天明细）；Token 构成与费用；常用工具与技能；按模型表（按费用或输入排序，未声明价格显示「—」并说明不计入）；底部写估算口径。效果图：https://claude.ai/artifact/LFJMkLdDCarfBDgK3ymrKa 。
- **TUI / CLI `/cost`**：只读，不发请求。上半部分是当前会话（模型、Turn 数、输入与缓存读取及命中率、输出、预估费用），下半部分是近 30 天本机全部会话按模型的 tokens 与费用和合计；末尾一行说明「按 API 价格估算」并提示完整统计在桌面端「设置 › 用量」。当前会话部分直接用会话视图里的用量，不必等统计接口。

## 后果

- 价格数据多了一个来源和三个字段；快照体积随白名单服务商的模型数增加。
- 统计结果依赖当前价格表：价格调整后历史费用会跟着变。这是估算，界面写明。
- 统计扫描全部日志，第一次打开用量页的耗时与日志总量成正比（本机 222 个会话、129MB）；内存缓存保证之后只读增量。若实测过慢，再考虑落盘缓存。

## 备选方案

- **在会话日志里记录每次请求的费用**：价格表变化不会改写历史，但要改事件格式，且估算价写进持久日志后无法纠正。否决。
- **只用 `turn.completed.usage`**：不分模型，一个 Turn 内切换模型或角色请求时归类错误。否决。
- **复用 `modelsDevProvider` 取价**：它同时驱动协议推断，给内置预设加它会改变请求协议。否决，改用只管价格的 `modelsDevPricing`。
- **在模型设置对话框里编辑价格**：价格多为上游声明，手写需求少；先放配置文件，有需要再加。

## 修订

### 2026-10-09：摘要请求补记用量

核对实现时发现，L2 摘要请求（自动压缩与手动 `/compact`）的用量没有进入任何持久事件：`runSummaryCall` 只收集文本，`context.compacted` 只有 `kind`、`throughSeq`、`summary`。第 2 节「压缩等角色请求若事件带用量也计入」因此落空，统计会漏掉全部摘要费用，也无法用 `cacheReadTokens` 检查摘要请求是否命中提示缓存。

- `context.compacted(kind="summary")` 增加可选字段 `usage?: Usage` 与 `model?: ModelRef`，由自动压缩与 `/compact` 两条路径写入本次摘要请求的用量和模型；`prune` 不调用模型，不写。兼容新增，旧日志没有这两个字段时按缺失处理。
- 摘要请求失败、超时或被中断时仍不写压缩事件（context.md §6.6 不变），这部分用量不计入，作为已知缺口写进 usage.md。
- 用量统计把带 `usage` 的 `context.compacted` 计入对应模型。
