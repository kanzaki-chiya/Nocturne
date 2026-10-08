# 技能（Agent Skills）

> 状态：已实现 ｜ 决策：[ADR-0048](../decisions/ADR-0048-skills.md) ｜ 公开契约：[RPC](../protocols/rpc.md)、[事件](../protocols/events.md)

## 1. 发现与格式

Runtime 在打开会话时读取一份技能快照。按以下顺序搜索，每个根目录只扫描下一层包含 `SKILL.md` 的子目录：

发现结果在单 Runtime 内按现有扫描参数（用户主目录、nocturneHome、workspaceRoot、cwd、来源开关与 extraDirs 顺序）缓存；当前发现规则不使用信任状态。复用前对全部来源目录、技能入口/真实目录与 SKILL.md（含缺失路径及失败条目）做 stat，mtime/size/type 未变才复用，不重复读正文；任一变化重新扫描，目录 mtime 检出新增删除，缺失路径变为存在也失效。配置、导入与启停仍走既有刷新路径与扫描验证，目录输出与预算规则不变。

1. 用户：`<NOCTURNE_HOME>/skills`、`~/.agents/skills`、`~/.claude/skills`、`skills.extraDirs`（配置中的顺序）。
2. 项目：从 `cwd` 上溯到 `workspaceRoot`，每一级依次搜索 `.nocturne/skills`、`.agents/skills`、`.claude/skills`。

用户层优先于项目层，项目内部离 cwd 最近的优先；名字不区分大小写。不同目录同名时保留全部条目，低优先级条目带 `shadowedBy`，不加载。同一真实目录的 symlink/junction 入口按真实路径去重，保留最高优先级来源，其余入口放在 `otherEntries`。项目技能不要求项目信任，规则同项目指令。

`SKILL.md` 使用 YAML 前言和 Markdown 正文；支持 BOM、CRLF、折叠/多行 YAML。解析失败跳过该条，warnings 含入口文件路径、行号和原因，其他技能不受影响。name 缺省取目录名；不符合小写字母/数字/连字符、最多 64 字符的规范只警告。description 缺失时不进入模型目录；when_to_use 接在说明后。

字段与占位符的完整规范以 ADR 第 1 节为准。支持 name、description、when_to_use、disable-model-invocation、user-invocable、argument-hint、arguments。license、compatibility、metadata 和其他未知字段仅展示；allowed-tools、disallowed-tools、model、effort、context、agent、background、hooks、paths、shell 返回忽略原因，不改变运行配置。正文的 `!` 反引号命令及 ` ```! ` 块列为不执行，正文仍交给模型。

## 2. 参数与用户快照

`submit({ text, skill: { name, arguments? } })` 在 Core 验证已启用、未覆盖、允许用户调用且不与内置命令重名。disable-model-invocation 不妨碍用户调用。

正文替换 `$ARGUMENTS`（原始参数）、`$ARGUMENTS[N]` / `$N`（从 0 开始的参数），以及 arguments 声明的 `$name`。参数按空白切分，单/双引号保留包含空白的参数；arguments 可为名字数组、含 name 的对象数组、以名字为键的映射或空白/逗号分隔字符串。未知占位符保留，已声明而未提供的参数替换为空；一次替换，不递归解释参数里的占位符。

`${NOCTURNE_SKILL_DIR}` / `${CLAUDE_SKILL_DIR}` 为技能真实目录，`${CLAUDE_PROJECT_DIR}` 为 workspaceRoot，`${CLAUDE_SESSION_ID}` 为会话 id。有参数而正文没有参数占位符时追加 `ARGUMENTS: …`。

渲染正文追加为用户消息末尾 `<skill name="…">…</skill>` 文本块；message.user 的可选 `skill: { name, body }` 同时供客户端展示。恢复/重放使用日志快照，不重读文件；客户端仅显示原文和可展开的技能标签。

## 3. 模型目录与工具

目录在项目指令之后、环境信息之前。只收集启用、未覆盖、有说明且允许模型调用的技能，按项目层优先、名字排序。每条说明至多 250 Unicode 字符，加省略号；整段预算为 `min(floor(contextWindow × 2%), 8000)` token，估算口径同 ContextReport。放不下完整说明时只列名字；名字也放不下时显示「另有 N 个技能未列出」。ContextReport 的 skills section 记录字符、token 和截断；空目录不注入，也不注册 skill 工具。

`skill({ name, arguments? })` 返回替换后的正文、真实目录及第一层最多 50 个文件/子目录。非 mutating、可并发，结果仍经过普通输出预算。不可用名字返回错误和最接近的三个名字。同一会话、同一渲染内容重复加载只返回「已加载，见前文」；切换模型、启停重建目录保留加载记录，L2 摘要后允许重新加载正文。

工具声明 `pinResult: true` 经 tool.started 写入日志并折叠到历史；L1 据此保留正文，L2 固定提示要求列出已加载技能名。Agent Loop 和 Context 不按工具名分支。

已发现技能的真实目录生成预设 read allow 规则，普通 read 仍走完整权限管线；嵌套链接解析到目录之外时不因此放行。写入、shell 和技能目录外的读取规则不变。子代理默认的 general / explore 工具池含 skill，使用启动时父会话的目录和正文快照，加载记录属于子会话。

## 4. 配置与更新

用户 config.json 的 `skills.sources.{agents,claude}` 默认 true，可分别关闭用户和项目同来源；extraDirs 支持 `~` 展开，相对路径以用户主目录解析。项目配置中的 skills 段一律忽略。settings.json 的 `skills.disabled: string[]` 按名字记录，通过现有写队列保存，对所有同名层生效。

磁盘增删改在下一个会话或配置重载生效；设置页每次打开重新扫描。启停立即保存，空闲会话立即重建，运行中的会话保持当前快照，在 Turn/压缩结束边界应用；正文快照和已发送历史不改写。

## 5. 公开查询

Runtime.describeSkills({ workspaceRoot? }) 重新扫描供设置页使用；RuntimeSession.describeSkills() 返回当前会话快照。setSkillEnabled({ name, enabled }) 返回 affectedSessions。RPC 名称见 rpc.md。

SkillOverview 包含名字、层、来源、入口/真实路径与其他入口、说明全文与目录显示长度、调用方式、目录状态、enabled/shadowedBy、命令冲突/缺说明、支持字段/未知字段/忽略项原因、正文行数/前 40 行、第一层文件清单和 SKILL.md 字节大小。接口不返回全部原始正文。

预算返回 usedTokens、limitTokens、fullCount、nameCount、disabledCount 及 basis。设置页查询优先用所选工作区已打开会话的模型窗口（session-model）；无会话时用默认模型（default-model）；窗口未知时采用 8000 token 上限（fallback），客户端说明依据。停用计数按有效同名技能计，去重入口和被覆盖条目不重复计数。

## 6. 客户端

CLI/TUI 的 `/skills` 只读列出当前快照。三个客户端的斜杠补全将命令放在技能前面，过滤停用、覆盖、user-invocable false 与命令冲突，展示名字、argument-hint 和截断说明；发送走 submit.skill。

内置命令名单是 protocol 导出的 `BUILTIN_SLASH_COMMANDS`，内容为三个客户端命令表的并集（TUI 的 `SLASH_COMMANDS` 全集与桌面的 `COMMANDS` ∪ `REDIRECTS`），发现时据此打 `commandConflict`。三个客户端各有测试断言本端每个斜杠命令都在名单内；新增命令必须同步名单，否则与该命令同名的技能会错误获得斜杠调用资格。

桌面设置页在 MCP 后，按用户/所选工作区项目分组，展示预算、来源、状态、只读覆盖开关、横幅原因表、完整路径、说明截断标记、字段 chips、正文预览及支持文件；解析失败汇总可展开路径与行号。目录按钮由 Rust 打开已有目录，只有 `<NOCTURNE_HOME>/skills` 空态按钮允许创建目录；规范按钮打开 agentskills.io。

## 7. 导入（桌面端）

「设置 › 技能」页的「导入技能」打开导入对话框（ADR-0048 修订 U-08，只做桌面端入口；TUI/CLI 不加导入命令）：

- **来源**：只支持本地文件夹，经系统文件夹对话框选择（Tauri 已有的 dialog 插件，不新增插件或权限）。选中的文件夹本身含 `SKILL.md` 时作为单个技能；否则扫描其下一层子目录，每个含 `SKILL.md` 的子目录算一个技能。zip、Git 地址不做。
- **目标**：用户级 `<NOCTURNE_HOME>/skills/` 或当前工作区 `.nocturne/skills/`，二选一，默认用户级。项目目标只在设置页选中了工作区时可选。
- **预检与执行**：`Runtime.importSkills`（RPC `skills.importSkills`）分两步——`preview` 只扫描校验、不写任何东西，返回候选与冲突；`commit` 按逐项决定写入。commit 走配置写队列，成功后推 `runtime.providersChanged` 并刷新已打开会话的技能目录（空闲立即重建，运行中在 Turn/压缩结束边界应用，与启停规则一致）。
- **校验**：逐项按第 1 节的格式规则检查——前言缺失/未闭合/解析失败、名字不符合小写字母/数字/连字符或超过 64 字符的列出原因并不可勾选；缺少 `description` 的可导入但标注"模型看不到"。只复制文件，不执行其中任何脚本；符号链接逐项跳过并列出相对路径；单个技能总大小上限 1 MiB（`SKILL_IMPORT_SIZE_LIMIT_BYTES`），超过的不可勾选。
- **重名**：目标目录已有同名（大小写不敏感）时逐项选择「改名」（默认，预填 `name-2` 起的可用后缀，同时改写 `SKILL.md` 的 `name`）、「覆盖」或「跳过」。覆盖先复制到目标目录内的临时目录，成功后经备份改名原子替换，失败时旧目录恢复、原技能保持不变。同名技能只存在于其他目录或层时不算冲突，但给出提示（用户层导入将覆盖项目层同名、项目层导入仍被用户层同名覆盖），见预检的 `shadowNote`。
- **启用**：放进目录即启用（停用靠 `skills.disabled`）。结果页逐项显示成功或跳过原因，成功项给「停用」按钮（走 `skills.setSkillEnabled`）。已打开的会话在下一个会话或重载配置后看到新技能。
