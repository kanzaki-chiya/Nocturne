# ADR-0066：大窗口模型的修剪绝对上限

- 状态：已接受（维护者 2026-10-25 确认：默认 200k；现在常用模型基本是 500k、1M 窗口）
- 日期：2026-10-25
- 修订：[context.md](../architecture/context.md) §6.5 修剪阈值 `P`；与 [ADR-0063](ADR-0063-loop-guard.md) §2、[ADR-0065](ADR-0065-compaction-per-request.md) 的衔接见第 3 节

## 背景

修剪阈值 `P = min(0.8·B, S)` 只按窗口比例计。窗口越大，修剪越晚：

- 1.03M 窗口（DeepSeek V4.1 Flash、Grok 4.7 @ 500k 一类），`P` 约 82 万 token，实际上永远不触发。
- 2026-10-25 一个编码会话的 `/context`：233,201 / 1,031,552，其中「工具调用与结果」167,567，占整个上下文的 72%；系统提示、工具定义、技能目录等合计不到 4.6 万。Magpie 网关对最近 6 个会话的统计是典型提示词 204K、最大 305K。
- 这些旧的读文件、命令输出大多已经用不上，但每一步都原样发给模型。缓存命中高（98%），所以费用可控；问题在质量：上下文越长，模型越容易丢掉早期状态。长任务里清单很少更新、摘要前的进展被忽略，都和这一点有关。
- 修剪本来就是为这种情况设计的：只把保留区 `K`（最多 40k）之前的工具结果换成占位，保留工具名和参数摘要，用户消息、助手回答和最近的原文都不动。它在小窗口模型上一直在工作，只是在大窗口上被比例阈值关掉了。

## 决定

### 1. 修剪阈值加绝对上限

- 新增修剪上限 `L`，默认 200,000 token。修剪阈值改为 `P = min(0.8·B, S, L)`。
- 只影响 `0.8·B > 200k`（可用预算约 250k 以上）的模型；窗口在这以下的模型行为不变。现在常用的模型基本是 500k 或 1M 窗口，所以对大多数会话来说，`L` 实际上就是修剪阈值，比例阈值只在小窗口模型上起作用。
- 选 200k 而不是按窗口比例：500k 和 1M 窗口按 `0.8·B` 分别是 40 万和 80 万，都远超长任务里实际需要的工作集；Magpie 统计的典型提示词约 204K，其中七成是旧工具结果。固定值让不同窗口的模型在长任务里行为一致，换模型不会突然改变修剪节奏。
- 修剪的推进条件不变：回收量 ≥ `R = min(20k, 0.1·B)`、截止点必须后移、保留区 `K` 不变。
- 摘要阈值 `S` 不变。绝对上限只引入修剪，不会让大窗口模型提前摘要。

### 2. 配置

- `compaction.pruneLimit`：正整数 token 数，默认 `200000`；`0` 表示不设绝对上限（回到只按比例）。和 `compaction.threshold` 同一套分层与校验（[config.md](../architecture/config.md) §2），设置页「压缩阈值」编辑框里加一项。
- 设得比 `0.8·B` 还大时等于没设，不报错。

### 3. 与修剪升级摘要的衔接

ADR-0063 §2：修剪后估算仍在 `P` 以上，就在同一窗口接着摘要。如果这里的 `P` 用带绝对上限的值，大窗口模型在对话内容（非工具结果）超过 200k 时就会被逼着摘要，等于把摘要阈值也降到了 200k。所以：

- 升级摘要的判定继续用比例阈值 `P_rel = min(0.8·B, S)`，不用 `L`。
- 只因为超过 `L` 而修剪、修剪后仍高于 `L` 的，不升级，等下一次满足修剪推进条件（新增内容让回收量再次 ≥ `R`）时再修剪。

### 4. 缓存

每次修剪会改动前缀，下一次请求按全价计入修剪后的上下文。修剪后的上下文通常降到几万 token，之后要再增长约 `R` 以上、并重新越过 `L` 才会再修剪；按日志里 +738 / 步的典型增长，大约几十到上百步一次。和一直背着十几二十万 token 的旧输出相比，这个代价可以接受。

### 5. 不变的部分

- 不新增事件或字段，修剪事件形状不变；旧日志重放不受影响。
- `/context` 照常显示；状态栏的上下文百分比按窗口计，不变。

## 验收

- 单元测试（Builder）：
  - 大窗口（`B` = 1M）、历史 210k、可回收 ≥ `R`：给出 `prune`；历史 190k：不给；
  - 小窗口（`B` = 200k）：行为与现在完全相同；
  - `pruneLimit = 0`：大窗口行为与现在完全相同；
  - 修剪后仍高于 `L` 但低于 `P_rel`：不升级摘要；高于 `P_rel`：照 ADR-0063 §2 升级；
  - 回收量不足 `R` 时不修剪（防止每步都修剪、每步都破坏缓存）。
- 配置：分层合并、非法值拒绝、设置页编辑（vitest）。

## 后果

- 大窗口模型在长任务里，旧工具结果会被定期换成占位；模型需要时要重新读文件或重跑命令。这和小窗口模型现在的行为一致。
- 每次修剪多一次全价请求。
- 1M 窗口的长上下文能力仍可用于单次大输入（例如一次读很大的文件）；绝对上限只清理历史里的旧工具结果。

## 备选方案

- **按比例降低修剪阈值**（例如大窗口用 20%）：仍和窗口挂钩，2M 窗口又会变成 40 万；绝对值更直接。
- **到 `L` 时直接摘要**：摘要损失远大于修剪（用户消息、助手推理都会被压缩），而且每次都要一次摘要请求；修剪足以处理工具结果占大头的情况。
- **不改，靠缓存**：缓存只解决钱，不解决长上下文下的注意力问题。

## 实现记录（2026-10-25）

- **修剪阈值与升级摘要**：`packages/core/src/protocol/compaction.ts` 新增 `DEFAULT_PRUNE_LIMIT = 200_000` 与 `parseCompactionPruneLimit`（接受 `0` 与正整数安全整数）。`packages/core/src/context/build.ts` 中计算比例修剪阈值 `pruneRelativeLine = min(0.8·B, S)` 与实际修剪阈值 `pruneLine = pruneLimit === 0 ? pruneRelativeLine : min(pruneRelativeLine, pruneLimit)`；升级摘要判定 `pruneInsufficient` 保持使用 `estimated > pruneRelativeLine`，只因超过 `L` 而修剪、修剪后仍高于 `L` 但低于或等于 `P_rel` 的不升级为摘要。
- **配置分层与设置页**：`ConfigFile.compaction.pruneLimit`、`ResolvedConfig.compactionPruneLimit`、`SettingItem`（`"compaction.pruneLimit"`）与 `SettingsPatch`（`"compaction.pruneLimit": number | null`）沿用 `compaction.threshold` 的分层合并与设置层逐字段独立降级；`packages/core/src/index.ts` 在主会话 `submit`、子代理 `subagent` 与 `describeContext`（含缓存键）中统一传入 `compactionPruneLimit`。桌面端 `apps/desktop/src/SettingsPage.tsx` 的「压缩阈值」对话框新增「修剪上限」输入框。
- **测试**：`packages/core/src/protocol/compaction.test.ts`、`packages/core/src/context/context.test.ts`、`packages/core/test/settings.test.ts` 与 `apps/desktop/test/settings.test.tsx` 覆盖全部验收项。

## 修订（2026-11-01）

### 背景：小额回收不足以抵偿缓存失效

§4 关于「修剪后降到几万 token、几十到上百步才再修剪」的假设被真实编码会话 `202610311549-4e916d5d` 推翻。模型为 `magpie / antigravity/gemini-4-argon`，使用 OpenAI 兼容协议，可用预算约 1.03M。分析时的 184 次请求发生了 17 次 L1 修剪，输入 34,572,292 token、缓存读 29,223,756（84.5%）；相邻未修剪步骤通常命中 96%–99%，修剪后首步仅命中系统提示与工具声明的 14,559 token（6%–17%），部分第二步也未命中。534.9 万未命中 token 中约 65% 集中在这些修剪后的头两步。

旧 L1 只替换工具结果，保留完整调用参数；大规模替换中 `edit` 参数累计约 37 万字符，`write` 约 7 万字符。后半段可见 203k → 161k、198k → 169k 的小额回收，末尾修剪后仍有 258k。§3 又允许在仍高于 L 时每新增可回收的 20k 内容就再剪，导致 seq 962–1084 附近几乎每一两步打断一次前缀缓存。

修剪的收益是后续每一步少发送的 token，而它们原本大多按缓存价计费；代价却是一次、甚至两次完整输入按非缓存价计费。回收太少、频率太高时，代价会超过收益。

### 决定与边界

1. 仅由绝对上限 L 触发的修剪提高回收门槛至 `max(R, L/2)`（默认 100k），使一次前缀失效换来足够回收量；比例阈值与强制路径仍保持原有门槛，`pruneLimit = 0` 的触发与门槛行为不变，不新增配置。精确判定统一以 [context.md §6.5](../architecture/context.md#65-触发) 为准，取代本文原 §1、§3、§4 中相应假设。
2. 修剪范围内工具结果对应的调用参数一并做确定性截短，仅改变投影。保留 JSON 结构能让模型继续识别路径和参数用途，同时释放旧替换文本、文件正文占据的空间；通用递归规则与估算口径统一放在 context.md §6.5，不按工具名分支、不改事件或协议。

签名采用保守例外：同源 assistant 的内容块或调用只要含 `providerData`，整组调用参数保持原样。这比只检查单个调用更保守，因为 Gemini 并行调用可以仅在第一项携带签名，而 Anthropic 的签名在 reasoning 块。跨协议/服务商已剥离专有数据时仍可截短。

依据：本地 `@ai-sdk/google` 4.0.77 的 `src/convert-to-google-messages.ts` 将 `part.input` 与 `thoughtSignature` 原样组合发送（463–515 行）；`@ai-sdk/anthropic` 4.0.58 的 `src/convert-to-anthropic-prompt.ts` 将 reasoning 的签名和工具 input 直接回传（727–781 行及其后的 tool-call 分支），均不会重新签名。[Google 官方 thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures) 要求签名回到原 Part，当前 turn 的函数调用会严格校验；[Anthropic 官方工具思考工作流](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows) 要求 assistant 内容原样回传，[官方 cookbook](https://platform.claude.com/cookbook/extended-thinking-extended-thinking-with-tool-use) 也警告修改先前内容可能拒绝请求。这些依据不足以证明改写签名关联参数安全，因此不做此改写。

真实服务冒烟中，原生 Gemini `gemini-4-argon` 生成带签名且超过 200 字符的参数，L1 投影保留参数后续请求被接受；`gemini-4-argon-contributor` 别名返回 400 Model is unavailable，Anthropic 环境凭据返回 401，后者未完成真实签名往返验证。保守例外也适用于非签名的不透明 `providerData`，可能减少部分模型的可回收量，这是避免 Context 解释 Provider 数据的取舍。

### 验收

- Builder 单测覆盖：B=1M 时仅超过 L、回收 80k 不剪/120k 剪；达到 P_rel 的等号仍按 L 门槛，超过 P_rel 回收 25k 仍剪；强制路径、小窗口 B=200k、关闭 L、自定义 L 与基础 R 的关系。
- 参数投影覆盖范围内外、pinResult、未结算调用、嵌套对象/数组/所有键/标量、合法 JSON、两次构建逐字节一致、截止点固定时增量前缀稳定；签名位于调用/并行首项/推理/文本时均保留，跨协议剥离数据后可截短；回收量与报告均计入参数投影。
- 真实会话副本按事件顺序重放，去掉原压缩并调用新旧 Builder，所有 assistant 前求计划并插入模拟 prune。验收副本已有 186 次请求（输入 35,166,410、缓存读 29,517,746），比分析时多两次；旧规则重现全部 17 次修剪及截止点，新规则降至 6 次。
- 回放使用 B=1,031,552、固定系统与工具底座 14,559 token；系统原文/工具快照不在日志中，用等 token 合成前缀。原请求 usage 加反事实历史投影差额校正锚点，避免新规则继续沿用旧请求的体积；未修剪时缓存按上步输入、修剪时按固定底座估算，首请求缓存为 0。估算命中率旧 89.255%、新 95.043%，输入总量旧 35,166,410、新 32,887,718。简化算法不模拟修剪后第二步失配、服务端分词与缓存块粒度，不代表真实计费预测；修剪后本地估算也可能低于下一次上游锚点。
- 一次性回放脚本、会话副本及两组原始输出保留于仓库外 `nocturne-mockups/impl/r1031k/`，不进入提交；测试位于 `packages/core/src/context/context.test.ts`。

- 2026-11-01：修剪占位追加固定补救说明，要求需要原文时重新运行或重新读取、不要凭记忆复述或补写；原因是会话 `202610312118-a50132c6` 在 seq 353 修剪检查输出后，模型于 seq 383 凭占位补写了不符仓库的命令输出，见 [context.md §6.5](../architecture/context.md#65-触发)。

