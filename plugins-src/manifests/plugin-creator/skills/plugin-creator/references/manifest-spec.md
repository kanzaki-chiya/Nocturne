# Nocturne 自有插件清单字段参考

Nocturne 自有插件的清单位于插件根目录下的 `.nocturne-plugin/plugin.json`（UTF-8 JSON 对象）。本地目录安装时若不存在自有清单，Nocturne 会依次回退读取 `.codex-plugin/plugin.json`、`.claude-plugin/plugin.json`；但新建 Nocturne 插件一律使用 `.nocturne-plugin/plugin.json`，以获得完整的 9 点位 Hook 与 `ui.surfaces` 支持。

## 1. 顶层字段一览

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "用一句简洁动词短语说明插件能做什么。",
  "skills": "./skills",
  "hooks": "./hooks/hooks.json",
  "mcpServers": {
    "my-server": {
      "command": "${NOCTURNE_NODE}",
      "args": ["${PLUGIN_ROOT}/server.mjs"]
    }
  },
  "interface": {
    "displayName": "我的插件",
    "composerIcon": "./icon.svg"
  },
  "ui": {
    "surfaces": []
  }
}
```

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `name` | 建议必填 | `string` | 插件标识名；省略时回退为插件根目录名。必须满足 `/^[a-z0-9-]+$/`（仅小写 ASCII 字母、数字、连字符）。本地安装后插件 ID 固定为 `nocturne:<name>@local`。 |
| `version` | 建议必填 | `string` | 推荐使用 SemVer 2.0（如 `0.1.0`、`1.2.3-rc.1`）。满足合法目录名 `/^[A-Za-z0-9.+_-]+$/`（且不为 `.`、`..`）时直接用作安装版本目录名；缺省或不合法时回退为 `local`。 |
| `description` | 建议 | `string` | 插件说明；缺失时回退取 `interface.shortDescription` 或 `interface.longDescription`。 |
| `skills` | 可选 | `string \| string[]` | 技能目录相对路径（必须以 `./` 开头）。可指向包含 `SKILL.md` 的单个技能目录，或包含多个 `<skill>/SKILL.md` 子目录的上级目录。省略时自动扫描默认 `./skills`（若存在）。 |
| `agents` | 可选 | `string` | 仅自有清单读取。子代理定义目录相对路径（必须以 `./` 开头，例如 `"./agents"`）；省略时不读取子代理。目录下每个 `*.md` 定义一个子代理（YAML 前言含必填 `name`、`description` 与可选 `tools`、`effort`，正文为角色说明）。 |
| `hooks` | 可选 | `string \| object \| (string \| object)[]` | Hook 配置文件相对路径（`./` 开头）或内联 Hook 映射对象，也可传数组合并多个来源。省略时自动读取默认 `hooks/hooks.json`（若存在）。 |
| `mcpServers` | 可选 | `string \| object \| (string \| object)[]` | MCP 服务器配置文件相对路径（`./` 开头，文件形如 `{ "mcpServers": { ... } }`）或内联服务器映射对象，也可传数组合并。省略时自动读取默认 `.mcp.json`（若存在）。 |
| `interface` | 可选 | `object` | 展示元数据：`displayName`（界面显示名）、`shortDescription`、`longDescription`、`composerIcon`、`logo`。 |
| `ui` | 可选 | `object` | 仅自有清单读取。包含 `surfaces` 数组，用于在桌面端右侧面板声明 MCP Apps 交互页面。 |

## 2. 相对路径与复制规则

- 清单内 `skills`、`agents`、`hooks`、`mcpServers` 中的字符串路径**必须以 `./` 开头**，且词法解析与真实路径（`realpath`）都不得越出插件根目录，否则安装会被拒绝。
- 本地安装会把插件目录递归复制到 `<NOCTURNE_HOME>/plugins/installed/local/<name>/<version>/`，复制过程中会**跳过 `.git` 目录和所有符号链接**（不跟随、不复制）。
- 若 `.nocturne-plugin/plugin.json` 或技能/脚本本身是符号链接，会导致复制后清单丢失或能力为空，安装会在复制后校验阶段拒绝。
- 源目录不得位于 `<NOCTURNE_HOME>/plugins/` 内部，否则会被拒绝安装。

## 3. 图标规则（`interface.composerIcon` / `interface.logo`）

- Nocturne 优先读取 `interface.composerIcon`，无效或缺失时回退 `interface.logo`。
- 图标路径必须是插件根目录内的相对路径（不能是绝对路径或越出根目录），不可指向根目录自身。
- 仅支持五种扩展名：`.png`、`.jpg`、`.jpeg`、`.webp`、`.svg`，且会校验文件头魔数（SVG 需以 `<svg` 标签开头，允许前导 XML 声明/注释/DOCTYPE）。
- 单个图标文件大小必须大于 `0` 且不超过 **64 KiB（65,536 字节）**。
- 不满足条件时不会阻断安装，界面会回退显示默认插件图标。

## 4. 可用能力门槛

安装与发现阶段均要求插件至少具备以下四项之一，否则安装失败（`清单无效：插件不包含可用的技能、Hook、MCP 服务器或子代理`）：

1. 至少一个解析成功的技能（含闭合 YAML 前言 `---` 的 `SKILL.md`）；
2. 至少一个受支持的 Hook 条目；
3. 至少一个未被跳过的 stdio MCP 服务器；
4. 至少一个解析成功的自有插件子代理定义（`agents/*.md`）。

## 5. MCP 服务器约束与凭据禁止

- 服务器键名（`serverId`）必须满足 `/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/`（1–32 位，字母或数字开头）。
- **仅支持 stdio 传输**（省略 `type` 或写 `"type": "stdio"`）；`"type": "http"` 的条目会被跳过（`skipReason: "http"`，界面标注「不支持 HTTP」），其他非 `stdio` 类型同样跳过。
- `command`、`args`、`env`、`cwd` 支持单次字符串替换：
  - `${NOCTURNE_NODE}`：当前运行 Nocturne Runtime 的 Node 可执行文件路径；
  - `${PLUGIN_ROOT}`：插件安装副本的真实根目录；
  - `${PLUGIN_DATA}`：Nocturne 为该插件分配的数据目录（`<NOCTURNE_HOME>/plugins/data/<name>-local`）。
- `env` 键名必须满足 `/^[A-Za-z_][A-Za-z0-9_]*$/`。
- **禁止明文凭据**：不要把 API Key、Token、密码写进清单或源码。
- **禁止 `{ stored: true }`**：插件 MCP 的 `env` 不允许声明 `{ "stored": true }`，此类条目会被跳过（`skipReason: "stored"`，界面标注「不支持凭据库」）。
- **同名冲突**：若服务器键名与用户、项目配置或 `mcp.json` 中的服务器同名（不区分大小写），配置文件优先，插件条目跳过（`skipReason: "conflict"`，界面标注「与配置同名」，并发 `plugin_mcp_conflict` 警告）。

## 6. `ui.surfaces` 字段（插件面板，ADR-0101）

仅自有清单（`.nocturne-plugin/plugin.json`）支持 `ui.surfaces`，仅在桌面端右侧面板生效（手机网页、安卓与 TUI 忽略页面，按普通工具行展示）。不合法的条目会被跳过并记入插件 `warnings`。

```json
"ui": {
  "surfaces": [
    {
      "id": "viewer",
      "title": "示例面板",
      "server": "my-server",
      "resourceUri": "ui://my-server/viewer.html",
      "open": {
        "tool": "open_item",
        "fileTypes": [".txt"]
      }
    }
  ]
}
```

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` | 是 | 仅允许小写字母、数字和连字符（`/^[a-z0-9-]+$/`），同一插件内不可重复。 |
| `title` | 是 | 非空字符串（不支持多语言对象），用于右侧面板标签与新标签页卡片标题。 |
| `server` | 是 | 必须是本插件有效 `mcpServers` 中的键名。 |
| `resourceUri` | 是 | 必须以 `ui://` 开头且后面非空。 |
| `open` | 否 | 配置文件引用自动打开：`tool` 为非空字符串，`fileTypes` 为非空小写点开头扩展名数组（如 `[".md", ".txt"]`，不含空白）。当工具列表可得时，`open.tool` 必须是该服务器上声明了 `readOnlyHint: true` 且 `visibility` 含 `"app"` 的工具，否则忽略 `open` 并记警告。 |

运行时宿主约束（ADR-0101）：

- `resources/read` 仅接受 `ui://` URI，响应 `mimeType` 必须为 `text/html;profile=mcp-app`，UTF-8 解码后不超过 **8 MiB**。
- 页面运行在断网沙箱（`connect-src 'none'`），不允许联网请求外部脚本、样式或接口，所需资源须内联进 HTML 或通过只读工具由本服务器提供。
- 页面经 postMessage 发起的 `tools/call` 只能调用**同一会话、同一服务器**上同时满足 `readOnlyHint: true` 且 `_meta.ui.visibility` 包含 `"app"`（省略时默认 `["model", "app"]`）的工具；写入类工具会被权限层以 `app_tool_not_allowed` 拒绝。
- 不支持 `sampling/createMessage`、`registerTool`、`oncalltool` 与 `ui/update-model-context`。
