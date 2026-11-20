# ADR-0103：远程通道压缩

- 状态：已接受
- 日期：2026-11-21
- 关联：[remote-channel.md](../protocols/remote-channel.md)、[rpc.md](../protocols/rpc.md) 第 2 节、[ADR-0052](ADR-0052-remote-web-client.md)、[ADR-0087](ADR-0087-lan-direct.md)、[ADR-0099](ADR-0099-top-level-session-readonly-observe.md)

## 背景

[ADR-0099](ADR-0099-top-level-session-readonly-observe.md) 通过顶层会话只读快照观察（`session.observe`）消除了手机打开未运行历史长会话时服务端的装配耗时，但网络传输量未变：打开样本会话 `202611190224-079332c3`（1367 条持久事件、日志文件 3,380,267 字节）时，仍要把全部事件按明文逐条发往手机。

2026-11-21 在本机用 Node 24.21.0 对这份样本日志实测（每条事件按 `session.observeEvent` 通知封装为 JSON-RPC 报文，合计 3,519,701 字节）：

| 方式 | 压缩后字节 |
|---|---|
| 每条消息单独 deflate-raw | 1,441,967 |
| 每 128 条合成一条再 deflate-raw | 751,289 |
| 整条连接共用一个 deflate-raw 流，每条消息后 `Z_SYNC_FLUSH`（level 6，windowBits 15） | 765,062 |
| 整份日志 brotli | 326,648 |

其中字节构成以 `tool.completed` 为主（2,181,230 字节，含 `modelContent` 1,373,164、`output` 706,459），其次为 `tool.started.input`（258,367 字节）。

浏览器侧运行时约束：

- `CompressionStream` / `DecompressionStream` 的 brotli 目前仅 Firefox 147+ 与 Safari 18.4+ 支持，Chrome、Android Chrome 与 Android WebView 均不支持（caniuse `mdn-api_compressionstream_compressionstream_brotli`）。
- `deflate-raw` 在 Chrome / Android 103+、Safari 16.4+、Firefox 113+ 可用。安卓 App 的 `minSdkVersion` 为 24，系统 WebView 随商店独立更新，旧版 WebView 可能不支持 `deflate-raw`，必须做运行时能力检测。
- 在 Edge 157（Chromium）中实测，长期存活的 `DecompressionStream("deflate-raw")` 在写入一段经 `Z_SYNC_FLUSH` 的数据后能立即产出该条消息的明文，无需等待后续消息。

因此采用「整条连接共用一个 `deflate-raw` 流」：压缩率与批量发送接近，不改动任何 RPC 消息形状，实时事件、`session.subscribe` 回放与 `session.observe` 一并受益。

## 决定

### 1. 范围

- 只压缩 **电脑 → 手机**（下行）方向；手机发往电脑的消息保持未压缩。
- 只作用于远程连接（`origin: "remote"`），同时涵盖经中继与局域网直连（[ADR-0087](ADR-0087-lan-direct.md)）；本机 RPC 连接（`origin: "local"`）与外部 agent 本机管道（`origin: "agent"`）不变。
- 握手帧（`hs.init` / `hs.resp` / `hs.fin`）、配对帧（`pair.hello` / `pair.accept`）与握手错误帧均不压缩。

### 2. 协商

- 手机端（网页端与安卓 App 共用的连接代码）在发出 `initialize` 之前执行能力检测：仅当 `new DecompressionStream("deflate-raw")` 不抛错时，才在 `initialize` 请求中声明 `capabilities.compression: ["deflate-raw"]`。
- 新版电脑端在远程连接收到含 `"deflate-raw"` 的声明且底层传输支持发送压缩时，在 `initialize` 结果中返回 `compression: "deflate-raw"`；`initialize` 响应本身仍以未压缩帧发出，发送端在发出该响应之后、处理后续请求与广播之前同步开启下行压缩，从下一条消息起全部压缩。
- 手机端仅在 `initialize` 结果中收到 `compression: "deflate-raw"`（且自身曾声明）时，在收到 `initialize` 响应的同步处理路径上立即启用接收解压，确保紧随其后到达的压缩帧不会竞态失败。
- 新旧组合行为：
  - **新电脑端 + 新手机端（支持 deflate-raw）**：协商成功，下行启用共享 `deflate-raw` 流压缩。
  - **旧电脑端 + 新手机端**：旧电脑端 `initialize` 只读 `interactive` 并忽略新字段，结果不含 `compression`，双方都不压缩。
  - **新电脑端 + 旧手机端（旧 APK / 旧网页）**：请求不声明 `capabilities.compression`，电脑端不压缩。
  - **两边都新但 WebView 不支持 deflate-raw**：能力检测为假，手机端不声明 `capabilities.compression`，双方都不压缩。

### 3. 帧格式

- 数据帧（`0x10`）解密后的首字节 `flag` 扩展压缩位（主定义见 [remote-channel.md 第 5 节](../protocols/remote-channel.md#5-帧与消息)）：
  - `0x00`：未压缩，消息结束
  - `0x01`：未压缩，还有分片
  - `0x02`：压缩，消息结束
  - `0x03`：压缩，还有分片
  - 其余取值报 `protocol_error` 并直接关闭。
- **发送端**：每条连接持有一个 `deflate-raw` 压缩流（`level: 6`，`windowBits: 15`，电脑端由 Node `node:zlib` 提供，注入 `packages/remote`，保持 `packages/remote` 同构无 Node 依赖）。每条消息按 `utf8(message) ‖ 0xFF` 写入后执行 `Z_SYNC_FLUSH`（RFC 3629 保证 `0xFF` 永不出现在合法 UTF-8 字节序列中，用于解决 `DecompressionStream` 跨运行时多块/异步输出时的消息边界切分，包括空消息与超大消息），将本次刷出的压缩字节作为该消息载荷，沿用既有分片上限与 AES-256-GCM 加密。同一条消息所有分片保持压缩位一致（中间分片 `0x03`，末片 `0x02`）。
- **接收端**：每条连接持有一个长期存活的 `DecompressionStream("deflate-raw")`。重组完一条压缩消息后串行写入解压流，逐块读取至 `0xFF` 终止哨兵后做严格 UTF-8 解码再交付上层，保证消息顺序。
- **禁止混发**：开启压缩后，同一方向不得再发未压缩消息，收到 `0x00`/`0x01` 报 `protocol_error`；未开启压缩时收到 `0x02`/`0x03` 同样报 `protocol_error`。
- **大小上限**：`MAX_MESSAGE`（16 MiB）按解压后的明文字节长度计算。接收端在解压过程中按块累计明文字节，一旦超过 `MAX_MESSAGE` 立即中止并取消解压流读取，报 `frame_too_large` 并关闭连接，不把超限明文全部读入内存。`MAX_FRAME`（1 MiB）与分片规则不变。
- **错误处理**：解压失败（数据损坏、非法流结束或哨兵后多余字节）按 `decrypt_failed` 同等处理——直接关闭连接，**不回错误帧**。
- **局域网直连**：[ADR-0087](ADR-0087-lan-direct.md) 的 4 字节长度前缀 TCP 帧封装不变，压缩位于加密数据帧内部、即长度前缀之内。

### 4. 长度侧信道

- 中继原本即可观测每条加密帧的长度；引入压缩后，帧长度还会反映报文内容的可压缩程度。
- 由于整条连接共用同一个 32 KiB LZ77 滑动窗口，攻击者可控的内容（例如 `web_fetch` 抓取的外部网页）与敏感内容（例如工具输出中偶然出现的密钥或凭据）可能落在同一压缩窗口内。理论上，既能持续观测中继密文长度、又能根据长度反馈反复改写 agent 将读取内容的一方，可以逐步猜测敏感内容——这与 CRIME 属于同类长度侧信道问题。
- 现实门槛：攻击者必须同时控制中继（或其网络路径）以实时观测精确帧长度，并且能按长度反馈在会话过程中反复注入和修改 agent 读入的外部内容。
- 本轮不提供关闭压缩的用户开关，理由与残余风险记录在「后果」中。

### 5. 不在本轮

重字段按需加载（`tool.completed.modelContent`、`output`、`tool.started.input` 先发占位、用户展开时再按需拉取）不在本轮实现，留待通道压缩上线后根据手机真机打开耗时再行评估。

## 后果

- **正面**：历史长会话打开（`session.observe`）、实时回放（`session.subscribe`）与常规 RPC 响应的下行传输量大幅下降（样本会话按 `session.observeEvent` 形态从 3.52 MB 降至约 0.77 MB，降幅约 78%），且无需改动任何 RPC 业务报文格式；中继与局域网直连统一受益。
- **兼容性**：完全向后兼容旧电脑端、旧手机 APK 与不支持 `deflate-raw` 的旧版 Android WebView，无损退回未压缩传输。
- **安全与残余风险（不加开关的理由）**：本轮不增加「禁用压缩」开关，原因是中继采用邀请制且本身已在手机网页信任边界内（[ADR-0052 第 4 节](ADR-0052-remote-web-client.md#4-端到端加密)），同时实施长度观测与自适应内容注入的现实门槛较高，而增加一个面向用户的加密压缩开关既难以向普通用户解释、也会扩大配置与协商测试面。残余风险为：若将来中继演进为面向不可信第三方开放的公共服务、或需要抵御同时控制中继与外部输入的自适应长度侧信道攻击，需重新评估是否改用按消息重置上下文、随机填充或允许关闭压缩。
- **实现约束**：发送端每条远程连接持有一个 Node `zlib` 压缩流，接收端持有一个 Web `DecompressionStream`，必须在连接正常关闭、异常中止与断线时及时释放底层流资源。

## 备选方案

- **每条消息单独 deflate-raw**：单条 `session.observeEvent` 独立压缩无需共享上下文，也不存在跨消息压缩窗口的长度侧信道；但实测样本会话压缩后仍达 **1,441,967 字节**（约为本方案 **765,062 字节**的 1.88 倍），JSON 键名与重复代码片段无法跨事件复用字典，收益明显不足。
- **批量发送（每 128 条合成一条再 deflate-raw）**：实测样本会话压缩后为 **751,289 字节**，与本方案 **765,062 字节**几乎相当；但需要新增批量通知封装或改变回放协议，且无法惠及逐条推送的实时事件与其他 RPC 响应。
- **brotli**：整份样本日志 brotli 压缩后仅 **326,648 字节**，压缩率最优；但浏览器标准 `CompressionStream` / `DecompressionStream` 的 brotli 目前仅 Firefox 147+ 与 Safari 18.4+ 支持，Chrome、Android Chrome 与 Android WebView 均不支持（caniuse `mdn-api_compressionstream_compressionstream_brotli`），若自备 WASM 解压器会显著增加网页与 App 体积及维护成本。
- **重字段按需加载**：将超过 4 KiB 的 `tool.completed.modelContent`、`output`、`tool.started.input` 替换为占位符后再按 128 条一批 deflate-raw 压缩，实测为 **334,456 字节**（对比本方案 **765,062 字节**）；但该方案需要改动视图归约、diff 显示逻辑与多处手机界面交互，侵入范围大，留到通道压缩上线后观察手机实际打开耗时再定。
