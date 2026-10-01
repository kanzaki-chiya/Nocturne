# 配置（Config）

> 状态：已接受 v0.1 ｜ 前置阅读：[modules.md](modules.md)、[permissions.md](permissions.md) ｜ 决策：[ADR-0007](../decisions/ADR-0007-config-format.md)、[ADR-0008](../decisions/ADR-0008-project-trust-grants.md)

`config` 模块负责把分散的配置来源合并成一份带出处、带信任标记的运行时配置。它只负责**加载、校验、合并、标注来源**；配置的含义由各模块自己消费（权限规则的解释在 permission，Provider 配置的解释在 provider）。

## 1. 配置来源与分层

```text
内置默认 < models.dev < 向导配置 < 用户编辑 < 程序设置 < 用户配置 < 项目配置 < 环境变量 < 命令行参数
```

| 层 | 位置 / 来源 | 信任 | 说明 |
|---|---|---|---|
| 内置默认 | 代码内常量 | 可信 | 预设名 `default`、Turn 默认值等；不是一个文件 |
| models.dev | 随版本快照或 `<NOCTURNE_HOME>/cache/models-dev.json` | 可信 | 只为已有模型补全推理、图片输入、上下文与最大输出；低于上游逐字段声明，不写入 `providers.json`（ADR-0025）；条目声明 `modelsDevProvider` 时另按服务商提供逐模型 `endpoints`（ADR-0031 §4，[providers.md](providers.md) 第 2 节） |
| 向导配置 | `<NOCTURNE_HOME>/providers.json` | 可信 | `nctrn setup` 与 `/provider` 原子写服务商；旧 `model` 继续读取但不再写入，默认模型改存程序设置层（[provider-setup.md](provider-setup.md)） |
| 用户编辑（`userModels`） | 同上 providers.json 条目的 `userModels` 字段 | 可信 | **合成层**：加载时由条目内 `userModels` 包成 `{providers:[{id,models:userModels}]}`，插在向导层与用户配置之间；只作用于 `models` 逐字段合并，不产生权限规则等其他字段（ADR-0024，见第 2 节） |
| 程序设置 | `<NOCTURNE_HOME>/settings.json` | 可信 | 白名单设置参与合并，界面偏好只保留；低于所有手写配置（[ADR-0034](../decisions/ADR-0034-settings-layer.md)，见第 2 节） |
| 用户配置 | `<NOCTURNE_HOME>/config.json` | 可信 | 用户手写的偏好；**程序从不改写它** |
| 项目配置 | `<workspaceRoot>/.nocturne/config.json` | **默认不可信** | 来自被操作的仓库，见第 3 节信任模型 |
| 环境变量 | `NOCTURNE_*` | 可信 | 见第 5 节；凭据经环境变量或操作系统凭据后端进入（索引文件 `credentials.json` 不含明文）（v0.2，[provider-setup.md](provider-setup.md)） |
| 命令行参数 | `nctrn` 参数 | 可信 | 本次启动的显式意图，优先级最高 |

机器维护的运行时数据（信任列表、项目 Grant、向导配置、程序设置、凭据索引、最近模型列表、models.dev 缓存）不放在 `config.json` 里，而是各自独立的 JSON 文件（`trust.json`、`grants/`、`providers.json`、`settings.json`、`credentials.json`、`recent-models.json`、`cache/models-dev.json`，见第 3、4 节与 [provider-setup.md](provider-setup.md) 第 2 节）——程序写自己的文件，不碰用户手写的配置。

交互输入历史由 Core 的 `RuntimeSession.readInputHistory()` / `recordInputHistory(text)` 管理，保存在 `<NOCTURNE_HOME>/history.jsonl`，**明文保存输入原文**，文件创建权限 `0600`（POSIX）；每行是 `{text, workspaceRoot, time}`。历史按会话绑定的工作区过滤，连续重复输入只记录一次，超过 1000 条保留最近 1000 条。TUI 提交前展开粘贴占位，读取后在输入框重新收起多行原文。读写故障发 `runtime.warning`，不阻断输入；CLI 与 TUI 都不直接读写此文件。

逐层合并后的结果叫 `ResolvedConfig`：每个字段都知道自己来自哪一层（用于诊断与权限规则的命中解释）。

## 2. 配置文件格式与 schema

两个配置文件都是**严格 JSON**（不支持的写法：注释、尾逗号、单引号）。理由与备选见 ADR-0007。

- 解析失败或不符合 schema：**用户配置**直接报错（快速失败，不带着半截配置启动）；**项目配置**整份忽略并发出警告（仓库里的坏文件不应阻塞会话，但也不能静默生效一半）。
- 文件不存在即跳过该层；`NOCTURNE_HOME` 改变时全部位置随之移动。

```ts
// 配置字段共用一个 schema；程序从不改写用户或项目 config.json
interface ConfigFile {
  /** false 时不联网更新 models.dev，仍使用随版本内置的快照 */
  modelsDev?: false;
  /** 默认模型，"provider/model" 形式 */
  model?: string;
  /** 新会话的默认思考档位（ADR-0018；缺省 off）。档位是否可用由所选模型的声明决定，
      不支持时按就近降档生效 */
  reasoningEffort?: ReasoningEffort;
  /** Provider 声明式配置，形状即 RuntimeOptions.providerConfigs 的元素；
      条目上的 thinking.format / thinking.budgets 见 provider-api.md；旧 levels/source 忽略 */
  providers?: ProviderConfig[];
  permissions?: {
    /** 预设名；缺省 "default" */
    preset?: "read-only" | "default" | "auto-edit" | "guarded";
    /** 追加的权限规则，形状即 PermissionRule（permissions.md 第 2 节） */
    rules?: PermissionRule[];
  };
  /** shell 选择（ADR-0022）：auto | pwsh | powershell | bash | cmd | sh */
  shell?: string;
  /** 非标准安装位置的可执行文件路径；种类仍由 shell 决定。
      未给 shell 时：文件名匹配已知 shell（pwsh/powershell/bash/cmd/sh）可推断种类，
      否则声明无效——合并层警告后忽略（不静默回退 auto 吞掉路径） */
  shellPath?: string;
  /** Turn 参数覆盖（agent-loop.md 3.8）。maxSteps 为可选正整数：设置后主对话
      单 Turn 步数受其限制并以 max_steps 收尾；未设即不限制 */
  turn?: { maxSteps?: number; retryLimit?: number; retryBaseDelayMs?: number; firstEventTimeoutMs?: number; idleTimeoutMs?: number };
  /** MCP 服务器（stdio，Phase 5；见 architecture/mcp.md 第 3 节） */
  mcp?: { servers?: Record<string, McpServerEntry> };
  /** Hooks（外部命令，Phase 5；见 architecture/hooks.md 第 2 节） */
  hooks?: Partial<Record<HookPoint, HookEntry[]>>;
}
```

`mcp` 与 `hooks` 的条目形状分别在 [mcp.md](mcp.md) 第 3 节与 [hooks.md](hooks.md) 第 2 节定义。两段都是**可执行内容**：`command`/`args` 意味着启动任意进程，信任语义见第 3 节。`env` 中的 `${NAME}` 引用只记变量名、值在启动时从进程环境展开（mcp.md 第 3 节）；与 `providers` 同规则，出现疑似凭据字面量的字段按 `config_credential_rejected` 拒绝该层。

合并规则：

| 字段 | 合并方式 |
|---|---|
| `model`、`permissions.preset`、`reasoningEffort`、`turn.*`、`shell`、`shellPath` | 高层覆盖低层 |
| `providers` | 按 `id` 合并：同 id 条目浅合并（高层字段覆盖），其中 `models` 按模型 id **逐字段合并**（ADR-0024 第 2 节）：顶层字段（`displayName`/`contextWindow`/`maxOutputTokens`/`pricing`/`protocol`/`endpoints`）逐个覆盖、`capabilities` 逐键覆盖、数组字段（`reasoningEffort`/`endpoints`）由最高层整体替换（显式空数组同样生效、不并集）；不同 id 并存 |
| `permissions.rules` | 追加：高层规则排在低层之后（权限"后写优先"语义见 permissions.md 5.1） |
| `mcp.servers` | 按服务器 id 浅合并（同 `providers`）；不同 id 并存 |
| `hooks.*` | 按事件点追加：用户级条目在前、项目级在后，执行顺序即此顺序（hooks.md 第 2 节） |

**`userModels` 合成层**（ADR-0024 第 2 节）：providers.json 条目里的 `userModels`（模型编辑页 / `/provider model` 写入的逐模型用户编辑）不是合并结果的一部分，而是加载时被包成一个独立层——`providers: [{ id, models: userModels }]`——插在向导层（setup）与 `config.json`（user）之间参与 `models` 逐字段合并。因此用户编辑优先于上游声明、低于任何手写层；只由该层引入、其他层都不声明的模型条目在合并后被丢弃。推理为 `none` 时没有可用思考档位；冲突处理见 [providers.md](providers.md) 第 2 节。`capabilities.editTool`（`"edit" | "apply_patch"`，ADR-0035 §5）同样经该链生效：手写配置与 `userModels` 都可声明；都未声明时由内置默认表按模型 id 末段匹配（含 `gpt`/`codex`，不区分大小写 → `apply_patch`，否则 `edit`）。

models.dev 数据在启动时从缓存或内置快照读取，启动不联网；添加服务商或刷新模型列表时才 GET 更新，10 秒超时，失败沿用本地数据并提示。`config.json` 的 `modelsDev: false` 关闭联网并只使用内置快照。缓存比快照新时优先使用缓存。匹配规则与字段映射见 [providers.md](providers.md) 第 2 节。

**程序设置层 `settings.json`**（[ADR-0034](../decisions/ADR-0034-settings-layer.md)）：白名单为 `model`、`reasoningEffort`、`permissions.preset`、`shell`、`shellPath`，与 `config.json` 共用 schema，按第 1 节的顺序参与通用合并。损坏文件忽略并警告；无效字段逐个忽略并警告，其余合法字段继续生效，不阻塞启动。白名单外字段（包括 `permissions` 中的未知成员）原样保留，但不参与合并；`theme` 等界面偏好仍由客户端解释。写入采用临时文件 + rename，成功后才更新内存，失败保留旧值，同进程并发写入串行执行，避免设置与偏好互相覆盖。

Shell 也走通用合并，`session.setShell` 仍先探测可执行文件，再写 `shell`/`shellPath`；`auto` 清除保存值。保留 ADR-0022 的声明边界：手写层之间逐字段覆盖；手写配置覆盖程序 shell 设置、环境变量覆盖配置时，替换整份 shell 声明，不继承低层路径。自动选择与非法环境变量降级见 [tools.md](tools.md) 第 6 节。

公开 Runtime 设置接口：

```ts
describeSettings(): SettingItem[]
updateSettings(patch: SettingsPatch): Promise<SettingItem[]>
setDefaultModel(model: string, reasoningEffort: ReasoningEffort | null): Promise<SettingItem[]>
```

`SettingItem` 给出默认预设、默认模型、默认档位和 shell 的生效值、来源、保存值与覆盖标记；默认模型与默认档位只读。`SettingsPatch` 只接受 `permissions.preset`，`null` 清除；默认档位不能单独修改，只随默认模型经 `setDefaultModel` 成对保存（ADR-0034 修订），`setDefaultModel` 按该模型的可用档位校验，不支持时以 `invalid_command` 拒绝并列出可选值。`setDefaultModel` 在一次原子写入中保存模型和档位，`null` 清除档位；不再写 `providers.json`，其中旧 `model` 仍按向导层读取。完整类型见 ADR-0034 第 3 节。未注入 `RuntimeConfig` 时读取返回空数组，写入 Promise 拒绝。

这些默认值只影响之后新建的会话，已有会话和恢复的会话继续使用自己的配置快照；`/new` 使用最新生效默认值。`/model` 页「设为默认」是显式切换，会同时修改当前会话；`/settings` 不修改当前会话的模型、档位或权限。

**通用界面偏好**（[ADR-0029](../decisions/ADR-0029-tui-themes.md) 第 3 节）：`RuntimeConfig` 与公开的 `Runtime` 都提供 `getPreference(key: string): string | undefined`、`setPreference(key: string, value: string | undefined): Promise<void>`。它们读写 `settings.json` 顶层的普通字符串字段；`undefined` 删除字段。写入拒绝无效字段名、`shell`/`shellPath` 等有专用接口的保留字段和非字符串值；原子写盘成功后才更新内存，失败时旧值不变，未知字段原样保留。`Runtime` 委托注入的 `RuntimeConfig`；`createRuntime` 未传 `config` 时，读取返回 `undefined`，写入返回被拒绝的 Promise，错误为「未注入 RuntimeConfig，无法保存偏好」。Core 不解释偏好值的 UI 含义；TUI 在首次渲染前读取 `theme`，由 TUI 判断 `dark`/`light`，非法值回退 `dark`；`/theme` 保存失败时保持原主题并留在选择页提示错误。

## 3. 项目配置的信任模型

项目配置来自被操作的仓库——它可能是恶意的。因此：

- **未信任时**，项目配置里只有 `permissions.rules` 中**收紧方向**（`ask` / `deny`）的规则参与求值：与可信结果取更严格者，`allow` 被忽略。其余字段（`model`、`providers`、`preset`、`reasoningEffort`、`turn`、`shell`、`shellPath`）全部忽略；`mcp` 与 `hooks` 两段同样**整段忽略**——它们定义的是要启动的进程，"运行但收紧"没有意义（进程一旦启动就是任意代码），收紧方向在可执行配置上不存在。这保证一份仓库配置永远无法放宽用户的安全边界、无法把会话引到别的 Provider 或模型，也无法让它在用户不知情时执行任何命令。
- **信任后**，项目配置整体进入第 1 节的正常分层（规则排序位于用户配置之后、环境变量之前）。
- 信任的标记存放在**机器维护的** `<NOCTURNE_HOME>/trust.json`：`{ version, workspaces: string[] }`，列出工作区真实路径（`realpath` 后比较，大小写规则同平台）。文件由 `nctrn trust` / `nctrn untrust` 原子写（临时文件 + rename）；用户也可以手工编辑。它是唯一能授予信任的来源——项目配置里没有这个字段，仓库不能自我授权。
- 会话打开（create / resume）时若发现项目配置存在但未信任，发出临时事件 `runtime.warning(code="project_config_untrusted")` 告知客户端；CLI 显示如何信任（`nctrn trust`，见 [apps/cli.md](../apps/cli.md)）。

## 4. Grant 的持久化

用户在权限确认中选择"在此项目中始终允许"时，生成的是**项目级 Grant**——它不是配置，而是运行期积累的授权记录，因此不写入 `config.json`：

- 位置：`<NOCTURNE_HOME>/grants/<workspaceKey>.json`。`workspaceKey` = 工作区真实路径的规范化形式（含盘符），经非字母数字字符替换为 `_` 后截取，前缀带短散列防冲突；文件内同时记录 `workspaceRoot` 原文用于校验与诊断。
- 内容：`{ version, workspaceRoot, grants: Grant[] }`；Grant 的形状与匹配语义见 [permissions.md](permissions.md) 第 5.4 节。
- 写入：整文件原子替换（临时文件 + rename）。
- 损坏或版本不符的 Grant 文件：忽略并警告，不阻塞会话；丢失授权的后果只是重新询问。
- 会话级 Grant 不落盘，随会话关闭失效（sessions.md 第 6 节的"不可恢复"表）。

Grant 文件的读写由 `config` 完成（它是"按工作区存放的用户数据"的拥有者），权限层只面对内存中的 Grant 集合——保持权限层零 I/O。

## 5. 环境变量层

环境变量在分层中是一个普通层（位于项目配置之上、命令行之下）：

| 变量 | 映射到 |
|---|---|
| `NOCTURNE_MODEL` | `model` |
| `NOCTURNE_API_TYPE` + `NOCTURNE_BASE_URL` + `NOCTURNE_API_KEY` / `--api-key-env` 指定的变量 | 合成一个 Provider 条目：`id` 取 api-type 值，`apiKeyEnv` 记录变量名（凭据值本身不进配置对象，由适配器经 `platform.env` 读取） |
| `NOCTURNE_HOME` | 数据目录位置（由 platform 消费，见 [repository-layout.md](../development/repository-layout.md) 第 5 节） |
| `NOCTURNE_SHELL` | shell 选择的最高层（ADR-0022）：种类名 `auto \| pwsh \| powershell \| bash \| cmd \| sh`，或可执行文件路径/文件名（按文件名识别种类，忽略大小写与 `.exe`）；无法识别时启动警告并回退自动选择（tools.md 第 6 节） |

- `NOCTURNE_API_TYPE` 缺省 `openai-compatible`；仅当该层至少能提供 `type` 之外的必填字段（openai-compatible 需要 `baseURL`）或显式设置了 `NOCTURNE_API_TYPE` 时才合成 Provider 条目。
- 命令行参数层同理合成一个条目（id 同 api-type），按 id 合并规则覆盖同 id 的环境变量条目。
- 合成条目的模型清单：环境变量/参数只给出"当前要用的模型"，其余行为与 Phase 2 一致（`allowUndeclaredModels`）。

### 网络代理

`nctrn` 在入口启动时、创建 Runtime 和任何网络请求之前调用公开的 `configureEnvProxy()`；逐行 CLI、TUI 与 `nctrn setup` 共用这个入口。函数位于 Core 的 platform 层，只在入口显式调用时设置进程全局代理，导入 Core 或调用 `createRuntime` 不会修改全局代理。

读取 `HTTP_PROXY`、`HTTPS_PROXY` 及小写 `http_proxy`、`https_proxy`，并将 `NO_PROXY` / `no_proxy` 交给 Node 处理；同名大小写变量都设置时小写优先。`NO_PROXY` 是逗号分隔的绕过列表，可匹配主机、域名、端口等，`*` 绕过所有地址；具体语法遵循 [Node 内置代理文档](https://nodejs.org/docs/latest-v24.x/api/http.html#built-in-proxy-support)。这些变量是进程级网络设置，不参与 `NOCTURNE_*` 配置分层，也不控制 MCP 子进程自身的网络实现。

自动初始化使用 Node 的 `http.setGlobalProxyFromEnv`，该 API [自 Node 24.14.0 提供](https://nodejs.org/docs/latest-v24.x/api/http.html#httpsetglobalproxyfromenvproxyenv)。仓库仍支持 Node >=24；有代理地址而当前 Node 缺少该 API 时，启动警告提示升级到 24.14.0 或设置 `NODE_USE_ENV_PROXY=1`，不阻断启动。无代理地址时不做任何设置；已设 `NODE_USE_ENV_PROXY=1` 时沿用 Node 在进程启动时完成的初始化，不重复调用。代理配置触发 `ERR_PROXY_INVALID_CONFIG` 时，启动警告仅报告变量名，不输出地址或用户名、密码；本次自动初始化未完成。启动后修改变量不会自动重配全局代理。

Node 的 fetch dispatcher 对不支持的代理协议也可能抛 `UND_ERR_INVALID_ARG`，按同样的无地址警告处理。

Core 冒烟配置在加载根目录 `.env` 后调用同一函数，冒烟专用 setup 也在 Vitest 测试 worker 入口调用它（worker 继承环境变量，但不继承配置进程的全局 dispatcher）。因此代理地址可以来自启动环境或冒烟环境文件；默认离线测试不会启用全局代理。

## 6. 与 Runtime 的接线

```text
CLI:   loadConfig(platform, { cliArgs })          → RuntimeConfig
         ├── base: ResolvedConfig                  用户+环境+命令行（与项目无关的部分）
         └── forWorkspace(workspaceRoot)           每个会话一次：
               → { resolved: ResolvedConfig        base + 项目层
                  , projectConfig: { present, trusted }
                  , grants: GrantStore             项目 Grant（含 add/持久化）
                  , warnings: string[] }
         setWorkspaceTrusted(root, trusted)        nctrn trust/untrust：原子写 trust.json
```

- `createRuntime` 接受可选的 `config: RuntimeConfig`；缺省时行为与 Phase 2 相同（无配置文件、固定 `default` 预设），测试不受影响。
- 项目层按**会话记录的 `workspaceRoot`** 加载，而不是进程 cwd：恢复会话时信任判定与规则都以会话绑定的目录为准。
- `ResolvedConfig` 的各段经原有 `RuntimeOptions` 字段注入：`providers`→`providerConfigs`、`models`→`modelOverrides`、`turn`→`turn`、权限层（preset + 各层规则 + Grant 集合 + 命令行提升）→ 新的 `permissions` 选项。`policy` 直注入仍保留，供测试与特殊客户端使用。`reasoningEffort` 落在 `ResolvedConfig` 上，新建会话时作为 `session.created.reasoningEffort` 的默认值（ADR-0018 第 4 节）。
- Phase 5 增补：`mcp.servers` → `ResolvedConfig.mcpServers`（按会话 workspaceRoot 解析，带 `origin` 标注，供 `RuntimeOptions.mcp` 的 connector 消费，见 [mcp.md](mcp.md) 第 8 节）；`hooks` → `ResolvedConfig.hooks`（供 `wrapSession` 构造 `HookRunner`，见 [hooks.md](hooks.md) 第 6 节）。两段都只在 `forWorkspace` 展开——项目层是否参与取决于信任状态（第 3 节）。

## 7. 暂不设计

- 配置文件中的凭据值（`config.json` 与 `providers.json` 都不存密钥；密钥只在环境变量或 `credentials.json`，见 [provider-setup.md](provider-setup.md) 第 3 节）；
- JSONC / TOML / 其他格式（ADR-0007 记录了取舍）；
- 通用的配置编辑命令（服务商的交互配置见 [provider-setup.md](provider-setup.md)）、Grant 的查看与撤销界面；
- 每会话不同的用户配置 profile。
