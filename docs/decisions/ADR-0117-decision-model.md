# ADR-0117：决策模型（Gemini Decisions 与 Jev）

- 状态：已接受（2026-11-24）
- 相关：[ADR-0036](ADR-0036-smart-permissions.md)、[ADR-0057](ADR-0057-reviewer-v2.md)（审查器七道题与 Jev 后端）、[ADR-0040](ADR-0040-model-roles.md)（模型角色）、[ADR-0015](ADR-0015-provider-setup-credentials.md)（系统凭据库）
- 效果图：设置页模型角色新增「决策模型」行、决策模型弹窗（Gemini / Jev）与安全审查弹窗（「关闭 / 决策模型 / 小模型」）

## 背景

安全审查已经能用 Jev 作为审查器（ADR-0057），接入点、模型、凭据都在「常规 › 安全审查」弹窗里填。Google 在 2026-11-11 发布了 Gemini Decisions API（`gemini-decision-1`），同样是「共享输入 + 一组问题 → 每题的选项、概率与置信度」，输入每百万 token 0.10 美元，输出不计费。用户想用 Google Developer Program 每月发放的 Google Cloud 赠金来跑审查。

决策模型不生成文字，不能做主模型、子代理或摘要，也不进服务商页：服务商页的条目都要能提供对话模型。

用户已定（2026-11-24）：
- 在「设置 › 模型 › 模型角色」加一行「决策模型」，来源 Gemini 或 Jev。
- 不新增 TypeSafe 或 Gemini 服务商；密钥在决策模型弹窗里填。
- Gemini 要能填自定义地址。
- 安全审查改为引用决策模型，接入点与凭据不再在审查弹窗里填。

## 决定

### 1. 配置

新增设置项 `decisionModel`（settings.json 白名单，与 config.json 共用 schema，按通用分层覆盖；项目不可信时忽略整段，避免改变数据接收方）：

```json
{ "decisionModel": { "source": "gemini", "endpoint": "ai-studio", "model": "gemini-decision-1", "credential": { "stored": true } } }
{ "decisionModel": { "source": "gemini", "endpoint": "custom", "baseURL": "https://gateway.example.com/v1beta", "model": "gemini-decision-1", "credential": { "env": "GEMINI_API_KEY" } } }
{ "decisionModel": { "source": "jev", "endpoint": "typesafe", "model": "jev-latest", "credential": { "stored": true } } }
{ "decisionModel": { "source": "jev", "endpoint": "opencode-zen", "model": "jev-1.13-free", "credential": { "provider": "opencode-go" } } }
```

- Gemini 接入点：`ai-studio`（`https://generativelanguage.googleapis.com/v1beta`，默认模型 `gemini-decision-1`，默认变量 `GEMINI_API_KEY`）与 `custom`。凭据只有 `{ env }` 与 `{ stored: true }`。
- Jev 接入点沿用 `JEV_ENDPOINTS`（`opencode-zen` / `typesafe` / `custom`）。凭据：`opencode-zen` 保留 `{ provider }` 借用（现有默认借 opencode-go），另两个只有 `{ env }` 与 `{ stored: true }`。
- `baseURL` 只在 `custom` 时保存，规则同现有 Jev（HTTP(S)、无内联凭据、无查询与片段）。对象拒绝未知字段与内联密钥。
- 单独密钥存系统凭据库，id `decision-model`。
- 环境变量与服务商密钥变量一样从 shell 子进程环境剥离。

### 2. 安全审查

`permission.reviewer` 新增 `{ "backend": "decision", "minConfidence"?: number }`，审查时读取当前生效的 `decisionModel`。`decisionModel` 未设置或不可用时，每次审查按 `unsure` 交人，理由写「决策模型未设置」或具体失败原因。

审查弹窗的审查器分段为「关闭 / 决策模型 / 小模型」。选「决策模型」时只显示当前决策模型与「设置 › 模型」跳转按钮，置信度阈值、两组追加规则和样例检查留在审查弹窗。

### 3. 旧配置

旧 `{ backend: "jev", endpoint, model, credential, minConfidence }` 继续有效，行为不变：
- `decisionModel` 未设置时，生效的决策模型从旧 Jev 字段派生，模型页那一行照常显示；
- 审查弹窗把它显示为「决策模型」；
- 用户在任一弹窗保存时，一次原子写入改写为新形状（`decisionModel` + `{ backend: "decision", minConfidence }`）；旧 `{ stored: true }` 密钥由 Core 在凭据库内从 `reviewer` 迁到 `decision-model`，不经客户端、不打印。

新形状写入后，更早版本的 Runtime 读到 `backend: "decision"` 按无效字段忽略并警告，审查器回落到低层配置。

### 4. Gemini 请求

`POST <baseURL>/decisions`，请求头 `x-goog-api-key`：

```json
{ "model": "gemini-decision-1", "input": "<state 的 JSON 文本>", "questions": { "1": { "type": "choice", "instructions": "…", "criteria": { "yes": "…", "no": "…" } }, "…": {} } }
```

- `questions` 与 Jev 共用 `buildJevQuestions` 生成的七道题；`input` 为 `stateForReview` 的 JSON 序列化文本（接口不接受对话与工具调用块）。
- 应答 `answers[key].choice` / `confidence` 交给与 Jev 相同的解析与 `minConfidence` 降级逻辑，再由 `decideFromAnswers` 判定。
- `usage.total_input_tokens` 记为 `inputTokens`，`outputTokens` 为 0，进入 `permission.reviewed.usage`，来源标 Gemini 接入点与模型。
- HTTP 400 带 `error.code` 为 `safety` / `prohibited_content` / `blocklist` / `image_safety` / `content_blocked`（以及 HTTP 200 带 `prompt_feedback.block_reason`）时理由写「决策模型拒绝了这次输入」；401/403、404、429、超时、解析失败沿用 Jev 的理由映射；一律 `unsure`。
- 模型列表：`GET <baseURL>/models`，取 `name` 去掉 `models/` 前缀后包含 `decision` 的项；失败时退回默认模型并允许手动输入，与 Jev 一致。

### 5. 数据外发说明

沿用 Jev 的首次披露：第一次让审查数据发往某个接收方时显示一次，接收方为 Google、TypeSafe、OpenCode 与 TypeSafe 或自定义地址。已接受的接收方记在偏好 `decisionDisclosureAccepted` 里；旧偏好 `jevDisclosureAccepted=yes` 视为已接受 OpenCode 与 TypeSafe。

### 6. 显示

- 桌面「设置 › 模型 › 模型角色」末尾一行「决策模型」：未设置显示「未设置」，否则显示模型 id 与来源（Gemini / Jev）；「选择」打开决策模型弹窗：来源「未设置 / Gemini / Jev」，其下接入点、地址（custom）、模型、凭据。
- TUI 设置页在模型角色后加同名一项，对话框字段与桌面一致；审查对话框后端改为「关闭 / 决策模型 / 小模型」。
- 除字段名、选项名与「设置 › 模型」外不加说明文字。

## 不做的事

- 不把决策模型放进服务商页，也不进默认模型、子代理或其他模型选择列表。
- 本轮只给安全审查用；工具排序等其他用途另立 ADR。
- 不支持 Vertex AI：Decisions API 目前只在 Gemini Developer API 提供。
- 修订（2026-11-25）：目标完成时可使用同一个决策模型独立抽查，见 [ADR-0119](ADR-0119-goal-check.md)。
