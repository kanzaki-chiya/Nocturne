# 配置（Config）

> 状态：已接受 v0.1 ｜ 前置阅读：[modules.md](modules.md)、[permissions.md](permissions.md) ｜ 决策：[ADR-0007](../decisions/ADR-0007-config-format.md)、[ADR-0008](../decisions/ADR-0008-project-trust-grants.md)

`config` 模块负责把分散的配置来源合并成一份带出处、带信任标记的运行时配置。它只负责**加载、校验、合并、标注来源**；配置的含义由各模块自己消费（权限规则的解释在 permission，Provider 配置的解释在 provider）。

## 1. 配置来源与分层

```text
内置默认 < 向导配置 < 用户配置 < 项目配置 < 环境变量 < 命令行参数
```

| 层 | 位置 / 来源 | 信任 | 说明 |
|---|---|---|---|
| 内置默认 | 代码内常量 | 可信 | 预设名 `default`、Turn 默认值等；不是一个文件 |
| 向导配置 | `<NOCTURNE_HOME>/providers.json` | 可信 | 机器维护：只由 `nctrn setup` 与 `/provider` 原子写，内容限 `model` 与 `providers`；手写配置按 `id` 覆盖它（v0.2 提议，[provider-setup.md](provider-setup.md)） |
| 用户配置 | `<NOCTURNE_HOME>/config.json` | 可信 | 用户手写的偏好；**程序从不改写它** |
| 项目配置 | `<workspaceRoot>/.nocturne/config.json` | **默认不可信** | 来自被操作的仓库，见第 3 节信任模型 |
| 环境变量 | `NOCTURNE_*` | 可信 | 见第 5 节；凭据经环境变量或操作系统凭据后端进入（索引文件 `credentials.json` 不含明文）（v0.2 提议，[provider-setup.md](provider-setup.md)） |
| 命令行参数 | `nctrn` 参数 | 可信 | 本次启动的显式意图，优先级最高 |

机器维护的运行时数据（信任列表、项目 Grant、向导配置、凭据索引、最近模型列表）不放在 `config.json` 里，而是各自独立的 JSON 文件（`trust.json`、`grants/`、`providers.json`、`credentials.json`、`recent-models.json`，见第 3、4 节与 [provider-setup.md](provider-setup.md) 第 2 节）——程序写自己的文件，不碰用户手写的配置。

逐层合并后的结果叫 `ResolvedConfig`：每个字段都知道自己来自哪一层（用于诊断与权限规则的命中解释）。

## 2. 配置文件格式与 schema

两个配置文件都是**严格 JSON**（不支持的写法：注释、尾逗号、单引号）。理由与备选见 ADR-0007。

- 解析失败或不符合 schema：**用户配置**直接报错（快速失败，不带着半截配置启动）；**项目配置**整份忽略并发出警告（仓库里的坏文件不应阻塞会话，但也不能静默生效一半）。
- 文件不存在即跳过该层；`NOCTURNE_HOME` 改变时全部位置随之移动。

```ts
// 各层文件共用一个 schema；程序从不改写它们
interface ConfigFile {
  /** 默认模型，"provider/model" 形式 */
  model?: string;
  /** Provider 声明式配置，形状即 RuntimeOptions.providerConfigs 的元素 */
  providers?: ProviderConfig[];
  permissions?: {
    /** 预设名；缺省 "default" */
    preset?: "read-only" | "default" | "auto-edit" | "full-access";
    /** 追加的权限规则，形状即 PermissionRule（permissions.md 第 2 节） */
    rules?: PermissionRule[];
  };
  /** Turn 参数覆盖（agent-loop.md 3.8） */
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
| `model`、`permissions.preset`、`turn.*` | 高层覆盖低层 |
| `providers` | 按 `id` 合并：同 id 条目浅合并（高层字段覆盖），其中 `models` 按模型 id 再逐条合并；不同 id 并存 |
| `permissions.rules` | 追加：高层规则排在低层之后（权限"后写优先"语义见 permissions.md 5.1） |
| `mcp.servers` | 按服务器 id 浅合并（同 `providers`）；不同 id 并存 |
| `hooks.*` | 按事件点追加：用户级条目在前、项目级在后，执行顺序即此顺序（hooks.md 第 2 节） |

## 3. 项目配置的信任模型

项目配置来自被操作的仓库——它可能是恶意的。因此：

- **未信任时**，项目配置里只有 `permissions.rules` 中**收紧方向**（`ask` / `deny`）的规则参与求值：与可信结果取更严格者，`allow` 被忽略。其余字段（`model`、`providers`、`preset`、`turn`）全部忽略；`mcp` 与 `hooks` 两段同样**整段忽略**——它们定义的是要启动的进程，"运行但收紧"没有意义（进程一旦启动就是任意代码），收紧方向在可执行配置上不存在。这保证一份仓库配置永远无法放宽用户的安全边界、无法把会话引到别的 Provider 或模型，也无法让它在用户不知情时执行任何命令。
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
| `NOCTURNE_SHELL` | shell 工具的执行 shell（tools.md 第 6 节，不经配置层） |

- `NOCTURNE_API_TYPE` 缺省 `openai-compatible`；仅当该层至少能提供 `type` 之外的必填字段（openai-compatible 需要 `baseURL`）或显式设置了 `NOCTURNE_API_TYPE` 时才合成 Provider 条目。
- 命令行参数层同理合成一个条目（id 同 api-type），按 id 合并规则覆盖同 id 的环境变量条目。
- 合成条目的模型清单：环境变量/参数只给出"当前要用的模型"，其余行为与 Phase 2 一致（`allowUndeclaredModels`）。

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
- `ResolvedConfig` 的各段经原有 `RuntimeOptions` 字段注入：`providers`→`providerConfigs`、`models`→`modelOverrides`、`turn`→`turn`、权限层（preset + 各层规则 + Grant 集合 + 命令行提升）→ 新的 `permissions` 选项。`policy` 直注入仍保留，供测试与特殊客户端使用。
- Phase 5 增补：`mcp.servers` → `ResolvedConfig.mcpServers`（按会话 workspaceRoot 解析，带 `origin` 标注，供 `RuntimeOptions.mcp` 的 connector 消费，见 [mcp.md](mcp.md) 第 8 节）；`hooks` → `ResolvedConfig.hooks`（供 `wrapSession` 构造 `HookRunner`，见 [hooks.md](hooks.md) 第 6 节）。两段都只在 `forWorkspace` 展开——项目层是否参与取决于信任状态（第 3 节）。

## 7. 暂不设计

- 配置文件中的凭据值（`config.json` 与 `providers.json` 都不存密钥；密钥只在环境变量或 `credentials.json`，见 [provider-setup.md](provider-setup.md) 第 3 节）；
- JSONC / TOML / 其他格式（ADR-0007 记录了取舍）；
- 通用的配置编辑命令（服务商的交互配置见 [provider-setup.md](provider-setup.md)）、Grant 的查看与撤销界面；
- 每会话不同的用户配置 profile。
