# ADR-0100：Nocturne 自有插件与内置 office 插件

- 状态：已接受
- 日期：2026-11-20
- 相关：[ADR-0096](ADR-0096-hook-context-and-plugins.md)（读取 Codex / Claude Code 插件）、[ADR-0048](ADR-0048-skills.md)、[ADR-0011](ADR-0011-mcp-client.md)、[ADR-0050](ADR-0050-distribution.md)、[architecture/hooks.md](../architecture/hooks.md)、[architecture/mcp.md](../architecture/mcp.md)、[architecture/skills.md](../architecture/skills.md)、[architecture/config.md](../architecture/config.md)

## 背景

ADR-0096 第二部分让 Nocturne 只读取 Codex、Claude Code 已安装的插件，复用它们的技能与 4 个上下文类 Hook 点位，明确不做自行安装。这只能沿用别家的生态：

- 插件只能从 Codex 或 Claude Code 装；
- 插件里的 MCP 服务器不接；
- Hook 只能用兼容的 4 个点位。

用户需要 Nocturne 自己的插件体系，并以文档处理为第一个内置插件。文档处理基于 LibreOffice 命令行（`soffice --headless --convert-to`），2026-11-20 在本机（LibreOffice 26.8.0.3，Windows 11）实测：

- txt→docx、csv→xlsx、docx→pdf、docx→UTF-8 文本均正常，中文无误；
- `csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1` 可一次把所有工作表导出为 `<文件名>-<表名>.csv`；
- 耗时（单个小文件）：
  - 开机后第一次调用约 17 秒；
  - 每次用一个全新的 `-env:UserInstallation` 目录，连续三次各约 3.7–3.9 秒；
  - 复用已初始化的目录约 1.7 秒；
- 并发：
  - 两个转换同时运行、共用同一个 `-env:UserInstallation` 目录时，一个成功，另一个退出码为 1，没有任何输出，也没有生成文件；
  - 两个转换同时运行、各用各的目录时，都成功；
- 源文件不存在时退出码为 1，并打印 `Error: source file could not be loaded`；
- `soffice.com` 与 `soffice.exe` 在输出重定向到文件时都会打印转换结果行；
- LibreOffice 自带 Python 3.13.15，`import uno` 可用。

## 决定

### 1. 清单与插件目录

- **自有清单**：位于插件根目录下的 `.nocturne-plugin/plugin.json`。`name`、`version`、`description`、`skills`、`hooks`、`mcpServers` 沿用 Claude Code 清单的字段名；`interface`（`displayName`、`composerIcon`、`logo` 等）沿用 Codex 清单的字段名，图标规则同 ADR-0096 的图标读取。
  - 清单内的相对路径必须以 `./` 开头，解析后不得越出插件根目录（同 ADR-0096 第二部分第 1 节）。
  - `name` 只允许小写字母、数字、连字符。
- **兼容清单**：经 Nocturne 安装（第 3 节）的插件，没有 `.nocturne-plugin/plugin.json` 时，依次查找 `.codex-plugin/plugin.json`、`.claude-plugin/plugin.json`。
  - 技能和 `mcpServers` 按本 ADR 接入；
  - Hook 仍按 ADR-0096 第二部分的兼容翻译，只接 4 个点位，因为这两家的 Hook 输出格式与 Nocturne 不同。
- **插件标识**：`nocturne:<name>@<marketplace>`。内置插件的 marketplace 为 `builtin`，本地目录安装的为 `local`。

### 2. 插件能带的内容

- **技能**：清单 `skills` 字段或默认 `skills/`，接入方式与 ADR-0096 第二部分第 5 节相同（`source: "plugin"`，优先级最低，同名用户技能优先）。
- **Hook**：自有清单（`.nocturne-plugin`）的插件可以用 Nocturne 全部 9 个事件点，输入、输出、超时、执行方式与配置文件里的 Hook 相同（[hooks.md](../architecture/hooks.md)）。
  - `PreToolUse` 没有 `allow`、只有 `PermissionRequest` 能放宽，这些规则照旧；
  - 这条修订了 ADR-0096「后果」里「不接入工具放宽点位」的边界：自有清单的插件（含经本地目录安装的第三方插件）启用后，其 `PermissionRequest` Hook 可以 `allow`。Codex、Claude Code 来源和兼容清单仍不接工具点位；
  - 子进程使用白名单环境，叠加 `PLUGIN_ROOT`、`PLUGIN_DATA`；
  - 命令和参数里的 `${PLUGIN_ROOT}`、`${PLUGIN_DATA}` 按字符串单次替换。
- **MCP 服务器**：清单 `mcpServers` 可以是内联对象，也可以是指向 JSON 文件（形如 `{ "mcpServers": { … } }`）的 `./` 相对路径；省略时读插件根目录的 `.mcp.json`（若存在）。
  - 一期只接 stdio；`type: "http"` 的条目跳过，记入 `unsupported`。
  - `command`、`args`、`env` 里的 `${PLUGIN_ROOT}`、`${PLUGIN_DATA}`、`${NOCTURNE_NODE}` 按字符串单次替换。`${NOCTURNE_NODE}` 为运行当前 Runtime 的 Node 可执行文件路径（`process.execPath`），插件因此可以用 Node 写服务器，不要求用户自装 Node。
  - 服务器 id 用清单里的键。与用户、项目或 `mcp.json` 里的同名服务器冲突时，配置文件优先，插件里的这条跳过并发 `runtime.warning`（code `plugin_mcp_conflict`）。
  - 工具名、权限主体（`mcp <server>/<tool>`）、按需加载、重连、输出预算与普通 MCP 服务器完全相同；`readOnlyHint` 照旧决定是否算写入。
  - 插件不能声明 `{ stored: true }` 凭据。
- **可用能力**：ADR-0096 修订（2026-11-20）里「既无受支持 Hook 又无技能就不列出」的规则，扩展为「受支持 Hook、技能、受支持 MCP 服务器三者都没有才不列出」，对所有来源生效。
- **明确不做**：斜杠命令（`commands/`）、界面扩展、子代理定义。

### 3. 来源、安装与信任

- **内置插件**：随发行包分发。
  - 仓库目录为 `plugins/<name>/`；
  - 桌面安装包放在 `<resource_dir>/plugins/<name>/`，npm 包放在包内 `plugins/<name>/`，与 `nctrn.mjs` 相邻；
  - 宿主（CLI 入口、桌面后台启动参数）把内置插件目录作为 Runtime 选项 `builtinPluginsDir` 传入，Core 不自行猜测路径；未传入时没有内置插件。
  - 内置插件不做指纹确认，版本随 Nocturne 升级；默认开启，用户关闭后在 `plugins.json` 记 `enabled: false`。
- **本地目录安装**：用户在「设置 › 插件」选择一个本地目录。
  - Nocturne 校验清单后，把整个目录复制到 `<NOCTURNE_HOME>/plugins/installed/local/<name>/<version>/`，以后只读这份副本；源目录改动不会生效，重新安装才更新；
  - 安装后状态为 `off`，启用时记录整目录指纹，规则同 ADR-0096 第二部分第 4 节（内容变了就是 `changed`）；
  - 卸载会删除这份副本和 `plugins.json` 里的记录，不动 `PLUGIN_DATA`。
- **git 地址、市场清单安装**：后续另立 ADR，复用同一套启用与指纹规则。
- **状态文件**：沿用 `<NOCTURNE_HOME>/plugins.json`，id 按第 1 节。

### 4. 内置插件 office

- **组成**：
  - 一个 MCP 服务器 `office`，用 Node 写，以 `${NOCTURNE_NODE}` 启动；
  - 三个技能 `office-docs`、`office-sheets`、`office-slides`，说明什么时候用、调哪个工具，以及「改内容 = 写出新内容，再转换成目标格式」的做法。
- **范围**：一期只做转换和读取，不用 UNO 直接修改文档。不处理 PDF 输入。
- **工具**（名称与参数由实现轮在此基础上确定，并写进 `site-docs/`）：
  - 转换：输入文件和目标格式，输出到指定目录或输入文件所在目录，返回生成的文件路径；算写入。
  - 提取文本：文字文档和演示文稿；只读（`readOnlyHint: true`）。
  - 读工作表：按工作表返回内容；只读。
- **服务器内部必须处理的点**：
  - 找 soffice：`PATH` 上的 `soffice` / `libreoffice`，Windows `%ProgramFiles%\LibreOffice\program\soffice.com`，macOS `/Applications/LibreOffice.app/Contents/MacOS/soffice`。找不到时工具返回明确错误（code `libreoffice_not_found`），不崩溃。
  - 每个服务器进程使用一个自己的临时 `-env:UserInstallation` 目录，进程退出时删除；不连到用户正在使用的 LibreOffice。
  - 同一进程内的 soffice 调用串行排队，任一时刻最多一个，包括模型并发调用的只读工具。每个会话各起一个服务器进程，各有各的目录，所以多个会话可以同时转换。
  - 以输出文件是否生成来判断成败，不只看退出码。
  - 单次调用超时 120 秒，超时结束整个进程树。
- **不打包 LibreOffice**，也不打包或改写任何第三方的文档技能文本；技能和服务器全部自研。

### 5. 接口与界面

- `PluginOverview` 的 `host` 新增 `"nocturne"`，并增加 `mcpServers`（id、command 摘要、是否跳过及原因）；marketplace 为 `builtin` 时表示内置插件。
- 新增 `plugins.installLocal({ path })`、`plugins.uninstall({ id })`；都只在本地开放，不加入远程白名单。
- 「设置 › 插件」：内置插件和已安装插件按来源分组显示；插件详情列出技能、Hook、MCP 服务器。不加说明文字。
- 「设置 › MCP」照常只列配置文件里的服务器；插件带的服务器在插件详情里看。

### 6. 分期

1. Core 与打包：自有清单发现、`builtinPluginsDir`、插件 MCP 服务器、9 点位 Hook；CLI、桌面端、npm 包带上 `plugins/` 目录；插件页显示内置插件和 MCP 服务器。
2. office 插件：`plugins/office/` 的 MCP 服务器、三个技能与测试。可与第 1 项并行开发，用独立进程直接测服务器。
3. 本地目录安装与卸载：RPC、插件页的安装与卸载入口。

## 后果

- Nocturne 有了自己的插件发布形态。内置插件随版本更新，第三方插件经本地目录安装后，与 Codex、Claude Code 插件用同一套启用与指纹信任。
- 插件可以带 MCP 服务器，能力与用户手写的 MCP 配置相同，权限照常经权限层。
- 安装包多出 `plugins/` 目录；office 插件需要用户自装 LibreOffice。
- office 默认开启的代价：每个会话多起一个 Node 进程，工具列表多 3 个工具，技能目录多 3 条；没装 LibreOffice 的机器也一样，直到用户在插件页关掉它。
- office 工具单次调用约 1.7 秒（同一进程内第一次约 4 秒，开机后第一次更久）；同一会话里的调用排队执行。

## 备选方案

- **把文档处理做成内置技能，不做插件**：实现最快，但内置能力没有统一的分发、启停与升级形态，以后的内置插件还得再造一遍。
- **在技能里让模型直接拼 `soffice` 命令**：引号转义、找可执行文件、并发 profile 冲突、输出校验都要靠模型每次做对，三个平台行为不一致。
- **用 UNO 直接改文档**：能力更强，但脚本要自己写、要在三个平台测，留待后续。
- **复用 Claude Code 的插件目录，往 `~/.claude/plugins` 里装**：违反「不写别家配置目录」的原则。
