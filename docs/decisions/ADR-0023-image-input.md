# ADR-0023：图片输入：沿用 imageInput 能力位、附件落盘引用、按当前模型投影

- 状态：已接受（维护者 2026-09-28 确认：单图 5 MB / 8000 px 不缩放、Alt+V、拖入路径转占位、分三步实现）
- 日期：2026-09-28

## 背景

v0.5 要让模型能「看图」：先让 `read` 工具能读图片，再支持在 TUI 里粘贴截图。维护者日常使用的 deepseek-v4.1-flash 支持图片输入（Chat Completions 的 `image_url`，base64 data URL）。

这件事同时牵动五处，任何一处单独决定都会和其他几处打架：

- **能力声明**：怎么知道当前模型能不能看图。`ModelCapabilities.imageInput` 已经存在：配置 schema 接受逐模型声明，`GET /models` 会从上游的 `architecture.input_modalities` 推导，模型选择页也用它显示 `I` 标记。但目前没有任何代码真正使用它。
- **事件与持久化**：`ContentBlock` 只有文本和推理两种；`ToolResult.modelContent` 与 `tool.completed.modelContent` 都是字符串。会话日志是 JSONL，每行一个事件。
- **上下文构建**：Context Builder 约定不做 I/O（[context.md](../architecture/context.md) 第 2 节）。context.md 第 7 节已经写了「新模型不支持的输入类型（例如图片）替换为文字占位」，但还没有落地。
- **Provider 适配器**：OpenAI Chat Completions 规定 `tool` 消息只能放文本，图片只能出现在 `user` 消息里。DeepSeek 在 system 或 assistant 消息里带图会返回 400。Anthropic 的 `tool_result` 可以直接包含图片块。另外，经核对，`@ai-sdk/openai-compatible` 3.0.49 遇到内容型工具结果时会直接 `JSON.stringify`，图片会变成一大段 base64 文本发给模型。
- **TUI**：Windows Terminal 的 Ctrl+V 只粘贴文本，剪贴板里的图片不会通过括号粘贴传进来。

参考：omp 用模型的 `input` 数组判断能否看图；粘贴时不检查模型能力，发送时把图片替换为 `[image omitted: model does not support vision]`；另有 `inspect_image` 工具，把图片委派给 `vision` 角色模型。

## 决定

### 1. 能力声明：沿用 `imageInput`

- 不新增 `input` 数组，继续用已有的 `capabilities.imageInput: boolean`。它已经接通了配置、上游推导和选择页；另起一个数组会让同一信息存两份。以后真要支持音频、PDF 时，再按同样方式加能力位，或者统一迁移。
- 来源沿用现有能力合并顺序：逐模型手写配置 > 向导层的用户声明 > 上游声明 > 内置目录 > 默认 `false`。**没有声明就按不支持处理。**
- 不维护一张「常见视觉模型」内置大表，理由与 [ADR-0016](ADR-0016-model-limits-from-upstream.md) 一致：以上游声明为准，内置表会过时。
- 新增用户声明入口：`/provider image <服务商> <模型> on|off`，写入向导层 `providers.json`，并标记为「用户声明」，`/provider refresh` 不覆盖。做法与 ADR-0018 的 `/provider thinking` 相同。手写 `config.json` 仍由用户自己编辑，程序不改写。

### 2. 附件：落盘保存，日志里只存引用

- 图片字节复制到 `<sessionsDir>/attachments/<sessionId>/img-<n>.<ext>`，与超预算输出的落盘文件同一目录（[tools.md](../architecture/tools.md) 第 4 节），不写进被操作的仓库，也不自动清理。
- 日志里只记录引用，不记录 base64：

  ```ts
  type ImageAttachment = {
    type: "image"
    file: string          // 相对 <attachmentsDir>/<sessionId>/ 的文件名，如 "img-3.png"
    mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    bytes: number
    sha256: string
    width?: number
    height?: number
    label?: string        // 显示用：原文件名或「剪贴板」
    source: "paste" | "read" | "mcp"
  }
  ```

- 事件新增可选字段：`message.user.attachments?: ImageAttachment[]`、`tool.completed.attachments?: ImageAttachment[]`。按 [events.md](../protocols/events.md) 第 8 节，这是在已知事件中新增可选字段，属于兼容变更，不提升 `formatVersion`。旧版 Runtime 恢复时会忽略这些字段，结果只是图片不再发给模型，不会出错。
- `read` 读图时**复制**文件，而不是只记原路径。原文件以后可能被改动或删除，那样历史就不再真实，提示缓存前缀也会被破坏。

### 3. `read` 工具读图片

- **按文件头识别格式**，不看扩展名：PNG、JPEG、GIF、WebP。这一步在二进制检查之前做。SVG 是文本，仍按文本读取。其他二进制格式（BMP、HEIC 等）照旧返回 `binary_file`，说明中列出支持的格式。
- **限制**：单张原始文件不超过 5 MB，每边不超过 8000 px，超出返回 `image_too_large` 并说明限制。尺寸从文件头解析（纯函数，不引入原生依赖）。第一版**不缩放**：缩放要引入 sharp 之类的原生依赖，这个代价以后单独评估。
- 图片读取忽略 `offset`/`limit`，也不写入 `readState`，因为图片不能被 `edit`/`write` 按文本修改。
- 工具**不知道当前模型能不能看图**，照常返回图片。`modelContent` 是一行说明，例如 `Image file: docs/shot.png (image/png, 1920×1080, 245 KB)`。图片最终是否发给模型由第 4 节决定，这样中途切换模型时，同一条历史能正确投影。
- `ToolResult` 增加可选字段 `attachments?: { mimeType; data: Uint8Array; label? }[]`，由执行器落盘并写入 `tool.completed.attachments`。这是 [tool-api.md](../protocols/tool-api.md) 第 6 节所说的「修改 ToolResult 形状」，由本 ADR 记录。

### 4. 上下文构建：按当前模型投影

- Builder 保持不做 I/O。Agent Loop 在构建前通过附件存储（`platform` 文件系统，运行期按 `sha256` 做内存缓存）读取本次需要的附件字节，作为数据传给 `build`。
- 投影规则按**当前**模型的 `imageInput` 判断，每次构建都重新计算：
  - 支持：消息带上图片；
  - 不支持：图片换成文字占位 `[image omitted: current model does not support image input]`；
  - 附件文件缺失（用户删了 attachments 目录）：换成 `[image unavailable: attachment file missing]`，并记诊断。
- **每个请求最多发 20 张图**。超出时从最旧的开始换成占位。20 是 Anthropic 对「超过 20 张就压低单图尺寸上限」的分界，同时也控制请求体大小。
- **压缩**：L1 修剪覆盖的工具结果，图片随正文一起省略。摘要请求本身不带图片，图片按占位处理。
- **token 估算**：每张图按固定 1,600 token 估算（仅用于判断是否需要压缩），不按 base64 字符数估算。`ContextReport` 单列图片数量与估算值。

### 5. 中性请求与适配器转换

- `ModelMessage` 的 `user` 与 `tool` 两种消息增加可选字段 `images?: { mimeType; data: string /* base64 */ }[]`。
- **openai-compatible**：`tool` 消息只放文本。一批连续工具结果里的图片合并成**一条** `user` 消息，紧跟在这批 `tool` 消息之后、下一条 user/assistant 之前，每张图前加一行文字标明来自哪个调用。用户消息中的图片转成 `image_url` 部件（data URL）。转换在适配器内、交给 SDK 之前完成，不让 SDK 的 `JSON.stringify` 路径碰到图片。
- **anthropic**：工具结果中的图片放进 `tool_result` 的原生 image 块，用户消息中的图片转成 image 块。
- Agent Loop 与 Context 中不出现按 Provider 的分支。
- **诊断日志**：`provider.request` 记录完整 `ModelRequest`（[observability.md](../architecture/observability.md)），其中图片数据替换为 `{ mimeType, bytes, sha256 }`，不写 base64。

### 6. TUI 粘贴

- **Alt+V** 从系统剪贴板读取图片。Windows Terminal 的 Ctrl+V 只能粘贴文本，Claude Code 在 Windows 上也用 Alt+V。读取通过 `platform` 的 `clipboard.readImage()` 完成。Windows 下由 Windows PowerShell 5.1（`-STA`）调用 `System.Windows.Forms.Clipboard` 导出 PNG，不弹窗，也不抢焦点。其他平台先返回「暂不支持」。
- **括号粘贴的文本恰好是一个已存在的图片文件路径**（拖文件进 Windows Terminal 就是这种情况，可能带引号）时，按图片附加，输入框里同样显示为 `[Image #n]`，不显示原路径。路径指向的文件不是支持的图片格式、超出限制或当前模型不支持图片时，按原文本插入（后两种情况同时给出提示）。
- **当前模型不支持图片**：不附加，输入框下方提示「当前模型 xxx 未声明支持图片输入；确认支持可用 `/provider image <服务商> <模型> on` 开启」。提交时再检查一次，防止粘贴后又切换了模型：此时不提交，保留输入与占位并给出同样的提示，由用户删掉占位或换回支持图片的模型。
- Alt+V 与拖入路径两种来源都在输入框里显示 `[Image #n]` 占位（编号在本次运行内递增、不复用），与 `[Paste #n, …]` 一样整体移动、整体删除。提交时落盘，写入 `message.user.attachments`。输入历史只保存文本，图片占位不保存。
- 行式 CLI 本 ADR 不做粘贴；`read` 读图在所有模式下都可用。

### 7. 显示

用户消息与 `read` 工具行下方显示一行 `[图片 #n · 名称 · 1920×1080 · 245 KB]`，颜色取自主题常量。不在终端里直接渲染图片（sixel 等），以后单独评估。

### 8. MCP 图片结果

MCP 工具返回的 image 块目前被转成文字说明（「内容未传回模型」）。改为走同一附件通道（`source: "mcp"`），大小、格式限制与投影规则相同。放在实现顺序的最后一步。

### 9. 实现顺序

1. 能力声明入口、附件类型与事件字段、附件存储、`read` 读图、Builder 投影、两个适配器的转换、诊断脱敏；
2. TUI 粘贴（Alt+V、拖入路径、占位、不支持时的提示）；
3. MCP 图片结果。

## 后果

- 能看图的模型可以通过 `read` 或粘贴查看截图、界面和图表。不能看图的模型会得到明确的文字说明，不会因为请求格式被拒而中断 Turn。
- 日志保持轻量：每张图只占一条引用。代价是会话数据分两处存放；删掉 attachments 目录后，旧会话里的图片会变成占位，但会话本身仍能恢复。
- attachments 目录会随使用增长，和落盘输出一样，由用户自己管理。
- 旧版 Runtime 恢复含图片的会话时，会静默丢掉图片，不会报错。
- 每张图都会随后续每一轮请求重复发送，直到被修剪或摘要覆盖。20 张上限和固定 token 估算让这部分开销可控，但比纯文本会话更早触发压缩。
- `ToolResult`、`ModelMessage`、两个事件和 `HistoryEntry` 都新增了可选字段；tool-api.md、provider-api.md、events.md、context.md、tools.md、tui.md、providers.md 需要同步更新。

## 备选方案

- **新增 `input: ["text", "image"]` 数组（omp 的做法）**：表达力更强，但与现有 `imageInput` 重复，还要迁移 schema、上游推导和选择页。目前只有图片一种非文本输入，不值得。
- **给 `ContentBlock` 增加 image 变体**：结构上更统一，但旧版 Runtime 会把未知块交给按文本处理的代码（如 `blockChars` 读取 `b.text.length`），恢复时会出错。改用新增可选字段，旧版本可以安全忽略。
- **把 base64 直接写进日志**：实现最简单，但 JSONL 单行会达到数 MB，读取、恢复和诊断都会变慢，同一张图也会随每次引用重复保存。
- **只记原文件路径，不复制**：原文件被修改或删除后，历史就不再真实，提示缓存也会失效。
- **工具根据当前模型决定是否返回图片**：工具需要知道模型信息，而且切换模型后历史里已经没有图片可以恢复。放在 Builder 投影更简单。
- **用 sharp 等原生库自动缩放**：体验更好，但原生依赖会增加安装和跨平台的负担。先用硬上限，确有需要再单独评估。
- **不能看图时委派给其他模型看图（omp 的 `inspect_image`）**：依赖路线图中的「模型角色」（`vision` 角色），等模型角色落地后再做，本 ADR 不涉及。
