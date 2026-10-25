# ADR-0062：Magpie Agent 插件与接入层

- 状态：已接受
- 日期：2026-10-25

## 背景

Magpie 是本机网关：持有上游订阅账号与 API 服务商，对外给出一个统一地址和按应用区分的客户端 key，并在应用页（Agent 页）里替用户改写各应用的配置。用户希望在 Magpie 的 Agent 页连接 Nocturne、选模型，使用 Magpie 管理的账号与服务商。

边界：Nocturne 继续独立负责 Agent Loop、上下文、工具与权限；Magpie 负责上游供应商、订阅鉴权与路由。所以要做的是「让 Magpie 能配置 Nocturne」的 **Agent 插件**，不是 Provider 插件，也不把 Nocturne 运行时放进 Magpie。

### 核查结论：旧文档与当前实现冲突

2026-10-25 核对 Magpie 仓库（提交 `75e78a5`）与官方插件文档：

- Magpie `docs/integrating.md` 仍写着「插件不能给 Agent 页加一行；Agent 行只能通过向仓库提 PR 增加」。
- 但 `docs/reference.md`「Agent plugins」、官方网站插件文档的「Agent 插件」一节，以及源码 `internal/plugin/agent.go`、`internal/agentplug`、`internal/agent/plugged.go` 都实现了 Agent 插件：`package.json` 的 `magpie.agent` 指向的模块（或单个 `*.agent.js`）导出 `agent` 与 `connect`。Magpie 插件市场页面已有「Agent」分类（Aider、PiG、Type4Me、Kimi 等社区插件）。
- 结论：以当前实现为准，`integrating.md` 该段已过时；本方案按 Agent 插件实现。

Agent 插件的实际机制（以源码为准）：

- 插件在 Magpie 进程内的 moejs 里运行，没有 Node API，只能导入插件目录内的文件；加载与 `connect` 各限时 1 秒。
- 插件只声明**一个**配置文件（`config`，格式 json / yaml / env）、模型键（`model`）与前缀（`prefix`）。Magpie 自己做全部写入：逐键原地修改，首次写入前把每个键的原值（或「原本不存在」）存入 Magpie 自己的暂存区，断开或切回 Agent 自己的模型时逐键还原、不存在的键删除。文件不会被整体覆盖。
- `connect({gateway, model, models, agent})` 返回要和模型一起写入的键值（键为点路径，值可以是对象或数组，数组保持插件给出的顺序）。Magpie 的模型清单变化时会重新调用 `connect`（`Sync`）。
- 没有 `detect` / `disconnect` 钩子：安装检测用 `bin` 与 `dir`，断开由上述还原机制完成。
- 写入目标只有 `config` 与 `library` 指向的路径，没有额外沙箱规则。

## 决定

### 1. 单文件写入与 Nocturne 配置的衔接：新增只读的接入层 `magpie.json`

Magpie 只能写一个文件，且对数组值是整键替换。Nocturne 现有的可写位置都不合适：

- `config.json` 是用户手写配置，程序从不改写；`providers` 是数组，整键替换会覆盖用户全部服务商。
- `providers.json` / `settings.json` 由 Nocturne 自己原子串行写，外部程序并发改写会破坏它；`settings.json` 也不接受 `providers`。

因此新增独立文件 `<NOCTURNE_HOME>/magpie.json`，由 Magpie 插件维护，Nocturne **只读**。它在分层里位于**用户配置之上、项目配置之下**（第 2 节）。Magpie 页的开关与模型选择只改这一个文件，Nocturne 其他配置文件与凭据存储不受影响。

不采用的做法见「备选方案」。

### 2. 优先级与语义

```text
… < 程序设置 < 用户配置 < Magpie 接入 < 项目配置 < 环境变量 < 命令行参数
```

- 接入期间 Magpie 页选定的模型是默认模型：它高于 `settings.json` 与 `config.json` 里保存的默认模型（否则 Magpie 页的选择会被旧默认悄悄盖掉）；环境变量 `NOCTURNE_MODEL`、命令行与可信项目配置仍可覆盖，因为它们是更明确的本次意图。
- 「接入」的判据是 `magpie.baseURL` 存在。断开后 Magpie 删除它写过的键，可能留下空的 `"magpie": {}`，等价于未接入；孤立的 `model` 被忽略。Magpie 页选择 Nocturne「自己的模型」同样等价于断开：`model` 不是 `magpie/…` 时不参与合并。
- 接入层只能贡献 `model` 与名为 `magpie` 的服务商条目，其余字段不读。该条目是用户级条目：项目配置（即使可信）改它的 `baseURL`、`headers`、`auth` 被忽略并告警（沿用 ADR-0042 §2）。
- 文件损坏或形状不符：告警 `magpie_config_invalid` 并按未接入处理，不阻塞启动（Magpie 可能正在写）。

### 3. 服务商条目由 Core 生成

插件写的是一份小而稳定的数据契约（见 [magpie.md](../architecture/magpie.md)），Nocturne 的 Core 负责把它转成服务商条目，而不是让插件生成 Nocturne 的 `providers` 条目：

- Nocturne 的 schema 变化只改 Core，不改插件；
- 复用现有机制，不在 Agent Loop 或 Context 里加任何服务商分支（AGENTS.md 第 3 节）：
  - 地址、协议：`type: "openai-compatible"`，每个模型的 `endpoints` 直接取 Magpie 的 `native_endpoints`（`/v1/chat/completions`、`/v1/responses`、`/v1/messages`），由 ADR-0026 的协议推导选 Chat / Responses / Messages；没有直通接口的模型回落 Chat，由网关翻译；
  - 会话标识：`sessionHeader: "X-Magpie-Session"`（ADR-0031 §3），网关据此归并用量到会话；
  - 鉴权：`auth: { kind: "external-file", path: <magpie.json>, keyPath: ["magpie","key"] }`（ADR-0042）。

### 4. 凭据

- Magpie 写进文件的是**本机网关为 Nocturne 签发的客户端 key**（形如 `magpie-nctrn`，用于计量与路由），不是任何上游凭据。上游账号、API key 始终只在 Magpie。
- Nocturne 不把该 key 复制进配置对象或凭据存储：它在每次请求时由 `external-file` 鉴权读取文件（按 mtime 缓存，401 重读一次），因此 Magpie 轮换 key 后无需重启。
- 权限层沿用 ADR-0042 §9：所有生效 `external-file` 路径的 `read`/`edit` 一律硬拒绝，`magpie.json` 因此对模型不可读；`config.json` 的凭据字段拒绝规则不变。

### 5. 模型 id

网关返回的 id 是 `provider/model`，其中 `provider` 还可能带斜杠段（如 `or/anthropic/claude-sonnet`）。插件写入 `model: "magpie/<完整 id>"`，Nocturne 全局按**第一个斜杠**切分服务商与模型，所以服务商 `magpie`、模型 id `or/anthropic/claude-sonnet` 原样保留，请求体里的 `model` 就是网关给出的完整 id。

### 6. 生效时机

接入文件在 `loadConfig` 时读取（启动、`reload`），所以改模型或清单后需重启 nctrn 或重新加载配置；网关 key 例外（请求时读取）。已打开的会话不受影响，沿用自己的模型快照。这是有意的最小方案，没有新增文件监听；需要热更新时另行设计。

## 后果

- 新增一个配置层、`LayerKind: "magpie"`，`SettingItem.source` 与 `ProviderOverview.origin` 多一个取值 `"magpie"`（四个客户端加了标签）。
- `/provider` 列出 `magpie`（只读、`managed: false`），模型来源标注为「上游」，不能在 Nocturne 里编辑；要改服务商和模型去 Magpie。
- 接入期间在 Nocturne 里「设为默认」写的是 `settings.json`，被接入层覆盖（设置页显示来源 Magpie）；要改默认模型就在 Magpie 页选，或断开。
- 自定义 `NOCTURNE_HOME` 时，Magpie 插件仍写 `~/.nocturne/magpie.json`：插件路径支持 `$VAR`，但变量未设置时展开为空串，会指向根目录，所以不使用变量。需要时把 `<NOCTURNE_HOME>/magpie.json` 做成指向该文件的链接。
- 会话记录里引用 `magpie/…` 模型的旧会话，在断开后恢复时按「模型不可用」的既有路径处理（ADR-0054 §3）。

## 备选方案

- **让 Magpie 写 `config.json` 的 `providers` 与 `model`**：数组整键替换会毁掉用户的服务商；且 `config.json` 约定程序从不改写。
- **插件用数组下标路径（如 `providers.-1`）追加一条服务商**：还原只能删整个键，无法可靠地删数组里的一项；Magpie 的原值暂存按键而不是按数组元素。
- **写 `providers.json`**：它由 Nocturne 原子串行写，并携带 `userModels`、凭据索引等；外部并发写会破坏它。
- **环境变量方式**（`NOCTURNE_BASE_URL` 等）：Magpie 的 `env` 格式写的是 `.env` 文件，Nocturne 不读它；也无法保存 key。
- **把 key 写成 Nocturne 凭据**：凭据存储是 Nocturne 的，外部程序不应写；`external-file` 已经是「读取别的程序维护的凭据文件，只读」的既有答案。
- **插件生成完整的服务商条目**：把 Nocturne 的 schema 固化进插件，Nocturne 一改就要同步发插件版本。
- **Nocturne 自己拉 `GET /v1/models`**：要读取就必须先知道地址与 key，仍然需要 Magpie 写入；而 Magpie 传给 `connect` 的清单已含上下文、输出、图片、档位、直通接口与价格，信息更全。

## 验证

- 离线测试（`packages/core/test/magpie-layer.test.ts`）：层加载与优先级、断开残留、损坏文件、项目重定向防护、概览、按模型选协议、插件契约；以及经本地模拟网关的 Chat 流式 + 工具调用往返（含完整 id、客户端 key、会话头）、Messages 协议请求、key 轮换后无需重启。
- 用 Magpie 源码里的真实 Agent 插件加载与写入代码，在隔离的 HOME 里跑连接、切换（含多斜杠 id）、模型清单同步、断开：Nocturne 的 `config.json`、`providers.json`、`settings.json` 逐字节不变，写出的文件被 Nocturne 加载器正确读取，上游 key 不出现在文件里。
- 真实环境联调（2026-10-25，Windows，本机 Magpie 与源码构建的桌面版）：插件经本地目录安装，Agent 页出现 Nocturne，连接后写出的 `~/.nocturne/magpie.json` 含 `magpie.baseURL`、客户端 key、83 个模型与默认模型；Nocturne 状态栏显示 `magpie · claude/claude-sonnet-5-5`（完整网关 id，含斜杠），真实订阅账号下流式回答正常，连续多轮读文件/搜索的工具调用往返正常，缓存命中显示正常。
- **未验证**：断开与还原、模型清单更新后的重启生效、Magpie 轮换 key、自定义 `NOCTURNE_HOME`，以及 Claude Code 桥接路径下较长会话的稳定性与协议细节。
