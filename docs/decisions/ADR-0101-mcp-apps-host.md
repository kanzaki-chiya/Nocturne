# ADR-0101：MCP Apps 宿主（插件交互页面与侧边面板）

- 状态：已接受
- 日期：2026-11-20
- 相关：[ADR-0100](ADR-0100-native-plugins.md)（自有插件，本 ADR 是其第 5 节分期第 4 项的前半）、[ADR-0088](ADR-0088-inline-html.md)（`nct-sandbox` 隔离空壳）、[ADR-0060](ADR-0060-desktop-side-panel.md)（右侧面板）、[ADR-0011](ADR-0011-mcp-client.md)、[ADR-0057](ADR-0057-reviewer-v2.md)、[architecture/mcp.md](../architecture/mcp.md)、[architecture/permissions.md](../architecture/permissions.md)

## 背景

ADR-0100 第 5 节分期第 4 项要求桌面端侧边面板显示文档，并配查看器技能。

参照对象：ZCode 的文档插件。它用 MCP Apps 扩展（SEP-1865，扩展标识 `io.modelcontextprotocol/ui`，规范版本 2026-01-26，状态 Stable）实现侧边面板：

- 插件 MCP 服务器提供 `ui://` 资源（`text/html;profile=mcp-app`）；
- 工具定义用 `_meta.ui.resourceUri` 关联页面；
- ZCode 在此之上加了插件清单 `ui.surfaces` 与工具 `_meta.ui.surface`，用来指定侧边面板；
- 页面经 postMessage 上的 JSON-RPC 调用本服务器的工具、把内容交回对话；
- 查看器技能（如 `docx-viewer`）配合 `open_document`、`show_in_viewer`、`get_view` 等工具使用。

用户在两种做法之间选了「MCP Apps 通用宿主」（2026-11-20）：任何启用的插件都能提供交互页面，第三方插件也一样。另一种做法是只在「文件」标签里内置文档查看，已放弃。

已有基础：

- ADR-0088 的 `nct-sandbox` 自定义协议、`sandbox="allow-scripts"` 不透明源子框架、子框架 Tauri IPC 封锁、断网 CSP，已在桌面、安卓、手机网页三端实测；
- 插件 MCP 服务器按需启动与工具缓存（ADR-0100 修订第 4 节）；
- `tool.completed.output.structured` 已保存 MCP `structuredContent`（`packages/mcp/src/connector.ts`）。

## 决定

### 1. 范围

- 只在**桌面端**提供 MCP Apps 宿主；页面一律显示在右侧面板的标签里。
- 不做的：
  - 对话内联显示 MCP App；
  - 手机网页、安卓 App、TUI 的宿主。这些客户端照常显示普通工具行；
  - 页面经宿主调用模型（`sampling/createMessage`）；
  - 页面向模型注册工具（`registerTool`、`oncalltool`）；
  - `ui/update-model-context`。
- 只接插件带来的 MCP 服务器（ADR-0100 第 2 节）。用户在配置文件里写的 MCP 服务器不接 MCP Apps，避免任意服务器在桌面端渲染页面。

### 2. Core 与 MCP 连接层

- **能力协商**：对插件服务器，客户端 `initialize` 声明扩展能力 `io.modelcontextprotocol/ui`，按 SDK 支持的写法；`mimeTypes` 为 `["text/html;profile=mcp-app"]`。
- **工具元数据**：
  - 保留工具定义里的 `_meta.ui.resourceUri`、`_meta.ui.visibility`、`_meta.ui.surface`；
  - 插件 MCP 工具缓存同时保存这三项。缓存格式变化后，旧缓存视为未命中。
- **可见性**：
  - `visibility` 缺省为 `["model", "app"]`；
  - 不含 `"model"` 的工具不进模型工具列表，也不进按需模式的 `mcp_search` 结果；
  - 不含 `"app"` 的工具，页面不能调用。
- **工具结果关联页面**：工具定义带 `resourceUri` 时，`tool.completed` 新增可选字段 `ui`，内容为插件 id、服务器 id、`resourceUri`、`surface`（若有）。
  - 不提升 `formatVersion`：`packages/core/src/protocol/schema.ts` 里 `tool.completed` 是普通 `z.object`（未用 `strict`），旧版本读到会剥离未知字段，理由同 ADR-0088 第 4 节。
  - 页面需要的工具结果取自同一事件里已有的 `modelContent`、`output.structured`，不另存一份。
- **读取页面**：
  - 经 MCP `resources/read` 读取；只接受 `ui://` 开头的 URI，且 `mimeType` 为 `text/html;profile=mcp-app`；
  - 内容可以是 `text`，也可以是 base64 `blob`，UTF-8 解码后不超过 8 MiB（与 ADR-0088 第二版 `MAX_INLINE_HTML_SAVED_BYTES` 相同）；
  - 服务器未启动时按 ADR-0100 修订第 4 节启动。

### 3. 页面调用工具与权限

- 页面只能调用**同一会话、同一服务器**上 `visibility` 含 `"app"` 的工具。跨服务器调用一律拒绝。
- 每次调用都经权限层判定，主体与模型调用相同（`mcp <server>/<tool>`，带 `readOnly`），另加调用来源 `app`。第一版页面只能调用只读工具，判定规则：
  - 工具不是 `readOnlyHint: true`：拒绝，错误码 `app_tool_not_allowed`，不论规则结果与预设（含 `guarded`、`bypass` 与显式 `allow`）；
  - 只读工具，规则结果为 `deny`：拒绝；
  - 只读工具，规则结果为 `allow` 或 `ask`：执行，不弹确认。
- 这是对权限的放宽：`default`、`read-only` 预设下 mcp 主体是 `ask`，页面来源的只读调用却直接执行。依据是 `readOnlyHint` 为插件服务器的自我声明，与 `smart` 预设的做法相同（ADR-0057）；且只有用户启用过的插件才有页面。页面加载后脚本即可发起调用，并不保证每次都由用户操作触发。
- 页面调用：
  - 不经 Agent Loop，不写进会话日志，不触发 PreToolUse 等 Hook；
  - 返回原始 `CallToolResult`（`content`、`structuredContent`、`isError`）；
  - 超时与模型调用相同。

### 4. 插件清单 `ui.surfaces`

- 沿用 ZCode 的字段名，放在自有清单（`.nocturne-plugin/plugin.json`）顶层：
  ```json
  "ui": {
    "surfaces": [
      {
        "id": "viewer",
        "title": "Word 文档",
        "server": "word",
        "resourceUri": "ui://word/viewer.html",
        "open": { "tool": "open_document", "fileTypes": [".docx"] }
      }
    ]
  }
  ```
- 字段规则：
  - `id` 只允许小写字母、数字、连字符；
  - `title` 为字符串。不做 ZCode 的多语言对象；
  - `server` 必须是本插件 `mcpServers` 里的键；
  - `resourceUri` 必须以 `ui://` 开头；
  - 不合法的条目跳过，记入插件的 `warnings`。
- `open` 是 Nocturne 的扩展，可选：
  - `tool`：本服务器上 `visibility` 含 `"app"`、且 `readOnlyHint: true` 的工具名。工具列表可得时（缓存或已连接）不满足这两条，这个 surface 不参与文件打开，并记入插件的 `warnings`；
  - `fileTypes`：小写扩展名列表，例如 `[".docx"]`。
- 兼容清单（`.codex-plugin`、`.claude-plugin`）不读 `ui`。

### 5. 桌面端面板标签

- **新标签种类**：`kind: "app"`。每个会话里，同一插件的同一 surface 只开一个标签；工具结果没有 `surface` 时，用 `resourceUri` 作键。
  - 标签标题取 surface 的 `title`，没有 surface 时取插件显示名；
  - 图标取插件图标（ADR-0096 的图标读取）。
- **打开方式**：
  1. **模型调用了关联页面的工具**：所属会话收到带 `ui` 的 `tool.completed` 时，打开或切到对应标签，并把这次工具调用的参数与结果交给页面。
     - 这个会话正在显示时，面板关着就打开；
     - 不在显示时，只把标签加进这个会话的面板，不切换会话。
     - 历史重放的事件不打开标签。
  2. **文件引用**：对话里的文件引用左键时，如果「默认打开方式」是「Nocturne 面板」，且文件扩展名命中某个已启用插件 surface 的 `open.fileTypes`，就打开那个 surface，再由宿主以页面调用的身份调用 `open.tool`，参数为 `{ "path": <绝对路径> }`，结果交给页面。
     - 命中多个插件时，取插件 id 字典序第一个；
     - 都不命中时，行为与现在相同。
- **生命周期**：
  - 标签第一次显示时才读取页面、调用 `open.tool`；重启后恢复的标签在显示之前不启动插件服务器；
  - 同一会话内切换标签，页面状态保留（与终端标签相同，隐藏而不卸载）；
  - 卸载页面前发送 `ui/resource-teardown`，最多等 1 秒；
  - 切换会话、进设置页时可以卸载页面；
  - `panelSessions` 只保存标签描述：插件 id、服务器 id、surface 或 `resourceUri`，以及最近一次 `open` 调用的参数。恢复时重新读取页面；有保存的参数就重新调用 `open.tool`。
- **插件停用或卸载后**：标签显示错误页，不自动关闭。

### 6. 桌面端沙箱与通信

- **空壳页**：`nct-sandbox` 协议新增精确路径 `/app.html`，复用 ADR-0088 第 2 节的协议处理器规则、子框架 IPC 封锁和 `sandbox="allow-scripts"`。响应头 CSP 按 MCP Apps 规范的默认策略：
  ```text
  default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors <宿主源>; sandbox allow-scripts
  ```
  `<宿主源>` 与 ADR-0088 相同。
- **网络与权限声明**：第一版不放行任何外部来源。资源 `_meta.ui.csp` 的 `connectDomains`、`resourceDomains`、`frameDomains`、`baseUriDomains` 与 `permissions` 一律忽略，规范允许宿主「进一步限制」。插件页面必须内联全部资源。
- **装载**：宿主把页面 HTML 经 postMessage 交给空壳页，空壳页用它替换整个文档，页面脚本照常执行。页面里的 `window.parent` 就是宿主，官方 `@modelcontextprotocol/ext-apps` 的 `App` 可直接使用。
- **与规范「Sandbox proxy」一节的差异**：规范要求网页宿主用双层 iframe（外层代理与宿主不同源，带 `allow-scripts`、`allow-same-origin`，内层装页面），并用保留消息 `ui/notifications/sandbox-proxy-ready`、`ui/notifications/sandbox-resource-ready` 传 HTML。Nocturne 桌面端按规范「UI Initialization (Desktop/Native Hosts)」的单层 iframe 做法：
  - 页面所在子框架是不透明源（无 `allow-same-origin`），隔离比外层代理更严；
  - 子框架拿不到 Tauri IPC（ADR-0088 第 2 节）；
  - 不使用 `ui/notifications/sandbox-*` 两条保留消息，HTML 用 ADR-0088 同款的 postMessage 装载。
- **宿主实现的消息**（方法名与参数以规范为准）：
  - `ui/initialize`：返回宿主信息与 `hostContext`，包括主题、样式变量、`displayMode: "inline"` 等。样式变量由主题令牌映射到规范的变量名；
  - `ui/notifications/initialized`：收到之前，宿主不向页面发任何请求或通知；
  - `ui/notifications/tool-input` 与 `ui/notifications/tool-result`：在第 5 节的两种打开方式下发给页面。工具状态为 `error` 时照常发 `tool-result`（`isError: true`）；为 `cancelled`、`interrupted`、`denied` 时发 `ui/notifications/tool-cancelled`。不发 `tool-input-partial`；
  - `ping`；
  - `notifications/message`：写入诊断日志；
  - `ui/request-display-mode`：不切换，返回当前模式 `inline`；
  - `ui/resource-teardown`：见第 5 节生命周期；
  - `ui/notifications/host-context-changed`：深浅色或主题变化时发送；
  - `tools/call`：按第 3 节经 RPC 执行；
  - `resources/read`：只能读本服务器的 `ui://` 资源；
  - `ui/message`：把文本插入这个会话输入框草稿的末尾并聚焦，不自动发送。正在显示的不是这个会话时，存为这个会话的草稿；
  - `ui/open-link`：只接受 `https:`，交给系统浏览器；
  - `ui/notifications/size-changed`：忽略，面板标签铺满。
- **其余请求**：返回 JSON-RPC 错误 `-32601`（含 `ui/update-model-context`）。
- **消息校验**：只接受 `event.source === iframe.contentWindow` 的消息；页面调用一律带上这个标签绑定的会话、插件和服务器，页面自己传的同名字段不算数。

### 7. RPC

新增三个会话方法，名称由实现轮按 rpc.md 现有命名风格确定，都**只在本地开放**，不加入远程白名单与 agent 白名单：

- 读取页面资源；
- 页面调用工具（第 3 节）；
- 列出当前会话可用的 surface，供文件引用匹配、插件标签标题和图标查找，以及模型调用时识别应持久化的 `openCall`。

## 后果

- 插件可以带侧边面板交互页面，写法与 ZCode、MCP Apps 生态一致。页面运行在与 ADR-0088 相同的隔离沙箱里，碰不到宿主界面、存储、网络与外壳命令。
- 页面调用写入类工具会直接失败（第 3 节），第一版的插件页面只能做查看与只读交互。之后要支持写入，需另行修订，增加页面内确认。
- 只读工具经页面调用时不弹确认，`default`、`read-only` 预设下也一样（第 3 节）。
- 页面不能联网，需要外部库的插件必须把库打进页面。
- 手机网页、安卓 App 与 TUI 看不到页面；带页面的工具调用在这些客户端是普通工具行。
- 同步死循环会卡住主界面渲染线程，限制与 ADR-0088 第 6 节相同。

## 备选方案

- **只在「文件」标签内置 docx/xlsx/pptx/pdf 查看**：一轮能完成，但只能看、不能选中引用，第三方插件也加不了界面。用户已否决。
- **页面放在独立子 webview（同面板浏览器）**：隔离更彻底，CPU 互不影响；但页面与宿主的通信要经 Rust 转发，主题同步、浮层遮挡和截图占位都要另做。暂不采用。
- **页面调用时弹确认**：能支持写入类工具，但要做 Turn 之外的权限交互。留待后续修订。

## 分期

1. 宿主：第 2–7 节，外加一个只在测试里用的示例插件（带一个页面、一个模型工具、一个页面专用工具），用来做端到端测试和截图。
2. 查看器：四个文档插件各加一个查看器页面、对应工具与查看器技能。另行修订 ADR-0100，写明页面渲染方式、锚点格式与工具清单。

## 修订：2026-11-20 宿主实现约定

- **RPC 方法名（仅本机开放，不在远程与 agent 白名单）**：
  - `session.readAppResource({ sessionId, pluginId, serverId, uri }) → { uri, mimeType: "text/html;profile=mcp-app", html, bytes }`
  - `session.callAppTool({ sessionId, pluginId, serverId, tool, arguments? }) → { content, structuredContent?, isError? }`
  - `session.listAppSurfaces({ sessionId }) → SessionAppSurface[]`
- **`tool.completed.ui` 确切形状**：
  ```ts
  {
    pluginId: string;
    serverId: string;
    resourceUri: string;
    surface?: string;
  }
  ```
- **`hostContext` 实际返回字段**：`theme`（`"light" | "dark"`）、`styles: { variables: Record<string, string> }`（见 [desktop.md](../apps/desktop.md#510-右侧面板adr-0060) 映射表）、`displayMode: "inline"`、`availableDisplayModes: ["inline"]`、`containerDimensions?: { width, height }`、`locale`、`timeZone`、`platform: "desktop"`、`deviceCapabilities: { touch: false, hover: true }`。
- **兼容性实测结论**：在真实 Windows 桌面端（Tauri 调试包）下，使用官方 `@modelcontextprotocol/ext-apps`（v2.0.4）`App` 类直接连接单层 `sandbox="allow-scripts"` 空壳页（`http://nct-sandbox.localhost/app.html`），`connect()` 握手成功（`hostVersion: { name: "nocturne", version: "0.56.0" }`），收到全部 9 个 `hostContext` 字段；只读 `tools/call` 成功返回结果，写工具被权限层以 `app_tool_not_allowed` 拒绝；`requestDisplayMode` 返回 `{ mode: "inline" }`；`sendMessage` 成功将文本预填进对应会话输入框草稿且未自动发送；未支持的 `ui/update-model-context` 返回 `-32601`；深浅色切换触发 `onhostcontextchanged` 并同步更新主题与样式变量。另实测沙箱下 `new Worker(URL.createObjectURL(new Blob(...)))` 被 `worker-src` 拦截、`WebAssembly.instantiate` 因未放开 `unsafe-eval` 被 `script-src 'unsafe-inline'` 拦截（本轮不改 CSP，留作分期第 2 项文档查看器选型依据）。
- **与 ADR 正文不一致的地方**：无。


## 修订：2026-11-20 放宽 CSP：WebAssembly 与 blob Worker

取代第 6 节「空壳页」的 CSP 中 `script-src` 一项，并新增 `worker-src`：

```text
default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; worker-src blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors <宿主源>; sandbox allow-scripts
```

- **原因**：上一节实测，blob Worker 被 `worker-src`（回落 `default-src 'none'`）拦截，`WebAssembly.instantiate` 被 `script-src` 拦截。文档查看器（[ADR-0100](ADR-0100-native-plugins.md) 分期第 4 项）用 pdf.js 在页面内渲染，需要 Worker 和 WebAssembly。
- **放开的范围**：
  - `'wasm-unsafe-eval'` 只允许编译 WebAssembly，不放开 `eval`、`new Function` 和字符串形式的定时器；
  - `worker-src blob:` 只允许页面用自己生成的 blob 创建 Worker，不能从任何网络地址加载。
- **不变的约束**：网络仍全部禁止。blob Worker 继承创建它的文档的 CSP（CSP Level 3「Initialize a global object's CSP list」），Worker 里的 `fetch` 同样受 `connect-src 'none'` 限制。实现轮必须在真实桌面端实测：Worker 能创建、能收发消息、Worker 内 `fetch` 被拦；WebAssembly 能编译运行；`eval` 与 `new Function` 仍被拦；页面 `fetch`、远程图片与 Tauri IPC 仍被拦。任何一项不符就停下，不得再放宽其他指令。

## 修订：2026-11-20 模型调用 surface `open.tool` 时持久化 `openCall`

补充第 5 节「生命周期」：当模型实时调用关联到某个 surface 的工具、执行成功且工具名正好是该 surface 的 `open.tool`（含 `mcp_call` 代理调用解析后的目标工具名）时，宿主同时将该次调用的参数记为该标签的 `openCall` 并随 `panelSessions` 持久化，使模型打开的标签重启后首次显示时也能重新打开原文档；实时投递期间仍直接使用模型结果，不重复发起 `callAppTool`。

## 修订（2026-11-23）

从新标签页移除插件面板卡片。卡片打开的查看器没有可显示的文档。插件面板用于检视 AI 生成或处理的文档，用户可让模型调用关联工具，或点击对话中的文件引用来打开。
