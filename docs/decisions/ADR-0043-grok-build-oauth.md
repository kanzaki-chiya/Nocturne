# ADR-0043：Grok Build 账号登录

- 状态：已接受
- 日期：2026-10-03

## 背景

[ADR-0042](ADR-0042-provider-oauth.md) 把 Grok 收成只读官方 CLI 的 `~/.grok/auth.json`。当时的理由是 xAI 没有公开第三方客户端注册，借用官方 `client_id` 被排除。

2026-10-03 核对官方仓库 `xai-org/grok-build` 与 `https://auth.x.ai/.well-known/openid-configuration` 后，情况是：

- 当前 `grok login` 不再写旧键 `https://accounts.x.ai/sign-in`。官方源码把该键标成 legacy，现行会话键是 `https://auth.x.ai::<client_id>`。
- 登录是 OAuth 2.1：issuer `https://auth.x.ai`，授权码 + PKCE，远程用 RFC 8628 设备码。发现文档公开了 authorize、device、token、jwks，没有 `registration_endpoint`。
- 官方客户端是公开客户端（无 secret）。`client_id` 写在安装脚本和源码里：`b1a00492-073a-47ea-816f-4c329264a828`。推理 scope 是 `grok-cli:access`。令牌打到官方文档已写明的 `cli-chat-proxy.grok.com`。
- 没有类似 OpenAI「Sign in with ChatGPT」的动态注册。企业 OIDC 是客户自己的 IdP，不是 grok.com 账号。

用户要求 Nocturne 自己完成 Grok Build 登录，而不是先安装官方 CLI。这覆盖 ADR-0042 里「Grok 也由 Nocturne 自己做 OAuth」那条被拒绝的备选。ADR-0042 的其余决定不变。

## 决定

1. 新增鉴权 kind `xai-oauth2`。它按协议命名，不按服务商命名。issuer、公开 `client_id`、scope 和代理地址写死在实现里，不从配置读取。
2. 预设 `grok`（显示名 Grok）使用该 kind，`baseURL` 必须是 `https://cli-chat-proxy.grok.com/v1`，并带 `X-XAI-Token-Auth: xai-grok-cli`、`x-grok-model-override`，以及代理版本门要求的 `x-grok-client-version` 等头（两个 Grok 预设共用一份声明）。项目配置不能改这个地址或把头重定向走。缺这些头的旧条目（含旧 `keyPath` 的 `grok-cli`）需重新添加；不在公共请求层按主机名补头。
3. 本机登录走 loopback PKCE，回调 `http://127.0.0.1:<端口>/callback`，失败可粘贴回调 URL。远程终端走设备码：展示验证地址和确认码，由 Nocturne 轮询，不要求用户把码粘回来。等待 10 分钟。
4. 令牌存在现有凭据后端。无系统后端时与 ChatGPT 一样，必须显式选择明文或仅本次运行。access token 剩余不足 5 分钟时刷新；跨进程用 `locks/oauth-<id>.lock`。`invalid_grant` 等不可再刷新的错误删除记录。
5. ID token 只按固定 issuer 的 JWKS 验 ES256，校验 `iss`、`aud`、`exp`、`nonce`。不按 JWT 里的 URL 取公钥。scope 必须含 `grok-cli:access`。
6. User-Agent 一律是 `nocturne/<version>`，`referrer` 是 `nocturne`。发往 `auth.x.ai` 的登录请求，`x-grok-client-version` 也是 `nocturne/<version>`。发往代理的推理请求不同：代理按 `x-grok-client-version` 做版本门，非官方 CLI 的 semver 回 426，所以这个头填当前能过门的官方 CLI 版本号（预设里一处声明，代理提高门槛时随之更新），`x-grok-client-identifier` 填 `nocturne` 表明身份。不伪装官方 CLI 的 User-Agent。
7. `grok-cli` 外部文件预设保留。新向导的 `keyPath` 改为现行会话键 `https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828`。已保存的旧条目不自动改写；需要旧键时在用户配置里覆盖 `keyPath`。Nocturne 仍不写、不刷新那个文件。

## 后果

- 不必安装官方 CLI 就能用 Grok 订阅登录。令牌只发往固定代理。
- 这条路径依赖官方公开客户端继续接受该 `client_id` 与 scope。xAI 收紧客户端绑定后，登录会失败，届时改回外部文件或 API key，不在运行时伪造客户端身份来绕过。
- 真实账号冒烟仍须维护者在场：本机登录、远程设备码、刷新、模型列表、一次流式回答。离线测试不能代替。

## 备选方案

- **继续只读 `auth.json`**：不依赖官方客户端身份，但用户必须另装 CLI，且旧键已经对不上当前 `grok login`。
- **动态注册自己的客户端**：发现文档没有注册端点。没有可实现的官方注册流程。
- **把 `client_id` 做成配置项**：那会让项目或用户把令牌交换指到别的客户端。固定在实现里，和 ChatGPT 通道一样。

## 修订

- 2026-10-03：代理请求头改由鉴权通道声明。`xai-oauth2` 解析器通过 `AuthResolver.requestHeaders` 返回 `GROK_PROXY_HEADERS`（`provider/grok-proxy.ts`），`createAuthFetch` 和模型列表请求每次都用它覆盖条目里的同名头。这样已保存的旧 `grok` 条目不用重新添加，代理提高版本门时改一处即可；第 2 条"缺头的旧条目需重新添加"只对 `grok-cli`（读官方 CLI 凭据，不走该通道）仍成立。仍不按主机名补头。
