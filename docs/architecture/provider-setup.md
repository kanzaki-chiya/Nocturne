# 服务商配置向导与凭据存储

> 状态：已接受 v0.2；v0.3 修订（[ADR-0019](../decisions/ADR-0019-tui-visual-provider-page.md)，提议，待验收）｜ 前置阅读：[config.md](config.md)、[providers.md](providers.md)、[permissions.md](permissions.md) ｜ 决策：[ADR-0015](../decisions/ADR-0015-provider-setup-credentials.md)

v0.1 接入一个模型服务要做三件事：设置持久的用户级环境变量存放密钥、在 `config.json` 里手写一整段 Provider 条目（`id`/`type`/`baseURL`/`apiKeyEnv`/`models`）、自己查清服务地址和模型 id。本文设计的目标是让首次配置和日常切换都能在交互中完成：

- `nctrn setup`：首次配置向导，独立于会话运行；
- `/provider`：会话内查看、添加、更新密钥、删除服务商（CLI 与 TUI 都提供）。

两个入口共用同一套 Core 数据接口（第 6 节），只是交互外壳不同。v0.3 起服务商配置与模型选择分离：向导只管"把服务商配上"，`/model` 是唯一的模型选择入口（[ADR-0019](../decisions/ADR-0019-tui-visual-provider-page.md) 第 3 条）。

## 1. 用户看到的流程

ChatGPT、Grok 与 OpenRouter 可以不手填 API key（[ADR-0042](../decisions/ADR-0042-provider-oauth.md)、[ADR-0043](../decisions/ADR-0043-grok-build-oauth.md)）。ChatGPT 走浏览器登录，回调失败或远程终端时粘贴完整回调 URL。Grok（`grok`）由 Nocturne 自己向 `auth.x.ai` 做授权码或设备码登录，令牌存在凭据后端；远程终端显示确认码，不粘贴回本进程。Grok CLI 仍只读官方 CLI 的 `~/.grok/auth.json`，向导不写该文件。OpenRouter 在「浏览器登录」与「粘贴密钥」中二选一，远程终端粘贴授权码。登录由 Core 的 `LoginSession` 完成，客户端打开浏览器并展示地址；Esc 取消。ChatGPT 与 OpenRouter 五分钟超时，Grok 十分钟。OpenRouter 得到的是普通 API key。没有系统凭据后端时，API key 只显示一次并给出环境变量命令，不落明文；ChatGPT 与 Grok 账号记录必须由用户显式选择明文保存或仅本次运行，不默认明文；保存位置在打开浏览器授权之前选择。

### TTY：服务商页 → 模型页的两步流程

`nctrn setup` 在交互终端直接打开**服务商页**（第 1 步，与 TUI 同一全屏，[tui.md](../apps/tui.md) 第 8 节）；按 `Esc` 完成后，如果没有默认模型自动进入**模型选择页**（第 2 步）设为默认；两页头部都显示"第 N 步，共 2 步"。没有任何已配置服务商时运行 `nctrn` 走同一流程，选完模型才创建会话进入主界面；有服务商但没有可解析的默认模型时直接进入第 2 步。

服务商页里选中未配置预设后的就地步骤（逐行向导与服务商页共用同一套客户端流程，第 6 节）：

```text
▸ ○ DeepSeek / OpenRouter / Anthropic / 其他 OpenAI 兼容 / 其他 Anthropic 兼容
（仅自定义预设）名称：commandcode
（仅自定义预设）服务地址：https://api.example.com/v1      ← anthropic 兼容可留空用官方端点
（仅自定义预设）会话标识请求头（可选，回车跳过）：x-opencode-session
API Key（掩码输入；直接回车表示改用环境变量）：********
密钥已交给 Windows DPAPI 加密保存
✓ 已获取 12 个模型                                       ← 确认前只发 GET /models；失败显示原因并继续
已保存 command，12 个模型                                ← 底部结果行，回到列表
```

- 内置预设不再问名称与地址（直接用预设默认值）。ChatGPT、Grok 与 Grok CLI 跳过密钥输入，改走登录或外部文件（第 5 节）。两个自定义预设问名称（必填）、服务地址（openai 兼容必填，anthropic 兼容可留空用官方端点）与**会话标识请求头**（ADR-0031 §3，可选）：填写请求头名（如 `x-opencode-session`）则写入条目 `sessionHeader`，之后每个模型请求携带该头（值为根会话 ID，见 [providers.md](providers.md) 第 4 节）；回车留空不写该字段。
- **向导不再选择模型**（v0.3）：模型列表仍经 `GET /models` 获取并把上游声明的上下文窗口、最大输出长度与能力标记写回条目 `models`（第 7 节），但不再出现"编号选择模型"与"设为默认模型"两步；默认模型在 `/model` 页设置。保存配置确认前获取并展示结果，需要手填模型时先填写模型 ID，获取结果替换进行中提示：成功显示"已获取 N 个模型"；失败显示原因并继续后续步骤——`GET /models` 返回 401/403 时提示"密钥可能无效（获取模型列表被拒绝）"，404/网络错误等其余失败提示"模型将手动填写"；保存后可用服务商页「刷新模型列表」或 `/provider refresh <名>` 重试。
- 添加服务商和刷新模型列表时顺带更新 models.dev 缓存；失败沿用本地缓存或内置快照，并在结果中提示一行，不影响上游列表的保存。向导不再询问服务商级思考档位。
- **TUI 表单形态**（ADR-0019 第 2 条）：全屏页面内不出现需要打字回答的是非题；已完成步骤折叠为一行摘要（如"名称 command • 地址 api.xxx.com • 密钥已保存"），当前步骤用强调色提问、灰色小字给说明（密钥获取入口、回车改用环境变量等）。
- **向导不发送模型请求**：连接测试会消耗 token 且重复了首次真实请求才能发现的问题，因此不做。密钥、地址与模型 id 的有效性由会话中的首次真实请求检验；请求失败时按 `ProviderError.kind` 给出可操作提示（`auth` → 密钥可能无效，附 `/provider key <name>`；`network`/`timeout` → 地址不通，附 `nctrn setup`；`invalid_request`/404 → 模型 id 或地址路径有误），实现位置为 `agent/turn.ts` 的 `providerFailureHint`（turn.completed.error.message，CLI 与 TUI 共用）。
- 系统凭据后端不可用时（第 3 节），API key 预设跳过保存密钥，直接进入环境变量方式；选择"改用环境变量"时询问变量名（默认按预设 `defaultKeyEnv`），条目写入 `apiKeyEnv`，密钥不落盘。ChatGPT 与 Grok 改为询问明文或仅本次运行，不默认明文；保存位置在打开浏览器授权之前选择。

### 逐行 CLI

`nctrn setup --cli` 与行式 REPL 的 `/provider add` 走逐行向导（步骤同上，无服务商页）：预设按编号选择（自定义预设才问名称与地址）、密钥不回显、模型列表只获取不选择。配置完第一个服务商后提示"用 /model 选择模型"。`nctrn setup` 在非 TTY 环境以退出码 2 退出并提示手写配置的方式（README）。

### 会话内的 `/provider`

| 命令 | 行为 |
|---|---|
| `/provider` | CLI 列出全部服务商：名称、类型、主机名、鉴权描述、凭据状态（有效 / 即将过期 / 已失效 / 缺少；判定见第 6 节 `describeProviders`）、保存位置（系统保存 / 明文保存 / 仅本次运行）、来源层，以及当前会话使用的是哪一个。不含令牌。TUI 中打开全屏**服务商页**（[tui.md](../apps/tui.md) 第 8 节） |
| `/provider add` | 逐行向导（CLI）或服务商页内嵌向导（TUI 打开服务商页并选中预设）；保存后提示"用 /model 选择模型" |
| `/provider key <name>` | 更新该服务商的密钥（不回显），保存后即完成；等价于服务商页「换密钥」 |
| `/provider refresh <name>` | 重新从上游获取模型列表与限额（第 7 节），写入向导配置并更新 models.dev 缓存；models.dev 失败只提示，不中断刷新 |
| `/provider model <name> <模型>` | 编辑该模型的八个设置（显示名 / 上下文长度 / 最大输出 / 推理 / 图片输入 / 思考档位 / 协议 / 编辑工具），写入条目 `userModels.<模型>`。推理为「跟随 / 是 / 否」，CLI 输入 `-`/`y`/`n`，选否时不询问档位；协议为「跟随 / Chat Completions / Messages / Responses」，CLI 输入 `-`/`chat`/`messages`/`responses`，选「跟随」清除用户编辑（ADR-0026 第 7 节、ADR-0031 §1）；编辑工具为「跟随 / edit / apply_patch」，CLI 输入 `edit`/`patch`（或 `apply_patch`）/`-`（ADR-0035 §5）；来源含「models.dev」「按接口声明推导」「服务商类型」。手写配置来源的字段只显示不提问；只能编辑清单内模型，程序不改写 `config.json` |
| `/provider remove <name>` | 删除向导写入的条目及其凭据；当前会话正在使用的服务商拒绝删除；手写在 `config.json` 或其他层的条目只读，提示去对应文件修改；等价于「删除」 |
| `/provider login <name>` | 重新走该条目的浏览器登录；不支持登录的条目提示原因。等待可取消，错误不含授权码或令牌 |
| `/provider logout <name>` | 删除本地保存的登录凭据。官方没有吊销接口，界面不声称已在服务端注销 |

Turn 进行中这些命令一律提示"会话忙"（与 `/model` 相同的前置条件）。这些子命令与服务商页操作调用同一套 Core 接口，命令名与效果在 CLI 与 TUI 一致。

TUI 另有全屏的**模型选择页**（`/model` 打开）：左右双栏（范围/服务商 + 搜索与模型列表）、最近使用置顶、上游声明的上下文/价格/能力标记、窄终端降级、左栏 `○` 预设内嵌添加向导。完整规格见 [tui.md](../apps/tui.md) 第 7 节。

## 2. 向导配置层：`providers.json`

用户手写的 `config.json` 仍然**程序从不改写**（[config.md](config.md) 第 1 节）。向导写入的是一个新的**机器维护文件** `<NOCTURNE_HOME>/providers.json`，它在分层中位于内置默认之上、用户配置之下：

```text
内置默认 < models.dev < 向导配置 < 用户编辑 < 程序设置 < 用户配置 < 项目配置 < 环境变量 < 命令行参数
```

```ts
interface ProviderSetupFile {
  version: 1;
  /** 旧默认模型，"provider/model" 形式；仅兼容读取，不再写入（ADR-0034） */
  model?: string;
  /** 形状同 config.json 的 providers 元素（ProviderConfig），apiKeyEnv 可省略（第 3 节）；
      另含 userModels?: Record<modelId, { displayName?; contextWindow?; maxOutputTokens?;
      capabilities?: { reasoning?; imageInput?; reasoningEffort?; editTool? }; protocol? }>——
      /provider model 与服务商页「编辑模型」写入的逐模型用户编辑（ADR-0024；protocol 见
      ADR-0026 §7；editTool 见 ADR-0035 §5），只在向导层有意义；
      refresh 重写 models 字段时保留；重新添加同名服务商会被拒绝（见下文「名称唯一性」） */
  providers: ProviderConfig[];
}
```

- 合并规则与 `config.json` 相同（按 `id` 合并，`models` **逐字段合并**——顶层字段逐个覆盖、`capabilities` 逐键覆盖、`reasoningEffort` 数组整体替换；ADR-0024 第 2 节）。手写配置里同名的字段覆盖向导条目：用户手写的永远赢。`/provider` 列表会标注"被 config.json 覆盖"，免得用户困惑"为什么向导改了不生效"。
- 条目里的 `userModels` 不直接出现在合并结果中：加载时它被包成一个独立合成层（`providers: [{ id, models: userModels }]`）插在向导层与用户配置之间参与逐字段合并——用户编辑优先于上游声明、低于手写配置；只由该层引入的清单外模型在合并后被丢弃（详见 [config.md](config.md) 第 2 节与 [ADR-0024](../decisions/ADR-0024-model-settings-editor.md)）。
- 写入方式与 `trust.json` 一致：整文件原子替换（临时文件 + rename）；解析失败或版本不符时忽略该文件并发出 `runtime.warning(code="provider_setup_invalid")`（不阻塞启动，与 Grant 文件的处理一致），`/provider` 在列表顶部显示该警告。
- 只有向导与 `/provider` 写这个文件；用户也可以手工编辑，但推荐的手写位置仍是 `config.json`。

**名称唯一性**：服务商 id 在合并后的全部层（providers.json、config.json、可信项目配置、环境变量、命令行参数）里唯一，比较**不区分大小写**；保存时保留用户输入的拼写，已有文件不做迁移。

- 添加服务商时，`prepareProvider` 在字段校验通过后、获取模型列表之前检查一次，`commitProvider` 开头再检查一次（准备之后别的进程可能已写入同名条目）；重名抛 `ProviderSetupError("name", "已有同名服务商 grok（providers.json）")`，括号里是冲突条目所在的最高层，报错里用已有条目的原拼写。CLI、TUI 与 RPC（-32005 / `field: "name"`）都依赖这一处检查，客户端不各自实现。
- 写文件时 `saveSetupProvider` 带模式：`create`（只有 `commitProvider` 使用）在写入前重读 providers.json，发现同 id（不分大小写）即抛 `ConfigError("provider_exists")`，`commitProvider` 把它转成上面的 name 字段错误，并撤回本次已写入的账号凭据；`replace`（缺省）保持整条替换，刷新模型列表、编辑模型等更新已有条目的路径都用它。providers.json 的写入没有跨进程锁，重读与原子替换之间仍有极小的竞争窗口，两个进程恰好同时添加同名服务商时后写者覆盖，与此前行为相同。
- `create` 提交前先删除同 id 的**孤立凭据**（条目已被手工删掉、凭据还在），新条目不会继承旧密钥或旧账号。
- 此前重新添加同名服务商会静默整条替换已有条目（地址、凭据方式等被新表单覆盖，只有 `userModels` 保留），属于缺陷，已直接修正，不提供兼容开关。要换地址或密钥，用服务商页的「换密钥」或先删除再添加。

为什么不直接改 `config.json`：程序改写用户手写的 JSON 会丢失用户的排版与字段顺序（JSON 没有注释，但顺序和分组对人有意义），并且会模糊"哪些是我写的、哪些是程序生成的"。ADR-0007/0008 已经确立"程序写自己的文件"的模式，本设计沿用它。

同类的机器维护文件还有 `<NOCTURNE_HOME>/recent-models.json`：模型选择页"最近使用"范围的数据源。`{ version: 1, models: string[] }`（"provider/model" 形式，新→旧，最多 10 条），由 Runtime 在 `setModel` 与新建会话时经 `recordRecentModel` 更新，整文件原子写；损坏时忽略（最坏后果是最近列表为空）。

## 3. 凭据存储：交给操作系统

凭据 id 分命名空间：服务商 id 禁止 `/`；MCP 使用 `mcp/<serverId>/<name>`，stdio 的 name 为环境变量名，HTTP 为小写请求头名。MCP 的保存、回滚与清理规则见 [mcp.md](mcp.md)。

API key **不以明文落盘**。向导把密钥交给操作系统自带的凭据保护能力，全部通过系统自带的命令完成，不引入原生依赖。账号登录记录的明文例外只在用户显式选择后发生，见下文。

| 平台 | 后端 | 写入 | 读取 | 密钥存放在 |
|---|---|---|---|---|
| Windows | DPAPI（当前用户范围） | 系统自带的 Windows PowerShell 5.1（`powershell.exe`）调用 .NET `ProtectedData.Protect`，得到只有当前用户在本机能解开的密文 | 同一工具调用 `ProtectedData.Unprotect` | `credentials.json` 中的密文 |
| macOS | 钥匙串 | `security -i`，命令经 stdin 写入（`add-generic-password -s nocturne -a <服务商 id> -U -w …`） | `security find-generic-password -w` | 钥匙串 |
| Linux | Secret Service（libsecret） | `secret-tool store`，密钥经 stdin 写入 | `secret-tool lookup` | 桌面密钥环 |

- **Windows 实现约束**（2026-09-25 在本机实测得出）：
  - 直接调用 .NET 的 `System.Security.Cryptography.ProtectedData`，不用 `ConvertTo-SecureString` 等 cmdlet：从 PowerShell 7 环境启动 `powershell.exe` 时，继承的 `PSModulePath` 会让 5.1 加载不了 `Microsoft.PowerShell.Security` 模块；
  - 启动子进程时从环境中去掉 `PSModulePath`；
  - stdin 与 stdout 两个方向都只传 Base64：5.1 按控制台代码页读取 stdin，直接传 UTF-8 会把非 ASCII 字符读乱。
  - 实测一次解密约 0.3 秒；篡改过的密文解密失败（按"缺少凭据"处理）。
- **密钥只经管道传递**：写入与读取时密钥都走子进程的 stdin/stdout，**永不出现在命令行参数里**（命令行参数对同机其他进程可见）。每个平台的这一性质在实现时逐一验证并写进测试。
- **没有可用后端时，API key 不退回明文**：例如无桌面环境的 Linux 服务器没有密钥环。此时向导说明原因，只提供环境变量方式（打印设置命令，不保存密钥）。**账号登录记录例外**（[ADR-0042](../decisions/ADR-0042-provider-oauth.md) 第 4 节）：仅 `openai-siwc` 记录可以在用户明确选择后写入。二选一，且不默认、不静默写入：
  - **保存到 `credentials.json`（明文，仅你可读）**：索引条目为 `{ backend: "plaintext", value }`，`value` 是账号记录 JSON。文件仍原子写，POSIX 上 `0600`，并继续受凭据文件硬拒绝。`/provider` 标注「明文保存」。界面说明风险：文件被备份、同步或拷走时凭据随之泄漏，refresh token 在被撤销前可以持续使用。
  - **仅本次运行**：记录只在进程内存，本进程内照常刷新，退出后丢失。`/provider` 标注「仅本次运行」，不取跨进程锁。
  API key 不能走这两项，因为 API key 有环境变量可用，而轮换的 refresh token 不能放进环境变量。
- `<NOCTURNE_HOME>/credentials.json` 是索引文件：

  ```ts
  interface CredentialIndex {
    version: 1;
    /** 系统后端条目含可选 ciphertext；plaintext 只存已校验的账号记录 JSON */
    entries: Record<
      string,
      | { backend: "dpapi" | "keychain" | "libsecret"; ciphertext?: string }
      | { backend: "plaintext"; value: string }
    >;
  }
  ```

  只有 DPAPI 需要 `ciphertext`（密文本身）；钥匙串与 libsecret 的密钥留在系统里，索引只记录"这个服务商的密钥存在哪个后端"。原子写，POSIX 上 `0600`。

- **统一接口 `CredentialStore`**（参考 oh-my-pi 的 `AuthStorage → CredentialStore` 分层；区别是 API key 不存明文 JSON）：

  ```ts
  interface CredentialStore {
    /** 取出该服务商的密钥；索引无此 id 或后端取出失败时返回 undefined */
    get(providerId: string): Promise<string | undefined>;
    /** 写入/更新密钥并登记索引；后端不可用时拒绝（向导据此跳过保存密钥这一步） */
    set(providerId: string, key: string): Promise<void>;
    /** 删除密钥与索引条目；不存在时无操作 */
    delete(providerId: string): Promise<void>;
    /** 当前系统后端。plaintext 是条目级保存位置，用 storage(id) 查询 */
    backend(): "dpapi" | "keychain" | "libsecret" | "memory" | "none";
    /** 保存账号记录。无系统后端时 storage 必填，省略则拒绝 */
    setAccount(providerId: string, record: string, storage?: "plaintext" | "memory"): Promise<void>;
    /** 不返回凭据内容 */
    storage(providerId: string): "system" | "plaintext" | "memory" | undefined;
  }
  ```

  每个平台一个实现：`dpapi`（Windows，索引存密文）、`keychain`（macOS，`security -i`/`find-generic-password`）、`libsecret`（Linux，`secret-tool`）——三者各自维护 `credentials.json` 索引的原子写与 POSIX `0600`；`memory` 只在内存中保存、不落任何文件，仅供测试；`none` 表示无可用系统后端（API key 的 `set` 拒绝，`get` 仍可读用户已选择的 `plaintext` 账号条目）。创建时按平台探测：找不到 `security`/`secret-tool` 可执行文件时落到 `none`。
- **密钥解析顺序**（按服务商 id）：
  1. 条目声明了 `apiKeyEnv` 且该环境变量已设置 → 用环境变量；
  2. 凭据索引中有该 id → 经对应后端取出；
  3. 都没有，或后端取出失败 → 启动或切换模型时报"缺少凭据"并说明原因，提示运行 `nctrn setup` 或 `/provider key <name>`。
- 解密结果在进程内按服务商 id 缓存（缓存在 `CredentialStore` 实现内部），避免每次请求都启动子进程（PowerShell 启动约数百毫秒）；`set`/`delete` 使对应条目失效——`/provider key` 更新后下一次请求即用新密钥。
- `apiKeyEnv` 因此变为可选。手写配置照旧可以只用环境变量，行为与 v0.1 相同。
- 密钥值只在 Provider 适配器发请求时经注入的 `CredentialStore.get(providerId)` 取得（第 6 节）：它不进入 `ResolvedConfig`、会话事件、诊断日志、`/provider` 输出或任何错误信息。后端子进程的 stderr 进入诊断日志前同样经过脱敏。

**这能防什么、不能防什么**（如实说明）：

- 能防：凭据随文件泄漏——`~/.nocturne` 被备份、同步到网盘、误提交、磁盘被拿走，以及同机的其他用户。作为对照，v0.1 推荐的"用户级环境变量"在 Windows 上以明文存放于注册表 `HKCU\Environment`，并不具备这种保护。
- 不能防：**以你的身份运行的进程**。DPAPI、钥匙串、密钥环都会为当前用户解密，所以 Agent 执行的一条已获准的 shell 命令，原则上也能调用同样的系统命令取出密钥。这一面由第 4 节的访问限制负责，并且同样不是沙箱。

## 4. 防止 Agent 读取凭据

凭据索引（含 Windows 上的 DPAPI 密文）位于 Agent 能触及的文件系统里，而当前用户的进程能解开它；同时 v0.1 已经存在一个同类问题：`shell` 工具的子进程继承完整进程环境，模型可以通过 `echo %NOCTURNE_API_KEY%` 这类命令读到环境变量里的密钥（`default` 预设下会先询问）。本阶段一并处理：

1. **内置硬拒绝**（[permissions.md](permissions.md) 5.3）：对 `<NOCTURNE_HOME>/credentials.json` 以及所有生效 `external-file` 路径的 `read` 与 `edit` 一律 `deny`，在规则求值之前生效。明文账号记录仍在这个文件里，不另建凭据文件。任何规则、Grant、`--yes`、预设与 Hook 都不能放开它。
2. **shell 子进程剥离凭据变量**：`shell` 工具启动子进程时，从环境中移除所有已解析服务商的 `apiKeyEnv` 变量名，以及 `NOCTURNE_API_KEY`、`ANTHROPIC_API_KEY` 两个默认名。默认补入 `PYTHONUNBUFFERED` 的规则见 [tools.md](tools.md) 第 6 节。MCP 服务器已经使用白名单环境（[mcp.md](mcp.md) 第 2 节），不受影响。Hook 维持继承完整环境（它是用户自己配置的脚本，[ADR-0012](../decisions/ADR-0012-hooks.md)）。
3. **命令提示**：命令字符串中出现 `credentials.json` 或生效 `external-file` 的凭据文件名，或调用凭据后端命令（macOS `security …-generic-password` 族、Linux `secret-tool`、Windows `ProtectedData`）的 `shell` 调用，在全部预设（含 `guarded`/`smart`/`bypass`）中至少 `ask`，`label` 为"可能读取 Nocturne 凭据"。这是基于模式的提示，不是可靠检测。详见 [permissions.md](permissions.md) 5.3。
4. `providers.json` 加入"Nocturne 授权数据"一组（permissions.md 第 6 节第 4 条）：对它的 `edit` 至少 `ask`——它能把会话重定向到别的端点。

**权限不是沙箱**（permissions.md 第 1 节）：一条已获准的 shell 命令仍然可以用任何方式取出密钥（比如拼接路径、调用脚本、间接调用系统凭据命令）。第 1、2 条挡住的是工具层面的直接读取与环境变量泄漏，第 3 条只是提示。文档与界面都不暗示凭据文件对 shell 完全不可见。

## 5. 服务商预设

内置预设除下表外还有 ChatGPT、Grok 与 Grok CLI（[ADR-0042](../decisions/ADR-0042-provider-oauth.md)、[ADR-0043](../decisions/ADR-0043-grok-build-oauth.md)）。ChatGPT（`chatgpt`）使用 `auth: { kind: "openai-siwc" }`、`https://api.openai.com/v1` 与 `modelsDevProvider: "openai"`；登记的模型协议为 `openai-responses`。Grok（`grok`）使用 `auth: { kind: "xai-oauth2" }`、`https://cli-chat-proxy.grok.com/v1`、静态头 `X-XAI-Token-Auth: xai-grok-cli` 与模型头 `x-grok-model-override`。Grok CLI 使用同一代理与请求头，凭据来自外部文件 `~/.grok/auth.json`（`keyPath: ["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828", "key"]`，续期 `grok login`）。向导跳过密钥输入。Grok CLI 先获取模型列表，失败询问模型 id；不修改官方 CLI 的文件。

预设是 `provider` 模块里的纯数据：

| 预设 | 类型 | 默认名称 | 服务地址 | 模型列表 | thinking-format |
|---|---|---|---|---|---|
| DeepSeek | `openai-compatible` | `deepseek` | `https://api.deepseek.com/v1` | `GET /models` | `openai` |
| OpenRouter | `openai-compatible` | `openrouter` | `https://openrouter.ai/api/v1` | `GET /models` | `openrouter` |
| Anthropic | `anthropic` | `anthropic` | 官方端点（省略 `baseURL`） | `GET /models`（`https://api.anthropic.com/v1/models`） | — |
| OpenCode Zen | `openai-compatible` | `opencode-zen` | `https://opencode.ai/zen/v1` | `GET /models` | — |
| OpenCode Go | `openai-compatible` | `opencode-go` | `https://opencode.ai/zen/go/v1` | `GET /models` | — |
| 其他 OpenAI 兼容 | `openai-compatible` | 用户输入 | 用户输入 | `GET /models`（可能不提供） | `openai` |
| 其他 Anthropic 兼容 | `anthropic` | 用户输入 | 用户输入（可留空用官方端点） | `GET /models`（失败转手动输入；ADR-0026 §3） | — |

- 预设只负责向导里的默认值；写进 `providers.json` 的是完整条目，之后与手写条目没有区别。预设数据更新不会改变已写入的条目。
- OpenCode 两个预设（[ADR-0031](../decisions/ADR-0031-opencode-presets-responses.md) §5）额外写死 `sessionHeader: "x-opencode-session"`（同系网关要求，Zen 文档未写明但带上无害）与 `modelsDevProvider`（`opencode` / `opencode-go`，启用 models.dev 服务商层的逐模型接口声明，见 [providers.md](providers.md) 第 2 节）；默认凭据变量名 `OPENCODE_API_KEY`，密钥入口为官方文档的 `https://opencode.ai/auth`。
- 新增预设的门槛：服务地址与协议兼容性有官方文档可查，并在真实服务上跑过一次连接测试。未满足的服务走"其他 OpenAI 兼容"。

## 6. Core 接口

服务商配置的判断逻辑（预设、哪些字段要问、凭据方式、无后端时怎么办、模型列表失败怎么提示、文件写入、登录会话）全部在 Core，以**数据接口**暴露（[ADR-0044](../decisions/ADR-0044-rpc-stdio.md) 第 6 节）：`describeProviderSetup` 描述某个预设需要填什么，`prepareProvider` 获取模型列表并暂存表单，`commitProvider` 在确认后保存。Core 不回调客户端、不持有任何界面概念；CLI 逐行向导、TUI 服务商页与 RPC 客户端（桌面端原生表单）都是这些接口的外壳——RPC 客户端经 `provider.*` / `login.*` 方法使用同一组接口，配置变更由服务端串行重载并推 `runtime.providersChanged`（[rpc.md](../protocols/rpc.md) 3.3、3.4）。登录接口是 `startProviderLogin` / `startDraftProviderLogin` / `discardDraftLogin` / `logoutProvider` / `LoginSession`（[provider-api.md](../protocols/provider-api.md) 第 1 节）。`fetchModels` 与模型请求都经同一 `AuthResolver` 取令牌。接口不发送模型对话请求。v0.3 起配置不再选择模型：`addProvider` 只把服务商配上，结果只含 `providerId` 与已登记模型数。

```ts
// @nocturne/core 公开导出
listProviderPresets(): ProviderPreset[]
fetchModels(entry: ProviderConfig, key: string | undefined, signal): Promise<UpstreamModel[]>
  // GET /models（anthropic 条目为 <baseURL 或官方默认 https://api.anthropic.com/v1>/models；
  //   ADR-0026 §3）；UpstreamModel = { id, displayName?, contextWindow?, maxOutputTokens?,
  //   pricing?, capabilities?, endpoints? }——只含上游明确声明的字段（第 7 节），endpoints
  //   为 supported_endpoints 原文；HTTP 错误抛
  //   ProviderUpstreamError（携带 status），不支持时返回 []

// 服务商配置（provider-setup.ts）
describeProviderSetup(config: RuntimeConfig, presetId: string): ProviderSetupDescription
  // { presetId, label, type, fields, credential, fetchableModels, manualModel? }
  //   fields：该预设要问的 name / baseURL / sessionHeader，每项带提问行、灰色说明、是否必填，
  //     预设写死的值带 fixed（不询问，客户端仍把它显示进步骤摘要）；
  //   credential：{ backend, methods, choose?, accountStorage? }
  //     methods 按首选顺序：apiKey（available 取决于凭据后端，留空回落到 env）、env（默认变量名）、
  //     login（account 区分账号登录与 OpenRouter 的 API key 登录）、external-file（Grok CLI）；
  //     choose 存在时先选一项（OpenRouter：浏览器登录 / 粘贴密钥）；
  //     accountStorage 仅账号型登录且无系统后端时给出（风险说明、选项、重试提示）；
  //   fetchableModels：提交时是否会获取模型列表；manualModel：上游无列表时手填模型 ID 的提问
prepareProvider(config, input: AddProviderInput, options?: AddProviderOptions): Promise<PrepareProviderResult>
  // input = { presetId, name?, baseURL?, sessionHeader?, credential, modelId? }
  // credential = { kind: "apiKey", key } | { kind: "env", name } | { kind: "login", loginId } | { kind: "external-file" }
  // 校验 → GET /models（options.signal 可取消）；不写文件、凭据，也不消费 loginId。
  // 账号令牌解析和续期使用独立的内存存储，不创建锁文件。
  // 字段校验后检查名称唯一性（第 2 节「名称唯一性」，options.workspaceRoot 给出时并入该工作区的项目层），
  //   重名抛 ProviderSetupError("name")，不发请求。
  // 返回 { draftId, modelCount, models, notices, needsManualModel, steps }；models 是获取到的上游模型摘要
  //   （id、displayName?、reasoning?、imageInput?、contextWindow?、maxOutputTokens?），供保存前预览；
  //   draftId 不透明，绑定 config，15 分钟过期自动清理。
  // notices 包含模型列表成功/失败的步骤与说明；steps 为已完成步骤摘要，均不包含密钥。
commitProvider(config, draftId, { manualModelId? }): Promise<AddProviderResult>
  // 再查一次名称唯一性 → 校验模型 ID → 删除同 id 孤立凭据 → 写入凭据和条目（saveSetupProvider mode "create"）
  //   → 消费 loginId → 刷新 models.dev。
  // needsManualModel 时缺模型 ID 抛 ProviderSetupError("modelId")；草稿不存在、过期或重复提交抛 draftId 字段错误。
  // 返回 { providerId, modelCount, notices, message }；此处 notices 只有保存阶段的 models.dev 警告。
  // 保存成功后草稿失效；保存失败可以重试。日志/诊断不记 input、令牌或草稿内容。
discardProvider(config, draftId): void // Esc / 放弃时释放草稿；不消费 loginId
addProvider(config, input, options?): Promise<AddProviderResult>
  // 无中间确认的兼容入口：prepare + commit（input.modelId 作为 manualModelId），合并两阶段 notices；失败也释放草稿。
  // 字段校验抛 ProviderSetupError(field)，取消抛 AbortError；准备阶段什么都没有写入。
setupFieldStep / setupCredentialStep / setupCredentialNotice(description, ...)
  // 已完成步骤的摘要行（"名称 x"、"密钥来源：环境变量 X"）与无后端时的环境变量提示，供各客户端按同一文案显示
startDraftProviderLogin(config, target: { presetId, name, baseURL }, options): Promise<LoginSession>
  // 条目尚未保存时的浏览器登录：会话带 loginId；凭据暂存在 Core（provider-login/pending.ts，随 RuntimeConfig 登记，
  //   不落盘），prepareProvider 收到 { kind: "login", loginId } 校验并使用内存凭据获取模型列表，commitProvider 才落盘并消费登录；
  //   OpenRouter 的密钥作为 key 交给 saveSetupProvider，无后端时条目改读环境变量。预设、名称、地址必须与草稿一致
  accountStorage: "plaintext" | "memory"（ProviderLoginOptions）
  // 无系统凭据后端时的账号凭据保存位置，由客户端经 accountStorage 描述让用户显式选择后传入；缺省不落盘，
  //   startProviderLogin / startDraftProviderLogin 在授权开始前就以 ProviderLoginError("accountStorage") 拒绝
discardDraftLogin(config, loginId): void
  // 丢弃草稿登录暂存的凭据（表单放弃或客户端断开）；进行中的登录用 LoginSession.cancel，commit 后为空操作

// RuntimeConfig（config 模块）新增
credentials: CredentialStore                             // 第 3 节的统一接口；get 结果在进程内缓存
saveSetupProvider(entry: ProviderConfig, opts: { key?: string; mode?: "create" | "replace" }): Promise<void>
  // key 存在时经 credentials.set 写入系统后端并登记 credentials.json 索引；
  //   mode "create" 重读文件后遇同 id（不分大小写）抛 ConfigError("provider_exists")，缺省 "replace" 整条替换
findProviderConflict(id: string, workspaceRoot?: string): Promise<{ id: string; layer: string } | undefined>
  // 名称唯一性检查：在合并层里不分大小写找同名条目，返回原拼写与最高所在层的显示名
setCredential(providerId: string, key: string): Promise<void>
  // 经 credentials.set 完成（缓存随之失效，下一次请求即用新密钥）；/provider key 与服务商页「换密钥」直接调用它
removeSetupProvider(providerId: string): Promise<void>     // 删除条目并经 credentials.delete 删凭据
describeSetupProvider(providerId: string): Promise<ProviderEntryConfig | undefined>
  // 现读 providers.json 里的条目原文（U-07 编辑表单预填用）；非向导条目返回 undefined。
  //   返回对象不含任何凭据字段——凭据只存在于凭据存储，条目从来不携带。
describeProviders(workspaceRoot?: string): Promise<ProviderOverview[]>
  // /provider 与服务商页列表数据：名称、类型、主机名、鉴权描述、认证方式 authKind、凭据状态、保存位置、来源层、
  //   模型数；不含令牌。给 workspaceRoot 时并入该工作区可信项目层的条目。
  // authKind："apiKey"（凭据存储里的密钥）/ "env"（环境变量）/ "account"（ChatGPT、Grok 账号登录）/
  //   "external-file"（外部登录文件）/ "none"（尚无凭据）；客户端据此选择「换密钥」或「重新登录」。
  // 账号凭据状态：每次从磁盘读最新记录（不用进程内缓存），只看本地记录，不发网络请求——
  //   有刷新令牌即为 valid，访问令牌是否过期都一样（下一次请求自动续期）；没有刷新令牌时按访问令牌到期时间
  //   给 valid / expiring（5 分钟内到期）/ expired。刷新令牌被服务端拒绝（invalid_grant 等终止性失败）时，
  //   续期路径在刷新锁内删除该凭据记录，下一次 describeProviders 因此显示 missing（缺少，需要重新登录）。
refreshUpstreamLimits(providerId: string): Promise<string | undefined> // 刷新上游及 models.dev；失败仅返回提示
refreshModelsDev(): Promise<string | undefined>          // 显式更新 models.dev 缓存；失败返回提示
listModelSettings(providerId: string, workspaceRoot?: string): Promise<ModelSettingsView[]>
  // 模型设置编辑（ADR-0024/0026）：逐模型返回七个字段的生效值/来源/可编辑标记
  //   （显示名/上下文长度/最大输出/推理/图片输入/思考档位/协议；协议推导为
  //   unavailable 的模型带 unavailable.reason），只含合并结果清单内的模型
  //   （按模型 id 排序）；服务商不在 providers.json 时整个视图 readonly 并带 readonlyHint
saveModelSettings(providerId: string, modelId: string, patch: ModelSettingsPatch): Promise<void>
  // 写入端：patch（undefined=保留、null=清除用户编辑）应用到条目 userModels；
  //   校验以"保存后的最终生效值"计算（非向导条目、清单外模型、patch 触及
  //   config 来源字段、非正整数、生效最大输出>上下文、推理否与手写档位冲突等抛
  //   config_invalid 且不写文件）；原子写 providers.json，绝不写 config.json

// 编辑自定义服务商（U-07，provider-setup.ts）
probeSetupProviderModels(config, params, options?): Promise<UpstreamModelEntry[]>
  // params = { providerId, type, baseURL?, headers? }：按候选配置向候选地址发一次模型列表
  //   请求；凭据按条目现有规则解析（apiKeyEnv → 环境变量 → 凭据存储），不写任何配置与凭据。
  //   失败原样抛错，由客户端决定是否「仍然保存」。
updateSetupProvider(config, providerId, patch): Promise<{ providerId, modelCount, message }>
  // 只允许 providers.json 里的自定义条目：非向导条目抛 ProviderSetupError("providerId")；
  //   id 与地址同某内置 preset 一致的条目（内置预设写出的条目）抛 ProviderSetupError("preset")——
  //   内置服务商的地址与协议由程序维护。patch 缺省字段保留原值；字符串字段空串表示清除
  //   （displayName / baseURL(仅 anthropic 可清) / sessionHeader），headers 整表替换；
  //   models 提供时随条目更新清单并重写 source/fetchedAt，缺省保留原清单。
  //   保存走 saveSetupProvider(mode "replace")：凭据与逐模型用户编辑自动保留。
setDefaultModel(model: string, effort: ReasoningEffort | null): Promise<SettingItem[]> // 成对写入 settings.json；Runtime 同名公开接口
recentModels(): ModelRef[]                               // recent-models.json 当前内容（新→旧）
recordRecentModel(ref: ModelRef): Promise<void>          // Runtime 在 setModel/新建会话时调用

// Runtime 新增
runtime.updateProviders(config: RuntimeConfig): Promise<void>
runtime.defaultModel(): ModelRef | undefined             // 分层合并后的默认模型（"默认模型"标记）
runtime.listRecentModels(): ModelRef[]                   // 模型选择页"最近使用"范围的数据源
```

**客户端外壳**：行式 CLI 与 TUI 服务商页的步骤顺序必须一致，所以不各写一遍，而是共用 `apps/tui` 的 `provider-setup-flow`（`runProviderSetupFlow` / `runProviderKeyFlow`）与 `provider-prompts`（`SetupPrompts`：`ask` / `askSecret` / `chooseMulti` / `busy` / `step` / `print`，`SetupAbort`）——这是客户端自己的流程，不属于 Core：它按 `describeProviderSetup` 的描述逐项提问、把答案交给 `prepareProvider`，显示列表结果与手填模型提问后再确认并 `commitProvider`，不判断任何预设差异。CLI 实现 `SetupPrompts` 为逐行输入（`apps/cli/src/setup.ts` 的 `createSetupPrompts`），TUI 实现为服务商页弹层（`wizard-io.ts` 的 `useProviderWizard`）。RPC 客户端不需要这层，直接按描述渲染表单后调用 prepare / commit。`/provider model` 的逐字段问答是纯客户端流程（`apps/cli` 的 `runProviderModelWizard`），收集完一次性 `saveModelSettings`（ADR-0024 第 4 节、ADR-0026 第 7 节）：逐字段显示"当前值（来源）"，回车保留、- 清除；推理用 y/n/-，为否时不问档位；协议输入 chat/messages/responses/-。

**提交流程与取消**：收集字段与凭据 → `prepareProvider`（「正在获取模型列表…」）→ 显示 notices → `needsManualModel` 时问「模型 ID」→「保存配置」确认（TUI；行式 CLI 直接提交）→ `commitProvider` → 结果行。列表失败提示必须在确认前可见，外部登录文件的手填模型步骤同样在确认前。获取模型列表期间 Esc 取消信号并保留输入，回到确认页决定是否重新准备；取消确认或模型输入时 `discardProvider` 释放草稿。保存阶段放行到完成。

`runtime.updateProviders`：用新的基础层配置重建运行时级 Provider 注册表；每个已打开会话在下一次空闲边界重建自己的会话级注册表（基础层 + 该会话的可信项目层）。`listModels` 展示当前工作区已加载的合并结果，包含可信项目层，供 `/model` 和 `/settings` 按生效模型能力列出档位。当前会话正在使用的服务商不会被移除（客户端在删除前检查，Core 在重建时对仍被引用的服务商保留原实例并发出 `runtime.warning`）。重载同时按各会话工作区增量 reconcile MCP（见 [mcp.md](mcp.md) 第 4 节），调用方等待完成；未变化的服务器不重启。它不产生持久事件；随后的 `setModel` 照常写 `session.config_changed`。

为什么不"关闭会话再用新配置重新打开"：那会触发 `SessionEnd`/`SessionStart` Hook、重启全部 MCP 服务器、重新取锁——添加一个服务商不应该有这些副作用。

## 7. 模型限额以上游声明为准

价格按手写配置 > 上游清单 > models.dev 取整个对象。内置预设的 `modelsDevPricing` 随 `modelsDevProvider` 的保存路径写入 providers.json，但只用于取价；缺省时回退到该条目已有的 `modelsDevProvider`，不改变协议推断。预设更新不改变已保存条目。OpenRouter 的 `input_cache_read` / `input_cache_write` 与输入输出价一样从每 token USD 换算为每百万 token，保存为 `cacheRead` / `cacheWrite`（包括零价）。models.dev 分档 `tier.size` 映射为 `aboveInputTokens`；价格来源标记进入 ModelInfo。详见 [ADR-0053](../decisions/ADR-0053-usage-and-cost.md)。

上下文窗口与最大输出长度是服务方的事实，应当由上游声明，而不是由 Nocturne 猜。v0.1 对目录外模型一律套用 `contextWindow` 128000、`maxOutputTokens` 4096，在实测中两头都错：commandcode 网关对 `deepseek/deepseek-v4.1-flash` 声明 `context_length` 为 1000000（按 128000 计算会过早触发压缩）；OpenRouter 对同一模型声明 `top_provider.max_completion_tokens` 为 393216（按 4096 截断会让一次大文件写入被切断）。

**来源与优先级**（高者覆盖低者）：

```text
默认值 < 内置目录 < models.dev < 上游声明 < 用户编辑 < 手写配置
```

- **上游声明**来自服务的模型列表接口，在向导保存服务商时、以及 `/provider refresh <name>` / 服务商页「刷新模型列表」时获取，写入 `providers.json` 对应条目的 `models`，并在条目上记录 `source: "upstream"` 与 `fetchedAt` 获取时间。不在每次启动时请求（避免启动依赖网络）。
- 字段映射只读有明确含义的字段：
  - OpenAI 兼容格式：`id` → 模型 id；`name` → `displayName`；`context_length` → `contextWindow`；
  - OpenRouter（同属 OpenAI 兼容形状）：`top_provider.max_completion_tokens` → `maxOutputTokens`（`top_provider.context_length` 优先于顶层 `context_length`）；`pricing`（按 token 计价的 USD 字符串）换算为每百万 token 写入 `pricing.input`/`pricing.output`；`supported_parameters` 含 `reasoning` → `capabilities.reasoning`；`architecture.input_modalities` 含 `image` → `capabilities.imageInput`；
  - ChatGPT 账号（`openai-siwc`，[ADR-0042](../decisions/ADR-0042-provider-oauth.md)）：只取 `models[]` 中 `visibility == "list"` 的项，`slug` → 模型 id；`display_name` → `displayName`；`context_window` → `contextWindow`；`input_modalities` 含 `image` → `capabilities.imageInput`；模型列表请求发送一个足够大的 `client_version`，以列出账号可用的全部模型；参数未写入官方文档，若日后失效，最坏只是列表变短，不影响登录与推理。
  - Anthropic 模型列表接口按其官方文档返回的限额字段映射（实现时对照文档，没有的字段不猜）；
  - `supported_endpoints`（字符串数组、非空才记）原文写入 `models.<id>.endpoints`，参与逐字段合并并据此推导模型生效协议（[providers.md](providers.md) 第 2 节、ADR-0026 §2）；手写配置也可在 `models.<id>.endpoints` 声明同一字段。
- `reasoning`/`imageInput` 复用 `ModelCapabilities` 的既有字段，但**只在有声明时设置**——上游没声明的字段保持目录/保守默认，不因"没在 supported_parameters 里看到"而断言不支持（清单字段的覆盖范围各服务不统一）。八个字段（`displayName`/`contextWindow`/`maxOutputTokens`/`reasoning`/`imageInput`/`reasoningEffort`/`protocol`/`editTool`）另有用户编辑一级：providers.json 条目的 `userModels`（`/provider model` 或服务商页「编辑模型」写入）位于上游声明之上、手写配置之下，完整优先级见 [providers.md](providers.md) 第 2 节。`editTool`（ADR-0035 §5）不接受上游映射——条目/覆盖未声明且内置目录未命中时，由按模型 id 末段匹配的内置默认表兜底（含 `gpt`/`codex`，不区分大小写 → `apply_patch`，否则 `edit`）。
- 上游或 models.dev 标明支持推理且没有逐模型档位声明时推导完整六档；用户可通过「编辑模型」或手写 `capabilities.reasoningEffort` 收窄。旧 `thinking.levels/source` 在运行时忽略，下次程序写入该条目时删除；启动提示见 [events.md](../protocols/events.md)。
- 写入 `models` 的 `pricing` 进入 `ModelInfo.pricing`（[provider-api.md](../protocols/provider-api.md) 第 2 节）；模型选择页按这些字段渲染"推理 / 图片输入 / 上下文 / 价格"列（[tui.md](../apps/tui.md) 第 7 节），未声明的列留空，不编造数据。
- **最大输出长度未知时不替上游做决定**：
  - `openai-compatible`：请求**不带** `max_tokens`，由上游按它自己的上限处理；
  - `anthropic`：协议要求必填，只有这种情况使用兜底值（8192），并在提示中说明。
  - 上下文预算为输出预留的空间与发送的值分开：未知时按兜底值预留，只影响本地预算估算，不发送给上游。
- **上下文窗口未知时**仍按 128000 估算（预算必须有一个数），同时在会话打开与 `setModel` 时发出 `runtime.warning(code="model_capabilities_defaulted")`，说明哪些值是默认的、如何运行 `/provider refresh` 或在 `config.json` 的 `models` 里声明；`/context` 报告显示同样的标注。
- 这要求 `ModelInfo.maxOutputTokens` 与 `ModelRequest.maxOutputTokens` 变为可选（[provider-api.md](../protocols/provider-api.md) 第 2、3 节），属于协议契约变化，见 [ADR-0016](../decisions/ADR-0016-model-limits-from-upstream.md)。

## 8. 本阶段不做

- API key 的明文凭据后备：没有系统后端时只提供环境变量方式。账号登录记录的明文或内存选择见第 3 节，不适用于 API key。
- Windows 凭据管理器（Credential Manager）：读取需要经 PowerShell 动态编译 P/Invoke 代码，启动慢且易被安全软件拦截；DPAPI 提供同等的"仅当前用户可解密"保护，本阶段只用 DPAPI。
- 官方未开放给第三方的订阅登录（如 Claude.ai）：不模拟官方客户端，不借用未公开的 client_id。Grok Build 是例外：没有注册端点，使用官方公开客户端，但不伪装 User-Agent，见 [ADR-0043](../decisions/ADR-0043-grok-build-oauth.md)。已接入的 ChatGPT、Grok、Grok CLI 凭据与 OpenRouter 登录见 [ADR-0042](../decisions/ADR-0042-provider-oauth.md)。
- 非交互的 `nctrn setup --provider ... --key ...`：命令行上的密钥会进入 shell 历史与进程列表，与"凭据不经命令行"的规则冲突；自动化场景继续使用环境变量或手写配置。
- 项目级向导配置：向导只写用户级文件。项目级服务商配置仍然手写在 `.nocturne/config.json`，并受信任模型约束。
- 探测上游未声明的能力：各服务的模型列表字段不统一，本阶段只映射上游明确声明的字段（第 7 节），不发探测请求、不按模型名猜测。
- 模型选择页的本机实测列（首字延迟、吞吐）：下一步单独实现；本阶段页面只展示上游/配置声明的数据（tui.md 第 7 节预留列位）。
