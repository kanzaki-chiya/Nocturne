# 服务商配置向导与凭据存储

> 状态：已接受 v0.2；v0.3 修订（[ADR-0019](../decisions/ADR-0019-tui-visual-provider-page.md)，提议，待验收）｜ 前置阅读：[config.md](config.md)、[providers.md](providers.md)、[permissions.md](permissions.md) ｜ 决策：[ADR-0015](../decisions/ADR-0015-provider-setup-credentials.md)

v0.1 接入一个模型服务要做三件事：设置持久的用户级环境变量存放密钥、在 `config.json` 里手写一整段 Provider 条目（`id`/`type`/`baseURL`/`apiKeyEnv`/`models`）、自己查清服务地址和模型 id。本文设计的目标是让首次配置和日常切换都能在交互中完成：

- `nctrn setup`：首次配置向导，独立于会话运行；
- `/provider`：会话内查看、添加、更新密钥、删除服务商（CLI 与 TUI 都提供）。

两个入口共用同一套 Core 能力（第 6 节），只是交互外壳不同。v0.3 起服务商配置与模型选择分离：向导只管"把服务商配上"，`/model` 是唯一的模型选择入口（[ADR-0019](../decisions/ADR-0019-tui-visual-provider-page.md) 第 3 条）。

## 1. 用户看到的流程

### TTY：服务商页 → 模型页的两步流程

`nctrn setup` 在交互终端直接打开全屏**服务商页**（第 1 步，备用屏幕，[tui.md](../apps/tui.md) 第 8 节）；按 `Esc` 完成后，如果没有默认模型自动进入**模型选择页**（第 2 步）设为默认；两页头部都显示"第 N 步，共 2 步"。没有任何已配置服务商时运行 `nctrn` 走同一流程，选完模型才创建会话进入主界面；有服务商但没有可解析的默认模型时直接进入第 2 步。

服务商页里选中未配置预设后的就地步骤（逐行向导是同一套 Core 编排的同构外壳）：

```text
▸ ○ DeepSeek / OpenRouter / Anthropic / 其他 OpenAI 兼容 / 其他 Anthropic 兼容
（仅自定义预设）名称：commandcode
（仅自定义预设）服务地址：https://api.example.com/v1      ← anthropic 兼容可留空用官方端点
API Key（掩码输入；直接回车表示改用环境变量）：********
密钥已交给 Windows DPAPI 加密保存
✓ 已获取 12 个模型                                       ← 只发 GET /models；失败显示原因并继续
思考强度档位（空格勾选，回车确认；不勾 = 不支持）：         ← 仅上游未声明思考能力时
  [ ] 不支持思考强度  [ ] minimal  [x] low  [x] medium  [ ] high  [ ] xhigh  [ ] max
已保存 command，12 个模型                                ← 底部结果行，回到列表
```

- 三个内置预设不再问名称与地址（直接用预设默认值）；两个自定义预设问名称（必填）与服务地址（openai 兼容必填，anthropic 兼容可留空用官方端点）。
- **向导不再选择模型**（v0.3）：模型列表仍经 `GET /models` 获取并把上游声明的上下文窗口、最大输出长度与能力标记写回条目 `models`（第 7 节），但不再出现"编号选择模型"与"设为默认模型"两步；默认模型在 `/model` 页设置。获取结果替换进行中提示：成功显示"已获取 N 个模型"；失败显示原因并继续后续步骤——`GET /models` 返回 401/403 时提示"密钥可能无效（获取模型列表被拒绝）"，404/网络错误等其余失败提示"模型将手动填写"；保存后可用服务商页「刷新模型列表」或 `/provider refresh <名>` 重试。
- **思考强度声明**（ADR-0018 第 6 节；v0.3 交互形式调整，规则不变）：上游 `/models` 没有声明思考能力时显示**单步勾选**列表，首项是"不支持思考强度"——它与 `minimal/low/medium/high/xhigh/max` 六档互斥（勾它清掉其余勾选，勾任一档位则清掉它）；什么都不勾直接确认同样等于不支持。TUI 用 `↑`/`↓` 移动、空格勾选、回车确认；CLI 逗号分隔编号（0 或空输入 = 不支持，非法输入重问）。勾选结果写到 `thinking.levels` 并标 `source: "user"`（`/provider refresh` 不得覆盖）。
- **TUI 表单形态**（ADR-0019 第 2 条）：全屏页面内不出现需要打字回答的是非题；已完成步骤折叠为一行摘要（如"名称 command • 地址 api.xxx.com • 密钥已保存"），当前步骤用强调色提问、灰色小字给说明（密钥获取入口、回车改用环境变量等）。
- **向导不发送模型请求**：连接测试会消耗 token 且重复了首次真实请求才能发现的问题，因此不做。密钥、地址与模型 id 的有效性由会话中的首次真实请求检验；请求失败时按 `ProviderError.kind` 给出可操作提示（`auth` → 密钥可能无效，附 `/provider key <name>`；`network`/`timeout` → 地址不通，附 `nctrn setup`；`invalid_request`/404 → 模型 id 或地址路径有误），实现位置为 `agent/turn.ts` 的 `providerFailureHint`（turn.completed.error.message，CLI 与 TUI 共用）。
- 系统凭据后端不可用时（第 3 节），跳过保存密钥这一步，直接进入环境变量方式；选择"改用环境变量"时询问变量名（默认按预设 `defaultKeyEnv`），条目写入 `apiKeyEnv`，密钥不落盘。

### 逐行 CLI

`nctrn setup --cli` 与行式 REPL 的 `/provider add` 走逐行向导（步骤同上，无服务商页）：预设按编号选择（自定义预设才问名称与地址）、密钥不回显、模型列表只获取不选择。配置完第一个服务商后提示"用 /model 选择模型"。`nctrn setup` 在非 TTY 环境以退出码 2 退出并提示手写配置的方式（README）。

### 会话内的 `/provider`

| 命令 | 行为 |
|---|---|
| `/provider` | CLI 列出全部服务商：名称、类型、服务地址（只显示主机名）、密钥来源（`凭据文件` / `环境变量 <NAME>` / `缺失`）、来源层（向导 / `config.json` / 项目 / 环境变量），以及当前会话使用的是哪一个。TUI 中打开全屏**服务商页**（[tui.md](../apps/tui.md) 第 8 节） |
| `/provider add` | 逐行向导（CLI）或服务商页内嵌向导（TUI 打开服务商页并选中预设）；保存后提示"用 /model 选择模型" |
| `/provider key <name>` | 更新该服务商的密钥（不回显），保存后即完成；等价于服务商页「换密钥」 |
| `/provider refresh <name>` | 重新从上游获取模型列表与限额（第 7 节），写入向导配置；不覆盖 `thinking.levels` 的用户声明；等价于「刷新模型列表」 |
| `/provider thinking <name>` | 对已配置的服务商重走思考声明步骤（单步勾选，首项"不支持"互斥），写入 `thinking.levels` 并标注 `source: "user"`；等价于「调整思考档位」 |
| `/provider remove <name>` | 删除向导写入的条目及其凭据；当前会话正在使用的服务商拒绝删除；手写在 `config.json` 或其他层的条目只读，提示去对应文件修改；等价于「删除」 |

Turn 进行中这些命令一律提示"会话忙"（与 `/model` 相同的前置条件）。四个子命令与服务商页操作是同一套 Core 编排的快捷方式，命令名与效果在 CLI 与 TUI 一致。

TUI 另有全屏的**模型选择页**（`/model` 打开）：左右双栏（范围/服务商 + 搜索与模型列表）、最近使用置顶、上游声明的上下文/价格/能力标记、窄终端降级、左栏 `○` 预设内嵌添加向导。完整规格见 [tui.md](../apps/tui.md) 第 7 节。

## 2. 向导配置层：`providers.json`

用户手写的 `config.json` 仍然**程序从不改写**（[config.md](config.md) 第 1 节）。向导写入的是一个新的**机器维护文件** `<NOCTURNE_HOME>/providers.json`，它在分层中位于内置默认之上、用户配置之下：

```text
内置默认 < 向导配置 < 用户配置 < 项目配置 < 环境变量 < 命令行参数
```

```ts
interface ProviderSetupFile {
  version: 1;
  /** 默认模型，"provider/model" 形式；由 /model 页"设为默认"写入（v0.3 起向导不写它） */
  model?: string;
  /** 形状同 config.json 的 providers 元素（ProviderConfig），apiKeyEnv 可省略（第 3 节） */
  providers: ProviderConfig[];
}
```

- 合并规则与 `config.json` 相同（按 `id` 合并，`models` 逐条合并）。手写配置里同名的条目覆盖向导条目：用户手写的永远赢。`/provider` 列表会标注"被 config.json 覆盖"，免得用户困惑"为什么向导改了不生效"。
- 写入方式与 `trust.json` 一致：整文件原子替换（临时文件 + rename）；解析失败或版本不符时忽略该文件并发出 `runtime.warning(code="provider_setup_invalid")`（不阻塞启动，与 Grant 文件的处理一致），`/provider` 在列表顶部显示该警告。
- 只有向导与 `/provider` 写这个文件；用户也可以手工编辑，但推荐的手写位置仍是 `config.json`。

为什么不直接改 `config.json`：程序改写用户手写的 JSON 会丢失用户的排版与字段顺序（JSON 没有注释，但顺序和分组对人有意义），并且会模糊"哪些是我写的、哪些是程序生成的"。ADR-0007/0008 已经确立"程序写自己的文件"的模式，本设计沿用它。

同类的机器维护文件还有 `<NOCTURNE_HOME>/recent-models.json`：模型选择页"最近使用"范围的数据源。`{ version: 1, models: string[] }`（"provider/model" 形式，新→旧，最多 10 条），由 Runtime 在 `setModel` 与新建会话时经 `recordRecentModel` 更新，整文件原子写；损坏时忽略（最坏后果是最近列表为空）。

## 3. 凭据存储：交给操作系统

密钥**不以明文落盘**。向导把密钥交给操作系统自带的凭据保护能力，全部通过系统自带的命令完成，不引入原生依赖：

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
- **没有可用后端时不退回明文**：例如无桌面环境的 Linux 服务器没有密钥环。此时向导说明原因，只提供环境变量方式（打印设置命令，不保存密钥）。
- `<NOCTURNE_HOME>/credentials.json` 是索引文件：

  ```ts
  interface CredentialIndex {
    version: 1;
    /** 写入时使用的后端；跨机器拷贝后后端不可用或密文解不开，按"缺少凭据"处理 */
    entries: Record<string, { backend: "dpapi" | "keychain" | "libsecret"; ciphertext?: string }>;
  }
  ```

  只有 DPAPI 需要 `ciphertext`（密文本身）；钥匙串与 libsecret 的密钥留在系统里，索引只记录"这个服务商的密钥存在哪个后端"。原子写，POSIX 上 `0600`。

- **统一接口 `CredentialStore`**（参考 oh-my-pi 的 `AuthStorage → CredentialStore` 分层；区别是它把密钥以明文 JSON 存进 SQLite，我们不存明文）：

  ```ts
  interface CredentialStore {
    /** 取出该服务商的密钥；索引无此 id 或后端取出失败时返回 undefined */
    get(providerId: string): Promise<string | undefined>;
    /** 写入/更新密钥并登记索引；后端不可用时拒绝（向导据此跳过保存密钥这一步） */
    set(providerId: string, key: string): Promise<void>;
    /** 删除密钥与索引条目；不存在时无操作 */
    delete(providerId: string): Promise<void>;
    /** 当前后端标识：界面提示（如"密钥已交给 Windows DPAPI 加密保存"）与测试断言用 */
    backend(): "dpapi" | "keychain" | "libsecret" | "memory" | "none";
  }
  ```

  每个平台一个实现：`dpapi`（Windows，索引存密文）、`keychain`（macOS，`security -i`/`find-generic-password`）、`libsecret`（Linux，`secret-tool`）——三者各自维护 `credentials.json` 索引的原子写与 POSIX `0600`；`memory` 只在内存中保存、不落任何文件，仅供测试；`none` 表示无可用后端（`get` 恒返回 `undefined`，`set`/`delete` 拒绝）。创建时按平台探测：找不到 `security`/`secret-tool` 可执行文件时落到 `none`。
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

1. **内置硬拒绝**（[permissions.md](permissions.md) 5.3）：对 `<NOCTURNE_HOME>/credentials.json` 的 `read` 与 `edit` 一律 `deny`，在规则求值之前生效。任何规则、Grant、`--yes`、`full-access` 预设、Hook 都不能放开它。`grep`/`glob` 的逐条过滤因此自然跳过它。路径同时按词法路径与真实路径匹配（与普通路径规则相同），符号链接绕不过去。
2. **shell 子进程剥离凭据变量**：`shell` 工具启动子进程时，从环境中移除所有已解析服务商的 `apiKeyEnv` 变量名，以及 `NOCTURNE_API_KEY`、`ANTHROPIC_API_KEY` 两个默认名。MCP 服务器已经使用白名单环境（[mcp.md](mcp.md) 第 2 节），不受影响。Hook 维持继承完整环境（它是用户自己配置的脚本，[ADR-0012](../decisions/ADR-0012-hooks.md)）。
3. **命令提示**：命令字符串中出现 `credentials.json`，或调用凭据后端命令（macOS `security …-generic-password` 族、Linux `secret-tool`、Windows `ProtectedData`——DPAPI 的 .NET 入口类名，比 `ConvertTo-SecureString` 更贴近实际读取路径）的 `shell` 调用，在全部预设（含 `full-access`）中至少 `ask`，`label` 为"可能读取 Nocturne 凭据"。这是基于模式的提示，不是可靠检测。
4. `providers.json` 加入"Nocturne 授权数据"一组（permissions.md 第 6 节第 4 条）：对它的 `edit` 至少 `ask`——它能把会话重定向到别的端点。

**权限不是沙箱**（permissions.md 第 1 节）：一条已获准的 shell 命令仍然可以用任何方式取出密钥（比如拼接路径、调用脚本、间接调用系统凭据命令）。第 1、2 条挡住的是工具层面的直接读取与环境变量泄漏，第 3 条只是提示。文档与界面都不暗示凭据文件对 shell 完全不可见。

## 5. 服务商预设

预设是 `provider` 模块里的纯数据：

| 预设 | 类型 | 默认名称 | 服务地址 | 模型列表 | thinking-format |
|---|---|---|---|---|---|
| DeepSeek | `openai-compatible` | `deepseek` | `https://api.deepseek.com/v1` | `GET /models` | `openai` |
| OpenRouter | `openai-compatible` | `openrouter` | `https://openrouter.ai/api/v1` | `GET /models` | `openrouter` |
| Anthropic | `anthropic` | `anthropic` | 官方端点（省略 `baseURL`） | `GET /v1/models` | — |
| 其他 OpenAI 兼容 | `openai-compatible` | 用户输入 | 用户输入 | `GET /models`（可能不提供） | `openai` |
| 其他 Anthropic 兼容 | `anthropic` | 用户输入 | 用户输入 | 手动输入 | — |

- 预设只负责向导里的默认值；写进 `providers.json` 的是完整条目，之后与手写条目没有区别。预设数据更新不会改变已写入的条目。
- 新增预设的门槛：服务地址与协议兼容性有官方文档可查，并在真实服务上跑过一次连接测试。未满足的服务走"其他 OpenAI 兼容"。

## 6. Core 接口

向导的逻辑（预设、模型列表、文件写入）放在 Core，客户端只负责交互；这样 CLI 与 TUI 共用一份行为，也为将来的 RPC 客户端留好入口。向导全程只发 `GET /models`，不发送任何模型请求。v0.3 起向导不再选择模型：`runProviderSetupWizard` 只把服务商配上（凭据 + 上游声明 + 可选思考档位），`WizardResult` 只含 `providerId` 与已登记模型数；选择模型与设默认一律走 `/model`。

```ts
// @nocturne/core 公开导出
listProviderPresets(): ProviderPreset[]
fetchModels(entry: ProviderConfig, key: string | undefined, signal): Promise<UpstreamModel[]>
  // GET /models；UpstreamModel = { id, displayName?, contextWindow?, maxOutputTokens?,
  //   pricing?, capabilities? }——只含上游明确声明的字段（第 7 节）；HTTP 错误抛
  //   ProviderUpstreamError（携带 status），不支持时返回 []

// RuntimeConfig（config 模块）新增
credentials: CredentialStore                             // 第 3 节的统一接口；get 结果在进程内缓存
saveSetupProvider(entry: ProviderConfig, opts: { key?: string }): Promise<void>
  // key 存在时经 credentials.set 写入系统后端并登记 credentials.json 索引
setCredential(providerId: string, key: string): Promise<void>
  // 经 credentials.set 完成（缓存随之失效，下一次请求即用新密钥）
removeSetupProvider(providerId: string): Promise<void>     // 删除条目并经 credentials.delete 删凭据
describeProviders(workspaceRoot?: string): Promise<ProviderOverview[]>
  // /provider 与服务商页列表数据：名称、类型、主机名、密钥来源、来源层、模型数；不含密钥。
  // 给 workspaceRoot 时并入该工作区可信项目层的条目
refreshUpstreamLimits(providerId: string): Promise<void>  // /provider refresh：重新获取并写入 providers.json（不覆盖 thinking.levels 用户声明）
saveSetupThinking(providerId: string, levels: ReasoningEffortLevel[] | undefined): Promise<void>
  // /provider thinking：写入/清除条目 thinking.levels（levels 存在时标 source:"user"）
runProviderSetupWizard(io, config, deps, opts?): Promise<WizardResult>
  // 步骤：预设选择（opts.presetId 直达）→（自定义预设才问）名称/地址 → 密钥
  //   → GET /models →（上游未声明思考能力时）思考档位 → 保存。
  //   WizardResult = { providerId, modelCount }；modelCount 供客户端显示
  //   "已保存 X，N 个模型"的结果行。不再询问模型与默认模型（v0.3）。
runProviderThinkingWizard(io, config, providerId): Promise<void>
  // 重走思考声明步骤（单步多选，首项"不支持思考强度"互斥；空勾选或勾首项 = 清除声明）
  // 后经 saveSetupThinking 保存；provider 须为向导条目
setDefaultModel(model: string): Promise<void>            // 写入 providers.json 的 model 字段（/model 页"设为默认"）
recentModels(): ModelRef[]                               // recent-models.json 当前内容（新→旧）
recordRecentModel(ref: ModelRef): Promise<void>          // Runtime 在 setModel/新建会话时调用

// Runtime 新增
runtime.updateProviders(config: RuntimeConfig): void
runtime.defaultModel(): ModelRef | undefined             // 分层合并后的默认模型（"默认模型"标记）
runtime.listRecentModels(): ModelRef[]                   // 模型选择页"最近使用"范围的数据源
```

`runtime.updateProviders`：用新的基础层配置重建运行时级 Provider 注册表（`listModels` 的数据来源）；每个已打开会话在下一次空闲边界重建自己的会话级注册表（基础层 + 该会话的可信项目层）。当前会话正在使用的服务商不会被移除（客户端在删除前检查，Core 在重建时对仍被引用的服务商保留原实例并发出 `runtime.warning`）。它不产生持久事件；随后的 `setModel` 照常写 `session.config_changed`。

为什么不"关闭会话再用新配置重新打开"：那会触发 `SessionEnd`/`SessionStart` Hook、重启全部 MCP 服务器、重新取锁——添加一个服务商不应该有这些副作用。

## 7. 模型限额以上游声明为准

上下文窗口与最大输出长度是服务方的事实，应当由上游声明，而不是由 Nocturne 猜。v0.1 对目录外模型一律套用 `contextWindow` 128000、`maxOutputTokens` 4096，在实测中两头都错：commandcode 网关对 `deepseek/deepseek-v4.1-flash` 声明 `context_length` 为 1000000（按 128000 计算会过早触发压缩）；OpenRouter 对同一模型声明 `top_provider.max_completion_tokens` 为 393216（按 4096 截断会让一次大文件写入被切断）。

**来源与优先级**（高者覆盖低者）：

```text
默认值 < 内置目录 < 上游声明 < 手写配置（config.json / 项目配置的 models）
```

- **上游声明**来自服务的模型列表接口，在向导保存服务商时、以及 `/provider refresh <name>` / 服务商页「刷新模型列表」时获取，写入 `providers.json` 对应条目的 `models`，并在条目上记录 `source: "upstream"` 与 `fetchedAt` 获取时间。不在每次启动时请求（避免启动依赖网络）。
- 字段映射只读有明确含义的字段：
  - OpenAI 兼容格式：`id` → 模型 id；`name` → `displayName`；`context_length` → `contextWindow`；
  - OpenRouter（同属 OpenAI 兼容形状）：`top_provider.max_completion_tokens` → `maxOutputTokens`（`top_provider.context_length` 优先于顶层 `context_length`）；`pricing`（按 token 计价的 USD 字符串）换算为每百万 token 写入 `pricing.input`/`pricing.output`；`supported_parameters` 含 `reasoning` → `capabilities.reasoning`；`architecture.input_modalities` 含 `image` → `capabilities.imageInput`；
  - Anthropic 模型列表接口按其官方文档返回的限额字段映射（实现时对照文档，没有的字段不猜）。
- `reasoning`/`imageInput` 复用 `ModelCapabilities` 的既有字段，但**只在有声明时设置**——上游没声明的字段保持目录/保守默认，不因"没在 supported_parameters 里看到"而断言不支持（清单字段的覆盖范围各服务不统一）。
- 上游的 `reasoning` 能力标记会推导该模型的可用思考档位为完整六档（ADR-0018 第 2 节）；逐档位的收窄由用户在向导勾选（`thinking.levels`，`source: "user"`）或手写 `capabilities.reasoningEffort` 完成——`refresh` 不覆盖这些用户声明。
- 写入 `models` 的 `pricing` 进入 `ModelInfo.pricing`（[provider-api.md](../protocols/provider-api.md) 第 2 节）；模型选择页按这些字段渲染"推理 / 图片输入 / 上下文 / 价格"列（[tui.md](../apps/tui.md) 第 7 节），未声明的列留空，不编造数据。
- **最大输出长度未知时不替上游做决定**：
  - `openai-compatible`：请求**不带** `max_tokens`，由上游按它自己的上限处理；
  - `anthropic`：协议要求必填，只有这种情况使用兜底值（8192），并在提示中说明。
  - 上下文预算为输出预留的空间与发送的值分开：未知时按兜底值预留，只影响本地预算估算，不发送给上游。
- **上下文窗口未知时**仍按 128000 估算（预算必须有一个数），同时在会话打开与 `setModel` 时发出 `runtime.warning(code="model_capabilities_defaulted")`，说明哪些值是默认的、如何运行 `/provider refresh` 或在 `config.json` 的 `models` 里声明；`/context` 报告显示同样的标注。
- 这要求 `ModelInfo.maxOutputTokens` 与 `ModelRequest.maxOutputTokens` 变为可选（[provider-api.md](../protocols/provider-api.md) 第 2、3 节），属于协议契约变化，见 [ADR-0016](../decisions/ADR-0016-model-limits-from-upstream.md)。

## 8. 本阶段不做

- 明文凭据文件作为后备：没有系统后端时只提供环境变量方式（第 3 节）。
- Windows 凭据管理器（Credential Manager）：读取需要经 PowerShell 动态编译 P/Invoke 代码，启动慢且易被安全软件拦截；DPAPI 提供同等的"仅当前用户可解密"保护，本阶段只用 DPAPI。
- OAuth 登录、订阅账号登录：providers.md 第 6 节已排除；模拟官方客户端特征的登录方式不纳入。
- 非交互的 `nctrn setup --provider ... --key ...`：命令行上的密钥会进入 shell 历史与进程列表，与"凭据不经命令行"的规则冲突；自动化场景继续使用环境变量或手写配置。
- 项目级向导配置：向导只写用户级文件。项目级服务商配置仍然手写在 `.nocturne/config.json`，并受信任模型约束。
- 探测上游未声明的能力：各服务的模型列表字段不统一，本阶段只映射上游明确声明的字段（第 7 节），不发探测请求、不按模型名猜测。
- 模型选择页的本机实测列（首字延迟、吞吐）：下一步单独实现；本阶段页面只展示上游/配置声明的数据（tui.md 第 7 节预留列位）。
