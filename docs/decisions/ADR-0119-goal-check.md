# ADR-0119：目标核对（`/goal` 完成时的独立抽查）

- 状态：已接受（2026-11-25）
- 相关：[ADR-0076](ADR-0076-work-modes.md) §4（目标模式）与 2026-11-02 修订（取消固定上限）、[ADR-0117](ADR-0117-decision-model.md)（决策模型）、[ADR-0057](ADR-0057-reviewer-v2.md)（审查器与小模型后端）、[ADR-0040](ADR-0040-model-roles.md)（smol 角色）

## 背景

`/goal` 现在由执行模型自己判定完成：`update_goal(met)` 要求清单与证据，但证据是执行模型自己写的文字，Runtime 只检查非空。常见失败是「说跑过测试但没跑」「测试在最后一次修改之前跑的」「清单漏了目标里的一项」。其他产品里，Claude Code 每轮结束把条件和对话发给小模型判定，判定方不调用工具，只看对话里已有的内容（code.claude.com/docs/en/goal）；Antigravity 与我们一样由执行模型自评。

ADR-0117 已接入决策模型（Gemini Decisions / Jev），并写明「其他用途另立 ADR」，本 ADR 即其中一项。Gemini Decision 1 单次请求最多 1000 道题，共享输入上限 262,144 token，免费档每分钟 5 万输入 token，免费档数据会被用于改进 Google 产品（AI Studio 模型页，2026-11）。

## 决定

### 1. 配置

新增设置项 `goalCheck`（settings.json 白名单；项目层不可信时忽略整段）：

```json
{ "goalCheck": { "backend": "decision" } }
{ "goalCheck": { "backend": "smol" } }
```

- `backend`：`off`（缺省）/ `decision`（读当前生效的 `decisionModel`）/ `smol`（模型角色 smol，未设置时回落会话模型，同 ADR-0040）。
- 不单独配接入点、模型或凭据，全部引用决策模型或 smol 角色。

### 2. 何时核对

- 只在 `update_goal(met)` 时核对；`blocked` 不核对。
- 核对在目标模块的 `report` 里进行，写 `met` 之前完成。`update_goal` 的 `timeoutMs` 由 5 秒改为 60 秒，决策模型请求自身 20 秒超时（同审查器），smol 45 秒。
- 工具的 `signal` 传给核对请求：用户中断、`stopGoal`、`cancelGoal` 时请求取消，结果丢弃，目标按既有规则处理。
- 计划模式、子会话不注册 `update_goal`，不受影响。

### 3. 核对输入由 Runtime 组装

核对方看到的是会话里真实发生的工具结果，不只是执行模型写的证据：

- `objective`：目标原文。
- `checklist`：执行模型提交的清单，每项 `evidence` 截到 1000 字。
- `records`：自 `since` 起所有 Turn 的工具调用，按发生顺序编号，每条包含工具名、主体摘要（命令、路径）、`status`、退出码（有则带）、结果末尾 40 行且不超过 4000 字；改文件的工具只给路径与 `+N −M`，不给差异正文。总预算 60,000 字，超出时保留最新的记录，最前面写「省略 N 条」。
- 脱敏：主体命中凭据硬拒绝或授权数据类别的调用只保留工具名与 `status`。其余结果文本与证据经一个新的纯函数按内容脱敏，替换为 `<redacted>`：`sk-` / `ghp_` / `gho_` / `github_pat_` / `ntn_` / `xox[abp]-` / `AIza` / `AKIA` 开头的密钥形字符串，`Bearer <token>`，`-----BEGIN … PRIVATE KEY-----` 整块，以及键名匹配 `CREDENTIAL_NAME`（`config/schema.ts`）的 `KEY=value`、`"key": "value"` 的值。诊断日志现有的 `sanitize` 只按键名处理，不适用于自由文本。
- 不发送用户消息、项目指令与图片。

### 4. 问题与判定

**决策模型**（`type: "choice"`，题数 = 清单项数 + 1，最多 51 道）：

- 第 i 项：「工具记录中能找到第 i 项证据对应的结果，且该结果在最后一次相关修改之后」，是 / 否。
- 覆盖题：「清单覆盖了目标原文的全部要求」，是 / 否。
- 某项答「否」且置信度 ≥ 0.7 才算未通过；低于阈值按通过处理。阈值沿用审查器的 `minConfidence` 缺省值，不单独设置。

**smol**：同样的输入以文本发送，要求返回 JSON `{ items: [{ index, supported, note }], coverage, note }`，`note` 一句话。`supported: false` 即未通过。解析失败按「不可用」处理。

### 5. 结果

| 结果 | 行为 |
|---|---|
| 全部通过 | 照常写 `met` |
| 有未通过 | 目标保持 `active`；工具以 `error`、`code: "goal_unverified"` 结算，`modelContent` 逐条列出未通过的项（smol 附 `note`），要求用工具补证据后再次调用 `update_goal` |
| 不可用（决策模型未设置、请求失败、输入被拒、解析失败） | 照常写 `met`，并记录原因 |

不可用时放行：没有决策模型时目标也必须能结束，否则核对比不核对更糟。

### 6. 防止来回打转

`update_goal` 算一次工具调用，「met → 未通过 → met」不会触发「连续三轮无工具调用」的规则，所以另加重复调用保护，不加轮数上限：

- 上一次核对未通过之后，如果执行模型没有调用任何别的工具，就再次调用 `update_goal(met)`，这次不再核对，直接写 `blocked`，`reason` 列出仍未通过的项（给模型的是英文，界面显示中文，做法同 no-progress）。
- 用户可以 `/goal resume` 继续，也可以 `/goal cancel` 结束。

### 7. 事件与用量

- 不新增事件类型。核对结果写在 `update_goal` 的 `tool.completed.output.check`：`{ backend, model?, result: "passed" | "rejected" | "unavailable", items?: [{ index, passed, confidence?, note? }], coverage?: boolean, reason? }`。
- `tool.completed` 新增可选字段 `usage?: Usage`，表示工具执行期间产生的辅助模型用量。它计入会话用量，不计入 `turn.completed.usage`、缓存命中率与速度（同 `attachment.described` 的角色用量）。usage 模块只读这个通用字段，不按工具名判断。兼容扩展，不升 `formatVersion`。
- 同步 events.md、usage.md、tool-api.md。

### 8. 数据外发说明

发送内容比安全审查多了工具输出，所以首次披露单独记录：第一次把目标核对数据发往某个接收方时显示一次，接收方的划分与 ADR-0117 §5 相同；已接受的记在偏好 `goalCheckDisclosureAccepted`。接收方为 Google 时，披露里写明免费档数据会被用于改进产品。smol 走的是用户已配置的服务商，不显示披露。

### 9. 显示

- 桌面「设置 › 常规」安全审查之后加一行「目标核对」，分段「关闭 / 决策模型 / 小模型」。选「决策模型」但未设置决策模型时，显示「设置 › 模型」跳转按钮，用法同审查弹窗。
- TUI 设置页加同名一项。
- `update_goal` 工具行：通过时不加东西；未通过时按 `goal_unverified` 显示为淡色中性行（同 `stale_file`），展开列出未通过的项；不可用时展开区显示原因。
- 除字段名、选项名与「设置 › 模型」外不加说明文字。

### 10. 模块

决策模型的请求、应答解析与错误映射从 `permission/gemini-decision-reviewer.ts` 和 Jev 后端中抽出，成为不含七道题的通用客户端，放在 `provider` 的公开接口下（`permission` 已可依赖 `provider`）。审查器与目标核对都调用它。目标核对逻辑放在 `work-modes`，由 `core/index` 装配注入，不经过 `PermissionGate`，也不写 `permission.reviewed`。modules.md 与 depcheck 规则按实际落点同步。

## 不做的事

- 不在每轮结束时都核对：只在执行模型声称完成时核对。
- 不让核对方读文件或运行命令：它只看 Runtime 组装的记录。
- 不加轮数、时长或金额上限。
- 不改 `blocked` 流程。

## 用户已定（2026-11-25）

1. 缺省 `off`。
2. 未通过时不加「按已完成处理」，用 `/goal cancel` 结束。
3. 决策模型阈值沿用 0.7，不加设置项。
4. records 预算 60,000 字。
5. 入库时在 ADR-0076 §4.2 与 ADR-0117「不做的事」各追加一行，链到本 ADR。
