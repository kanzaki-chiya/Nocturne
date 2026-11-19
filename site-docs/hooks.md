# Hook

Hook 是在固定生命周期事件点触发的外部命令：Runtime 在对应时机启动子进程，经 `stdin` 传入 JSON 上下文，从 `stdout` 读取 JSON 结果并合并进当前执行管线。配置写在用户级 `~/.nocturne/config.json` 或项目级 `<workspaceRoot>/.nocturne/config.json` 的 `hooks` 段（详见 [配置参考](config.md)）。

## 完整示例

下面配置一条 `PreToolUse` Hook，在执行 `shell` 工具前拦截包含 `git push --force` 的命令。

### 1. 在 `config.json` 中登记

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "shell",
        "command": "node",
        "args": ["./hooks/guard-shell.mjs"],
        "timeoutMs": 5000
      }
    ]
  }
}
```

每条配置包含四个字段：

- `command`（必填）与 `args`（可选）：可执行文件与参数数组，**不经 shell 解释**（如需 shell 语法可自行写 `sh -c` 或 `cmd /c`）。裸命令只按 `PATH` 查找；相对路径按会话 `workspaceRoot` 解析。
- `matcher`（可选）：工具名通配符（支持 `*`、`?` 与 `|` 分隔，缺省 `"*"`），仅对 `PreToolUse`、`PermissionRequest`、`PostToolUse` 生效。
- `timeoutMs`（可选）：单次执行超时毫秒数，默认 `5000`，硬上限 `60000`。

子进程继承 Runtime 进程环境，并额外注入 `NOCTURNE_HOOK_EVENT`、`NOCTURNE_SESSION_ID`、`NOCTURNE_WORKSPACE_ROOT`、`NOCTURNE_CWD` 四个环境变量。

### 2. 编写读 `stdin`、写 `stdout` 的脚本

在工作区下创建 `hooks/guard-shell.mjs`：

```js
import { readFileSync } from "node:fs";

const payload = JSON.parse(readFileSync(0, "utf8"));
const cmd = typeof payload.input?.command === "string" ? payload.input.command : "";

if (/\bgit\s+push\b[^\n]*(--force|-f)\b/.test(cmd)) {
  process.stdout.write(
    JSON.stringify({
      decision: "deny",
      reason: "禁止通过 shell 执行强制推送",
    }),
  );
}
```

脚本正常退出（退出码 `0`）且 `stdout` 为空时视作「无意见」，工具调用照常继续。

## 事件点与输出摘要

全部 9 个事件点的触发时机与 `stdout` JSON 可用字段如下（完整输入字段与权限管线接线见 [Hooks 架构文档](https://github.com/kanzaki-chiya/Nocturne/blob/main/docs/architecture/hooks.md#1-事件点) 与 [契约说明](https://github.com/kanzaki-chiya/Nocturne/blob/main/docs/architecture/hooks.md#2-hook-的形态与契约)）：

| 事件点 | 触发时机 | 可返回的有效字段 |
|---|---|---|
| `PreToolUse` | 工具输入校验通过后、权限主体计算前（支持 `matcher`） | `decision`（`"ask"` \| `"deny"`，无 `"allow"`）、`reason`、`updatedInput`（改写后重新校验） |
| `PermissionRequest` | 权限规则求值为 `ask` 后、询问用户前（支持 `matcher`） | `action`（`"allow"` \| `"deny"`）、`reason`；无有效字段时继续询问用户 |
| `PostToolUse` | 工具执行返回后、结果归一化前（支持 `matcher`） | `feedback`（追加进模型可见结果，上限 `4000` 字符，超出截断） |
| `TurnStart` | 用户消息写入与 `UserPromptSubmit` 之后、Agent Loop 开始前 | `block`（`true` 时以 `hook_blocked` 结束本轮）、`reason` |
| `TurnEnd` | `turn.completed` 写入后 | 忽略所有输出（仅通知） |
| `UserPromptSubmit` | 用户主动提交消息写入后、`TurnStart` 前 | `block`、`reason`、`additionalContext`（附注在该条用户消息后；拦截时丢弃） |
| `SessionStart` | 会话新建、恢复、分叉打开后，及 L2 摘要成功后下一次请求前 | `additionalContext`（作为会话级快照注入系统上下文） |
| `SubagentStart` | 子会话 `SessionStart` 后、首个 Turn 前（外部 ACP Agent 不触发） | `additionalContext`（作为子会话快照注入系统上下文） |
| `SessionEnd` | 会话关闭、清理开始前 | 忽略所有输出（仅通知） |

关键限制与顺序规则：

- 同一事件点的多条 Hook 按配置顺序**串行执行**；`PreToolUse` 后续条目能看到前一条改写后的 `updatedInput`；`deny` 或 `block` 结算后短路，不再运行后续条目。
- `additionalContext` 单条上限 `10,000` 字符（超出截断），单事件全部条目合计上限 `30,000` 字符（超出后续条目丢弃）。
- 单次调用的 `stdout` 上限为 `64 KB`（`65536` 字节）。

## 生效范围

- **分层追加**：用户级 `~/.nocturne/config.json` 与项目级 `<workspaceRoot>/.nocturne/config.json` 按事件点合并，同名点位**追加**执行——用户级在前，项目级在后，执行顺序即配置顺序。
- **项目级需要信任**：未信任项目的 `.nocturne/config.json` 中的 `hooks` 段整段**不执行**。在桌面端「设置」→「授权」点击「信任此项目」（或运行 `nctrn trust`）后才会启用（见 [权限模式](permissions.md)）。
- **生效时机**：Hook 在打开会话时按当前配置装配。修改配置文件或变更项目信任状态后，需**新开或重新打开会话**才生效；子代理会话沿用父会话已按信任过滤的 Hook 条目（子会话不触发 `UserPromptSubmit`）。

## 在桌面端查看

打开桌面端「设置」→「Hook」（位于「Agent 能力」分组下），可以只读查看实际生效的 Hook：

- 配置文件中的 Hook 按事件点分组排在前面，组内按实际执行顺序排列；
- 每行显示等宽命令与参数、`matcher`（仅支持 `matcher` 的工具事件点）、超时时长和来源配置文件路径；
- 项目级 Hook 会标出「已信任」或「未信任」，未信任条目不会生效；
- 插件带的 Hook 也会列在这里，点击查看插件详情（列在「来自插件」分组下，仅含已启用且至少有 1 个受支持 Hook 的插件，见 [插件](plugins.md)）。

## 排查

### 失败与超时的表现

以下任一情况都按本次 Hook 执行失败处理（详见 [Hooks 超时与失败处理](https://github.com/kanzaki-chiya/Nocturne/blob/main/docs/architecture/hooks.md#4-超时失败输出过大)）：

- 进程启动失败（例如命令不在 `PATH` 中或脚本路径不存在）；
- 超过 `timeoutMs`（触发整个进程树强杀）；
- 退出码非 `0`；
- `stdout` 超过 `64 KB` 或非合法 JSON。

Hook 失败**不会阻断会话或工具执行**：该条目视作无效果（`PermissionRequest` 失败则继续询问用户），并向当前会话发出 `hook_failed` 警告。

### 查看诊断日志

Hook 的 `stderr` 与运行详情写入本地诊断日志，默认关闭（详见 [可观测性文档](https://github.com/kanzaki-chiya/Nocturne/blob/main/docs/architecture/observability.md)）：

- 设置环境变量 `NOCTURNE_DEBUG=1`（或在 CLI 传入 `--debug`）启用诊断，默认写入 `~/.nocturne/logs/debug-<yyyymmdd-HHmmss>-<pid>.jsonl`；
- 如需指定路径，设置 `NOCTURNE_DEBUG_FILE=<路径>`（或 `--debug-file -` 输出到 `stderr`）；
- 在 JSONL 日志中按 `kind` 检索：
  - `hook.run`：每次触发记录点位、命令与工具名；
  - `hook.done`：记录耗时（`durationMs`）、是否成功（`ok`）、退出码、失败原因（`reason`）及截断至 `2000` 字符的 `stderrTail`；
  - `hook.context_dropped`：当 `additionalContext` 超过单事件 `30,000` 字符总上限被丢弃时记录。
- 桌面端也可在「设置」→「后台日志」查看后台进程的 `stderr` 输出。
