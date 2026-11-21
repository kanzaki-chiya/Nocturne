# ADR-0105：插件定义子代理

- 状态：已接受
- 日期：2026-11-21
- 相关：[ADR-0100](ADR-0100-native-plugins.md)（Nocturne 自有插件，落实分期第 5 项）、[ADR-0058](ADR-0058-subagent-profiles.md)（子代理档位）、[architecture/subagent.md](../architecture/subagent.md)（修订第 14、19 节）、[architecture/config.md](../architecture/config.md)、[protocols/rpc.md](../protocols/rpc.md)

## 背景

[ADR-0100](ADR-0100-native-plugins.md) 修订「四个文档插件」第 5 节分期第 5 项预留了「插件定义子代理（例如视觉验收）」。现有四个内置文档插件（`docx`、`xlsx`、`pptx`、`pdf`）的技能都要求主模型直接调用 `render` 查看页面截图，导致多张页面图片留在主会话上下文里，快速消耗上下文窗口并干扰后续编辑。把看图验收交给独立的只读子代理，由子代理逐页 `render` 并经 `finish` 返回逐页结论，主会话只需接收文本结论即可按需修改。

引入插件子代理触及两条既有边界，本 ADR 正式修订这两条边界（并仅放开**原生插件提供的定义**；用户级、项目级自定义 agent 定义文件仍然不做）：

1. [subagent.md 第 14 节](../architecture/subagent.md#14-角色系统边界结论)：原为「本阶段不开放用户/项目自定义的 agent 定义文件」，修订为仅允许 Nocturne 自有插件通过清单提供子代理定义，用户/项目级定义文件仍不开放。
2. [ADR-0100 第 2 节](ADR-0100-native-plugins.md#2-插件能带的内容)「明确不做」：原含「子代理定义」，修订为自有清单支持 `agents` 目录，斜杠命令（`commands/`）与兼容插件里的子代理定义仍不做。

## 决定

### 1. 清单与文件格式

- **清单字段**：Nocturne 自有清单（`.nocturne-plugin/plugin.json`）新增可选字段 `agents`，值为插件根目录内的相对目录（必须以 `./` 开头、解析后不得越出插件根目录，路径校验与 `skills` 相同，例如 `"agents": "./agents"`）。省略时该插件没有子代理。
- **文件结构**：`agents` 目录下每个 `*.md` 定义一个子代理（非递归单层扫描）。Markdown 须包含 YAML frontmatter 与正文：
  - `name`（必填）：子代理名，命名规则同 `isValidSubagentProfileName`（小写字母、数字、`-`，最长 32，`default` 保留）。
  - `description`（必填）：一句话说明何时选用；超过 300 字符时整条跳过并记警告，不截断。
  - `tools`（可选）：字符串数组，列 Nocturne 工具名（可写 `mcp__<server>__<tool>`），运行时仅用于收窄子会话工具池。
  - `effort`（可选）：思考档位，取值同档位配置（`off | minimal | low | medium | high | xhigh | max`）。
  - 其他字段（含 `model`）：一律忽略并各自记一条警告；插件不能替用户指定模型。
  - 正文（必填）：角色说明，去首尾空白后须非空，最长 10,000 字符；为空或超限时整条跳过并记警告。
- **容错隔离**：单个 `.md` 解析或校验失败只跳过该文件并记入插件 `warnings`，不影响同一插件的其他子代理、技能、Hook 与 MCP 服务器。
- **可用能力与安装检查**：`hasUsablePluginCapabilities` 将有效子代理计入可用能力（技能、受支持 Hook、受支持 MCP 服务器、子代理四者皆空才不列出）；`validateManifestPaths` 与 `checkLocalPluginDirectory` 同步校验 `agents` 路径合法性与子代理清单。
- **范围边界**：Codex、Claude Code 兼容插件里的 agent 文件不读取。

### 2. 名称、去重与选择表

- **档位 id**：`<插件 name>:<子代理 name>`（例如 `pptx:visual-judge`）。用户档位和外部 agent 的名称不允许包含 `:`，天然不冲突。
- **同名插件去重**：两个已启用插件的 `name` 相同时，按发现顺序保留第一个插件的子代理，其余跳过并记警告。
- **选择表位置**：插件子代理进入 `task.profile` 的同一张选择表（由共享 `subagentSelectionTable` 生成），排在用户档位之后、外部 agent 之前；括号内按实际生效模型显示模型、强度与基础档单价，描述取 frontmatter 的 `description`。
- **动态重建**：插件启用或停用后，选择表与 `task.profile` 枚举按 [subagent.md 第 19 节](../architecture/subagent.md#19-子代理档位) 的同一规则，在下一个空闲边界随档位表一并重建，无需重开会话。停用后再调用按「不存在或停用档位」报 `invalid_input` 并列出可选值。

### 3. 解析与运行

- **统一档位形状**：在配置层（`config/subagent-profiles.ts`）将插件子代理解析为与既有档位相同的结构（`ResolvedSubagentProfile`），附加 `rolePrompt`、`sourcePluginId`、`sourcePluginName` 与 `allowedTools`；launcher 统一消费解析结果，Agent Loop 不认识插件子代理，也不按名称分支。
- **模型、强度与超时**：
  - 模型：用户在设置中为该档位 id 选了模型（`subagents.pluginModels.<插件>:<子代理>`）就用所选模型；未选则跟随 `default`（即 `modelRoles.task`，若未设则跟随当前会话模型）。选定模型不可用时，按 `subagent_profile_unavailable` 同一规则排除出选择表并告警，不静默回退。
  - 强度：frontmatter 指定 `effort` 时用该值，否则继承父会话；两种情况都再经 `clampReasoningEffort` 按子模型可用档位就近降档。
  - 超时：使用默认值（不设额外封顶）。
- **系统提示词**：固定子代理提示词（`subagentBasePrompt`，含 `finish` 协议与不可提问约束）保持逐字不变；角色说明单独成段追加在其后，段首注明来源插件显示名与插件 id（`以下角色说明来自插件 <显示名>（<插件 id>）：`）。角色说明不得替换或删减固定提示词；工作树隔离段落照旧追加。
- **工具裁剪**：子会话工具池先按既有规则算出，若子代理声明了 `tools`，取工具池与 `tools` 的交集（列表中不在工具池内的名字静默忽略，`finish` 始终保留）。交集为空（只剩 `finish`）时，本次 `task` 调用直接报 `invalid_input`，提示该子代理在当前会话没有可用工具。
- **不变边界**：权限主体、交互转发与非交互策略、最大深度限制均不变。

### 4. 配置、协议与界面

- **模型设置**：在 `settings.json` 白名单新增 `subagents.pluginModels`（`Record<"<插件>:<子代理>", "provider/model">`），经既有 `describeSettings` / `updateSettings` 读写（键名 `subagents.pluginModels.<id>`，`null` 清除回归「跟随默认」）。用户层与可信项目层按 id 覆盖，不可信项目层一律忽略（规则同 `subagents.profiles`）。插件停用或卸载不删除已保存的模型选择。
- **协议概览**：`PluginOverview` 新增可选 `agents?: PluginAgentOverview[]`（每项含 `id`、`name`、`description`、`effort?`、`tools?`）。
- **桌面端「设置 › 子代理」**：保留「内置档位」「外部 Agent」两组；每个已启用且包含子代理的插件在其间单独渲染一个 `SettingsGroup`（标题为 `interface.displayName` 带计数，顺序同插件页）；每行使用 `SettingsListRow`（左侧插件 `composerIcon`、等宽无前缀子代理名、「N 个工具」标签、最多两行省略描述、右侧模型下拉首项「跟随默认」即时写入，无启停开关）；点行进入只读详情页（展示名称、描述、来源插件、工具清单与可改模型）。
- **桌面端插件详情页与启用确认框**：增加带计数的「子代理」一节，列出子代理名称与描述。
- **TUI**：`/settings › 模型角色` 的只读档位列表一并列出已启用插件的子代理，带 `<插件>:` 前缀。

### 5. 第一批子代理：四个文档插件的 `visual-judge`

- `docx`、`xlsx`、`pptx`、`pdf` 四个内置文档插件均添加 `agents/visual-judge.md`，`tools` 仅列出 `read` 与各自 MCP 服务器的 `render` 工具（`mcp__word__render`、`mcp__sheets__render`、`mcp__slides__render`、`mcp__pdf__render`），只看不改、逐页输出「通过 / 不通过 / 无法确认」及具体视觉证据。
- 四份 `SKILL.md` 同步更新：交付前优先经 `task` 调用本插件的 `visual-judge` 完成视觉检查，仅在子代理不可用时回退为主会话直接调用 `render`，避免重复看图。

## 后果

- **正面**：文档视觉验收的页面截图留在子会话中，主会话只接收结构化逐页结论，显著降低上下文占用；子代理随插件安装、启停、打包与升级一体化交付，无需用户手写配置。
- **负面与约束**：`task` 选择表会随已启用带子代理的插件增加条目；子代理工具名强依赖 MCP 服务器注册名，构建测试需验证 `tools` 与 `tools/list` 一致。

## 备选方案

1. **开放用户级和项目级自定义 agent 定义文件**
   - 不采用理由：用户/项目自定义 agent 文件会把角色系统、作用域覆盖、项目信任边界与模型覆盖策略一次性引入，而项目级定义还会带来不可信仓库提示词注入与权限边界扩张问题；当前实际需求聚焦在随插件分发的受控能力（如文档视觉验收），路线图对用户/项目级自定义定义另有独立安排，本阶段只放开受插件信任体系管控的原生插件定义。
2. **允许插件在 frontmatter 中指定 `model`**
   - 不采用理由：不同用户的服务商、可用模型清单与费用预算差异很大，插件作者硬编码模型 id 不仅容易指向用户未配置的模型导致大面积不可用，还会越权替用户决定计费模型。由 Nocturne 统一默认跟随用户的 `default`（`modelRoles.task`），并在设置页提供按子代理 id 独立覆盖的模型下拉，兼顾开箱可用与用户掌控权。
3. **让插件的角色说明替换固定子代理提示词（`subagentBasePrompt`）**
   - 不采用理由：`subagentBasePrompt` 承载了子代理运行契约（必须通过 `finish` 交付、不得提问、遵守输出 schema 等），一旦允许插件覆盖或删减，单个插件正文就能破坏子会话收束协议或绕过既有约束。将角色说明作为独立段落追加在原样保留的固定提示词之后并标明来源插件，既能清晰限定专业职责，又保证核心运行协议不可被篡改。
