# 技能、Hook 与 MCP 服务器写法示例

下文提供三个可直接安装验证的最小完整示例：纯技能插件、Hook 插件与 stdio MCP 服务器插件。

## 1. 最小技能插件示例（`hello-skill`）

目录结构：

```text
hello-skill/
├─ .nocturne-plugin/
│  └─ plugin.json
└─ skills/
   └─ hello-skill/
      └─ SKILL.md
```

`.nocturne-plugin/plugin.json`：

```json
{
  "name": "hello-skill",
  "version": "0.1.0",
  "description": "生成简短的工作日报草稿。",
  "skills": "./skills",
  "interface": {
    "displayName": "日报助手"
  }
}
```

`skills/hello-skill/SKILL.md`：

```markdown
---
name: hello-skill
description: 根据用户提供的事项整理今日进展、明日计划与阻塞项。
argument-hint: "[今日事项]"
---

# 日报助手

根据参数 `$ARGUMENTS` 或对话上下文，按以下三节输出简洁中文日报：

1. **今日完成**
2. **明日计划**
3. **风险与阻塞**
```

说明：

- `SKILL.md` 顶部必须有闭合的 `---` YAML 前言；`name` 省略时默认取目录名。
- 插件技能的优先级为 `source: "plugin"`（最低），同名用户技能或项目技能会覆盖它。

---

## 2. Hook 契约与最小可用示例（`hook-guard`）

### 2.1 自有清单支持的全部 9 个 Hook 事件点

自有清单（`.nocturne-plugin/plugin.json`）可使用 Nocturne 全部 9 个 Hook 事件点（兼容清单 `.codex-plugin` / `.claude-plugin` 仅支持 4 个上下文类点位）：

| 事件点 | 触发时机 | stdout JSON 允许字段 |
|---|---|---|
| `PreToolUse` | 工具输入校验后、权限主体解析前 | `{ "decision": "ask" \| "deny", "reason"?: string, "updatedInput"?: unknown }`（**没有 `allow`**） |
| `PermissionRequest` | 规则求值为 `ask` 后、向用户弹窗前 | `{ "action": "allow" \| "deny", "reason"?: string }`（唯一可放宽 `ask` 的点位） |
| `PostToolUse` | 工具执行返回后、结果归一化前 | `{ "feedback"?: string }`（上限 4,000 字符） |
| `TurnStart` | `message.user` 写入后、Agent Loop 开始前 | `{ "block"?: boolean, "reason"?: string }` |
| `TurnEnd` | `turn.completed` 写入后 | 无效果（忽略输出，仅通知） |
| `UserPromptSubmit` | 用户输入写入后、`TurnStart` 前 | `{ "block"?: boolean, "reason"?: string, "additionalContext"?: string }` |
| `SessionStart` | 会话新建/恢复/分叉打开后，以及 L2 摘要后 | `{ "additionalContext"?: string }` |
| `SubagentStart` | 子会话首个 Turn 前 | `{ "additionalContext"?: string }` |
| `SessionEnd` | `session.close()` 清理开始前 | 无效果（忽略输出，仅通知） |

关键规则：

- `matcher` 仅对 `PreToolUse`、`PostToolUse`、`PermissionRequest` 生效，匹配工具名（如 `"shell"`、`"mcp_*"`），缺省 `"*"`。
- `timeoutMs` 默认 `5000`（5 秒），上限 `60000`（60 秒）。
- 子进程运行在最小白名单环境（`envMode: "minimal"`），注入 `PLUGIN_ROOT`、`PLUGIN_DATA`、`NOCTURNE_HOOK_EVENT`、`NOCTURNE_SESSION_ID`、`NOCTURNE_WORKSPACE_ROOT`、`NOCTURNE_CWD`。
- `command` 与 `args` 支持单次替换 `${PLUGIN_ROOT}`、`${PLUGIN_DATA}`、`${NOCTURNE_NODE}`。
- 不支持非命令类型（`type` 非 `"command"`）、`async: true` 与 `${user_config.*}` 占位符，它们会被记入「不运行」。
- 退出码 `0` 时按 stdout JSON 生效（空 stdout 表示无效果）；非零退出码视为失败，忽略 stdout 且不阻断会话。

### 2.2 最小 Hook 插件示例

目录结构：

```text
hook-guard/
├─ .nocturne-plugin/
│  └─ plugin.json
└─ hooks/
   └─ guard.mjs
```

`.nocturne-plugin/plugin.json`：

```json
{
  "name": "hook-guard",
  "version": "0.1.0",
  "description": "在会话启动注入安全提醒并拦截危险清空命令。",
  "hooks": {
    "SessionStart": [
      {
        "command": "${NOCTURNE_NODE}",
        "args": ["${PLUGIN_ROOT}/hooks/guard.mjs"],
        "timeoutMs": 5000
      }
    ],
    "PreToolUse": [
      {
        "matcher": "shell",
        "command": "${NOCTURNE_NODE}",
        "args": ["${PLUGIN_ROOT}/hooks/guard.mjs"],
        "timeoutMs": 5000
      }
    ]
  },
  "interface": {
    "displayName": "命令守卫"
  }
}
```

`hooks/guard.mjs`：

```js
const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const raw = Buffer.concat(chunks).toString("utf8").trim();
const payload = raw ? JSON.parse(raw) : {};

if (payload.point === "SessionStart") {
  process.stdout.write(
    JSON.stringify({
      additionalContext: "已启用命令守卫：执行破坏性删除命令前必须先确认目标路径。",
    }),
  );
  process.exit(0);
}

if (payload.point === "PreToolUse" && payload.tool === "shell") {
  const command = typeof payload.input?.command === "string" ? payload.input.command : "";
  if (/\brm\s+-rf\s+\/(?:\s|$)/.test(command)) {
    process.stdout.write(
      JSON.stringify({
        decision: "deny",
        reason: "命令守卫拦截了针对根目录的递归删除操作。",
      }),
    );
    process.exit(0);
  }
}
```

---

## 3. 最小 stdio MCP 服务器插件示例（`text-metrics`）

使用 `${NOCTURNE_NODE}` 启动零外部依赖的单文件 ESM 脚本，直接按换行分隔的 JSON-RPC 2.0 响应 MCP stdio 请求，无需用户另装 Node 或执行 `npm install`。

目录结构：

```text
text-metrics/
├─ .nocturne-plugin/
│  └─ plugin.json
└─ server.mjs
```

`.nocturne-plugin/plugin.json`：

```json
{
  "name": "text-metrics",
  "version": "0.1.0",
  "description": "统计文本的行数、字符数与非空词数。",
  "mcpServers": {
    "text-metrics": {
      "command": "${NOCTURNE_NODE}",
      "args": ["${PLUGIN_ROOT}/server.mjs"]
    }
  },
  "interface": {
    "displayName": "文本统计"
  }
}
```

`server.mjs`：

```js
import { createInterface } from "node:readline";

const TOOL_DEF = {
  name: "count_text",
  description: "Count lines, characters, and whitespace-separated words in a text string.",
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to analyze." },
    },
    required: ["text"],
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleRequest(req) {
  if (req.method === "notifications/initialized") return;

  if (req.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "text-metrics", version: "0.1.0" },
      },
    });
    return;
  }

  if (req.method === "ping") {
    send({ jsonrpc: "2.0", id: req.id, result: {} });
    return;
  }

  if (req.method === "tools/list") {
    send({ jsonrpc: "2.0", id: req.id, result: { tools: [TOOL_DEF] } });
    return;
  }

  if (req.method === "tools/call") {
    const name = req.params?.name;
    const args = req.params?.arguments ?? {};
    if (name !== "count_text" || typeof args.text !== "string") {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          isError: true,
          content: [{ type: "text", text: "Invalid tool call: expected count_text({ text })" }],
        },
      });
      return;
    }
    const text = args.text;
    const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length;
    const chars = Array.from(text).length;
    const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
    const stats = { lines, chars, words };
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
        structuredContent: stats,
      },
    });
    return;
  }

  if (req.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handleRequest(JSON.parse(trimmed));
  } catch {
    // 忽略无法解析的非 JSON 行
  }
});
```

说明：

- 只读工具请标注 `annotations: { readOnlyHint: true }`；未标注或为 `false` 的工具按写入工具走权限判定。
- 若服务器需要外部配置文件或 API 凭据，不要写进清单，也不要使用 `{ stored: true }`；请由用户通过系统环境变量（如在 `env` 中引用 `${MY_API_KEY}`）或在运行目录外自行配置。
