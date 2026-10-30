# ADR-0072：任意文件附件、大段粘贴转附件、提问回答附文件

- 状态：已接受
- 日期：2026-10-30
- 修订：[ADR-0023](ADR-0023-image-input.md)（附件通道扩展到非图片文件）、[ADR-0032](ADR-0032-ask-user-tool.md)（回答可带附件）

## 背景

附件通道目前只收图片（[ADR-0023](ADR-0023-image-input.md)）。实际使用里有三处不够用：

- **只能附图片**：日志、PDF、压缩包、导出的表格这类文件没法直接交给模型。工作区里的文件可以 `@` 引用，工作区外的只能手动把路径贴进对话，模型读取时还要走权限确认。
- **大段粘贴整段进上下文**：TUI 的 `[Paste #n]` 占位提交前会展开成原文，桌面端直接把原文放进输入框。粘贴一段几十 KB 的日志，整段写进 `message.user`，之后每次请求都带着它，压缩前一直占窗口。
- **提问回答只能写文字**：`ask_user`（[ADR-0032](ADR-0032-ask-user-tool.md)）的自由回答限 2000 字符，模型问「报错长什么样」时，用户贴不了截图或日志。

参照：T3 Code 把 32 KiB 以上的粘贴存成文本文件附件，模型拿到路径后按需读取；提问回答可以附文件，模型收到保存后的路径。

## 决定

### 1. 附件分两类：图片照旧，其他文件只给模型路径

- **图片**：PNG/JPEG/GIF/WebP 且通过现有检查（单张 5 MB、边长 8000 px）的，走 ADR-0023 的图片通道，行为不变。
- **文件**：其余一切，包括未通过图片检查的图片（BMP、超限的截图），一律作为文件附件。Core 把字节存进会话附件目录，**不把内容放进上下文**，只在用户消息里追加一段引用说明，模型需要时用 `read`（或 shell）去读。

文件附件不内联、不按大小区分：说明只有一行，前缀稳定、缓存友好；`read` 已能按行段读取长文件，现有权限规则已放行当前会话附件目录（[permissions.md](../architecture/permissions.md) 第 6 节），读取不触发确认。代价是模型多一步 `read`。

不做：调用服务商原生的 PDF/文档输入、按文件类型解析内容、自动清理附件目录。

### 2. 存放与事件

- 文件存为 `<sessionsDir>/attachments/<sessionId>/file-<n>.<ext>`，编号与并发规则同 `img-<n>`（[tools.md](../architecture/tools.md) 第 4 节）。`ext` 取原文件名的扩展名，只保留 `[a-z0-9]`、至多 10 个字符，没有就不带扩展名；原文件名只存在 `label` 里，不进文件系统路径。
- 引用类型：

```ts
type FileAttachment = {
  type: "file"
  file: string              // 相对 <attachmentsDir>/<sessionId>/ 的文件名，如 "file-2.log"
  bytes: number
  sha256: string
  label: string             // 原文件名；大段粘贴为 "pasted-<n>.txt"
  mimeType?: string         // 客户端给出的类型，仅供显示
  text?: { lines: number }  // UTF-8 可解码且不含 NUL 时给出
  source: "paste" | "upload" | "answer"
}
```

- 事件新增可选字段 `message.user.files?: FileAttachment[]`、`tool.completed.files?: FileAttachment[]`。**不并入现有的 `attachments` 字段**：那里旧版本 Runtime 会按图片处理；新开字段是兼容扩展，旧版本忽略它，照常恢复会话，不提升 `formatVersion`（[events.md](../protocols/events.md) 第 8 节）。
- `readAttachment` 的授权范围扩到 `files` 登记的文件（包括子会话的只读方法），供客户端预览和下载。分叉、回退沿用附件目录现有约定。

### 3. 给模型的引用说明

`submit` 时由 Core 生成，作为文本块追加在用户消息末尾，与 `@` 引用快照同样写进 `message.user.content`，Builder 不需要改。每个文件一行，英文：

```text
<attachment name="build.log" path="<sessionsDir>\attachments\<id>\file-2.log" size="1.2 MB" lines="18204" />
<attachment name="report.pdf" path="…\file-3.pdf" size="840 KB" type="application/pdf" />
```

`name`、`path` 按 XML 属性转义。提问回答（第 6 节）里的文件用同样的格式写进 `modelContent`。

### 4. 提交入口与限额

- `submit` / `enqueueInput` / RPC 的 `attachments` 不再限定图片类型，任意 `mimeType` 都接受；Core 按第 1 节分流。客户端不需要自己判断是图片还是文件。
- 限额：单个文件 20 MB，单条消息至多 10 个附件（图片和文件合计）。远程连接受 16 MiB 报文上限约束，一条提交的附件原始字节合计不超过 `remoteAttachmentLimit`；客户端发送前检查并提示，RPC 层再校验，超限报 `attachment_too_large`。
- 插话与排队（[ADR-0070](ADR-0070-steer-and-queue-input.md)）的待发条目照常携带附件；`updateInput` 仍不改附件。

### 5. 大段粘贴转附件

- 粘贴文本达到 **32 KiB**（UTF-8 字节）时，不再放进正文，转为文件附件 `pasted-<n>.txt`（`source: "paste"`）。
- **TUI**：占位显示为 `[File #n pasted-1.txt 48 KB]`，与图片占位一样整体移动、整体删除；输入历史回填时还原为原文（与现有粘贴占位一致）。
- **桌面端与网页端**：输入框上方显示附件卡片，可删除；Ctrl+Shift+V 保留原文粘贴进正文。
- 32 KiB 以下的粘贴行为不变。

### 6. 提问回答附文件

- `respondQuestion` 每道题的回答增加可选 `attachments`（形状同 `submit.attachments`），没有选项的题，或有选项的题选择「其他」时可以带附件；选了预设选项又带附件报 `invalid_reply`。一组回答合计受第 4 节的数量与大小限制。
- 图片走 `tool.completed.attachments`，文件走 `tool.completed.files`，`source` 分别为原值与 `"answer"`；`modelContent` 在该题回答之后列出引用说明。
- 界面：自由回答区可添加文件、粘贴图片或文件；可以只发附件、不写文字。

### 7. 各客户端的添加方式

- **桌面端、网页端、安卓**：「＋」菜单的「添加图片…」改为「添加文件…」（系统对话框不限类型）；粘贴剪贴板里的文件、拖入任意文件都成为附件。附件卡片对文件显示文件名与大小。
- **TUI**：Alt+V 读剪贴板时，除了图片，也读资源管理器复制的文件列表（Windows `CF_HDROP`），每个文件一个占位。粘贴或拖入的路径文本：图片路径保持现状（转图片），其他路径照原文插入，不自动转附件，以免想讨论路径时被改掉。
- 对话里的用户消息：文件附件显示为文件名与大小的卡片，隐藏第 3 节的引用文本块（同 `fileRefs` 隐藏快照块的做法）；桌面端点击在面板打开（文本文件）或在资源管理器中显示。

## 后果

- 任何文件都能交给模型，大段粘贴不再长期占上下文；对话前缀里只多一行说明。
- 模型读附件多一步工具调用；读到的内容按工具结果计入上下文，可被修剪、压缩，比放在用户消息里更易回收。
- 附件目录增长更快（文件附件比图片大），仍由用户自己管理；会话设置页显示附件目录占用的事以后再议。
- 旧版本打开含文件附件的会话：引用说明仍在用户消息里，模型照样能按路径读，只是界面不显示附件卡片。

## 备选方案

- **小文本文件直接内联**：省一步 `read`，但要定阈值、处理截断，前缀随文件变大；与 `@` 引用重复，不采用。用户想让模型直接看到内容时，粘贴原文或 `@` 引用工作区文件即可。
- **把文件并入 `attachments` 字段（`type: "file"`）**：形状更统一，但旧版本会把它当图片处理，可能恢复失败；不采用。
- **大段粘贴保留在正文、只在压缩时处理**：上下文占用问题依旧，不采用。

修订（2026-10-30）：第 6 节明确「其他」属于自由回答，可附文件；预设选项与附件不能同时提交。
