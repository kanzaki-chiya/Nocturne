---
name: plugin-creator
description: 创建或修改 Nocturne 自有插件（.nocturne-plugin/plugin.json）：明确需求、编写源码、调用 check_plugin 校验并给出界面安装与试用步骤。
when_to_use: 当用户要求新建、修改或排查 Nocturne 插件（含技能、Hook、MCP 服务器或面板）时使用。
argument-hint: "[插件需求或源码目录]"
---

# Nocturne 插件创建器

本技能用于编写、检查并交付 Nocturne 自有格式（`.nocturne-plugin/plugin.json`）的本地插件。按以下六步顺序执行；未与用户核对清楚前不要猜测功能，用户未在界面完成安装前不要把状态写成已完成。

## 1. 问清楚要做什么

- 若用户只发送了 `/plugin-creator` 或只给了模糊想法，先问清楚再动手：
  1. 插件要实现什么具体能力（需要技能、Hook、MCP 服务器还是它们的组合）？
  2. 约定一个**具体的试用例子**：用户会输入什么，期望得到什么结果（作为自测与交付时的试用提示词）。
  3. 是否有指定的源码目录（若未指定，默认放在 `<工作区>/plugins/<name>/`）。
- 只有目标能力和试用例子都明确后，才进入下一步。

## 2. 确定源码目录

- 默认路径：`<工作区>/plugins/<name>/`，用户明确指定目录时以用户指定的为准。
- `name` 仅允许小写 ASCII 字母、数字和连字符（`/^[a-z0-9-]+$/`），不能包含大写字母、下划线、空格或 `@`。
- **修改已有插件时**：直接在原源码目录上修改，保持清单中的 `name` 不变，不要换目录或另起新名。
- 不要把插件源码放在 `<NOCTURNE_HOME>/plugins/` 下，安装接口会拒绝从该目录内安装。

## 3. 编写清单与组件

动手写文件前，按需阅读本技能附带的参考文档：

- 清单字段、路径、图标与 `ui.surfaces` 规则：[references/manifest-spec.md](references/manifest-spec.md)
- 技能、Hook（9 个事件点）与 stdio MCP 服务器的最小可用示例：[references/hooks-and-mcp-examples.md](references/hooks-and-mcp-examples.md)

编写原则：

- **只写真正需要的组件**：纯提示词流程只写技能；需要拦截、改写或注入生命周期上下文再加 Hook；需要自定义工具再加 stdio MCP 服务器；不要生成用不到的空目录或空模板。
- **满足可用能力门槛**：插件必须至少包含以下三者之一——有效技能、受支持 Hook、受支持 stdio MCP 服务器。
- **清单与相对路径**：清单写在 `.nocturne-plugin/plugin.json`；清单中的 `skills`、`hooks`、`mcpServers` 相对路径必须以 `./` 开头且解析后不得越出插件根目录；避免在插件目录内依赖符号链接（安装复制会跳过 `.git` 与符号链接）。
- **Hook（自有清单 9 个事件点）**：可用 `PreToolUse`、`PermissionRequest`、`PostToolUse`、`TurnStart`、`TurnEnd`、`UserPromptSubmit`、`SessionStart`、`SubagentStart`、`SessionEnd`。`PreToolUse` 没有 `allow`，只有 `PermissionRequest` 可以放宽 `ask`。命令与参数支持单次替换 `${PLUGIN_ROOT}`、`${PLUGIN_DATA}`、`${NOCTURNE_NODE}`，运行时处于最小白名单环境并注入 `PLUGIN_ROOT`、`PLUGIN_DATA` 与 `NOCTURNE_HOOK_*`。
- **MCP 服务器（仅 stdio）**：命令、参数、环境变量与 `cwd` 支持单次替换 `${NOCTURNE_NODE}`、`${PLUGIN_ROOT}`、`${PLUGIN_DATA}`。优先使用 `${NOCTURNE_NODE}` 启动 Node 脚本，避免依赖用户系统 PATH 中的 Node。
- **禁止明文凭据与 `{ stored: true }`**：绝不把 API Key、Token 等凭据写进清单或源码；插件 MCP 也不允许在 `env` 中声明 `{ stored: true }`（会被直接跳过）。
- **实现必须真实可用**：如果声明了 Hook 或 MCP 服务器，必须写出完整可运行的脚本并处理好输入输出，不能只留空壳或 TODO 占位。

## 4. 检查与自测

1. 调用 MCP 工具 `check_plugin`（所属服务器 `plugin-creator`），参数 `{ "path": "<插件根目录绝对路径>" }`。
   - `check_plugin` 为只读工具，与 Nocturne「安装插件…」共用同一套安装前校验逻辑，不会复制或修改任何文件。
   - 若 `installable` 为 `false` 或 `errors` 非空，逐条修复并重新调用 `check_plugin`，直到 `installable: true` 且 `errors` 为空。
   - 同时检查 `warnings` 与 `skipped`，确认没有意外被跳过的 Hook 或 MCP 条目。
2. 用第 1 步约定的试用例子，在当前环境能执行的部分先实测（例如直接运行 Hook 脚本喂入样例 stdin 检查 stdout JSON，或启动 MCP 服务器做 `initialize` / `tools/list` / `tools/call` 冒烟）。
3. 当前环境测不了的部分（例如依赖外部服务的真实凭据、特定硬件或桌面端安装后交互），如实记录在交付清单中，不要假装测过。

## 5. 指导用户在界面安装、启用与试用

阅读 [references/install-update-uninstall.md](references/install-update-uninstall.md)，按用户的场景给出准确的桌面端操作步骤：

- **严禁代办安装或修改状态**：不要自行复制文件到 `<NOCTURNE_HOME>/plugins/installed/`，不要修改 `<NOCTURNE_HOME>/plugins.json`，也不要调用或模拟安装/启用操作。
- **首次安装**：
  1. 打开「设置」→「插件」，点右上角「安装插件…」，选择插件源码根目录。
  2. 安装完成后会自动进入插件详情页并提示「已安装 <显示名>」，此时插件默认处于关闭状态（`off`）。
  3. 打开启用开关，在「启用 <显示名>」确认框中核对 Hook、技能、MCP 服务器与不运行项后，点「启用」。
  4. 若插件包含可调用技能，启用后在详情页右侧点「立即试用」，会在当前工作区新开草稿会话并预填 `/<技能名> `（不会自动发送），接着补充试用提示词发送即可。
- **更新已有插件**：
  1. 先把 `.nocturne-plugin/plugin.json` 中的 `version` 提高一个小版本（例如 `0.1.0` → `0.1.1`）。
  2. 打开「设置」→「插件」，点「安装插件…」选择同一源码目录。
  3. 同名重装会原子替换整个已安装目录；若插件原本已启用且内容变化，状态会变为「已更改」（`changed`），Hook 会停止运行、技能与 MCP 服务器会被移除，需点「重新确认」并在弹窗中再次点「启用」后生效。

## 6. 如实交付

最终回复必须包含以下全部条目：

1. **源码目录绝对路径**；
2. **安装后的插件 ID**（`nocturne:<name>@local`）与**版本号**；
3. **`check_plugin` 检查结果**：`installable`、错误/警告摘要、发现的技能 / Hook / MCP 服务器，以及需留待「安装时才会检查」的说明；
4. **界面操作步骤**：首次安装或更新对应的完整点击步骤；
5. **试用提示词与预期结果**（对应第 1 步约定的例子）；
6. **已做与未做的检查**：明确区分已验证项与受环境限制未验证项；
7. **当前状态**：在用户尚未在界面完成操作前，明确标注为**「待安装、待启用、待试用」**（更新场景为**「待重新安装、待重新确认启用、待试用」**），绝不写成已完成。
