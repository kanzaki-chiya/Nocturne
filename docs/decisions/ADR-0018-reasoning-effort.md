# ADR-0018：思考强度——统一中性档位、按声明决定可用档位、适配器归一化

- 状态：提议
- 日期：2026-09-25

## 背景

`ModelRequest.reasoningEffort` 从 v0.1 起是保留字段：Runtime 不赋值、适配器不映射，开启思考只能靠 `providerOptions` 直传服务方专有键（[providers.md](../architecture/providers.md) 第 3 节）。本阶段把它接通为正式的统一能力，要求：

- 用户能配置、切换并在会话间恢复思考档位；
- 每个模型的可用档位由**声明**决定，不按模型名猜；
- `Agent Loop` / `Context` 不出现服务商分支，档位到请求字段的换算全部在适配器内；
- 档位定义参考 oh-my-pi（omp）并收窄：不做 `auto` 档（需要按难度分类的模型路由层）、不做 Anthropic adaptive 模式。

## 决定

### 1. 中性档位集合

```text
off | minimal | low | medium | high | xhigh | max
```

七个值，本轮不做 `auto`。**`max` 是通用的最高档，不属于任何一家**：OpenAI 自 gpt-5.6 系列起（如 `gpt-5.6-sol`、`gpt-6-astra`）的档位序列是 `low/medium/high/xhigh/max`，openai 与 openrouter 请求格式都原样发送 `"max"`；只有 Anthropic 格式把 `max` 换算为 `thinking.budget_tokens`（默认 32768）。`off` 表示不发送任何思考参数，任何模型都可用，不在"可用档位"声明集合里。

**为什么档位必须按模型声明**：同一系列不同型号的最高档不同——例如 gpt-5.5 最高到 `xhigh`，gpt-5.6 系才有 `max`。档位集合因此逐模型解析（第 2 节），`max` 只是"该模型声明的最高档"，不隐含任何一家的私有语义。

### 2. 可用档位的声明链

每个模型的可用档位集合按以下优先级解析（高者覆盖低者）：

```text
providers[].models.<id>.capabilities.reasoningEffort   逐模型声明（手写 config.json 最高层）
  > providers[].thinking.levels                        服务商级用户声明（向导勾选写入，source:"user"）
  > capabilities.reasoning ≠ "none"                    上游声明了思考能力 → 标准六档全档位
  > 无                                                  不可切换
```

- 声明只允许 `minimal…max` 六档；非法值在校验/归一时丢弃，集合按全局档位顺序整理去重。
- `thinking.levels` 标注 `source: "user"`，表示用户声明；`/provider refresh` 只更新 `models` 的上游声明字段，不覆盖 `thinking`（见 [provider-setup.md](../architecture/provider-setup.md)）。
- 三家上游的模型列表都只声明"是否支持思考"（如 OpenRouter `supported_parameters` 含 `reasoning`），没有逐档位字段；上游标记因此映射为完整六档。映射偏宽的后果由第 7 条的 400 定向提示 + `/provider thinking` 收窄路径兜住。
- 解析结果落在 `ModelInfo.capabilities.reasoningEffort`：适配器构造模型清单时完成折叠，注册表对清单外模型（`allowUndeclaredModels`）用同一规则再折叠服务商级默认。**无可用档位**的模型：Shift+Tab 不响应、状态栏不显示档位段、`/effort` 提示未声明。

### 3. 适配器归一化与请求形态

中性档位只在适配器内翻译，`Agent Loop` / `Context` / `session` 不见 `reasoning_effort`/`thinking` 等字段名。

- **thinking-format**（服务商条目 `thinking.format`，预设自动填写，用户不需要选）：
  - `openai`（Chat Completions）：请求体 `reasoning_effort: "<level>"`，档位原样发送（含 `"max"`）；
  - `openrouter`：请求体 `reasoning: { "effort": "<level>" }`，档位原样发送（含 `"max"`）。OpenRouter 预设填 `openrouter`，其余 openai-compatible 一律 `openai`。
- **reasoning-disable-mode**：第一版只实现 `omit`——`off` 与"无可用档位"时请求体**不含**任何思考字段（不发 `reasoning_effort`、`reasoning`、`thinking`）。
- **anthropic**：档位 → `thinking: { "type": "enabled", "budget_tokens": <预算> }`。默认预算表（与 omp 相同，`thinking.budgets` 可逐档覆盖）：

  | 档位 | minimal | low | medium | high | xhigh | max |
  |---|---|---|---|---|---|---|
  | budget_tokens | 1024 | 4096 | 8192 | 16384 | 32768 | 32768 |

  `off` 时同样不发 `thinking`（omit，不发 `type:"disabled"`）。
- **max_tokens 调整**（anthropic，协议要求 `max_tokens > budget_tokens`）：发请求前 `wireMax = request.maxOutputTokens ?? 8192`（ADR-0016 兜底值）；要求 `wireMax ≥ 预算 + 1024`（响应余量）。不足时先把 `wireMax` 抬到 `预算 + 1024`、封顶模型声明的最大输出长度（未声明则无封顶）；封顶后仍不足就把预算压到 `wireMax − 1024`，压到低于 1024（Anthropic 下限）时本轮不发送思考参数并记诊断 `provider.unsupported_capability`。
- **强制 tool_choice 冲突**：思考开启 + 强制 `tool_choice` 的部分服务会 400——沿用既有适配器行为（丢弃 `tool_choice` 并在 `provider.request` 诊断标注）；另外 `TurnDeps.toolChoice` 存在的那一轮（子代理 `finish` 兜底轮）Runtime 不携带 `reasoningEffort`，整轮关闭思考（subagent.md 第 2 节语义不变）。
- `providerOptions` 中的原生推理键仍可直传；与归一化字段同义时（openai 的 `reasoningEffort`、openrouter 的 `reasoning`、anthropic 的 `thinking`）归一化字段胜出。

### 4. 会话持久化与切换语义

- 档位是会话配置：`session.created.reasoningEffort` 与 `session.config_changed.reasoningEffort`（均为可选 `ReasoningEffort`）持久化，折叠入 `SessionConfig` 与 `SessionView.config`；旧日志无此字段按 `off` 处理。客户端命令 `setReasoningEffort(level)`。
- **允许 Turn 进行中切换**：`session.config_changed` 是会话级事件（无 `turnId`，不影响重放等价不变量），请求组装在每步执行时重新读取 `session.state().config`——切换对"下一次模型请求"生效，满足用户期望的即时性，语义与 omp 一致。
- **配置默认值**：`config.json` 顶层 `reasoningEffort` 给出新会话的默认档（经 ResolvedConfig 合并，命令行参数不设此开关）。
- **就近降档**：`SessionConfig.reasoningEffort` 记录的是**用户意图**，不在 `setModel` 时改写；每次请求组装时对当前模型的可用集合做就近降档——取不超过当前档位的最高可用档，一档都不超过时取最低可用档，集合为空视为 `off`（不发送）。`setModel` 后发现有效档被压低/落空时发 `runtime.warning(code="reasoning_effort_clamped")` 提示；切回原模型即恢复原意图。只有 `setReasoningEffort` 直接给出当前模型不支持的档位才返回 `invalid_command`。

### 5. 子代理继承

子会话 `session.created` 写父会话当前档位**按子模型可用集合就近降档后的值**（子会话记录自己的声明，不运行时跟随父会话变化）；`finish` 兜底轮不携带思考参数（第 3 节）。

### 6. 客户端

- **TUI**：输入框状态下 `Shift+Tab`（`\x1B[Z`，Ink 解析为 `key.tab + key.shift`）在 `[off, …可用档位]` 循环，包括 Turn 进行中（下个请求生效）；权限确认框内 `Shift+Tab` 保持"反向移动焦点"不切换档位；弹层/选择页/向导激活时不拦截。状态栏新增档位段 `思考:<档>`，仅当当前模型有可用档位时显示。
- **CLI**：`/effort` 列出当前与可用档位；`/effort <档>` 切换（非法值列出可选档位）。
- **向导**：上游模型列表未声明思考能力时询问"该服务支持思考强度吗？[y/N]"；`y` 后多选档位（TUI 空格勾选回车确认；CLI 逗号分隔编号，非法输入重问），写 `thinking.levels` + `source:"user"`。`/provider thinking <name>` 对已配置服务商重走这一步（CLI 与 TUI 一致）。

### 7. 400 定向提示

`invalid_request` 且当前有效档位非 `off`、错误文本命中 `reasoning|thinking|effort|budget` 字样时，提示改为"该模型可能不支持档位 \<档\>：\<原始信息\>（可用 `/provider thinking <名>` 或配置文件调整，或用 `/effort` 切换档位）"。这覆盖了"能力字段 400 无针对性提示"已知限制中思考参数的部分（roadmap）。

### 8. 本阶段不做

- **`auto` 档**：按难度自动选档需要模型驱动的分类器与路由层（omp 的实现是一个独立的 auto-thinking 子系统），超出本轮范围；
- **Anthropic adaptive 模式**：`thinking.type:"adaptive"` 与 effort 参数是协议的新形态，`budget_tokens` 已完整表达六档语义；adaptive 下档位不可精确表达，将来如接入按新字段扩展适配器即可；
- **逐档位上游探测**：不发探测请求判断各档可用性（第 2 条已说明上游无此字段）；
- **思考档位的其他禁用形态**：`reasoning-disable-mode` 只实现 `omit`（`"none"`/其他服务方私有写法按需再加）。

## 后果

- `ModelRequest.reasoningEffort` 从保留字段变为 Runtime 真实赋值、适配器真实映射的正式字段；`ModelCapabilities.reasoningEffort` 成为"已解析的可用档位集合"（含服务商级默认与能力标记推导）。
- 同一台服务上档位声明不准时，用户有 `/provider thinking` / 手写 `capabilities.reasoningEffort` 两层修正路径，错误路径有 400 定向提示指引。
- 会话日志新增字段均为可选，旧日志按 `off` 兼容恢复（events.md 第 8 节兼容口径）。
- `setReasoningEffort` 是第一个"允许 Turn 进行中"的会话配置命令：它只影响下一次模型请求，不改动已写出的历史事件；`setModel`/`setPermissionPreset` 保持空闲限定不变（它们改变模型解析与权限上下文，影响面不同）。

## 备选方案

| 方案 | 结论 | 理由 |
|---|---|---|
| 沿用 `providerOptions` 传原生键 | 否决 | 现状即问题：键名/语义因服务而异，无法持久化为统一会话配置，客户端也无从知道可用档位 |
| 用 AI SDK 的推理调用选项做映射 | 否决 | SDK 的档位集合与 ours 不一致（无 `max`），且其 anthropic 映射附带 adaptive/模型名嗅探逻辑，与"按声明、不写服务商分支"的边界冲突；归一化在适配器内一处实现反而更直白 |
| `auto` 档 + 难度分类 | 否决（本轮） | 需要模型路由层与额外请求，先收窄 |
| 在 `setModel` 时把降档写回持久档位 | 否决 | 会永久丢失用户意图（max → xhigh 后切回来也是 xhigh）；意图与有效档分离后切回原模型自动恢复 |
| `setReasoningEffort` 只允许空闲时调用 | 否决 | config_changed 无 turnId、对重放不变量无影响，限制没有收益；用户期望 Shift+Tab 随时可循环 |
| Anthropic 用 adaptive/effort 参数 | 否决（本轮） | 见第 8 条；`budget_tokens` 已覆盖全部档位语义且行为可预测 |
