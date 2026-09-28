# ADR-0026：按模型选择协议：同一服务商下的模型按上游声明各走各的接口

- 状态：已接受（维护者 2026-09-29 确认：跨协议请求同时带两种鉴权头；不可用模型照常列出并标注；Responses 接口暂不接入）
- 日期：2026-09-29

## 背景

目前一个服务商条目只对应一种协议：条目的 `type` 是 `openai-compatible` 就全部走 `/chat/completions`，是 `anthropic` 就全部走 `/messages`。

聚合服务不是这样。维护者的 command code 服务商（`https://api.commandcode.ai/provider/v1`）的 `/models` 共返回 82 个模型，每个模型都带 `supported_endpoints`：

| `supported_endpoints` | 模型数 | 例子 |
|---|---|---|
| `["/chat/completions", "/responses"]` | 65 | GPT、DeepSeek、GLM 等 |
| `["/chat/completions"]` | 8 | Qwen3.8-Flash、LongCat-2.0 等 |
| `["/messages"]` | 9 | Claude 系 |

条目类型是 `openai-compatible`，所以 Claude 模型的请求也发到 `/chat/completions`，结果必然报错。现在唯一的绕法是用同一个地址和密钥再加一个「其他 Anthropic 兼容」服务商：密钥存两份，模型列表出现两遍；而且这个预设不能获取模型列表，要手动填。

上游其实已经说清楚了每个模型该走哪个接口，只是我们没用这个字段。[ADR-0016](ADR-0016-model-limits-from-upstream.md) 定下的原则是「以上游声明为准，不猜」，协议也应该这样处理。

两种协议在这个服务里共用同一个基础地址：`<baseURL>/chat/completions` 与 `<baseURL>/messages`。这正是 `@ai-sdk/openai-compatible` 与 `@ai-sdk/anthropic` 各自的地址约定：`baseURL` 写到 API 版本这一级，适配器自己补后面的路径。

## 决定

### 1. 协议属于模型，条目类型是默认值

每个模型解析出一个**生效协议**，取值为 `openai-compatible`（Chat Completions）或 `anthropic`（Messages）。条目的 `type` 保留原有含义，另外兼作：

- 模型的默认协议；
- 模型列表接口与鉴权方式的「本家」写法（第 3 节）。

不新增服务商类型，也不迁移已有条目：没有任何逐模型声明时，行为与现在完全相同。

### 2. 生效协议的来源与优先级

```text
手写 models.<id>.protocol > 用户编辑 userModels.<id>.protocol > 上游 supported_endpoints > 条目 type
```

- **上游声明**：刷新模型列表时，把 `supported_endpoints` 原样记进 `models.<id>.endpoints`（只在上游声明时写；空数组视为未声明）。存原始事实、在解析时推导协议，这样以后改推导规则不用重新刷新。
- **推导规则**，按顺序取第一个成立的：
  1. 条目 `type` 对应的接口在列表里（`openai-compatible` ↔ `/chat/completions`，`anthropic` ↔ `/messages`），就用条目 `type`，不切换；
  2. 列表含 `/chat/completions`，用 `openai-compatible`；
  3. 列表含 `/messages`，用 `anthropic`；
  4. 以上都不成立（例如只有 `/responses`），模型标为**不可用**（第 5 节）。

  接口按路径末尾比较，`/v1/messages` 与 `/messages` 视为同一个。
- models.dev 与内置目录不提供协议：models.dev 的协议信息是服务商级的，对聚合服务不成立。
- 不按模型名猜协议（例如不因为名字带 `claude` 就走 `/messages`）。

### 3. 地址、鉴权与参数

- **地址**：两种协议共用条目的 `baseURL`。openai 协议请求 `<baseURL>/chat/completions`，anthropic 协议请求 `<baseURL>/messages`。`anthropic` 条目省略 `baseURL` 时用官方的 `https://api.anthropic.com/v1`。
- **顺带修正模型列表路径**：`fetchModels` 对 `anthropic` 条目现在请求 `<baseURL>/v1/models`，与适配器「`baseURL` 含版本号」的约定不一致。自定义 Anthropic 兼容服务如果按适配器的约定填了 `…/v1`，模型列表地址就会变成 `…/v1/v1/models`。改为 `<baseURL 或官方默认>/models`。修正后，「其他 Anthropic 兼容」预设也改为可以获取模型列表，获取失败时照旧转为手动填写。
- **鉴权**：
  - 模型协议与条目 `type` 相同时，照现在的方式发送鉴权头。
  - `openai-compatible` 条目下的 anthropic 协议请求，同时发送 `x-api-key`、`Authorization: Bearer` 与 `anthropic-version`。各家网关的 Messages 兼容接口接受的鉴权头不统一，两个都带，由网关选用。
  - `anthropic` 条目下的 openai 协议请求只发 `Authorization: Bearer`。不给 Anthropic 官方端点多发 `Authorization`，以免被当成 OAuth 令牌。
  - 条目的 `headers` 两种协议都带。
- **思考参数**：openai 协议按条目的 `thinking.format` 翻译档位，anthropic 协议恒走 `thinking.budget_tokens` 并使用 `thinking.budgets`（[ADR-0018](ADR-0018-reasoning-effort.md)）。
- **`providerOptions`**：条目级 `providerOptions` 只交给与条目 `type` 相同协议的请求，因为里面的键是按协议写的。跨协议的模型不带条目级 `providerOptions`；请求级的归一化字段不受影响。

### 4. 实现形态：路由只在 Provider 层

- 每个条目仍然只生成一个 `Provider` 实例，`id` 与 `type` 不变。
- 实例内部按需创建两种适配器。它们共用同一个凭据解析器、`headers` 和诊断通道。
- `stream()` 按请求模型的生效协议分发给对应的适配器。
- `ModelInfo` 新增两个字段：
  - `protocol`：生效协议，只由带协议的适配器填写，`FakeProvider` 等可以不填；
  - `unavailable?: { reason }`：不可用模型的原因。
- Agent Loop 与 Context 不按协议写分支。唯一与协议有关的是第 6 节的等值比较，它比较的是一个不透明的值。

### 5. 不可用模型

- 模型页照常列出不可用模型，行尾显示灰色的「协议不支持」，选中时底部说明原因。原因例如：「上游只声明了 /responses，Nocturne 暂不支持该接口；如确认可用 Chat Completions，可在 /provider 编辑模型里指定协议」。
- `setModel`、`--model`、`/model <名>` 选中不可用模型时拒绝，并给出同样的说明。
- 已打开的会话在刷新后模型变为不可用时，下一轮在发请求前以同样的说明结束，不发出必然失败的 HTTP 请求。
- **套餐限制无法从模型列表判断**：模型列表里的模型，账号不一定能用。这类情况照旧由首次真实请求的错误提示处理（`providerFailureHint`），不在列表里标注。

### 6. 会话历史跨协议回传

- `message.assistant` 事件新增可选字段 `protocol`，记录产生这条消息时的生效协议。这是可选字段，旧版本读取时忽略，不升 `formatVersion`。
- 带 Provider 专有数据（`providerData`，例如 Anthropic 思考签名）的推理块，只在「同一服务商，而且同一协议」时回传；否则剥离，与现在跨服务商切换的处理相同（[context.md](../architecture/context.md) 第 7 节）。
- 旧事件没有 `protocol` 时只比较服务商，与现在的行为一致。在本 ADR 之前，一个服务商只有一种协议。
- 工具调用、工具结果、图片都是中性格式，由各适配器分别转换，跨协议切换不需要额外处理。

### 7. 界面

- 模型编辑页（服务商页「编辑模型」与 `/provider model`，[ADR-0024](ADR-0024-model-settings-editor.md)）新增第七个字段「协议」，选项为「跟随 / Chat Completions / Messages」。「跟随」表示清除用户编辑，按第 2 节推导。来源显示为「手写 / 用户编辑 / 上游 / 服务商类型」。CLI 输入 `-`、`chat`、`messages`。
- 模型页不新增协议列，只对不可用模型显示标注（第 5 节）。
- 诊断日志的请求记录带上协议和接口路径，不带密钥。

### 8. 验证

- **单元与契约测试**，覆盖：
  - 推导规则的每一条分支；
  - 四层来源的优先级；
  - 两种协议的请求地址与鉴权头，各自用假 `fetch` 断言；
  - `anthropic` 条目的模型列表路径；
  - 不可用模型的拒绝；
  - 同服务商跨协议时剥离 `providerData`。
- **真实服务冒烟**（可选，缺变量时跳过）：用现有的 `NOCTURNE_SMOKE_ANTHROPIC_*` 变量（维护者的 OpenRouter，它同时提供 Chat Completions 和 Messages 兼容接口）。建一个 `openai-compatible` 条目，下挂两个模型：一个走默认协议，一个手写 `protocol: "anthropic"`，同一个密钥分别完成一轮对话。这证明「同一地址、同一密钥、两种协议」能跑通。
- **维护者手测**：在 command code 下选一个 Claude 模型，请求应发到 `/messages`；维护者的套餐不含 Claude，预期得到服务商拒绝的错误，而不是「接口不存在」。

## 后果

- **正面**：
  - 聚合服务不用再拆成两个服务商；
  - Claude 这类只支持 Messages 的模型能直接在原服务商下使用；
  - 上游声明被用上，用户不用自己判断；
  - 已有条目与手写配置不需要任何改动。
- **负面**：
  - `openai-compatible` 条目的实例里可能同时持有两种适配器；
  - 跨协议请求的鉴权头是按「常见网关都接受」选的，个别网关可能只认其中一种，会在首次请求时以鉴权错误暴露；
  - 模型编辑页多一个字段。
- **约束**：
  - 新增协议（例如 Responses）时，只需要在推导规则和 Provider 内部分发各加一项，Core 不变；
  - `endpoints` 字段只记录上游原文，不能用来推导「套餐是否可用」。

## 备选方案

- **新增一种「统一」服务商类型**：需要迁移已有条目，也会让「条目类型」的含义分成两套。本方案让 `type` 继续有意义（默认协议），不需要迁移。
- **维持现状，让用户为同一服务加两个条目**：密钥重复保存，模型列表重复，自定义 Anthropic 预设还不能获取列表。这正是本 ADR 要解决的问题。
- **按模型名猜协议**：违背 ADR-0016「不猜」的原则，名字规则也跟不上聚合服务的命名。
- **现在就接 Responses API**：需要引入新的适配器（providers.md 第 4 节的 `openai` 适配器）。维护者数据里所有声明了 `/responses` 的模型也都声明了 `/chat/completions`，目前没有必须走 Responses 的模型，所以暂缓。那时只需按上一段的约束扩展。
