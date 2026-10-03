# ADR-0042：服务商账号登录：ChatGPT、Grok CLI 凭据与 OpenRouter

- 状态：已接受；Grok 自有登录被 [ADR-0043](ADR-0043-grok-build-oauth.md) 取代
- 日期：2026-10-02

## 背景

目前接入服务商只能填 API key（[provider-setup.md](../architecture/provider-setup.md)）。provider-setup.md 第 8 节和 [providers.md](../architecture/providers.md) 第 6 节把「OAuth 登录、订阅账号登录」排除在外，理由是不做「模拟官方客户端特征的登录方式」。

[调查记录](../research/provider-oauth.md) 核对了各家官方文档，有三家提供了写明供第三方使用的路径：

- **ChatGPT**：OpenAI 的「Sign in with ChatGPT」开源应用通道。开源、本地运行的应用可以动态注册 OAuth 客户端，用用户的 ChatGPT 套餐调用 `api.openai.com/v1/responses`。凭据可刷新：access token 1 小时，refresh token 30 天、每次刷新轮换。
- **Grok**：xAI 官方 CLI 的仓库文档「Using auth.json for API Access」写明，可以用 `grok login` 写下的 `~/.grok/auth.json` 调用 `cli-chat-proxy.grok.com` 的 Chat Completions 接口。xAI 没有公开第三方客户端注册，Nocturne 只能读取官方 CLI 的登录结果。
- **OpenRouter**：OAuth PKCE。授权后得到一把普通的用户 API key，没有刷新逻辑。

Anthropic 明确不允许第三方应用使用 Claude.ai 登录或订阅凭据，不接入。其他服务商见调查记录，本 ADR 不涉及。

三者的授权结果各不相同，不能都建模成「带 refresh token 的账号」：

- ChatGPT 是 Nocturne 自己持有、自己刷新的 OAuth 凭据；
- Grok 是别的程序维护的文件，Nocturne 只读；
- OpenRouter 登录完就是 API key。

## 决定

### 1. 范围与边界

- 接入的前提是**服务商官方文档写明第三方可以这样调用**。抓包得到的接口、借用官方客户端的 client_id、伪造官方 User-Agent，一律不做。
- Grok 请求需要带 `X-XAI-Token-Auth: xai-grok-cli` 请求头，这是官方文档给出的调用写法，不是伪装。User-Agent 仍以 `nocturne/<version>` 开头（ADR-0031 §2）。
- 修订 provider-setup.md 第 8 节与 providers.md 第 6 节：排除项改为「官方未开放给第三方的订阅登录（如 Claude.ai）」，并链接本 ADR。

### 2. 配置：鉴权方式与协议分开

`ProviderConfig` 新增可选字段 `auth`，省略时等同 `{ "kind": "apiKey" }`，现有条目不受影响：

```ts
type ProviderAuth =
  | { kind: "apiKey" } // 现状：apiKeyEnv → 凭据存储
  | { kind: "openai-siwc" } // ChatGPT 账号，Nocturne 自己登录、刷新
  | {
      kind: "external-file"; // 读取其他程序维护的凭据文件，只读
      path: string; // 支持开头的 ~
      keyPath: string[]; // JSON 中密钥所在路径
      renewHint: string; // 失效时提示用户执行的命令，如 "grok login"
    };
```

- `kind` 按鉴权协议命名，不按服务商命名。Grok 的文件位置和字段路径写在预设数据里（第 7 节），不写进代码。官方 CLI 改了文件结构时，用户可以在 `config.json` 覆盖 `keyPath`。
- OpenRouter 浏览器登录得到的是普通 key，条目仍是 `apiKey`。
- 非 `apiKey` 的条目忽略 `apiKeyEnv`；同时声明时发 `runtime.warning(code="provider_auth_conflict")`。
- **只在用户级生效**：`auth` 只从内置预设、`providers.json` 和用户 `config.json` 读取。项目配置（即使可信）里出现非 `apiKey` 的 `auth`，或者试图覆盖这类条目的 `baseURL`、`headers`，一律忽略并发 warning。这样项目配置无法把用户的账号令牌重定向到别的主机。
- `openai-siwc` 条目的 `baseURL` 必须是 `https://api.openai.com/v1`，否则报 `config_invalid`。`external-file` 条目的令牌只发往该条目的 `baseURL`。

### 3. 鉴权解析层

Provider 模块新增鉴权解析层，替代各适配器现在直接调用的 `CredentialResolver`：

```ts
interface AuthResolver {
  /** 取当前可用的令牌；需要时刷新。失败抛 ProviderAuthError（带用户可读的处理建议） */
  token(signal: AbortSignal): Promise<string>;
  /** 上游返回 401 时调用：apiKey 无操作，openai-siwc 强制刷新，external-file 重新读文件 */
  invalidate(): Promise<void>;
}
```

- 每种 `kind` 一个实现，按条目声明选择。适配器只认 `AuthResolver`，不知道背后是哪种鉴权。Agent Loop 和 Context 不感知鉴权方式（AGENTS.md 第 3 节）。
- 所有经过 Provider 注册表的调用都走这一层：主对话、子代理、模型角色、智能权限审查器、压缩摘要、`fetchModels`。
- **401 只重试一次**：适配器在流式响应开始之前收到 401 时，调用 `invalidate()` 后用新令牌重发一次；仍然 401 就报错。不进入 Agent Loop 的通用重试。
- `apiKey` 的解析顺序不变（provider-setup.md 第 3 节）。

### 4. ChatGPT：登录、存储与刷新

**登录**（按 OpenAI 开源应用文档）：

- 首次授权：
  - 请求 `https://auth.openai.com/api/accounts/authorize`，参数 `client_id=dynamic_agent_client`、`agent_name_hint=Nocturne`、`ext_agent_host_id`；
  - `scope=openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`，`resource=https://api.openai.com/v1`；
  - 带 `state`、`nonce`，PKCE S256。
- `ext_agent_host_id` 每台机器生成一次（`urn:uuid:` 形式），保存在 `<NOCTURNE_HOME>/oauth-host.json`（`{ version: 1, hostId }`，不是机密，原子写）。
- 回调地址：
  - 地址为 `http://127.0.0.1:<随机端口>/auth/callback`，监听只绑定 `127.0.0.1`，一次性使用。
  - 校验 `state`，取回调里签发的 `client_id`（`oaiapp_…`）。
  - 用它和 `code_verifier` 到 `https://auth.openai.com/api/accounts/oauth/token` 换取令牌（form 编码，同一 `redirect_uri` 与 `resource`，不带 secret）。
- 校验：
  - ID token：按 issuer 的 JWKS 验签，并校验 `iss`、`aud`（等于签发的 client_id）、`exp`、`nonce`。用 Node 自带的 `crypto` 验签，不引入新依赖。
  - 授权范围必须包含 `chatgpt.tokens.use.direct`，缺少时登录失败，说明「该账号未授予推理权限」。
- 之后重新登录：用已保存的 client_id，并带 `login_hint` / `id_token_hint`，不再动态注册。
- 用户输入：
  - 浏览器回调失败，或者在远程终端里，可以把浏览器地址栏的完整回调 URL 粘贴回来，校验方式相同。
  - 等待回调 5 分钟超时，Esc 可以取消。

**存储**：

- 凭据记录序列化为 JSON 字符串，经现有 `CredentialStore.set(providerId, …)` 交给系统后端保存：DPAPI、钥匙串或 libsecret。有系统后端时不落明文；没有时见下文。
- 记录内容：`{ version: 1, clientId, subject, email?, idToken, accessToken, refreshToken, expiresAt, scopes }`。
- 没有系统后端（`none`，实际只会出现在无桌面密钥环的 Linux 上）时仍可登录，登录完成后让用户二选一：
  - **保存到 `credentials.json`（明文，仅你可读）**：索引新增后端 `plaintext`，条目里直接存记录 JSON。文件沿用现有的原子写与 POSIX `0600`，也沿用 `credentials.json` 的硬拒绝（permissions.md 5.3），不新增文件。`/provider` 的凭据状态标注「明文保存」。
  - **仅本次运行**：凭据只放在进程内存，本进程内照常刷新，退出后丢失，下次启动重新登录。`/provider` 标注「仅本次运行」，这种情况下不取跨进程锁。
  - 不默认选明文，也不静默写入。界面如实说明明文的风险：文件被备份、同步或拷走时凭据随之泄漏，refresh token 在被撤销前可以持续使用。
- 明文后端**只用于账号登录凭据**（本 ADR 的 `openai-siwc` 记录）。API key 维持 provider-setup.md 第 3 节「没有可用后端时不退回明文、只提供环境变量方式」，因为 API key 有环境变量可用，而 refresh token 每次刷新都会轮换，没法放进环境变量。

**刷新**：

- `token()` 在 access token 剩余不足 5 分钟时刷新。同一进程内并发请求共用一次刷新（single-flight）。
- **跨进程互斥**：refresh token 每次刷新都会轮换，重复使用旧 token 可能导致整组令牌被吊销。所以刷新前先取 `<NOCTURNE_HOME>/locks/oauth-<providerId>.lock`（独占创建，沿用会话锁的「开机时间 + PID」判定陈旧锁）。拿到锁后绕过进程内缓存重读存储：别的进程已经刷新过，就直接用它的结果。
- 新记录**先写入存储，再使用**新的 access token。写入失败时本次请求报错，不使用一个之后无法续期的令牌。
- 刷新返回 `invalid_grant`、`refresh_token_reused` 等表示 refresh token 不可再用的错误时，删除记录，报「ChatGPT 登录已失效，请执行 /provider login <名称>」。网络错误和 5xx 按可重试上报，不删除记录。

**退出登录**：`/provider logout <名称>` 和删除服务商都会删除本地记录。官方文档没有给出吊销接口，界面上不声称「已在服务端注销」。

### 5. ChatGPT：模型与请求约束

- **模型列表**：
  - `fetchModels` 对 `openai-siwc` 条目解析 `GET /v1/models` 的 `models[]`，只取 `visibility == "list"` 的项，`slug` 作为模型 id，`display_name` 作为显示名。
  - 上下文长度、最大输出等限额由 models.dev 层补全（预设写 `modelsDevProvider: "openai"`）；查不到时按 ADR-0016 的默认值处理并发 warning。
- **协议**：条目内全部模型的生效协议是 `openai-responses`。向导登记模型时写入逐模型 `protocol`（ADR-0026 §7）。
- **请求约束**由 `openai-siwc` 鉴权实现提供一份声明，Responses 适配器按声明改写请求，不按服务商名分支：
  - 固定 `store: false`、`stream: true`（现状已满足），`input` 一律是数组，不发 `previous_response_id`；
  - 不发 `max_output_tokens`、`temperature`、`top_p`、`metadata`、`truncation`、`user`、`prompt_cache_retention`、`safety_identifier`。本地预算仍按模型限额为输出预留空间，与 provider-setup.md 第 7 节「预留与发送分开」一致；
  - system 消息不作为 system 角色项发送，改为 `instructions`；
  - function 工具按文档放进 namespace（或 `additional_tools`）。AI SDK 不支持时，在适配器的 fetch 包装层改写请求体与响应中的工具名，改写对 Core 不可见；
  - `include: ["reasoning.encrypted_content"]` 和思考档位是否被接受，在真实账号上验证。不被接受时，从这份声明里去掉相应字段，并修订本节。
- **完成判定**：只有收到 `response.completed` 才算成功。流在此之前结束，按可重试的流中断上报。
- **错误映射**（适配器把 `{detail}` 和 `{error: {code}}` 两种形状都归一化）：

  | 上游 | 用户看到 | 可重试 |
  |---|---|---|
  | 429 `subscription_sharing_usage_limit_exceeded` | ChatGPT 套餐额度已用完，稍后再试或换模型 | 否 |
  | 403 `subscription_sharing_user_not_eligible` | 该 ChatGPT 账号的套餐不支持第三方应用调用 | 否 |
  | 400 `subscription_sharing_unsupported_capability` | 该功能不支持经 ChatGPT 账号调用（附上游说明） | 否 |
  | 503 `subscription_sharing_usage_unavailable` | ChatGPT 额度服务暂不可用 | 是 |
  | 401（重试一次后仍是） | ChatGPT 登录已失效，请执行 /provider login | 否 |

### 6. Grok：读取官方 CLI 凭据

- 预设「Grok（官方 CLI 登录）」写入的条目：

  ```jsonc
  {
    "id": "grok-cli",
    "type": "openai-compatible",
    "baseURL": "https://cli-chat-proxy.grok.com/v1",
    "headers": { "X-XAI-Token-Auth": "xai-grok-cli" },
    "modelHeader": "x-grok-model-override",
    "auth": {
      "kind": "external-file",
      "path": "~/.grok/auth.json",
      "keyPath": ["https://accounts.x.ai/sign-in", "key"],
      "renewHint": "grok login"
    }
  }
  ```

- 新增通用条目字段 `modelHeader`：适配器把本次请求的模型 id 同时写进这个请求头。它不针对 Grok，任何需要这种写法的网关都能用。
- **读取规则**：
  - 文件在第一次 `token()` 时读取，之后按 mtime 缓存；mtime 变化或 `invalidate()` 时重读。
  - 文件不存在、JSON 解析失败、`keyPath` 取不到字符串时，报缺少凭据：「未找到 Grok CLI 登录凭据，请先安装官方 Grok CLI 并执行 grok login」。
  - 401 时重读一次文件重试，仍然 401 就提示执行 `renewHint`。
  - Nocturne **从不写、从不刷新、从不复制**这个文件，也不把令牌存进自己的凭据存储。令牌寿命以官方 CLI 为准，代码里不写死 7 天。
- **模型列表**：向导先试 `GET /models`，失败转手动输入模型 id（ADR-0026 §3 的方式），不内置模型清单。
- 官方 README 提到的 `GROK_CLI_CHAT_PROXY_BASE_URL` 环境变量不读，要换地址就在 `config.json` 里改 `baseURL`。
- 普通 `api.x.ai` 的 API key 用法不变，走「其他 OpenAI 兼容」。

### 7. OpenRouter：浏览器登录生成 key

- OpenRouter 预设的密钥步骤增加二选一：「浏览器登录」或「粘贴密钥」。
- 浏览器登录：
  - 打开 `https://openrouter.ai/auth?callback_url=http://localhost:<随机端口>/callback&code_challenge=…&code_challenge_method=S256`。监听同时绑定 `127.0.0.1` 和 `::1`，避免 `localhost` 解析不一致。
  - 回调拿到 `code` 后，`POST https://openrouter.ai/api/v1/auth/keys`，请求体 `{ code, code_verifier, code_challenge_method: "S256" }`，返回 `{ key }`。
  - 得到的 key 经 `CredentialStore.set` 保存，之后与手填的 key 完全相同。
- 远程终端：省略 `callback_url`，页面显示授权码，用户粘贴回来（单次有效，10 分钟过期），交换方式相同。
- 没有系统后端时，登录得到的 key 无处保存。此时向导只显示一次 key 和设置环境变量的命令，与现在手填 key 的处理一致。

### 8. Core 接口与客户端

登录流程放在 Core，客户端负责打开浏览器和显示界面（Core 不依赖终端，AGENTS.md 第 3 节）：

```ts
// @nocturne/core 公开导出
startProviderLogin(config: RuntimeConfig, providerId: string): Promise<LoginSession>
interface LoginSession {
  authorizeUrl: string;          // 客户端尝试打开浏览器，同时完整显示，便于复制
  manualInput: "callback-url" | "code"; // 手动粘贴的内容：ChatGPT 是回调 URL，OpenRouter 是授权码
  completion: Promise<LoginResult>;      // 回调成功、超时或取消时结束
  submitManual(text: string): Promise<void>;
  cancel(): void;
}
type LoginResult = { providerId: string; account?: string }; // account：ChatGPT 账号邮箱，仅用于显示

logoutProvider(config: RuntimeConfig, providerId: string): Promise<void>
```

- `runProviderSetupWizard` 遇到预设的鉴权方式不是 `apiKey`，或者用户选了「浏览器登录」时，用 `LoginSession` 代替「输入密钥」这一步。
- `ProviderOverview` 增加 `auth` 描述：`apiKey`（来源：环境变量或系统保存）、`ChatGPT 账号 <email>`、`Grok CLI 凭据 ~/.grok/auth.json`，以及凭据状态（有效、即将过期、已失效、缺少）和保存位置（系统保存、明文保存、仅本次运行）。只描述，不含令牌。
- **TUI**：
  - 服务商页的登录等待页显示授权地址、「已在浏览器打开」或「请复制到浏览器」、粘贴输入框和 Esc 取消。
  - 服务商详情增加「重新登录」「退出登录」。
  - 状态与错误文案按本 ADR 第 4–7 节。
- **CLI**：新增 `/provider login <名称>` 和 `/provider logout <名称>`，行式流程同上。`nctrn setup` 跟随向导。
- 打开浏览器由客户端调用系统命令（Windows `start`、macOS `open`、Linux `xdg-open`）。失败不算错误，只显示地址。Windows 实际用 `rundll32 url.dll,FileProtocolHandler`（见修订）。

### 9. 安全

- 令牌只在适配器发请求时经 `AuthResolver.token()` 取得。不进入 `ResolvedConfig`、事件、诊断日志、错误信息和 `/provider` 输出。
- 诊断日志记录 OAuth 请求时去掉 `code`、`code_verifier`、`refresh_token`、`id_token`、`access_token` 和 `Authorization`。
- **硬拒绝扩展**（permissions.md 5.3）：除 `credentials.json` 外，所有生效的 `external-file` 条目的 `path` 也一律禁止 `read` 和 `edit`。shell 命令里出现这些路径（按文件名匹配，如 `.grok/auth.json`）时，命令提示同样至少是 `ask`。
- `oauth-host.json` 和锁文件不是机密，不纳入硬拒绝。
- 本地回调监听只绑定回环地址，只接受一次带正确 `state` 的请求，返回一页「可以关闭此页面」后立即关闭。

### 10. 验收

- **离线测试**：
  - 用本地假授权服务器覆盖：PKCE 参数、state 不匹配、超时与取消、ID token 验签与 nonce 校验、缺少 scope、刷新轮换的原子写入、跨进程锁、刷新不可用时删除记录；
  - Responses 请求约束的请求体快照、错误码映射；
  - external-file 的 mtime 重读与 401 重读；
  - OpenRouter 的 code 换 key；
  - API key 用户的回归。
- **真实账号冒烟**（需要维护者在场登录）：
  - ChatGPT：登录、模型列表、流式回答、一次本地工具调用往返，以及一次刷新（把 `expiresAt` 改到过去后发请求）。
  - Grok：`grok login` 之后的模型列表或手动模型、流式回答、工具调用往返。
  - OpenRouter：浏览器登录得到 key 后正常对话。
- 不能用离线测试替代真实冒烟。冒烟结果写进本 ADR 的修订记录；有请求约束与本节不符的，按实测修订第 5 节。

## 后果

- ChatGPT 订阅用户不必另买 API 额度，就能用 Nocturne 调用套餐内的模型；Grok CLI 用户复用已有登录；OpenRouter 用户省去复制 key 的步骤。
- 新增 `auth` 字段、`modelHeader` 字段、鉴权解析层、登录会话接口和 `oauth-host.json`，没有新的持久事件。需要同步的文档：
  - providers.md 第 3、4、6 节；
  - provider-setup.md 第 1、3（`plaintext` 后端只用于账号登录凭据）、4、5、6、8 节；
  - provider-api.md（`AuthResolver`、`ProviderAuthError`）；
  - permissions.md 5.3、config.md（`auth` 只在用户级生效）；
  - cli.md、tui.md。
- ChatGPT 通道仍是 OpenAI 的预览接口，请求约束和错误码可能变化。约束集中在一份声明里，变化时只改这一处。
- Grok 路径依赖用户安装官方 CLI，并受它的文件格式约束。格式变化时用户可以先在配置里改 `keyPath`，我们再更新预设。
- 鉴权方式增多后，问题排查要先区分「key 无效」「登录过期」「额度用完」。`/provider` 的凭据状态和第 5 节的错误文案用来承担这部分。

## 备选方案

- **Grok 也由 Nocturne 自己做 OAuth**：xAI 没有公开第三方客户端注册。借用官方 CLI 的 client_id 正是第 1 节排除的做法。
- **ChatGPT 复用 Codex CLI 的 `~/.codex/auth.json`**：Codex 的令牌签发给 Codex 客户端，由它负责刷新。两个程序同时刷新同一组轮换令牌，会互相吊销。OpenAI 已经给出开源应用的自有注册路径，没有理由借用。
- **为 OAuth 凭据新建独立的存储文件**：凭据存储已经按服务商 id 保存任意字符串，并且有平台加密。JSON 记录直接放进去即可，不需要第二套加密与索引。
- **把请求约束做成通用的 `omitRequestFields` 配置项让用户手写**：约束是 ChatGPT 通道的接口契约，不是用户偏好。放在鉴权实现里，用户不会因为漏写一项而遇到 400。以后有第二个服务商需要同类约束时，再考虑抽成通用字段。
- **OpenRouter 也按「账号」建模、显示登录状态**：它登录后就是 key，没有过期和刷新。当作 key 处理最简单，也和用户在 OpenRouter 后台看到的一致。

## 修订

- 2026-10-03：Windows 打开浏览器改用 `rundll32.exe url.dll,FileProtocolHandler <地址>`。原先经 `cmd.exe /c start` 时，Node 给参数加的反斜杠转义 cmd 不认，授权地址里的 `&` 被当作命令分隔符，浏览器打不开。TUI 登录等待页另加「复制地址」按钮：长地址折行后终端只识别首行链接，框选会带上边框字符。
- 2026-10-03：真实账号冒烟发现 `/v1/models` 每项还声明 `context_window`（实测 272000）、`input_modalities`、`supported_reasoning_levels` 等字段。第 5 节改为：`context_window` 映射为上下文长度，`input_modalities` 含 `image` 时可看图，二者作为上游声明优先于 models.dev（ADR-0016）；思考档位仍按现有规则。另：该接口按 `client_version` 查询参数过滤较新的模型（不带时 gpt-6.x 不出现），这是官方文档未写明的参数，发送一个足够大的版本号以列出账号可用的全部模型；参数未写入官方文档，若日后失效，最坏只是列表变短，不影响登录与推理。
- 2026-10-03：真实账号冒烟中首个推理请求被拒（400 `Missing required parameter: tools[0].description`）：通道要求 namespace 工具带 `description`，已补上。对照官方预览限制页，第 5 节不发送的字段补充 `background`、`conversation`、`max_tool_calls`、`moderation`、`multi_agent`、`prompt`、`top_logprobs`。未映射的 4xx 错误改为附带经脱敏过滤的上游说明与参数名，便于定位。
- 2026-10-03：工具调用回合被拒（400 `input[n].name` 不匹配 `^[a-zA-Z0-9_-]+$`）：历史 `function_call` 与 `tool_choice` 的名字不再拼成 `functions.<名>`，改为保留原名并附 `namespace: "functions"` 字段；上游事件里的调用名若带该前缀则去掉，并删除 `namespace` 字段再交给上层。
- 2026-10-03：ChatGPT 通道的缓存命中率在只发 `prompt_cache_key` 时仍约 1%。对照官方客户端（及转发它的代理）的请求，补发 `session_id: <会话 ID>` 请求头：作为通道约束声明（`requestConstraints.sessionHeader`），条目自己声明了 `sessionHeader` 时以条目为准，规则同 ADR-0031 §3。官方客户端另有同一 Turn 内回传服务端 `x-codex-turn-state` 响应头的粘性路由，暂不实现，视命中率再定。
- 2026-10-03：加 `session_id` 后逐请求看用量，命中在「几乎全部命中」与「只命中所有会话共用的约 2.5K 前缀」之间来回跳，说明同一会话的多步请求仍被分到不同后端。通道约束再声明 `stickyRoutingHeader: "x-codex-turn-state"`：上游在响应头返回该令牌时按会话记在内存里，后续请求原样带回，上游给新值就替换，请求失败时丢弃。令牌不落盘，进程退出即失效。
