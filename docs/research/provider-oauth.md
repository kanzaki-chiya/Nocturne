# Provider OAuth 接入调查（2026-10-02）

本记录通过 Exa 检索，并核对服务商官方文档。它是接入选型研究，不代表 Nocturne 已实现或实测这些登录流程；实现仍须更新 Provider、配置向导与凭据存储契约。

## 结论与首批范围

首批建议接入 **ChatGPT 和 OpenRouter**，并将 **xAI / Grok Build** 加入首批验证候选。前两者均有公开的第三方接入路径，但授权结果不同：ChatGPT 返回可刷新的 OAuth 凭据，OpenRouter 通过 PKCE 生成用户 API key。不要把二者都建模成需要 refresh token 的账号。xAI 可先复用官方 CLI 登录后的凭据，独立 OAuth 客户端注册尚未确认。

| 服务商 | 官方开放路径与限制 | 建议 |
| --- | --- | --- |
| ChatGPT / OpenAI | 开源、本地应用可申请使用用户 ChatGPT plan 执行合格的 Responses 请求；付费或远程托管产品走另行申请路径 | 首批，需适配订阅接口的请求限制 |
| OpenRouter | OAuth PKCE 授权后生成用户控制的 API key；消费 OpenRouter 额度 | 首批，优先验证最小登录闭环 |
| xAI / Grok Build | 官方 CLI 支持 OAuth / device code；官方仓库明确展示登录凭据调用 CLI chat proxy | 首批验证候选；先复用 CLI 登录，再验证模型、工具调用与凭据生命周期 |
| Gemini / Vertex AI | Google Cloud OAuth；需要自己的项目、客户端、权限和相应计费配置 | 第二批，不沿用 Gemini CLI 的客户端身份与额度 |
| Azure OpenAI / Foundry | Microsoft Entra ID 获取 bearer token；需要资源、租户和 RBAC 权限 | 第二批，面向云资源账号 |
| GitHub Copilot | 注册自己的 GitHub OAuth App / GitHub App，将用户 token 交给 Copilot SDK，使用用户订阅 | 有官方路径，但 SDK/CLI 会话集成需单独设计 |
| MiniMax | 官方明确支持 OpenClaw 的 MiniMax Global OAuth | 候选；本次未找到供 Nocturne 注册新客户端的通用文档 |
| Kimi Code | 官方客户端支持账号登录；第三方开发工具指南要求配置 API key，也可使用会员编程权益 | 先保留官方 API key 路径 |
| Claude / Anthropic | 官方不允许第三方应用提供 Claude.ai 登录或代用户使用 Free / Pro / Max 凭据；开发者应使用 Console API key 或支持的云服务 | 不接入订阅 OAuth |
| Qwen | Qwen Code 旧 OAuth 免费层已于 **2026-04-15** 停用，新的请求被拒绝 | 不接入旧路径；使用 ModelStudio API key / Coding Plan |
| DeepSeek、Z.AI / GLM、Mistral | 所查公开开发者文档主要提供 API key；没有确认供新第三方应用使用的通用 OAuth 注册与推理闭环 | 本轮维持 API key；不把“未确认”当成“不存在” |

“服务商官网能登录”或“官方 CLI 使用 OAuth”不能单独证明第三方应用可以复用相同客户端身份调用模型。MiniMax 和 Copilot 是有官方集成证据、但接入边界不同的例子。

## 首批实现要点

### OpenRouter

使用授权码 + PKCE S256，支持 CLI 的 loopback 回调。授权码通过 `POST /api/v1/auth/keys` 换取 `{ key }`，然后复用现有加密凭据存储和兼容协议适配器。其凭据生命周期按 API key 管理，不增加 refresh token 逻辑。

官方还提供无回调的手工输入授权码方式，适合 SSH / 容器；授权码单次使用，十分钟过期。首批可先完成本地浏览器回调，远程登录需求明确后再增加该交互。

### ChatGPT

按官方开源应用动态注册流程接入，使用真实应用名和稳定的 host ID。首登使用 `dynamic_agent_client`，回调返回实际 `client_id` 后才交换并保存凭据；后续使用已签发的客户端 ID。使用 PKCE、state、nonce，校验 ID token 和推理授权 scope，保护存储 access / refresh token，并原子保存刷新结果。

推理使用公开 `api.openai.com/v1/responses`，模型通过授权后的 `/v1/models` 获取；该模型列表使用 `models` / `slug` / `visibility`，需要与通用模型发现格式归一化。

预览接口要求 `store: false`、`stream: true`、数组形式的 input；system 消息需归一化为 instructions / developer。不能发送 `temperature`、`top_p`、`max_output_tokens` 等不支持的参数。function / custom tools 需要 namespace 或 `additional_tools` 形式。因此接入不能只替换 Authorization；还需要验证现有 Responses 适配器的请求和工具转换。

### xAI / Grok Build（补充核查）

官方 CLI 提供 `grok login` 和 `grok login --device-auth`，凭据写入用户的 `~/.grok/auth.json`。官方仓库 `xai-grok-shell` 的 “Using auth.json for API Access” 明确展示：用该登录凭据调用 `https://cli-chat-proxy.grok.com/v1/chat/completions`，携带 bearer token、`X-XAI-Token-Auth: xai-grok-cli` 和 `x-grok-model-override`，使用流式请求。这是公开文档中的路径，不是从抓包推断出来的接口。

对 Nocturne，建议先验证“官方 CLI 完成登录 → 读取其当前凭据 → 通过现有 Chat Completions 适配器调用 CLI proxy”。无需引入 Grok 的 Agent Loop。此方案依赖安装官方 CLI，不能宣称已经实现 Nocturne 自己注册 OAuth 客户端的登录；本次仍未找到该注册流程。官方另有 ACP / headless 集成方式，但那是外部 Agent 会话集成，不能与模型 Provider 混为一谈。

普通 `api.x.ai/v1` 的开发者 API key 路径继续保留。CLI proxy 的可用模型、额度、工具调用兼容性及真实 token 轮换均需账号实测；不同官方文档对凭据寿命和刷新描述有差异，不应硬编码七天寿命或假设凭据文件结构固定不变。本次没有执行登录或推理测试。

### Nocturne 的最小改动边界

优先复用现有凭据后端、Provider 适配器和共享配置向导。配置中的协议类型与认证方式分开表达，公开配置只保存认证选择和非敏感信息；OAuth 凭据保存在现有保护后端。

认证解析必须覆盖推理、模型发现和 reviewer 等实际调用方，不能只让主对话获得新 token。OAuth 刷新在认证/适配层处理，不在 Agent Loop 或 Context 中添加按服务商分支。

实现前更新 [Provider 架构](../architecture/providers.md)、[服务商配置向导](../architecture/provider-setup.md) 和 [Provider API](../protocols/provider-api.md) 的相关契约；目前架构文档将账号登录排除在范围之外。本研究不修改这些既有契约。

首批验收包括：登录取消与超时、错误回调 state、凭据保护存储、ChatGPT scope / ID token 校验与刷新、模型发现、流式回答、一次本地工具调用往返，以及 API key 用户的回归验证。离线测试不能替代真实账号的授权和推理冒烟。

## 官方来源

- ChatGPT：[开放范围](https://developers.openai.com/siwc/token-sharing-open-source)、[注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。
- OpenRouter：[OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth)。
- xAI：[Grok Build 认证](https://docs.x.ai/build/enterprise)、[官方仓库的 CLI 凭据与 API Access 示例](https://github.com/xai-org/grok-build/tree/main/crates/codegen/xai-grok-shell)、[当前认证指南](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md)、[API / CLI / ACP 接入概述](https://docs.x.ai/build/overview)。
- Google：[Gemini OAuth](https://ai.google.dev/gemini-api/docs/oauth)、[Gemini CLI 认证](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx)。
- Microsoft：[Foundry / Azure OpenAI 的 Entra ID 认证](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/configure-entra-id)。
- GitHub：[Copilot SDK 的 GitHub OAuth](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth)。
- MiniMax：[官方 OpenClaw OAuth 指南](https://platform.minimax.io/docs/token-plan/openclaw)。
- Kimi：[Kimi Code 概述与第三方 API 接入](https://www.kimi.com/code/docs/en/)。
- Anthropic：[Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance)。
- Qwen：[认证文档与旧 OAuth 停用说明](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)。
- 其他：[DeepSeek](https://api-docs.deepseek.com/)、[Z.AI](https://docs.z.ai/guides/develop/http/introduction)、[Mistral](https://docs.mistral.ai/admin/identity-access/api-keys)。
