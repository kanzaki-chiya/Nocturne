# ADR-0096：Hook 上下文注入与插件兼容设计

- 状态：已接受
- 日期：2026-11-18
- 相关：[architecture/hooks.md](../architecture/hooks.md)、[architecture/context.md](../architecture/context.md)、[architecture/subagent.md](../architecture/subagent.md)、[protocols/events.md](../protocols/events.md)、[protocols/view.md](../protocols/view.md)、[ADR-0012](ADR-0012-hooks.md)

## 背景

ADR-0012 与 [hooks.md](../architecture/hooks.md) 将 Hook 定位为控制流与工具反馈机制，明确不为 Hook 新增持久事件，且暂不设计上下文注入。

为了兼容「在会话开始、子代理启动与用户提交提示词时向模型注入规则/上下文」的工作流（并作为后续兼容 Claude Code / Codex 已安装插件的前置能力），需要分两期演进：

1. **第一期（本轮实现）**：让 Hook 能够向模型上下文注入有界文本，新增 `UserPromptSubmit` 与 `SubagentStart` 事件点，扩展 `SessionStart`（携带 `source` 与压缩后重跑），并以持久事件 `hook.context` 保证重放可重现。
2. **第二期（已实现 Core 部分；界面另轮）**：只读发现用户本机已安装的 Claude Code / Codex 插件，经由受控白名单与用户显式启用后接入第一期的生命周期 Hook 与技能目录。

---

## 决定

### 第一部分：Hook 上下文注入（第一期，已实现）

#### 1. 事件点与输入/输出契约

| 点位 | 触发时机 | stdin 新增 | stdout 允许 |
|---|---|---|---|
| `SessionStart`（修订） | 会话新建（`startup`）、恢复（`resume`）、分叉首次打开（`fork`）后；L2 摘要（自动或手动）成功后、下一次模型请求前（`compact`） | `source: "startup" \| "resume" \| "fork" \| "compact"`（保留原有 `resumed: boolean`） | `{ additionalContext?: string }` |
| `UserPromptSubmit`（新增） | `message.user` 写入后、`TurnStart` 之前；只在本轮由用户输入发起时触发 | `turnId`、`text`（用户原文 `submit.text`，不含技能渲染块和文件块）、`skill?: { name, arguments? }` | `{ block?: boolean, reason?: string, additionalContext?: string }` |
| `SubagentStart`（新增） | 子会话的 `SessionStart` 之后、第一个 Turn 之前 | `agentType`（档位名；无档位或 `default` 为 `"general"`；自定义工具集为 `"custom"`） | `{ additionalContext?: string }` |

触发与作用范围：

- 以下消息**不**触发 `UserPromptSubmit`：
  - 带 `subagent` / `backgroundShell` / `ensemble` / `ensembleQuietReminder` 的非用户输入消息；
  - `workMode.source === "runtime"` 的运行时消息；
  - `steer: true`（运行中插话）的消息；
  - 子会话内的消息（`meta.parent !== undefined`）。
- `UserPromptSubmit` 的 `block: true` 与 `TurnStart` 同语义（Turn 以 `error(code: "hook_blocked")` 结算）；被拦截时，同批输出中的 `additionalContext` 一并丢弃。
- 外部 agent（ACP）不触发 `SubagentStart`。子会话里 `SessionStart` 照旧触发。
- 失败、超时、非零退出：不产生上下文，只写诊断并降级（`hook_failed`），不阻断会话。

#### 2. 持久事件 `hook.context` 与投影

- 新增会话级持久事件 `hook.context`：
  ```ts
  {
    point: "SessionStart" | "SubagentStart" | "UserPromptSubmit",
    source?: string,
    entries: { hook: string; text: string; truncated?: number }[],
  }
  ```
  - `hook` 沿用 `permission.resolved.rule` 的命名形式：`hook <点位> <command>`；
  - `UserPromptSubmit` 的事件携带 `turnId`；
  - 不提升 `formatVersion`：旧版 Runtime 遇到未知持久事件拒绝恢复（`session_log_newer`），旧只读客户端与 `SessionView` 忽略该事件（与 `events.md` 第 8 节一致）。
- **`SessionStart` / `SubagentStart`（会话快照）**：
  - 有效历史中最近一条对应点位的 `hook.context` 就是当前快照。
  - Context Builder 将其作为新的 system section `hookContext` 注入，位于技能目录（`skills`）之后、环境信息（`environment`）之前；计入 `ContextReport` 的 `hooks` 段（桌面端 `apps/desktop/src/context-panel.tsx` 的 `SECTIONS` 显式补录 `hooks: { label: "Hook", color: "var(--a-muted)" }`，其余界面不变）。
  - 本次结果与有效历史当前快照逐字相同时不写事件；原来有内容、本次全部执行成功但结果为空时写 `entries: []` 清空。快照只在打开、恢复、分叉与 L2 摘要后变化，其余时候 system 前缀不变；回退和分叉按有效事件前缀重建。
- **`UserPromptSubmit`（历史 note）**：
  - 在 `session/fold.ts` 中折叠为一条 `note`，落在该 `message.user` 之后；沿用既有 `note` 的投影、L1 不修剪、L2 纳入摘要与工具结果邻接规则，计入 `ContextReport.history.breakdown.user`。

#### 3. 文本格式与上限

- 注入文字使用英文标签包裹：
  - system section `hookContext` 以单行英文前言开头：`The following context was provided by user-configured hooks at session start:`；
  - 每条条目以 `<hook-context point="…">\n…\n</hook-context>` 包裹。
- 单条 `text` 上限 `10,000` 字符（`MAX_HOOK_CONTEXT_ENTRY_CHARS`），超出截断并在 `truncated` 记被截掉的字符数。
- 同一事件全部条目合计上限 `30,000` 字符（`MAX_HOOK_CONTEXT_TOTAL_CHARS`），超出的后续条目丢弃并记录 `hook.context_dropped` 诊断。

#### 4. 不变量

1. 未配置任何 Hook，或点位无匹配条目时：不写 `hook.context`；事件序列、模型请求与 `ContextReport` 与改动前逐项一致。
2. 同一份日志重放两次，上下文构建结果逐字节相同。
3. 同一 Turn 相邻 Step 的请求前缀不因 `hookContext` 改变（L2 摘要重建缓存后同样保持稳定）。

#### 5. 文档修订范围

本部分修订了 [hooks.md](../architecture/hooks.md) 第 1、2、3（原第 86 行）、7、8 节，[context.md](../architecture/context.md) 第 3 节与第 6 节（压缩后重跑 `SessionStart`），[events.md](../protocols/events.md)、[subagent.md](../architecture/subagent.md) 第 10 节、[view.md](../protocols/view.md) 与 [site-docs/config.md](../../site-docs/config.md)。

---

### 第二部分：读取已装插件（第二期，已实现 Core 部分；界面另轮）

> 依据说明：本部分以 `openai/codex` commit `6257fbc4bd5339144e6ffb3398a011917d883a2e` 与 Claude Code 官方文档（`plugins-reference`、`hooks`）为事实依据，并修订第一轮设计稿中的偏差项。

#### 1. 发现（只读）与版本/清单规则

- **Codex**：用 `smol-toml` 只读解析 `<codexHome>/config.toml`（默认 `CODEX_HOME` 或 `~/.codex`），仅收集 `[plugins."<name>@<marketplace>"]` 中 `enabled = true` 的条目；`name` 与 `marketplace` 禁止路径分隔符及 `.` / `..`。解析失败整份忽略并告警（不打印文件内容）。
  - **版本选择规则**（依据 `codex-rs/core-plugin-common/src/installed.rs` `active_plugin_version`）：列出 `<codexHome>/plugins/cache/<marketplace>/<name>/` 下合法子目录（仅允许 ASCII 字母、数字、`.`、`+`、`_`、`-`，排除 `.` 与 `..`）；存在 `local` 时优先选 `local`；否则按双 SemVer 2.0 比较或字符串比较取最大值。
  - **清单查找顺序**（依据 `codex-rs/utils/plugins/src/plugin_namespace.rs` `find_plugin_manifest_path`）：依次查找 `.codex-plugin/plugin.json`、`.claude-plugin/plugin.json`；根目录 `plugin.json`、agent-plugins 格式与 `.cursor-plugin` 不支持。
- **Claude Code**：只读解析 `<claudeHome>/plugins/installed_plugins.json`（取 `scope === "user"` 条目的 `installPath`）与 `<claudeHome>/settings.json`（取 `enabledPlugins[id] === true`），两份文件其余字段不留存内存也不写日志；文件损坏时整份忽略并告警。默认 `claudeHome` 为 `CLAUDE_CONFIG_DIR` 或 `~/.claude`。
  - **清单查找**：仅查找 `.claude-plugin/plugin.json`（缺失时按默认布局尝试 `hooks/hooks.json` 与 `skills/`）。
- **插件标识**：`<host>:<name>@<marketplace>`（`host` 为 `codex` 或 `claude`）；同一插件在两边均安装时为两个独立 id，各自独立启停。
- **路径 containment 与 hooks 来源**（依据 `codex-rs/core-plugins/src/loader.rs` `load_plugin_hooks` 与 Claude Code `plugins-reference`）：
  - 清单内相对路径必须以 `./` 开头且解析后不越出插件根目录；
  - 清单 `hooks` 支持字符串路径、路径数组、内联事件映射对象或混合数组；Codex 省略时读取 `hooks/hooks.json`，Claude 始终先读 `hooks/hooks.json`（若存在）再合并清单 `hooks` 字段（按规范路径去重）；
  - 不含 `hooks` 键的 JSON 文件（如 `claude-band.json`）静默跳过，不报警告。

#### 2. 支持范围、跳过规则与父子会话边界

- **兼容点位**：仅接 `SessionStart`、`UserPromptSubmit`、`SubagentStart`、`SessionEnd`。
- **跳过规则**：以下条目全部跳过并记入 `PluginOverview.unsupported`（不运行）：
  - 其他点位（含 `PreToolUse`、`PermissionRequest`、`PostToolUse` 等工具点位）→ `"point"`；
  - 非 `command` 类型（如 `prompt`、`agent`、`mcp_tool`）→ `"type"`；
  - `async: true` → `"async"`；
  - `command` 或 `args` 含 `${user_config.` → `"user_config"`。
- **只在父会话运行**：插件的 `SessionStart` 与 `SessionEnd` 对 Codex 与 Claude 两种来源都**只在父会话运行**，子会话只跑 `SubagentStart`，避免子会话重复触发会话级规则注入。

#### 3. 格式翻译（内部扩展类型 `HookEntry & { plugin: PluginHookSpec }`）

- **执行方式按宿主区分**：
  - **Codex 来源**（依据 `hooks/src/engine/command_runner.rs` `build_command` 与 `discovery.rs` 约 670 行）：Windows 优先使用 `commandWindows ?? commandWindows_snake ?? command`，经 `%COMSPEC%`（`cmd /d /s /c "<command>"`，`windowsVerbatimArguments: true`）原样执行；其他平台使用 `$SHELL -lc <command>`（无 `SHELL` 时回退 `/bin/sh`）。
  - **Claude 来源**（依据 Claude Code `hooks` 官方文档）：带 `args` 时走 exec 形式直接 spawn；否则按 `shell` 字段（缺省 `"bash"`）：Windows 优先 Git Bash（`detectShells`），找不到时回退 PowerShell；其他平台使用 `sh -c`。
- **占位符与环境**：`${PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_ROOT}`、`${PLUGIN_DATA}`、`${CLAUDE_PLUGIN_DATA}`、`${CLAUDE_PROJECT_DIR}` 在命令与参数中按纯字符串单次替换；子进程仅使用白名单环境（`envMode: "minimal"`），叠加上述 5 个环境变量与 4 个 `NOCTURNE_HOOK_*` 变量；运行前创建 `PLUGIN_DATA`（`<NOCTURNE_HOME>/plugins/data/<name>-<marketplace>`）。不读写 `~/.codex`、`~/.claude` 运行时数据目录。
- **缺省超时与上限**（依据 `discovery.rs` `normalize_command_hook`）：单位为秒转毫秒；一般点位缺省 60 秒、上限 60 秒；`SessionEnd` 缺省 1 秒、上限 3 秒。
- **matcher**：仅含 `[A-Za-z0-9_\- ,|]` 时按 `|` / `,` 切分为精确列表匹配，否则按正则匹配；`*`、空串或缺省匹配全部；`SessionStart` 匹配插件看到的 `source`（Nocturne 的 `fork` 映射为 `resume`），`SubagentStart` 匹配 `agent_type`，`UserPromptSubmit` 与 `SessionEnd` 忽略 matcher；正则非法时跳过该条目并告警。
- **stdin / stdout / 退出码**：
  - stdin 为 snake_case JSON：`hook_event_name`、`session_id`、`cwd`，`SessionStart` 带 `source`（`fork` → `resume`），`UserPromptSubmit` 带 `turn_id` 与 `prompt`（技能调用时为 `/<name>` 或 `/<name> <arguments>`，否则为用户原文），`SubagentStart` 带 `agent_type`，`SessionEnd` 带 `reason`。
  - stdout 退出码 0：trim 后为 JSON 对象时取 `hookSpecificOutput.additionalContext`，`UserPromptSubmit` 另认顶层 `decision: "block"` 与 `reason`；非 JSON 非空文本整段作为上下文。`UserPromptSubmit` 退出码 2 表示拦截（`reason` 取 stderr）；其他非零退出按 `hook_failed` 失败降级。上下文上限沿用第一期（单条 10,000、单事件合计 30,000 字符）。
- **条目名**：`hook.context` 条目名、warning 与诊断给用户看的标识一律为 `plugin <name>@<marketplace> <点位>`，不写展开后命令与绝对路径（诊断 `command` 字段可保留未展开的原始命令）。

#### 4. 启用、整目录指纹信任与状态文件

- **状态文件**：`<NOCTURNE_HOME>/plugins.json`（形状 `{ "version": 1, "plugins": { "<id>": { "enabled": true, "hash": "sha256:…" } } }`），与 `mcp.json` 共用配置写入队列并原子写；损坏或版本不符整份忽略并告警，无效条目逐条忽略。不写入手写 `config.json`。
- **整目录指纹**（依据 `hooks/src/engine/plugin_fingerprint.rs`）：对整个插件根目录做深度优先、按字节序排列文件名的 SHA-256 指纹，前缀改为 `nocturne-plugin-bundle-v1`（跳过 `__pycache__`、`.venv`、`*.pyc`、`*.egg-info`）；遇到符号链接或非普通文件/目录即失败且禁止启用（`setPluginEnabled` 抛错）。
- **校验与生效时机**：已发现插件默认不启用（`state: "off"`）。每次会话打开与每次 `describePlugins` 重新计算指纹：一致为 `on`，变化或校验失败为 `changed`（不运行 Hook、不提供技能，会话打开时发一次 `runtime.warning`，code 为 `plugin_changed` 并写插件名；再次启用即重新信任）。Hook 变更对之后打开的会话生效；技能目录在空闲边界重建。

#### 5. 技能接入与 Runtime / RPC 接口

- 已启用且未变化插件的技能目录（清单 `skills` 字段或默认 `skills/`）作为 `user` 来源层排在 `extraDirs` 之后，优先级最低（同名用户技能优先）；`SkillOverview.source` 新增 `"plugin"`，并新增可选字段 `plugin: "<name>@<marketplace>"`；插件变为 `changed` 时其技能立即消失。
- `Runtime` 与 RPC 新增 `describePlugins`（`plugins.describePlugins`）与 `setPluginEnabled`（`plugins.setPluginEnabled`，响应前推 `runtime.providersChanged` 并返回 `{ affectedSessions }`）；桌面端界面在下一轮单独实现。

#### 6. 明确不做

- 不支持 `commands/`（Codex `.toml` / Claude `.md` 自定义斜杠命令）；
- 不支持 `modules` / band / statusline 等宿主界面扩展；
- 不提供从 git 地址自行安装或升级插件的功能。

---

## 后果

- **可重现性与缓存**：上下文注入通过持久事件与独立 `hookContext` section 落地，既保证会话恢复、分叉、回退的逐字节重放一致，又把变化收敛在会话生命周期与压缩边界，不破坏普通 Step 之间的提示词缓存前缀。
- **兼容性**：新增持久化事件 `hook.context` 不提升 `formatVersion`；旧版本 Runtime 拒绝恢复包含它的日志（`session_log_newer`），只读端和视图忽略。
- **插件安全边界**：第二期坚持白名单环境、显式启用、脚本内容哈希复核与不接入工具放宽点位，在复用现有生态上下文插件的同时守住权限层与凭据隔离。

## 备选方案

- **把 `SessionStart` 注入当作临时状态、不写持久事件**：会话恢复或换机重放时若 Hook 配置变化或脚本输出依赖当时环境，重放结果会漂移，破坏模型输入可重现性。
- **直接放行第三方插件的 `PreToolUse` / `PermissionRequest`**：插件按 Claude 工具名匹配且允许返回 `allow`，与 Nocturne 按解析后权限主体求值的安全模型冲突。
- **把插件 Hook 写进用户 `config.json`**：违背 Nocturne「程序不改写手写 `config.json`」的原则，改用独立状态文件。
