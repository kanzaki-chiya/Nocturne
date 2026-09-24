# 服务商配置向导与凭据存储

> 状态：提议 v0.1（v0.2 设计）｜ 前置阅读：[config.md](config.md)、[providers.md](providers.md)、[permissions.md](permissions.md) ｜ 决策：[ADR-0015](../decisions/ADR-0015-provider-setup-credentials.md)

v0.1 接入一个模型服务要做三件事：设置持久的用户级环境变量存放密钥、在 `config.json` 里手写一整段 Provider 条目（`id`/`type`/`baseURL`/`apiKeyEnv`/`models`）、自己查清服务地址和模型 id。本文设计的目标是让首次配置和日常切换都能在交互中完成：

- `nctrn setup`：首次配置向导，独立于会话运行；
- `/provider`：会话内查看、添加、更新密钥、删除服务商（CLI 与 TUI 都提供）。

两个入口共用同一套 Core 能力（第 6 节），只是交互外壳不同。

## 1. 用户看到的流程

```text
$ nctrn setup
选择服务商：
  1) DeepSeek          2) OpenRouter        3) Anthropic
  4) 其他 OpenAI 兼容服务  5) 其他 Anthropic 兼容服务
> 1
名称 [deepseek]：
API Key（输入不回显；直接回车表示改用环境变量）：********
正在获取模型列表…
  1) deepseek-chat   2) deepseek-reasoner
选择模型，或直接输入模型 id：> 1
正在测试连接… 成功（812ms）
设为默认模型？[Y/n] y
已保存：服务商 deepseek、默认模型 deepseek/deepseek-chat
```

- 预设服务商（1–3）只问名称、密钥和模型；自定义（4、5）额外询问服务地址。
- 模型列表来自服务的 `GET /models`（OpenAI 兼容与 Anthropic 都有该端点）；获取失败或服务不提供时退回手动输入，不阻塞流程。
- **连接测试**发送一次最小请求（单条用户消息、`maxOutputTokens` 取 16、不带工具），把 `ProviderError.kind` 翻译成可操作的提示：`auth` → 密钥无效；`network`/`timeout` → 地址不通；`invalid_request` 或 404 → 模型 id 或地址路径有误。测试失败时询问"仍然保存？[y/N]"，默认不保存。
- 选择"改用环境变量"时询问变量名（默认 `NOCTURNE_API_KEY`，Anthropic 类默认 `ANTHROPIC_API_KEY`），条目写入 `apiKeyEnv`，密钥不落盘；此时连接测试只在该变量已设置时进行。
- `nctrn setup` 要求 stdin/stdout 为 TTY，否则以退出码 2 退出并提示手写配置的方式（README）。

会话内的 `/provider`：

| 命令 | 行为 |
|---|---|
| `/provider` | 列出全部服务商：名称、类型、服务地址（只显示主机名）、密钥来源（`凭据文件` / `环境变量 <NAME>` / `缺失`）、来源层（向导 / `config.json` / 项目 / 环境变量），以及当前会话使用的是哪一个 |
| `/provider add` | 运行与 `nctrn setup` 相同的向导；完成后询问"切换当前会话到该模型？[Y/n]"，确认即调用 `session.setModel` |
| `/provider key <name>` | 更新该服务商的密钥（不回显）并重新测试连接 |
| `/provider remove <name>` | 删除向导写入的条目及其凭据；当前会话正在使用的服务商拒绝删除；手写在 `config.json` 或其他层的条目只读，提示去对应文件修改 |

Turn 进行中这些命令一律提示"会话忙"（与 `/model` 相同的前置条件）。TUI 用弹层完成同样的步骤：列表选择器（复用 `/model` 组件）、单行输入框、密钥输入框（显示为 `*`）、确认对话框；命令名与效果与 CLI 一致。

## 2. 向导配置层：`providers.json`

用户手写的 `config.json` 仍然**程序从不改写**（[config.md](config.md) 第 1 节）。向导写入的是一个新的**机器维护文件** `<NOCTURNE_HOME>/providers.json`，它在分层中位于内置默认之上、用户配置之下：

```text
内置默认 < 向导配置 < 用户配置 < 项目配置 < 环境变量 < 命令行参数
```

```ts
interface ProviderSetupFile {
  version: 1;
  /** 默认模型，"provider/model" 形式；只在向导里选择"设为默认"时写入 */
  model?: string;
  /** 形状同 config.json 的 providers 元素（ProviderConfig），apiKeyEnv 可省略（第 3 节） */
  providers: ProviderConfig[];
}
```

- 合并规则与 `config.json` 相同（按 `id` 合并，`models` 逐条合并）。手写配置里同名的条目覆盖向导条目：用户手写的永远赢。`/provider` 列表会标注"被 config.json 覆盖"，免得用户困惑"为什么向导改了不生效"。
- 写入方式与 `trust.json` 一致：整文件原子替换（临时文件 + rename）；解析失败或版本不符时忽略该文件并发出 `runtime.warning(code="provider_setup_invalid")`（不阻塞启动，与 Grant 文件的处理一致），`/provider` 在列表顶部显示该警告。
- 只有向导与 `/provider` 写这个文件；用户也可以手工编辑，但推荐的手写位置仍是 `config.json`。

为什么不直接改 `config.json`：程序改写用户手写的 JSON 会丢失用户的排版与字段顺序（JSON 没有注释，但顺序和分组对人有意义），并且会模糊"哪些是我写的、哪些是程序生成的"。ADR-0007/0008 已经确立"程序写自己的文件"的模式，本设计沿用它。

## 3. 凭据存储：`credentials.json`

```ts
interface CredentialFile {
  version: 1;
  /** 按服务商 id 存放的密钥 */
  keys: Record<string, string>;
}
```

- 位置：`<NOCTURNE_HOME>/credentials.json`，原子写。POSIX 上以 `0600` 创建；Windows 依赖用户目录的默认访问控制（仅当前用户、SYSTEM 与管理员可访问），不额外设置 ACL。
- **密钥解析顺序**（按服务商 id，每次请求时读取，因此 `/provider key` 更新后立即生效，不需要重启）：
  1. 条目声明了 `apiKeyEnv` 且该环境变量已设置 → 用环境变量；
  2. `credentials.json` 中有该 id 的密钥 → 用凭据文件；
  3. 都没有 → 启动或切换模型时报"缺少凭据"，提示运行 `nctrn setup` 或 `/provider key <name>`。
- `apiKeyEnv` 因此变为可选。手写配置照旧可以只用环境变量，行为与 v0.1 相同。
- 密钥值只在 Provider 适配器发请求时被读取：它不进入 `ResolvedConfig`、会话事件、诊断日志、`/provider` 输出或任何错误信息。适配器通过注入的 `CredentialSource.get(providerId)` 读取（第 6 节），`config` 模块拥有文件 I/O，保持权限层与 Provider 层零文件 I/O 的现状。
- **明文存储，如实说明**：文件内容是明文，保护来自文件系统权限与第 4 节的访问限制。它与 `~/.npmrc`、多数 CLI 工具的做法相同。操作系统级密钥库（Windows 凭据管理器、macOS 钥匙串、libsecret）需要原生依赖，本阶段不做（第 8 节）。

## 4. 防止 Agent 读取凭据

凭据文件让密钥第一次以文件形式出现在 Agent 能触及的文件系统里；同时 v0.1 已经存在一个同类问题：`shell` 工具的子进程继承完整进程环境，模型可以通过 `echo %NOCTURNE_API_KEY%` 这类命令读到环境变量里的密钥（`default` 预设下会先询问）。本阶段一并处理：

1. **内置硬拒绝**（[permissions.md](permissions.md) 5.3）：对 `<NOCTURNE_HOME>/credentials.json` 的 `read` 与 `edit` 一律 `deny`，在规则求值之前生效。任何规则、Grant、`--yes`、`full-access` 预设、Hook 都不能放开它。`grep`/`glob` 的逐条过滤因此自然跳过它。路径同时按词法路径与真实路径匹配（与普通路径规则相同），符号链接绕不过去。
2. **shell 子进程剥离凭据变量**：`shell` 工具启动子进程时，从环境中移除所有已解析服务商的 `apiKeyEnv` 变量名，以及 `NOCTURNE_API_KEY`、`ANTHROPIC_API_KEY` 两个默认名。MCP 服务器已经使用白名单环境（[mcp.md](mcp.md) 第 2 节），不受影响。Hook 维持继承完整环境（它是用户自己配置的脚本，[ADR-0012](../decisions/ADR-0012-hooks.md)）。
3. **命令提示**：命令字符串中出现 `credentials.json` 的 `shell` 调用在全部预设（含 `full-access`）中至少 `ask`，`label` 为"可能读取 Nocturne 凭据"。这是基于模式的提示，不是可靠检测。
4. `providers.json` 加入"Nocturne 授权数据"一组（permissions.md 第 6 节第 4 条）：对它的 `edit` 至少 `ask`——它能把会话重定向到别的端点。

**权限不是沙箱**（permissions.md 第 1 节）：一条已获准的 shell 命令仍然可以用任何方式读取凭据文件（比如拼接路径、调用脚本）。第 1、2 条挡住的是工具层面的直接读取与环境变量泄漏，第 3 条只是提示。文档与界面都不暗示凭据文件对 shell 完全不可见。

## 5. 服务商预设

预设是 `provider` 模块里的纯数据：

| 预设 | 类型 | 默认名称 | 服务地址 | 模型列表 |
|---|---|---|---|---|
| DeepSeek | `openai-compatible` | `deepseek` | `https://api.deepseek.com/v1` | `GET /models` |
| OpenRouter | `openai-compatible` | `openrouter` | `https://openrouter.ai/api/v1` | `GET /models` |
| Anthropic | `anthropic` | `anthropic` | 官方端点（省略 `baseURL`） | `GET /v1/models` |
| 其他 OpenAI 兼容 | `openai-compatible` | 用户输入 | 用户输入 | `GET /models`（可能不提供） |
| 其他 Anthropic 兼容 | `anthropic` | 用户输入 | 用户输入 | 手动输入 |

- 预设只负责向导里的默认值；写进 `providers.json` 的是完整条目，之后与手写条目没有区别。预设数据更新不会改变已写入的条目。
- 新增预设的门槛：服务地址与协议兼容性有官方文档可查，并在真实服务上跑过一次连接测试。未满足的服务走"其他 OpenAI 兼容"。

## 6. Core 接口

向导的逻辑（预设、模型列表、连接测试、文件写入）放在 Core，客户端只负责交互；这样 CLI 与 TUI 共用一份行为，也为将来的 RPC 客户端留好入口。

```ts
// @nocturne/core 公开导出
listProviderPresets(): ProviderPreset[]
fetchModelIds(entry: ProviderConfig, key: string | undefined, signal): Promise<string[]>      // GET /models；不支持时返回 []
testProviderConnection(entry: ProviderConfig, key: string | undefined, model: string, signal):
  Promise<{ ok: true; latencyMs: number } | { ok: false; error: ProviderError }>

// RuntimeConfig（config 模块）新增
saveSetupProvider(entry: ProviderConfig, opts: { key?: string; makeDefault?: boolean }): Promise<void>
setCredential(providerId: string, key: string): Promise<void>
removeSetupProvider(providerId: string): Promise<void>     // 同时删除该 id 的凭据
describeProviders(): ProviderOverview[]                    // /provider 列表数据；不含密钥
credentials: CredentialSource                              // { get(providerId): string | undefined }，适配器使用

// Runtime 新增
runtime.updateProviders(config: RuntimeConfig): void
```

`runtime.updateProviders`：用新的基础层配置重建运行时级 Provider 注册表（`listModels` 的数据来源）；每个已打开会话在下一次空闲边界重建自己的会话级注册表（基础层 + 该会话的可信项目层）。当前会话正在使用的服务商不会被移除（客户端在删除前检查，Core 在重建时对仍被引用的服务商保留原实例并发出 `runtime.warning`）。它不产生持久事件；随后的 `setModel` 照常写 `session.config_changed`。

为什么不"关闭会话再用新配置重新打开"：那会触发 `SessionEnd`/`SessionStart` Hook、重启全部 MCP 服务器、重新取锁——添加一个服务商不应该有这些副作用。

## 7. 目录外模型的提示

v0.1 里目录中查不到的模型会静默套用保守默认值（`contextWindow` 128000、`maxOutputTokens` 4096）。本阶段在会话打开与 `setModel` 时，如果当前模型的能力来自默认值，发出临时事件 `runtime.warning(code="model_capabilities_defaulted")`，说明哪些值是默认的、如何在 `config.json` 的 `models` 里声明；`/context` 报告也显示同样的标注。默认值本身是否调整见 ADR-0015 的开放问题。

## 8. 本阶段不做

- 操作系统级密钥库：需要原生依赖（凭据管理器 / 钥匙串 / libsecret），与 v0.1 不引入原生依赖的取舍一致；接入时 `CredentialSource` 换实现即可，文件格式与解析顺序不变。
- OAuth 登录、订阅账号登录：providers.md 第 6 节已排除；模拟官方客户端特征的登录方式不纳入。
- 非交互的 `nctrn setup --provider ... --key ...`：命令行上的密钥会进入 shell 历史与进程列表，与"凭据不经命令行"的规则冲突；自动化场景继续使用环境变量或手写配置。
- 项目级向导配置：向导只写用户级文件。项目级服务商配置仍然手写在 `.nocturne/config.json`，并受信任模型约束。
- 按模型自动探测能力（上下文窗口、推理支持）：各服务的 `/models` 返回字段不统一，本阶段只取模型 id。
