# ADR-0111：页面存数据与调用模型（`render_html` 页面二期）

- 状态：已接受
- 日期：2026-11-23
- 修订：[ADR-0088](ADR-0088-inline-html.md) 第 1 节第 1 条（页面除脚本外新增一条受控的宿主通道）、[ADR-0109](ADR-0109-page-versions.md)「不做的事」中「页面持久化数据存储、页面内调用模型」两项
- 相关：[ADR-0101](ADR-0101-mcp-apps-host.md)（插件页面经 postMessage 调宿主，本 ADR 沿用其消息校验与「只认标签绑定身份」做法）、[ADR-0040](ADR-0040-model-roles.md)（模型角色）、[permissions.md](../architecture/permissions.md)、[usage.md](../architecture/usage.md)

## 背景

ADR-0088 的页面关在断网沙箱里：不透明源（`window.origin === "null"`），`localStorage`、`document.cookie` 读写都抛 `SecurityError`，`connect-src` 为空。页面刷新、切会话或重开应用后，页面里的状态全部丢失；需要「记账本」「待办」「打分表」这类会累积数据的小工具做不出来，也做不出「页面里点一下让模型帮我改写这段」。

ADR-0101 已经让插件页面经 postMessage 调宿主（`tools/call`），宿主只认标签绑定的会话与服务器、页面自己传的身份字段不算数。本 ADR 按同一做法给 `render_html` 页面开两条通道：存数据、调模型。沙箱的网络边界不变，页面仍然不能直接联网。

## 决定

### 1. 页面里的接口

空壳页 `sandbox.html` 在装载页面之前定义只读全局对象 `window.nocturne`（`Object.freeze`，不可写、不可重定义）。接口全部返回 Promise，经 postMessage 与宿主往返，请求带递增 `requestId`：

```ts
nocturne.storage.get(key: string): Promise<unknown | undefined>
nocturne.storage.set(key: string, value: unknown): Promise<void>   // value 必须能 JSON 序列化
nocturne.storage.delete(key: string): Promise<void>
nocturne.storage.keys(): Promise<string[]>
nocturne.ask(prompt: string, options?: { system?: string; maxTokens?: number }): Promise<string>
```

- 宿主不支持的地方（TUI 用浏览器打开的页面、下载的 `.html`、旧版客户端）没有 `window.nocturne`。工具说明要求页面先判断 `window.nocturne` 是否存在，不存在时照常显示，只是不保存、不调用。
- 页面经 postMessage 自己拼请求与用接口等价，宿主不区分；宿主只认这个 iframe 绑定的会话 id 与页面 id，消息里的同名字段一律忽略（同 ADR-0101 第 6 节「消息校验」）。
- 内嵌页面与面板页面都有这组接口。同一页面的所有版本共用一份数据、共用一份调模型授权。

### 2. 存数据

- **位置**：`attachments/<sessionId>/page-data/<page>.json`，一个页面一个文件，内容是 `{ "version": 1, "entries": { key: value } }`。不写进事件日志，不随 Turn 回放。
- **上限**：`key` 非空、至多 200 个字符；单个页面序列化后至多 1 MiB。超出时 `set` 被拒绝（错误码 `page_storage_full`），已有数据不变。依据：1 MiB 远低于远程通道附件上限 `remoteAttachmentLimit()`（约 11.95 MiB），手机端整份读取没有压力；够放几千条记账或待办记录。
- **写入**：同一页面的写入在 Core 里串行，临时文件 + rename，写盘成功才返回。不做多端实时同步：电脑与手机同时开着同一页面时，各自写入按到达顺序覆盖同名 key，另一端刷新页面后看到最新值。
- **会话生命周期**：
  - 删除会话：随附件目录一起删除；
  - 归档：保留；
  - 分叉：分叉点仍有效的页面，数据文件复制到新会话（与附件复制同一步）；之后两边各写各的；
  - 回退：数据不回退（不是事件，回退只截断派生历史）。若回退后某页面一个有效版本也不剩，删除它的数据文件，避免以后新建的页面复用同一 `page-<n>` 时读到旧数据。
- **权限**：存数据只读写本页面自己的文件，不碰工作区，不经权限层、不弹确认，与 ADR-0101 页面调只读工具的口径一致。

### 3. 调用模型

- **能给模型什么**：只有页面传来的纯文本 `prompt` 与可选 `system`。看不到会话历史、工具、文件、页面 HTML 与存的数据（页面要用自己的数据，得自己拼进 `prompt`）。不带图片。
- **模型**：`smol` 角色，没配置时回落到会话当前模型。思考档位用该模型的最低可用档。
- **大小**：`prompt` 与 `system` 合计 UTF-8 至多 256 KiB（与 `render_html` 的 `html` 上限一致）；`maxTokens` 缺省 4096，可传更小，传更大按模型声明的最大输出夹紧。
- **返回**：完成后一次性返回全文。不做流式（第一版）。失败时 Promise 拒绝，`Error.message` 是 Core 错误原文。
- **排队与停止**：同一页面同一时刻只有一个请求在跑，后来的按顺序排队；不设次数上限。请求进行中，面板标签工具栏（手机为全屏工具栏）显示停止按钮，点击中止当前请求并清空该页面的队列，被中止的 Promise 拒绝。关闭页面标签、切走会话或关闭全屏时同样中止。
- **用量**：每次调用写一条持久事件 `page.model_called`：`page`、`model`（provider/model）、`usage?`、`durationMs`、`outcome: "ok" | "error" | "aborted"`。不写 `prompt` 与回复原文。按 usage.md 的口径计入会话用量（与 `session.titled`、`attachment.described` 同类：不属于 Turn，回退不撤销），不计入 `turn.completed.usage`。

### 4. 调模型的权限

- **新权限类别** `page`，`target` 为 `<sessionId>/<page>`，调用来源（`PermissionCaller`）新增 `{ kind: "page", page }`。判定只在权限层发生，宿主与页面都不自己决定要不要确认。
- **各预设缺省**：`bypass` 为 `allow`，其余预设为 `ask`。用户规则可以写 `page * → allow` 或 `page * → deny`。项目层规则只能收紧。
- **确认**：结果为 `ask` 时，Core 暂停这次调用并发临时事件 `page.permission_requested`（`requestId`、`page`、`title`、`model`），只在显示这个页面的标签或全屏里出现确认条，不在主对话插卡片。选项：「允许一次」「这个页面以后都允许」「拒绝」。回复经新 RPC 送回；没人回复时调用一直等待，停止按钮可以取消。
- **记住**：「这个页面以后都允许」写入项目授权（`page` 类别，`target` 为 `<sessionId>/<page>`），在「设置 › 授权」可撤销；远程连接不能保存，手机确认条不显示这一项。授权只覆盖这一个页面（含它以后的版本），不覆盖同会话的其他页面。
- 确认与结算不写 `permission.requested` / `permission.resolved`（那两条事件绑定工具调用 `callId`），只在 `page.model_called` 里记 `outcome`。

### 5. 客户端与 RPC

- **桌面端**：`InlinePage` 与面板页面标签按第 1 节转发消息；确认条与停止按钮放在面板标签工具栏、内嵌页面的浮动工具栏、全屏工具栏。不加说明文字，按钮只写动作名。
- **手机网页与安卓**：存数据、调模型都可用。确认条在全屏工具栏下方，只有「允许一次」「拒绝」。
- **TUI**：不提供（浏览器里打开的页面没有 `window.nocturne`）。
- **RPC**：新增会话方法：读写删列页面数据、页面调模型、回复页面调模型确认、停止页面调模型。名称按 rpc.md 现有风格由实现轮确定。七个方法都加入远程白名单（回复确认时 `remember` 为项目级的，远程连接照现有规则拒绝）；都不加入 agent 白名单。

### 6. 安全边界小结

- 网络：不变，`connect-src 'none'`。页面拿到的模型回复只能在页面里显示或存起来，发不出去。
- 宿主权限：页面只能读写自己的数据、按确认调模型；碰不到其他页面的数据、会话历史、工作区与外壳命令。
- 花钱：每个页面第一次调用必须经用户确认（`bypass` 除外），之后可以随时停止；用量计入会话，在「设置 › 用量」可见。
- 三期（ADR-0112，CDN 白名单）放开外部脚本后，第三方脚本也能用这组接口；那份 ADR 单独评估。

## 备选方案

- **页面直接用 `localStorage`**：需要给 iframe 加 `allow-same-origin`，页面就和空壳页同源，能拿到子框架里的 Tauri 内部对象，ADR-0088 的隔离失效。不采用。
- **把数据写进事件日志**：回退、分叉自动正确，但每次 `set` 都追加一条事件，记账类页面会把日志撑大；且数据随回退被撤销，不符合「页面里存的东西不该因为回退对话而丢」的直觉。不采用。
- **调模型时带上会话历史**：等于让页面能读整段对话，ADR-0088「碰不到会话数据」的边界失效。不采用。

## 实现前要实测

桌面调试包（WebView2）与经本机中继配对的手机网页（Edge，390 × 844）均实测通过全局对象不可覆盖或重定义、忽略伪造身份、阻断 `localStorage` 与 `fetch`、超过 1 MiB 后保留旧值及停止请求。WebView2 的页面 IPC 探测被拦。桌面重开后记账数据保留。对两次验收使用的会话通过宿主 RPC 验证分叉数据独立、回退全部版本后删除原数据文件。Core 集成测试也覆盖只回退部分版本时保留数据。安卓共用手机网页实现，未连接设备或模拟器。
