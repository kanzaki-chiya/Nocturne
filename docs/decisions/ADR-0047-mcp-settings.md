# ADR-0047：MCP 设置管理——程序维护的 `mcp.json`、凭据库引用与连接探测

- 状态：已接受（维护者 2026-10-06 拍板，见文末「已拍板」）
- 日期：2026-10-06

## 背景

MCP 客户端从 Phase 5 起就可以用（[mcp.md](../architecture/mcp.md)、[ADR-0011](ADR-0011-mcp-client.md)），但管理入口只有手写配置一条路：服务器写在 `config.json` 或项目 `.nocturne/config.json` 的 `mcp.servers` 里，状态只能在会话里用 `/mcp` 查看。桌面端要做「设置 → MCP」页面，让用户在界面里增删改服务器、开关服务器、测试连接。现有设计里有三处缺口：

1. **没有程序能写的层。** config.md 的原则是「程序写自己的文件，从不改写 `config.json`」（第 1 节），服务商因此有 `providers.json`，程序设置有 `settings.json`。MCP 还没有对应的机器维护文件。
2. **密钥只能来自环境变量。** `env` 的值只允许写 `${NAME}` 引用，疑似字面凭据会导致整层配置被拒（`config_credential_rejected`）。图形界面里，用户多半是从服务器的 README 复制一个 token 直接粘贴，要求他们先去设系统环境变量，门槛太高。
3. **状态只能在会话里看到。** 服务器随会话启动、随会话关闭（mcp.md 第 4 节）。设置页是全局页面，没有会话，就看不到「能不能连上、有哪些工具」。

## 决定

### 1. 新增程序维护层 `<NOCTURNE_HOME>/mcp.json`

```jsonc
{
  "version": 1,
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": { "stored": true },
        "LOG_LEVEL": "info",
        "HTTP_PROXY": "${HTTP_PROXY}"
      },
      "enabled": true
    }
  }
}
```

- **条目形状**：与 `mcp.servers` 相同（mcp.md 第 3 节），共用同一个 schema。唯一扩展是 `env` 的值可以写成 `{ "stored": true }`，见第 2 节。
- **分层位置**：与 `providers.json` 同级，低于所有手写配置：

  ```text
  内置默认 < … < mcp.json（程序维护）< 程序设置 < 用户配置 < 项目配置 < …
  ```

  按服务器 id 合并（规则沿用 mcp.md 第 3 节）。合并产物 `ResolvedConfig.mcpServers` 的 `origin` 新增一个取值 `"app"`。
- **信任**：可信，与 `providers.json` 一样，因为只有用户自己操作的界面会写它。
- **写入**：先写临时文件再 rename（原子替换），成功后才更新内存，失败时保留旧值。走同一个配置写入队列串行执行，与 `providers.json`、`settings.json` 共用。文件损坏时忽略整个文件并发出警告，不阻塞启动；单个条目无效时只忽略该条并警告。
- **权限**：把 `mcp.json` 加进 permissions.md 第 6 节第 4 条「Nocturne 授权数据」一组，对它的 `edit` 至少 `ask`。理由是这个文件决定会话启动哪些进程，和 `providers.json` 能把请求重定向到别的端点属于同一级别的风险。

### 2. 密钥：存进凭据库，配置里只留引用

- **只在 `mcp.json` 里有效**：`env` 值可以是字符串（字面值或 `${NAME}`），也可以是 `{ "stored": true }`。后者表示这个变量的值存在 ADR-0015 的凭据库里，凭据 id 为 `mcp/<serverId>/<VAR>`。`config.json` 和项目配置维持现状：仍然只接受字符串，出现 `{ "stored": … }` 时按无效字段处理。
- **凭据 id 不会和服务商撞车**：服务商 id 不允许含 `/`，`mcp/` 前缀就不会与之冲突。实现时要核对服务商 id 的校验规则，如果没有禁止 `/`，就先补上。
- **启动时取值**：spawn 之前经注入的 `CredentialStore.get` 取出值，叠加到白名单环境上（mcp.md 第 3 节）。取不到值时，该服务器记为 `failed`，警告码 `mcp_secret_missing`，消息里写出服务器名和变量名，不写值。取出的值不进入 `ResolvedConfig`、事件、诊断日志或错误消息；脱敏规则沿用 provider-setup.md 第 3 节。
- **没有可用的系统后端时**（`backend() === "none"`）：界面不提供「保存到凭据库」，只提供环境变量引用，并说明原因。与 API key 的规则一样，不退回明文存储。
- **跟着条目一起删**：删除服务器、或把某个变量从 `stored` 改成其他形式时，同步删除对应的凭据。服务器 id 创建后不可改；要改名就删掉重建，免得凭据 id 迁移出错。
- **防 Agent 读取**：凭据仍在 `credentials.json` 或系统后端里，已有的硬拒绝和提示规则（provider-setup.md 第 4 节）直接覆盖，不用新增。

### 3. 管理接口：Core 数据接口，加上 RPC 的 `mcp.*` 方法

Core 的 `Runtime` 新增以下方法，RPC 一一映射为 `mcp.*` 命名空间下的方法（形状校验全部在 Core，RPC 层不复制）：

| 方法 | 参数 → 结果 | 说明 |
|---|---|---|
| `describeMcpServers` | `{ workspaceRoot? }` → `{ servers: McpServerOverview[]; warnings }` | 合并后的服务器列表。每项包括 `id`、`origin`（`app` / `user` / `project`）、`editable`（只有 `app` 为 true）、`enabled`、`command`、`args`、`cwd?`、超时设置，以及 `env: { name, kind: "literal" \| "env" \| "stored", value?, stored?: "set" \| "missing" }[]`。字面值原样返回，因为它们本来就不是密钥；stored 的值永远不返回。给了 `workspaceRoot` 时附带该项目的条目，并带 `trusted` 标记；不给时只返回 `app` 和 `user` |
| `saveMcpServer` | `{ mode: "create" \| "replace", id, config, secrets?: Record<VAR, string \| null> }` → `McpServerOverview` | 写 `mcp.json`。`secrets` 中给了字符串就写入凭据库，给 `null` 就删除。顺序是先写凭据、再写配置；配置写入失败时回滚刚写的凭据，做法同 `updateSettings` 处理 reviewerKey。字段错误以 `-32005` 返回，附 `field`。`create` 时 id 和任何来源的已有服务器 id 重复（不区分大小写），返回 `field: "id"`，规则同服务商重名 |
| `deleteMcpServer` | `{ id }` → `null` | 只能删 `app` 条目，同时删除它的全部凭据 |
| `setMcpServerEnabled` | `{ id, enabled }` → `null` | 只能改 `app` 条目 |
| `probeMcpServer` | `{ id } \| { config, secrets? }`，外加 `workspaceRoot` → `McpProbeResult` | 见第 4 节 |

- **只能编辑程序维护的条目。** 写在 `config.json` 里的服务器在界面上只读，标明「在 config.json 中定义」；项目里的服务器同样只读，并显示该项目的信任状态。理由：程序从不改写手写配置；`mcp.json` 的层级又低于 `config.json`，想用它去覆盖手写条目也覆盖不了。
- **修改对已打开的会话热生效**，机制见第 4a 节。保存成功后，客户端负责让其他后台重新读配置：桌面端复用 `BackendPool.propagateConfig`，调用其他后台的 `runtime.reloadConfig`。不新增事件类型。
- **TUI 和 CLI 本轮不加管理命令**，`/mcp` 维持只读。

### 4. 连接探测 `probeMcpServer`

- **流程**：经现有 `McpConnector` 走一遍 spawn → `initialize` → `tools/list` → 关闭（含进程树清理），总时长受该条目的 `startupTimeoutMs` 约束。
- **两种入参**：可以探测已保存的条目（按 `id`），也可以探测还没保存的草稿（`config` 加上一次性的 `secrets`）。草稿里的 secrets 只在这次探测时注入子进程环境，不落盘，也不缓存。
- **cwd**：相对路径按调用方给的 `workspaceRoot` 解析。桌面端的设置页传普通对话的工作区。
- **结果**：`{ ok, durationMs, serverInfo?: { name, version }, tools: { name, description? }[], error?: { code, message }, stderrTail?: string[] }`。`stderrTail` 最多 20 行，每行截断，并经过与诊断日志相同的脱敏。错误码复用现有的 `mcp_server_failed` 类别，并细分为 `spawn_failed`、`startup_timeout`、`initialize_failed`、`mcp_secret_missing`。
- **不经过权限层**：探测是用户在设置界面里亲手点的操作，和服务商的「获取模型列表」同类，不是模型发起的工具调用。未信任项目的条目拒绝探测，因为那就等于替不可信的仓库启动它指定的进程。
- **探测结果不持久化**：设置页的状态列显示的是本次界面里最近一次探测的结果，没测过就显示「未测试」。会话里服务器的实际运行状态仍然通过 `/mcp` 和 `mcp.server` 事件查看。

### 4a. 已打开会话的热更新

- **触发**：Runtime 每次重新加载配置后（包括 `mcp.*` 变更方法自动触发的重载，以及其他进程通知的 `reloadConfig`），对每个已打开的会话，按它的 `workspaceRoot` 和信任状态重新算出期望的服务器集合，交给该会话的 `McpSession.reconcile(servers)`。`McpSession` 接口新增 `reconcile` 方法，`@nocturne/mcp` 提供实现。不监听文件：用户在编辑器里手改 `config.json` 后，要等下一次 `reloadConfig`（或重开会话）才会生效。
- **比对**：以服务器 id 为键，比较规范化后的条目内容（包括 stored 凭据的当前值摘要，这样替换密钥也算变更）：
  - 新增或由停用改为启用 → 启动；
  - 删除或改为停用 → 停止；
  - 内容有变化 → 先停止再启动；
  - 内容没变 → 不动，不重启进程。
- **生效时机**：沿用 mcp.md 第 4 节处理 `list_changed` 的暂存规则。会话空闲时立即执行；会话正在跑 Turn 时，暂存到 Turn 边界再执行。这样 Turn 内的工具集和上下文前缀保持稳定，在途调用也不会被中途杀掉。子会话持有的是父会话工具集的快照，子会话本来就在父 Turn 内运行，所以自然在父 Turn 结束之后才切换。
- **可见性**：每台服务器的状态变化照常发临时事件 `mcp.server`；启动失败照常发 `runtime.warning`。工具集变化会让下一次请求的提示缓存失效，这是用户主动修改配置换来的、可以接受的代价。
- **恢复兼容**：被删除服务器的历史调用照常回放（mcp.md 第 7 节已有的结论）。

### 5. 桌面端「设置 → MCP」页

- **入口**：设置导航在「服务商」之后新增「MCP」一项。
- **列表**：每行显示名称、命令摘要、来源标签（程序管理 / config.json）、启用开关（仅程序管理的条目可用）、最近一次探测结果（未测试 / 已连接 · N 个工具 / 失败与原因），以及「测试」「编辑」「删除」三个操作。只读条目只有「测试」和「查看」。
- **从 JSON 导入**：列表页有「从 JSON 导入」按钮。可以粘贴 Claude Desktop 格式的 `{"mcpServers": {...}}`、单个 `{"名称": {...}}`，或者裸条目 `{"command": …}`；解析在前端完成，结果预填进添加表单，一次导入多台服务器时逐台确认。`env` 里疑似密钥的字面值（变量名含 `KEY`、`TOKEN`、`SECRET`、`PASSWORD`，或者值看起来像令牌）默认切换为「保存到凭据库」，用户可以手动改回。不支持的字段（例如 `type: "http"`）明确提示「暂不支持」，不静默丢弃。
- **添加 / 编辑表单**：
  - 字段：名称（创建后不可改）、命令、参数（逐行一个）、工作目录（可选）；
  - 环境变量：表格形式，每行选择值的类型——「明文」「引用环境变量」「保存到凭据库」。已保存的密钥只显示「已保存」，可以「替换」或「清除」，永远不回显明文；
  - 高级选项折叠在一起：两个超时设置；
  - 表单底部有「测试连接」，成功时展开工具列表。测试失败也允许保存。
- **空态**：一句说明，加一个「添加服务器」按钮。
- 视觉细节以单独的界面稿为准，界面稿经维护者确认后才开始实现。

### 6. 文档

- mcp.md：第 3 节加入 `mcp.json` 层与 `stored`，第 7 节加入探测，第 8 节加入管理接口；
- config.md：第 1 节分层表；
- provider-setup.md：第 3 节写明凭据 id 的命名空间；
- permissions.md：第 6 节第 4 条；
- rpc.md：新增 `mcp.*` 小节；
- desktop.md：设置区与 5.x MCP 页；
- README：只写面向用户的「在桌面端添加 MCP 服务器」一句话说明。

## 后果

- 新增一个机器维护文件和一类凭据 id。旧版本 Runtime 不认识 `mcp.json`，会直接忽略它：降级后程序管理的服务器会消失，但不会报错。
- MCP 服务器第一次可以带上不来自环境变量的密钥，安全性与服务商 API key 处于同一级别（凭据库加硬拒绝）。
- 界面上的服务器分成两类：程序管理的可编辑，手写的只读。已经在 `config.json` 里写了服务器的老用户，要改就继续手改；本 ADR 不提供迁移。
- 已打开的会话在 Turn 边界热更新服务器列表，`McpSession` 接口多出一个 `reconcile` 方法。手改 `config.json` 不会被自动发现，仍然要等重载或重开会话。

## 备选方案

- **把 MCP 条目放进 `settings.json` 白名单**：`settings.json` 存放的是标量设置和界面偏好；服务器条目是一组可执行内容，带凭据引用，还需要逐条校验和逐条失效处理。单独放一个文件，边界更清楚，也能单独纳入「授权数据」保护。不采用。
- **由程序直接改写 `config.json`**：违背 config.md 第 1 节「程序从不改写用户手写配置」的原则，而且会破坏用户手写的注释和格式。不采用。
- **只对新会话生效**：实现最简单，但维护者要求修改能在已打开的会话里生效（见「已拍板」第 3 条）。不采用。

## 实施顺序

1. Core：`mcp.json` 层、`stored` 解析与凭据注入、管理接口、`probeMcpServer`、`McpSession.reconcile` 热更新；RPC `mcp.*`；离线测试用假 MCP 服务器夹具覆盖全部路径。
2. 界面稿（交维护者确认）。
3. 桌面端 MCP 页、从 JSON 导入、保存后的配置传播、前端测试、GUI 实测。
4. 文档同步。

## 已拍板

1. **支持粘贴 JSON 导入**：规则见第 5 节。
2. **手写条目保持只读**：`mcp.json` 层级不高于 `config.json`，界面不改手写配置。
3. **对已打开的会话热生效**：在 Turn 边界按 id 比对后增量启停，见第 4a 节。
4. **TUI 和 CLI 本轮不加管理命令**：`/mcp` 维持只读，等桌面端形态稳定后再评估。
