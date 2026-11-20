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

## 修订：2026-11-20 四个文档插件、创建与编辑、按需启动

本节取代第 4 节和第 6 节第 2 项，并补充第 2 节的 MCP 服务器规则。

### 依据（2026-11-20 本机实测，LibreOffice 26.8.0.3，Windows 11）

- 以 `--accept=pipe,name=<名称>;urp;` 启动一个常驻的 headless soffice，再用 LibreOffice 自带的 Python（3.13.15）通过 UNO 连接，可以：
  - 新建两页的演示文稿并写入文字，存为 pptx；用 `GraphicExportFilter` 把每页导出为 PNG，中文显示正常；
  - 新建表格，写入公式 `=A1*A2`，`calculateAll()` 后得 6，插入第二个工作表，存为 xlsx；
  - 新建文字文档，用 `replaceAll` 替换文本，存为 docx。
- 以上三项连续执行共约 1.0 秒（不含 soffice 启动）。

### 1. 四个内置插件

取代原来的单个 office 插件：

| 插件 name | 显示名 | MCP 服务器 id | 技能 |
|---|---|---|---|
| `docx` | Word 文档 | `word` | `docx` |
| `xlsx` | 电子表格 | `sheets` | `xlsx` |
| `pptx` | 演示文档 | `slides` | `pptx` |
| `pdf` | PDF | `pdf` | `pdf` |

- 范围：创建、读取、编辑、转换，并能按页导出图片供模型查看效果。
  - Word、表格、演示通过 UNO 实现编辑；具体工具与参数由实现轮确定，写进 `site-docs/`；
  - PDF：由其他格式生成 PDF、按页导出图片、提取文本、合并与拆分。
- 图标自行绘制，不使用其他产品的图标素材。
- 技能和服务器全部自研，不参考、不改写第三方的文档类技能文本。

### 2. 源码与构建

- 源码放在工作区包 `plugins-src/`（四个插件共用的 LibreOffice 引擎代码也在这里）。
- `pnpm build` 把每个插件构建成自包含的 `plugins/<name>/`：清单、技能、单文件 `server.mjs`、引擎用到的 Python 脚本。
  - 运行时不依赖 `node_modules`；
  - `plugins/` 是构建产物，不入库；
  - 第 3 节的打包规则照旧复制它。
- 允许把许可证兼容（MIT、Apache-2.0、BSD）的 npm 依赖打进 `server.mjs`，例如处理 PDF 的库；第三方许可证写进 `THIRD-PARTY-NOTICES.md`。

### 3. LibreOffice 引擎

- 每个 MCP 服务器进程在第一次需要时，才启动自己的 soffice（headless，`--accept` 管道，独立的临时 `-env:UserInstallation`）和一个 UNO 辅助进程（LibreOffice 的 Python 运行引擎脚本，与服务器之间用 stdio 交换 JSON）。
- 闲置 5 分钟后，两者都退出；下次调用再启动。服务器进程退出时，两者一并结束，临时目录删除。
- 同一服务器进程内的调用串行。
- 找 Python：
  - Windows `<LibreOffice>\program\python.exe`；
  - macOS `/Applications/LibreOffice.app/Contents/Resources/python`；
  - Linux 用系统 `python3`，要求能 `import uno`。
- 错误：
  - 找不到 LibreOffice 时返回 `libreoffice_not_found`；
  - 找到了但 UNO 不可用（例如 Linux 没装 `python3-uno`）时返回 `libreoffice_uno_unavailable`；
  - 只用命令行转换就能完成的工具，在 UNO 不可用时照常工作。
- 第 4 节原有的要求仍然有效：输出文件存在才算成功、单次调用超时 120 秒并结束进程树、不连到用户正在使用的 LibreOffice。

### 4. 插件 MCP 服务器按需启动（补充第 2 节）

适用于所有插件带来的 MCP 服务器；配置文件里的 MCP 服务器行为不变。

- **工具缓存**：服务器第一次启动、取得 `tools/list` 后，缓存到 `<NOCTURNE_HOME>/plugins/cache/mcp-tools/`。
  - 缓存键：插件 id、服务器 id，加上内置插件的版本（含 `.nocturne-plugin/build-id` 时为 `<version>+<buildId>`）或已安装插件的指纹；
  - 缓存内容：服务器信息与工具列表（名称、说明、参数 schema、annotations）。
- **会话打开**：
  - 缓存命中：直接用缓存的工具定义注册工具，不启动进程；
  - 缓存未命中或已失效：照常启动服务器取工具列表并写缓存，本会话里不再退出。
- **第一次调用**：启动服务器，完成 initialize 与 `tools/list`，再执行这次调用。
  - 实际工具列表与缓存不同时，更新缓存，新工具集在下一个 MCP 边界生效（[ADR-0086](ADR-0086-mcp-steer-boundary.md)）；
  - 这次要调用的工具已不存在时，返回错误 `mcp_tool_missing`。
- **生命周期**：启动后随会话关闭而结束。崩溃与重启规则同普通 stdio 服务器。
- **状态**：会话的 MCP 状态里增加「未启动」，区别于「已连接」和「失败」。
- **结果**：不用文档的会话不会多出任何进程；工具定义与提示词缓存前缀和启动后一致。

### 5. 分期（取代第 6 节第 2 项，其余顺延）

1. Core 与打包（第 6 节第 1 项），另加本修订第 4 节的按需启动。
2. 四个文档插件：`plugins-src/`、构建、引擎、技能与测试。
3. 插件详情页：大图标、各节计数、版本与来源、「立即试用」（新开会话并调用该插件的技能）；本地目录安装与卸载。
4. 查看器：桌面端侧边面板显示文档，加上对应的查看器技能。宿主部分见 [ADR-0101](ADR-0101-mcp-apps-host.md)。
5. 插件定义子代理（例如视觉验收），届时修订第 2 节「明确不做」。

### 对「后果」的修订

- 默认开启的代价，由「每个会话多一个 Node 进程」改为：
  - 不用文档的会话，不增加进程；
  - 工具列表多出四个插件的工具，技能目录多 4 条；
  - 用到某个插件时，多一个 Node 进程、一个 soffice、一个 Python 辅助进程，闲置 5 分钟后 soffice 和 Python 退出。

## 修订：2026-11-20 四个文档插件实现补充与实测调整

本节补充四个内置文档插件（`plugins-src/`）实测与落地后的边界约定，不改动上述正文：

- **演示文稿重排页序**：无头模式下 LibreOffice Impress 的 `.uno:MovePageFirst` 等界面调度命令不生效；`slides.edit` 的 `reorder_slides` 通过改写 `.pptx` 内 `ppt/presentation.xml` 的 `<p:sldIdLst>` 节点顺序实现，再由 UNO 重新打开继续后续操作，保留全部版式、图片与备注。
- **Word / 表格按页出图**：Writer 与 Calc 不直接支持逐页 `GraphicExportFilter`，`word.render` 与 `sheets.render` 先导出临时 PDF（`writer_pdf_Export` / `calc_pdf_Export`），再经 LibreOffice Draw（`draw_pdf_import`）逐页 `GraphicExportFilter` 输出 PNG；演示文档直接经 Impress `GraphicExportFilter` 输出。
- **PDF 文本提取、出图、合并与拆分**：`pdf.read` 与 `pdf.render` 采用 LibreOffice Draw（`draw_pdf_import`）导入 PDF 后按页提取文本与导出 PNG，复用系统字体（含中文字体）而无需打包原生 Canvas 或 CMap 资源；`pdf.merge` 与 `pdf.split` 使用打入 `server.mjs` 的 `pdf-lib`（MIT）在 Node 中无损完成，不依赖 LibreOffice。
- **`render` 默认页数与上限**：缺省返回前 4 页，单次调用最多返回 4 张 PNG，与 Nocturne MCP 客户端每次工具调用 4 张图片的附件上限一致；超过 4 页的文档通过 `pages` 参数分批查看。
- **查找与超时覆盖**：环境变量 `NOCTURNE_OFFICE_SOFFICE` 与 `NOCTURNE_OFFICE_PYTHON` 优先于各平台默认安装路径；`NOCTURNE_OFFICE_IDLE_MS` 与 `NOCTURNE_OFFICE_TIMEOUT_MS` 可覆盖 5 分钟闲置超时与 120 秒单次调用超时。

## 修订：2026-11-20 第三期实现约定

本节记录第三期（插件详情页大图标与「立即试用」、本地目录安装与卸载）的落地约定：

- **方法名**：取代第 5 节中的 `plugins.installLocal` / `plugins.uninstall`，Runtime 与 RPC 统一命名为 `installLocalPlugin({ path })` / `uninstallPlugin({ id })`（对应 RPC 方法 `plugins.installLocalPlugin`、`plugins.uninstallPlugin`），与 `plugins.describePlugins`、`plugins.setPluginEnabled` 保持同一风格；两个方法均不加入远程白名单。
- **同名重装**：同名本地插件重新安装（不论版本）时，先复制到同级临时目录再原子替换整个 `<NOCTURNE_HOME>/plugins/installed/local/<name>/`，保留 `plugins.json` 中的已有记录；内容变化后按既有整目录指纹规则自动显示为 `changed`，不新增状态规则。新装插件状态为 `off`；复制时跳过 `.git` 与符号链接。
- **版本目录名**：与 `selectActivePluginVersion` / `isValidPluginVersionDirName` 保持一致——清单 `version` 满足合法版本目录名时直接采用该值，缺省或不合法时采用 `local`。
- **卸载与缓存清理**：`uninstallPlugin` 仅接受 `host === "nocturne"` 且 `marketplace === "local"` 的插件；先按停用路径让已打开会话在边界生效，再删除 `installed/local/<name>/` 与 `plugins.json` 记录（目录删除失败如被占用时回滚状态，保持磁盘与 `plugins.json` 一致），最后删除 `<NOCTURNE_HOME>/plugins/cache/mcp-tools/` 下属于该插件的缓存文件，不动 `PLUGIN_DATA`。
- **「立即试用」**：仅在插件状态为 `on` 且至少有一个可调用技能时在详情页 hero 右侧显示；多技能时经菜单选择。点击后在当前工作区新开会话、关闭设置页、向草稿输入框预填 `/<技能名> `（光标置于末尾并聚焦），不自动发送。
- **入口范围**：一期只在桌面端「设置 › 插件」提供本地安装与卸载入口。

## 修订：2026-11-20 界面扩展

第 2 节「明确不做」中的「界面扩展」由 [ADR-0101](ADR-0101-mcp-apps-host.md) 取代：自有清单的插件可以用 `ui.surfaces` 与 MCP Apps 页面，在桌面端右侧面板提供交互页面。斜杠命令与子代理定义仍不做。

## 修订：2026-11-20 文档查看器

本节落实「修订：四个文档插件」第 5 节分期第 4 项。宿主见 [ADR-0101](ADR-0101-mcp-apps-host.md)，所需 CSP 见其修订「放宽 CSP：WebAssembly 与 blob Worker」。

### 1. 一个查看器，四个插件共用

- 四个插件共用同一个查看器页面，统一按 PDF 显示：
  - PDF 直接显示；
  - Word、表格、演示由插件服务器先用 LibreOffice 转成 PDF 再显示，转换结果按「真实路径 + 修改时间 + 大小」缓存在服务器进程的临时目录，进程退出时删除。
- 页面用 pdf.js（`pdfjs-dist`，Apache-2.0）渲染，整页内联进 HTML（含 Worker 源码），总大小不超过 ADR-0101 第 2 节的 8 MiB。cMap、标准字体、WebAssembly 等 pdf.js 辅助资源随插件一起打包，由页面经下面的辅助资源工具取得，不走网络。
- 每个插件声明一个 surface：

  | 插件 | surface id | `open.fileTypes` |
  |---|---|---|
  | `docx` | `viewer` | `.docx`、`.doc`、`.odt`、`.rtf` |
  | `xlsx` | `viewer` | `.xlsx`、`.xls`、`.ods` |
  | `pptx` | `viewer` | `.pptx`、`.ppt`、`.odp` |
  | `pdf` | `viewer` | `.pdf` |

### 2. 工具（每个插件各一组，名称相同）

| 工具 | 可见性 | 只读 | 作用 |
|---|---|---|---|
| `show_in_viewer` | 模型与页面 | 是 | 参数 `{ path, page? }`。登记文档（Office 格式先转换），返回文档句柄、文档的绝对路径、文件名、页数和初始页码；关联查看器页面（`_meta.ui.resourceUri` 与 `_meta.ui.surface`）。也是 surface 的 `open.tool`。 |
| `read_document` | 仅页面 | 是 | 参数 `{ docId, offset, length }`，按块返回 PDF 字节（base64），单块上限由实现轮按宿主消息大小实测确定。 |
| `viewer_asset` | 仅页面 | 是 | 参数 `{ name }`，返回 pdf.js 辅助资源；只认打包清单里的名字。 |

- `read_document` 只认 `show_in_viewer` 登记过的句柄。`show_in_viewer` 对页面可见，所以页面本身可以登记任意路径：安全依靠的是查看器页面由插件自带、页面拿不到网络和 Tauri IPC（ADR-0101 第 6 节），读到的字节出不了这个页面。
- 句柄和转换缓存只在服务器进程内有效，会话关闭、应用重启或服务器崩溃重启后失效。`read_document` 遇到未知句柄返回 `document_unknown`，页面用结果里保存的绝对路径再调一次 `show_in_viewer` 取得新句柄。
- 单个文档上限 100 MiB，超出返回 `document_too_large`。
- 模型拿到的 `show_in_viewer` 结果只是一句文字（文件名与页数），要看页面内容仍用 `render`。

### 3. 页面

- 连续滚动，只渲染可见页附近的页面；默认适应宽度，可放大缩小；显示当前页与总页数，可跳页。
- 页面外框跟随宿主主题（`hostContext` 样式变量），纸面保持白底。
- 同一标签再次收到工具结果时切换到新文档，模型改完文档再调一次 `show_in_viewer` 就能看到新版本。
- 不显示说明文字；出错时只显示错误本身（例如找不到 LibreOffice）。

### 4. 技能

不另建技能，取代分期第 4 项「加上对应的查看器技能」的写法：查看器只是现有技能的一个步骤，单独成技能会多占技能目录。四个插件现有的技能各加一小节：创建或编辑完文档后，调用 `show_in_viewer` 让用户在面板里查看；用户说「打开」「给我看看」某个文档时也用它。

### 5. 后果

- 表格查看器按单页工作表导出 PDF（`SinglePageSheets=true`，每工作表一页、贴合内容尺寸），宽表不再被拆到多页；以后需要时再给表格单独做网格视图。
- 查看 Office 文档需要本机装有 LibreOffice，转换一次通常要几秒；PDF 不需要。
- 每个插件多一个模型可见的工具。

### 6. 实现约定

- **`read_document` 单块上限**：`4 MiB`（`4,194,304` 字节）。经由 `@nocturne/mcp` `StdioPipeTransport`（单行 JSON-RPC 上限 8 MiB，`packages/mcp/src/transport.ts`）+ RPC 链路实测，1 MiB 与 4 MiB（base64 仅存一份于 `structuredContent.data`，单行约 5.33 MiB）稳定往返，8 MiB（base64 约 10.67 MiB）触达 8 MiB 上限断连。
- **`pdfjs-dist` 版本与工厂**：`pdfjs-dist@6.5.438`（Apache-2.0，2026-11-01 发布，无 `eval` / `new Function`）。主线程通过自定义 `BinaryDataFactory`（`useWorkerFetch: false`、`disableWorkerRendering: true`）按 `kind`（`cMapUrl` / `standardFontDataUrl` / `wasmUrl`）经 `viewer_asset` 获取资源，不触发任何网络请求。
- **Worker 路径**：构建时将 `pdf.worker.min.mjs` 打包为经典 IIFE 脚本内联进 `viewer.html`，运行时通过经典 `new Worker(URL.createObjectURL(blob))` 启动真实 blob Worker 并将 `port` 传入 `PDFWorker`（`sandbox="allow-scripts"` 的 opaque origin 下 Chromium 拒绝 `{ type: "module" }` 的 blob Worker，经典 blob Worker 在真实 Windows WebView2 中稳定走通）；创建失败或超时时通过内联 `<script>` 退回 pdf.js 主线程模式。
- **打包资源清单**（仅打包 MIT / Apache-2.0 / BSD 合规文件，写入 `viewer-assets/manifest.json`）：
  - `cmaps/*.bcmap`（168 个，1,165,667 字节，BSD-3-Clause）；
  - `standard_fonts/Foxit*.pfb`（10 个，200,615 字节，BSD-3-Clause）；`LiberationSans-*.ttf`（4 个，GPL-2.0-only with font exception）与 `iccs/CGATS001Compat-v2-micro.icc`（CC0-1.0）因不在允许许可范围内未打包；
  - `wasm/jbig2.wasm`（103,671 字节，BSD-3-Clause + Apache-2.0）与 `wasm/openjpeg.wasm`（220,817 字节，BSD-2-Clause + BSD-3-Clause）；
  - 共用 `viewer.html`：约 2.07 MiB（2,171,011 字节，低于 8 MiB 上限）。

## 修订：2026-11-21 内置插件「插件创建器」与校验规则共用

新增内置插件 `plugin-creator`（`nocturne:plugin-creator@builtin`，显示名「插件创建器」），随四个文档插件一起由 `plugins-src/` 构建到 `plugins/plugin-creator/` 并打包进桌面资源与 `nctrn` npm 包，默认开启：

- **组成**：
  - 技能 `plugin-creator`（附 `references/manifest-spec.md`、`references/hooks-and-mcp-examples.md`、`references/install-update-uninstall.md`）：引导模型先问清目标与试用例子，在工作区编写 Nocturne 自有插件源码，调用 `check_plugin` 校验并自测，再给出桌面端「安装插件…」与启用、试用步骤；不自动安装、不修改 `plugins.json` 或 `<NOCTURNE_HOME>/plugins/installed/`，交付时如实标注「待安装、待启用、待试用」。
  - 按需启动的 stdio MCP 服务器 `plugin-creator`（`server.mjs`，不含文档查看器资源），仅提供一个只读工具 `check_plugin`（`readOnlyHint: true`），入参为插件根目录绝对路径 `{ path }`，返回是否可安装、错误、警告、安装后插件 id、版本、技能/Hook/MCP/面板清单、跳过条目原因，以及「安装时才会检查」的项目说明。
- **检查与安装共用一份规则**：
  - 将 `installLocalPluginFiles` 中复制前的全部目录、清单、名称、相对路径与可用能力校验抽出为 `packages/core/src/plugins/check.ts` 导出的纯只读函数 `checkLocalPluginDirectory(platform, options)`，同时经 `@nocturne/core` 与轻量子路径 `@nocturne/core/plugin-check` 导出；
  - `installLocalPluginFiles` 先调用 `checkLocalPluginDirectory`，复制后保留对符号链接跳过导致的清单丢失与能力为空校验；
  - `plugins-src` 通过 `devDependencies` 引用 `@nocturne/core` 的 `@nocturne/core/plugin-check`，在构建 `plugins/plugin-creator/server.mjs` 时直接打入单文件产物，运行时无外部依赖且不复制校验逻辑。
- **桌面入口**：在「设置 › 插件」页头「安装插件…」旁增加「创建插件」按钮，复用 `tryPluginSkill` 新开草稿会话并预填 `/plugin-creator `（不自动发送）；插件创建器关闭或技能不可调用时按钮禁用，界面不加说明文字。

