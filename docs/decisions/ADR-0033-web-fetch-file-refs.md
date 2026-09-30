# ADR-0033：网页抓取工具与 `@文件` 引用

- 状态：已接受（维护者 2026-10-01 确认）
- 日期：2026-10-01

## 背景

[v0.5 路线图](../roadmap/roadmap.md)还有两项基础能力没有做：

- **网页抓取**：模型要查文档、看 issue、读报错里给的链接时，只能让用户自己打开网页再贴回来，或者用 `shell` 跑 `curl`。`curl` 拿到的是原始 HTML，脚本、样式和导航占掉大半，浪费上下文；而且 `shell` 走的是命令权限，用户在确认框里看不出这是一次网络访问。
- **`@文件` 引用**：用户想让模型看某个文件时，只能写路径，再等模型调用 `read`，多一个来回。输入框也不能补全路径，长路径容易打错。

权限层早就预留了 `network` 类（[permissions.md](../architecture/permissions.md) 第 3 节，目标为「URL 或主机」，各预设已有对应的列），附件通道也在 [ADR-0023](ADR-0023-image-input.md) 落地了。本 ADR 在这两块现有机制上补齐两项能力。搜索不内置，仍交给 MCP。

## 决定

### 1. `web_fetch` 工具

新增内置工具 `web_fetch`。输入：

```ts
{ url: string }
```

- 只接受 `http:` 与 `https:`，其他协议（`file:`、`data:`、`ftp:` 等）以 `invalid_input` 结算。URL 至多 2000 字符，不得含用户名密码段（`https://user:pass@host`）。未知字段拒绝。
- 不提供 `prompt` 参数。Claude Code 的 WebFetch 会用小模型按提示词提炼页面内容，这依赖「模型角色」，排在以后；本版本直接返回转换后的正文，长页面靠现有的结果预算与完整输出落盘兜底（[tools.md](../architecture/tools.md) 第 4 节），模型可以用 `read` 按需看后半部分。

**请求**

- 只发 `GET`，User-Agent 为 `nocturne/<version>`（与 Provider 请求相同的基值，ADR-0031 §2），带 `Accept: text/html, text/markdown, text/plain, application/json, */*;q=0.5`。
- 代理沿用进程级设置（`configureEnvProxy`），不另外处理。
- 总超时 30 秒，由 `traits.timeoutMs` 表达；中断时取消请求。
- 响应体最多读 5 MB，超出就停止读取，并在结果里注明「页面过大，只处理了前 5 MB」。
- **重定向手动处理**，至多 5 次。主机不变（含 `http` → `https` 升级）时直接跟随；**跨主机时不跟随**，以 `status: "ok"` 结算，`modelContent` 为「该地址重定向到 <新 URL>；如需继续，请用新地址再次调用 web_fetch」。这样权限主体始终是实际访问的主机，不会被重定向带到用户没批准过的地方。

**内容转换**（按响应的 `Content-Type`）

| 类型 | 处理 |
|---|---|
| `text/html`、`application/xhtml+xml` | 先去掉 `script`、`style`、`noscript`、`svg`、`iframe`、`nav`、`header`、`footer`、`aside`、`form`，页面有 `main` 或 `article` 时只取其内容，再转成 Markdown。标题取 `<title>` |
| `text/markdown`、`text/plain`、`text/*`、`application/json`、`application/xml` 及 `+json`/`+xml` | 原文 |
| `image/png`、`image/jpeg`、`image/gif`、`image/webp` | 走 ADR-0023 附件通道（`source` 取 `"read"`），大小与尺寸限制同 `read`，按当前模型的 `imageInput` 投影 |
| 其他（PDF、压缩包、音视频等） | `error`，`code: "unsupported_content"`，说明类型与大小 |

- 字符集按 `Content-Type` 的 `charset` 解码；HTML 未声明时读前 1024 字节里的 `<meta charset>`；仍未知时按 UTF-8。解码用 WHATWG `TextDecoder`，不引入额外编码库。
- HTML 转 Markdown 引入 `node-html-markdown`（MIT，依赖 `node-html-parser`，不需要 DOM 环境）。主体内容提取只用上面的标签规则，不引入 Readability（它需要 DOM 实现，依赖更重）。

**结果**

- 状态码 2xx：`status: "ok"`。`modelContent` 首行为 `URL: <最终地址>`，有标题时第二行为 `标题: <title>`，空一行后接正文。
- 状态码 4xx、5xx：`status: "error"`，`code: "http_error"`，`modelContent` 给出状态码，并附正文前 2000 字符（很多 API 的错误信息在正文里）。
- DNS 失败、连接失败、TLS 错误、超时：`status: "error"`，`code: "network_error"`，说明原因；超时仍按执行器现有规则以 `timeout` 结算。
- `output` 供客户端渲染：`{ url, finalUrl, status, contentType, title?, chars, truncatedBytes? }`，不含正文。
- `traits`：`mutates: false`、`concurrencySafe: true`、`timeoutMs: 30_000`、`maxModelChars: 30_000`。

**权限**

- `permissionSubjects` 返回 `[{ kind: "network", target: <主机> }]`。主机取小写 `hostname`，端口不是协议默认端口时带上 `:端口`，不含协议和路径。
- 按主机而不是完整 URL 作目标，是为了让「本会话允许」覆盖同一站点的后续访问；否则每换一个页面都要重新确认。确认框里另外显示完整 URL（见第 3 节），用户能看清具体访问哪一页。
- 各预设的行为沿用 permissions.md 第 6 节现有的 `network` 列：`full-access` 放行，其他预设询问。用户可以写 `network docs.python.org → allow` 或 `network *.github.com → allow` 这类规则。
- 访问 `localhost`、内网地址时不特殊处理，同样经过权限求值。文档写明：在 `full-access` 下模型可以访问本机和内网服务。
- **子代理**：`web_fetch` 声明 `mutates: false`，会自动进入 `explore` 工具集。子会话是非交互的，需要确认的访问会被拒绝；父会话里已经「本会话允许」过的主机，子会话按只读继承（permissions.md 5.4 节），可以直接访问。工具说明向模型写清这一点。

**工具说明**（模型可见）写明：用于读取用户给出的链接、官方文档与公开网页；不能登录，也不带 Cookie；不能执行页面脚本，靠脚本渲染的页面可能拿不到内容；不要用来搜索（没有搜索能力，除非配置了搜索类 MCP）。

### 2. 权限确认框显示 URL

- `PermissionSubject` 新增可选字段 `detail?: string`（兼容新增）：给人看的补充说明，**不参与规则匹配、Grant 键与 Hook 判定**。`web_fetch` 在这里填完整 URL。
- TUI 与 CLI 的确认框在目标下方加一行显示 `detail`，超宽时截断中间部分。「本会话允许」的选项文字写明范围，例如「本会话允许访问 docs.python.org」。

### 3. `@文件` 引用：语法与解析

- **语法**：`@` 位于输入开头或紧跟空白之后，后接不含空白的路径，例如 `@src/app.ts`。路径含空格时写成 `@"docs/my notes.md"`。邮箱这类 `a@b.com` 中间出现的 `@` 不算引用。
- **解析**：相对路径以会话的工作目录为基准；也接受绝对路径。路径不存在时，如果去掉末尾的中英文标点（`，。,.;；:：)）!！?？`）后存在，就用去掉后的路径。仍不存在就当普通文字，不报错。
- **在 Core 解析**：`submit` 收到文本后由 Core 识别引用并读取文件，TUI、逐行 CLI 与 `-p` 行为一致。Core 另外导出纯函数 `parseFileRefs(text)`，客户端用它做高亮与提交前提示。

### 4. `@文件` 引用：附带什么

| 目标 | 附带内容 |
|---|---|
| 文本文件 | 按 `read` 的文本规则读取（二进制嗅探、换行与编码处理相同），带行号。单文件的 2000 行与 50,000 字符两个上限**取较宽的一个**：不超过 2000 行，或不超过 50,000 字符，都完整附带；两者都超出时，按「前 2000 行」与「50,000 字符以内的整行」中内容更多的一种截取，并注明「文件共 N 行，只附带了第 1–M 行，其余用 read 查看」 |
| 图片（PNG/JPEG/GIF/WebP） | 走 ADR-0023 附件通道（`source: "paste"`），限制相同；当前模型不支持看图时不附加，按普通文字发送，并提示用户（与粘贴图片一致） |
| 目录 | 一层目录列表，遵守 `.gitignore`，至多 200 项，子目录名后加 `/` |
| 其他二进制文件 | 不附加，按普通文字发送，并提示用户 |

- 一条消息内所有引用合计至多 150,000 字符，这是硬上限（单文件取较宽上限后仍受它约束）；超出后剩余的引用不再附加内容，只保留路径，并提示用户。
- 同一路径出现多次只附带一次。
- **内容在提交那一刻固定**：随用户消息写入会话日志，之后文件再改也不影响这条消息。
- **先读后写**：完整或部分附带的文本文件，按 `read` 的规则写入 `readState`，模型可以直接 `edit`，不必再读一遍。
- **不经过权限层**：`@` 引用是用户自己的操作，不是模型的工具调用，不做权限求值，也不触发 `PreToolUse` 等工具 Hook。工作区外的文件同样可以引用，因为路径是用户亲手写的。

### 5. `@文件` 引用：事件与上下文

- 用户消息的 `content` 依次为：原文文本块，然后每个被附带的文件或目录各一个文本块，格式为

  ```
  <file path="src/app.ts" lines="1-2000" total="2400">
  …带行号的内容…
  </file>
  ```

  目录用 `<directory path="…" entries="37">`。图片仍走 `attachments`。
- `user.message` 事件与 `HistoryEntry` 的 user 条目新增可选字段 `fileRefs?: Array<{ path: string; kind: "file" | "directory" | "image"; lines?: number; totalLines?: number; chars: number; truncated: boolean }>`（兼容新增，不升 `formatVersion`）。客户端据此把这条消息显示为原文，外加一行「附带 @src/app.ts（2000/2400 行）」，不把文件内容铺进对话。旧客户端不认识该字段，会把文件块当普通文字显示，功能不受影响。
- Context Builder 不做特殊处理：文件块就是普通的用户内容，照常参与上下文预算与压缩。

### 6. 输入框补全

- **TUI**：光标所在的词以 `@` 开头时（规则同第 3 节），在输入框下方打开候选列表，复用斜杠补全的列表组件与键位（至多 8 行，`↑`/`↓` 移动，`Tab` 补全，`Esc` 关闭）。
  - 候选来自工作区文件索引：遍历复用内置工具的 `walk` 与 `.gitignore` 规则，跳过 `.git`，至多 20,000 项。第一次输入 `@` 时建立，每个 Turn 结束后标记过期、下次输入 `@` 时重建。建立索引期间列表显示「正在索引…」，不阻塞输入。
  - 匹配不区分大小写，按以下顺序排序：文件名前缀匹配、文件名包含、路径包含；同档内路径短的在前。目录带 `/` 后缀，补全目录后列表保持打开，继续列下一级。
  - 列表打开时 `Enter` 选中当前候选（插入 `@路径 `），不提交消息；列表关闭后 `Enter` 照常提交。
  - 已识别的引用在输入框里用主题的强调色显示，与 `[Image #n]` 一致。
- **逐行 CLI**：readline 的 completer 同样补全 `@` 开头的词，用同一份索引。

## 验收

- **`web_fetch`**（离线，用本地 HTTP 服务器或注入 fetch）：
  - HTML 转 Markdown：去掉脚本、样式与导航，取 `main`/`article`，提取标题；
  - 纯文本、JSON 原样返回；图片进入附件通道；PDF 返回 `unsupported_content`；
  - 字符集：`Content-Type` 的 `charset`、`<meta charset>`、GBK 页面；
  - 5 MB 截断；超过 30,000 字符时落盘并注明路径；
  - 同主机重定向跟随，跨主机不跟随并返回新地址；超过 5 次报错；
  - 4xx/5xx 带正文摘要；连接失败；超时与中断各恰好一个 `tool.completed`；
  - 协议、URL 长度、用户名密码段的输入校验；
  - 权限主体为主机（含非默认端口），`detail` 为完整 URL 且不参与规则匹配与 Grant 键；`default` 下询问、`full-access` 下放行，「本会话允许」后同主机不再询问；
  - `explore` 子代理含 `web_fetch`，父会话已授权的主机可直接访问，未授权的被拒；
  - 默认测试集不访问外网（沿用 `setup-offline.ts`）。
- **`@文件`**：
  - `parseFileRefs`：开头、空白后、引号路径、邮箱不误判、末尾标点回退、不存在时按普通文字；
  - 文本截断（2000 行与 50,000 字符取较宽、两者都超出时取内容更多的截法、合计上限）、目录列表遵守 `.gitignore`、二进制不附加、同一路径只附带一次；
  - 图片在支持与不支持看图的模型下的不同处理；
  - 事件含 `fileRefs`，恢复会话后显示一致；附带的文件写入 `readState` 后可以直接 `edit`；
  - 不产生权限请求与工具 Hook。
- **补全**：TUI 与 CLI 的候选排序、目录逐级补全、`.gitignore` 过滤、`Enter` 选中不提交、索引过期重建；高亮显示。
- **维护者手测**：在 Windows Terminal 里让模型抓取一个文档页面，检查确认框显示的 URL；用 `@` 补全并引用一个文件，检查对话里的显示。
- **文档同步**：
  - [tools.md](../architecture/tools.md)：内置工具列表、`web_fetch` 小节、`@` 引用的读取规则；
  - [tool-api.md](../protocols/tool-api.md)：错误码 `unsupported_content`、`http_error`、`network_error`；
  - [permissions.md](../architecture/permissions.md)：`network` 类目标改为主机、`detail` 字段、`@` 引用不经过权限层；
  - [events.md](../protocols/events.md)、[view.md](../protocols/view.md)：`fileRefs`、`PermissionSubject.detail`；
  - [context.md](../architecture/context.md)：用户消息里的文件块；
  - [subagent.md](../architecture/subagent.md)：`explore` 含 `web_fetch`；
  - [tui.md](../apps/tui.md)、[cli.md](../apps/cli.md)：`@` 补全、引用显示、确认框的 URL 行；
  - `THIRD-PARTY-NOTICES.md`：新依赖的许可证；
  - 路线图条目、[decisions/README.md](README.md)。

## 后果

- **正面**：
  - 模型能直接读文档和链接，不再借道 `curl`，拿到的是去掉杂质的正文；
  - 网络访问有了独立的权限类别，确认框里看得到具体地址，也能按站点写规则；
  - 用户引用文件少一个来回，补全减少路径打错；
  - `detail` 字段以后可以给 MCP 等其他工具用。
- **负面**：
  - 靠脚本渲染的页面拿不到内容；主体提取只是标签规则，复杂页面仍会带进一些杂质；
  - 按主机授权意味着「本会话允许」后，同站点的任何页面都不再询问；
  - `@` 引用的文件内容整份进入上下文，引用大文件会很快用掉上下文窗口（有截断上限兜底）；
  - 新增一个 npm 依赖。
- **约束**：
  - `web_fetch` 不得带 Cookie 或凭据，不得执行页面脚本；
  - `detail` 只用于显示，任何判定逻辑都不得读取它；
  - Core 解析 `@` 引用只认第 3 节的语法，不猜测其他写法。

## 备选方案

- **提供 `prompt` 参数，用小模型提炼页面**：效果更好，但依赖「模型角色」里的轻量模型，排在以后；届时可以作为兼容新增的可选参数。
- **按完整 URL 作权限目标**：粒度最细，但每个页面都要重新确认，读文档时几乎没法用。
- **跨主机重定向自动跟随**：少一次调用，但权限只批准了原主机，自动跟随等于让重定向绕过确认。
- **用 Readability + DOM 实现提取正文**：文章类页面效果更好，但要引入 DOM 实现，依赖重、启动慢；等标签规则确实不够用再考虑。
- **`@` 只插入路径，由模型自己 `read`**（Codex 的做法）：实现最简单，但省不掉那个来回，也就失去了这项功能的主要意义。
- **把 `@` 引用伪装成一次 `read` 工具调用写进日志**：显示上更统一，但要伪造工具事件，破坏「工具事件都来自模型调用」的前提，恢复与审计时容易混淆。
- **`@` 引用也走权限层**：用户亲手写的路径再让用户确认一次没有意义；权限层管的是模型的动作。
- **在客户端解析 `@` 引用，提交时把路径列表交给 Core**：客户端各自实现，`-p` 模式也要单独处理，行为容易不一致。
- **顺带实现 MCP 图片结果（ADR-0023 第 8 节）**：维护者决定挪到「MCP 服务器管理」一轮，与添加、删除服务器的界面一起做，届时有真实服务器可以手测。
