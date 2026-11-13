# ADR-0090：图片自动缩小与长图切段

- 状态：已接受
- 日期：2026-11-13
- 修订：[ADR-0023](ADR-0023-image-input.md)（取消「第一版不缩放」，改用统一预算、自动缩小与长图切段）、[ADR-0072](ADR-0072-file-attachments.md)（可解码且不超硬上限的图片走图片通道）

## 背景

[ADR-0023](ADR-0023-image-input.md) 第一版为了避免引入 sharp 等原生依赖，采用 `5 MB / 每边 8000 px` 硬拒。实测一张 9.5 MB 的长截图（1849×16348 PNG）会直接在 `file-attachments` 降级为普通文件附件、再于 `read` 报 `image_too_large`；即便缩小整张图片，各服务商也有各自的图像预算（截至 2026-11-13）：

- **Claude**（`platform.claude.com/docs/en/build-with-claude/vision`）：单张上限按 base64 后算 Claude API 10 MB、Amazon Bedrock 5 MB；每边不超过 8000 px（单次请求超过 20 张建议每张每边不超过 3000 px）；服务端会将长边超过 2576 px 的图像等比缩小（1849×16348 整张发送会被服务端缩到约 291×2576，文字不可辨认）。
- **OpenAI**（`developers.openai.com/api/docs/guides/images-vision`）：单次请求总上限 512 MB；high 档缩到 2048×2048 以内。
- **Gemini**（`ai.google.dev/gemini-api/docs/image-understanding`）：内联数据与文本整请求不超过 20 MB。

使用纯 WebAssembly 的 `@jsquash` 系列包（`@jsquash/png` 3.1.1、`@jsquash/jpeg` 1.6.0、`@jsquash/webp` 1.5.0、`@jsquash/resize` 2.1.1，均 Apache-2.0）无需原生编译依赖即可在 Node.js 完成跨平台解码、缩放与编码。

## 决定

### 1. 处理时机

只在图片进入会话时处理一次，处理结果存成同会话附件目录下的独立文件；Context Builder 每次请求直接发送已存结果，不按请求或服务商重新编码：

- 工具与入口不知道会话后续会切到哪个服务商；
- 符合 `AGENTS.md` 硬性约束：Agent Loop 与 Context Builder 内不按 Provider 写分支；
- 每次请求不重新编码，可保持提示词缓存前缀稳定。

### 2. 统一预算与处理规则

常量导出自 `@nocturne/core/protocol`（客户端统一引用，不各自硬编码）：

- **输入硬上限**（超过即报 `image_too_large`）：`IMAGE_MAX_BYTES = 50 * 1024 * 1024`（50 MB）且 `IMAGE_MAX_PIXELS = 64_000_000`（宽×高，替代原每边 8000 px）。
- **处理条件**（满足任一条才处理，其余原样保留与发送）：
  - `(a)` 原文件 `> 3.5 MB`（`3.5 * 1024 * 1024`，base64 后约 4.7 MB，低于 Bedrock 5 MB 上限）；
  - `(b)` 任一边 `> 8000 px`；
  - `(c)` 长边 `> 2576 px` 且 `longEdge / shortEdge > 2576 / 768`（即整张缩到长边 2576 px 后短边会小于 768 px）。
- **处理方式**：
  - 满足 `(c)` 时**切段**：沿长边方向切割；短边超过 2576 px 时先等比缩到 2576 px；先计算段数 `n = ceil((L − 64) / (2576 − 64))` 再均分切段（每段长度 `ceil((L + (n - 1) * 64) / n)`，最后一段允许少几个像素，保证每段长边不超过 2576 px、相邻两段重叠 64 px，避免出现极短末段）；单张原图最多 8 段，超过 8 段先等比缩小到 8 段能放下的尺寸（最大覆盖 `8 * 2576 - 7 * 64 = 20160 px`）。
  - 仅满足 `(a)` 或 `(b)` 时**整张缩小**：长边超过 2576 px 时等比缩到长边 2576 px（不超过 2576 px 时保持尺寸转码）。
  - 全部处理结果铺白底消除透明通道后编码为 JPEG q85；超过 3.5 MB 依次降为 q75、q60，仍超则继续等比缩小直至符合 3.5 MB。
- **GIF**：`@jsquash` 无 GIF 编解码。不满足处理条件的 GIF 原样保留；满足处理条件的 GIF 报 `image_too_large`，错误文案说明 GIF 不支持自动缩小或切段。

### 3. 存储与协议

- 原图照旧落盘（`img-<n>.<ext>`），界面继续显示原图。
- 处理结果存为同一会话附件目录下的 `img-<n>-<k>.jpg`（`k` 从 1 开始）。
- 在 `ImageAttachment` 上新增可选字段 `processed?: ProcessedImage[]`，每项含：
  - `file`、`mimeType`、`bytes`、`sha256`、`width`、`height`；
  - `region: { x, y, width, height }`：对应原图上的像素区域（整张缩小时为整张原图范围）。
- `processed` 为向后兼容的可选字段：旧日志缺省时按原图处理，不提升 `formatVersion`。
- 分叉（`forkSession`）复制整个会话附件目录，处理结果一并复制；回退（`rewind`）对处理结果与原图一视同仁；`readSessionAttachment` 允许读取 `processed` 中的文件。

### 4. 发给模型与工具文本

- Context Builder 投影 `user` 消息的切段图片（`processed.length > 1`）时，会在其对应图片之前附加一条 `text` 块，写明原图尺寸、段数、排列方向（`ordered top to bottom` 或 `ordered left to right`）与 `64 px overlap`（只缩小未切段的不加；`tool` 消息沿用 `read` 的 `modelContent` 不重复添加）；`token` 估算与 20 张上限占位逻辑（整组丢弃时同时移除该说明并替换为上限占位）一并计入这段文字。
- Context Builder 投影图片时，若存在 `processed` 则按顺序发出各处理结果，否则发原图；`describeImages` 视觉代描述角色同样优先取 `processed`。
- `MAX_IMAGES_PER_REQUEST = 20` 与每张 1600 token 的估算均按实际发出的张数计算；**同一张原图的各段采用整组原子保留/丢弃**，不允许只发其中几段。
- `read` 的 `modelContent` 沿用 `Image file: …` 英文格式，在图片被处理时写明原图尺寸与大小，以及缩小后尺寸或分段总数、各段尺寸与从上到下 / 从左到右顺序。

### 5. Worker 线程与产物分发

- 解码、铺白底、缩放与编码在 `node:worker_threads`（`image-worker`）内执行，不阻塞 Runtime 主线程；同一 Runtime 内串行队列，同一时间只处理一张图。
- WASM 线性内存只增不减，worker 在空闲 **10 秒（10,000 ms）** 后自动退出归还系统内存（定时器使用 `.unref()` 不阻塞进程退出）；`runtime` 内发生任务中断（工具取消或会话关闭）时立即终止 worker 并删除已落盘的原图与半成品分段文件；`runtime.close()` 关闭时一并调用 `imageProcessor.close()` 立即释放 worker。
- 构建与打包时随产物复制 5 个运行时 WASM 文件（`squoosh_png_bg.wasm`、`mozjpeg_dec.wasm`、`mozjpeg_enc.wasm`、`webp_dec.wasm`、`squoosh_resize_bg.wasm`）与 `image-worker.mjs` 至 `packages/core/dist/`、`apps/desktop/src-tauri/resources/` 与 `nctrn` npm tarball（`apps/cli/dist/main.js` 外部引用 `@nocturne/core`，运行时直接使用 `packages/core/dist/` 内的 worker 与 WASM，不再在 `apps/cli/dist` 重复放置无法解析 `@jsquash/*` 裸导入的副本），运行时不联网下载。

### 6. 覆盖入口与暂不做的项

- **覆盖入口**：`read`、`web_fetch`（图片允许读取至 `IMAGE_MAX_BYTES` 50 MB）、`file-attachments`（可解码且不超硬上限的图走图片通道）、`file-refs`（`@` 引用图片）、直接粘贴/拖入的图片；客户端同步更新 `apps/tui/src/images.ts`（采用新硬上限）与 `apps/desktop/src/web/phone-images.ts`（仅超过新硬上限或 `SUBMIT_MESSAGE_LIMIT` 时处理，先保尺寸转 JPEG 仍超再缩尺寸）。
- **明确不做**：
  1. **MCP 工具返回的图片**（`packages/mcp/src/connector.ts`）：电脑操控（ADR-0082）与内置浏览器截图需要与原图精确对应的像素坐标，缩放或切段会破坏坐标对齐，保持原规则。
  2. **`render_html` 的 `images`**：图片嵌入本地 HTML 供沙箱渲染显示，不发往模型。
  3. **Gemini 20 MB 单次请求总量上限**：JPEG 分段已显著压缩体积，跨多图的总请求字节数控制暂不在本轮范围，记入下方风险。

## 后果与风险

- 长截图与超大图在进入会话时即可直接按清晰分段或合理尺寸投喂模型，不再因 `image_too_large` 退回模型自行写脚本压缩，也不受服务端等比缩糊影响。
- 单图处理峰值内存主要来自解码后的 RGBA 帧与 WASM 线性内存（约三百余 MB），通过单工串行队列、零拷贝纵向分段视图与 10 秒空闲退出 worker 控制内存驻留。
- **已知风险**：单次请求最多 20 张 JPEG（单张上限 3.5 MB）在极端情况下总字节可能超过 Gemini 单请求 20 MB 限制，后续如遇真实需求再增加按模型窗口/请求体积的降级策略。
