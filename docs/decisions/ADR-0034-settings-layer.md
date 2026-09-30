# ADR-0034：设置层与 `/settings` 页

- 状态：已接受（维护者 2026-10-01 确认）
- 日期：2026-10-01

## 背景

[v0.5 路线图](../roadmap/roadmap.md)要求一个程序维护的设置层，和手写的 `config.json` 分层合并、手写优先，并提供 `/settings` 页集中管理偏好。后面几项功能都要靠它存设置：智能权限要选安全审计模型和审查器后端，模型角色要存各角色用哪个模型，MCP 服务器管理要能添加和删除服务器。

现状：

- `<NOCTURNE_HOME>/settings.json` 已经存在（ADR-0022 第 3 节），由程序原子写入，读入时保留未知字段。但它**不在配置合并链里**：只有 shell 选择单独合成（`NOCTURNE_SHELL` > `config.json` > `settings.json` > 自动），另外经 `getPreference`/`setPreference` 存 `theme` 这类纯界面偏好（ADR-0029 第 3 节）。
- 默认权限预设和默认思考档位只能手写 `config.json`（`permissions.preset`、`reasoningEffort`）。Alt+M、`/preset`、Shift+Tab、`/effort` 只改当前会话，不会保存。
- 默认模型由 `/model` 页的「设为默认」写进 `providers.json`（v0.3 起向导不再选模型），但设默认模型时不能同时定档位：新会话的档位来自全局的 `reasoningEffort`，与默认模型各管各的。档位是否可用取决于模型，两者分开设置容易出现「默认档位在默认模型上不可用」而被静默降档。
- ADR-0030 的对话框控件已在模型编辑页落地，并说明 `/settings` 将来沿用同一套对话框。

## 决定

### 1. 设置层进入合并链

`settings.json` 作为独立一层，插在用户编辑层与用户配置之间：

```text
内置默认 < models.dev < 向导配置 < 用户编辑 < 程序设置 < 用户配置 < 项目配置 < 环境变量 < 命令行参数
```

- **信任**：与用户配置相同，可信。
- **可写字段白名单**（本 ADR 定义的）：`model`、`reasoningEffort`、`permissions.preset`、`shell`、`shellPath`。以后的 ADR 按需扩充白名单（安全审计模型、模型角色、MCP 服务器等），每次扩充都在对应 ADR 里写明。
- 白名单字段与 `config.json` 用同一套 schema 校验、同一套合并规则（config.md 第 2 节）。任何更高层声明同名字段都覆盖程序设置，所以手写 `config.json` 永远优先，程序仍然不改写 `config.json`。
- **shell 并入通用合并**：`shell`/`shellPath` 不再单独合成，走上面的合并链。顺序与原来等价（程序设置 < 用户配置 < 项目配置 < 环境变量），行为不变。
- **界面偏好不进合并链**：`theme` 这类只有客户端解释的字段继续经 `getPreference`/`setPreference` 存在同一个文件的顶层，Core 不解释它们的含义（ADR-0029 第 3 节不变）。
- **容错**：`settings.json` 是程序写的，损坏或字段无效时忽略该字段（或整个文件）并发出警告，不阻塞启动。这一点和 `config.json` 解析失败直接报错不同，理由是用户没有手动编辑过它，不应该因为它启动不了。
- 白名单外、又不是界面偏好的字段原样保留，不参与合并。
- **默认模型改存设置层**：`model` 从此由程序写进 `settings.json`，不再写 `providers.json`。`providers.json` 里已有的 `model` 仍作为向导层读取（旧数据兼容），但设置层高于它，一旦在新版本里设过默认模型就以设置层为准。

### 2. 默认模型与默认档位成对设置

- 默认模型和默认档位是**一对**：「设为默认」时同时确定档位，两者在一次原子写入里保存到 `settings.json` 的 `model` 与 `reasoningEffort`。
- **`/model` 页**：右栏 `Enter` 后的选项条仍是 `[仅本会话] [设为默认]`。选「设为默认」后，若该模型声明了可用档位，选项条原地换成档位选择（`off` 加该模型的可用档位，`←`/`→` 选择、`Enter` 确认、`Esc` 返回上一步）。预选值依次取：当前会话档位（该模型支持时）、已保存的默认档位按该模型就近降档后的结果、`off`。模型没有可用档位时跳过这一步，并清除保存的默认档位。
- 确认后：保存这一对默认值，同时把当前会话切到该模型与该档位（与现在「设为默认」同时切换当前会话的行为一致）。
- `/settings` 页里默认档位可以单独调整，可选值按**默认模型**的可用档位列出；默认模型本身只读，修改去 `/model` 页。

### 3. Core 接口

`Runtime` 新增三个方法，`createRuntime` 未注入 `RuntimeConfig` 时与现有偏好接口一样：读取返回空，写入返回被拒绝的 Promise。

```ts
describeSettings(): SettingItem[]
updateSettings(patch: SettingsPatch): Promise<SettingItem[]>
setDefaultModel(model: string, reasoningEffort: ReasoningEffort | null): Promise<SettingItem[]>

interface SettingItem {
  key: "permissions.preset" | "reasoningEffort" | "shell" | "defaultModel"
  /** 合并后的生效值 */
  effective: string | undefined
  /** 生效值来自哪一层 */
  source: "default" | "setup" | "settings" | "user" | "project" | "env" | "cli"
  /** settings.json 里保存的值；未保存时 undefined */
  saved: string | undefined
  /** 保存值被更高层覆盖时为 true（界面据此提示「已保存但不生效」） */
  overridden: boolean
  /** 只读项（defaultModel），不能经 updateSettings 修改 */
  readonly?: true
}

type SettingsPatch = Partial<{
  "permissions.preset": PermissionPresetName | null   // null 表示清除，回到默认
  reasoningEffort: ReasoningEffort | null
}>
```

- `updateSettings` 先按 schema 校验，原子写盘成功后才更新内存中的合并结果，失败时旧值不变。
- shell 仍用现有的 `setShell` 写入（它要先探测可执行文件是否存在），不走 `updateSettings`。`describeSettings` 里的 `shell` 项只读地反映结果。
- `defaultModel` 在 `describeSettings` 里是只读项，不能经 `updateSettings` 修改；修改走 `setDefaultModel`，它把模型与档位一起原子写入（`null` 档位表示清除）。现有 `RuntimeConfig.setDefaultModel(model)`（写 `providers.json`）被它取代。
- `updateSettings` 修改 `reasoningEffort` 时，按生效的默认模型校验档位是否可用，不可用时拒绝并列出可选值。
- **生效时机**：默认模型、默认档位和默认预设只影响**之后新建的会话**。例外是 `/model` 页的「设为默认」本身就是一次显式切换，会同时切换当前会话（第 2 节）；`/settings` 页里的修改不改变当前会话。当前会话继续用 Alt+M、`/preset`、Shift+Tab、`/effort` 切换。这样「默认值」和「当前会话值」的含义清楚，不会出现 Turn 进行中改默认值导致当前会话突变。

### 4. 授权数据保护

`settings.json` 现在能设置默认权限预设（包括 `full-access`），应当和 `config.json` 同等保护：

- 把 `<NOCTURNE_HOME>/settings.json` 加入 permissions.md 第 6 节的「Nocturne 授权数据」组，对它的 `edit` 至少 `ask`（`read-only` 下保持 `deny`），标签同为「修改 Nocturne 授权配置」。
- 与该组其他文件一样，这是提示而不是安全边界：`--yes` 与 `full-access` 下的 `shell` 仍可绕过（权限不是沙箱）。

### 5. `/settings` 页（TUI）

- 全屏页面（与 `/theme` 相同的整帧替换方式），沿用 ADR-0030 的对话框框架与控件，全屏模式开放鼠标单击，`--inline` 在临时备用屏里打开。
- 按分组列出各项，每项一行：名称、当前值、来源标记。

| 分组 | 项 | 控件 | 保存到 |
|---|---|---|---|
| 会话默认 | 默认权限预设 | 分段按钮（4 个预设 + 「跟随默认」） | `settings.json` 的 `permissions.preset` |
| 会话默认 | 默认模型 | 只读，显示「在 /model 页设置」 | — |
| 会话默认 | 默认思考档位 | 分段按钮（`off` 与默认模型的可用档位） | `settings.json` 的 `reasoningEffort` |
| 界面 | 主题 | 分段按钮（深色 / 浅色），`Enter` 可进入 `/theme` 预览 | 偏好 `theme` |
| 执行 | Shell | 显示当前值，`Enter` 打开现有 shell 选择器 | `setShell` |

- **来源标记**：值来自程序设置显示「设置」，来自手写文件显示「config.json」或「项目配置」，来自环境变量或命令行显示对应名称，未设置显示「默认」。某项被更高层覆盖时，该行显示「已保存，但被 config.json 覆盖」，与现在 `/shell` 选择页的提示一致。
- **保存方式**：沿用 ADR-0030 的草稿模式，改动先进入草稿，底部「保存」一次写入，「取消」或 `Esc` 丢弃；有未保存改动时 `Esc` 弹出现有的放弃确认。主题例外：切换时立刻预览，取消时恢复。
- 页面顶部一行说明：「默认值对新会话生效；当前会话用 Alt+M 切换权限、Shift+Tab 切换思考档位」。
- 保存失败时保留草稿，并在底部显示错误。
- 本轮不做的项（安全审计模型、审查器后端、模型角色、MCP 服务器）不显示占位，由各自的 ADR 加入。
- 现有命令保留：`/theme`、`/shell`、`/preset`、`/effort` 行为不变，`/settings` 是集中入口。

### 6. 逐行 CLI

- `/settings` 打印各项的生效值、来源与覆盖提示，格式与 TUI 分组一致。
- `/settings preset <名称|reset>`、`/settings effort <档位|reset>` 修改对应项，`reset` 清除保存值；其余项提示去对应命令（`/shell`、`/model`、`/theme` 仅 TUI）。
- 非法值以 `invalid_command` 拒绝并列出可选值。

## 验收

- **Core**：
  - 合并顺序：程序设置高于用户编辑、低于 `config.json`、项目配置（已信任时）、环境变量与命令行；
  - 白名单外字段不参与合并且原样保留；界面偏好读写不受影响；
  - 损坏文件、无效字段的降级与警告；
  - `describeSettings` 的生效值、来源、保存值与覆盖标记在各种层组合下正确；
  - `updateSettings` 校验、原子写入、失败时旧值不变、`null` 清除；
  - 新会话使用保存的默认模型、档位与预设，已有会话不受影响；
  - `setDefaultModel` 一次写入模型与档位、`null` 清除档位；旧 `providers.json` 的 `model` 仍被读取，设置层存在时以设置层为准；
  - `updateSettings` 拒绝默认模型不支持的档位；
  - shell 合并改走通用链后，现有 shell 选择测试全部照常通过；
  - `settings.json` 的 `edit` 在各预设下至少 `ask`（`read-only` 下 `deny`）。
- **TUI**：`/model` 页「设为默认」后的档位选择步骤（预选规则、无档位模型跳过、`Esc` 返回）；`/settings` 页的键盘操作、鼠标单击、草稿保存与取消、放弃确认、覆盖提示、保存失败保留草稿、窄终端与 ASCII/NO_COLOR 退化；主题即时预览与取消恢复；从页面进入 shell 选择器和 `/theme` 后返回。
- **CLI**：`/settings` 列表、`preset`/`effort` 修改与 `reset`、非法值提示。
- **维护者手测**：在 Windows Terminal 里打开 `/settings`，深浅主题下检查布局；在 `/model` 页「设为默认」并选档位，再 `/new`，确认新会话使用该模型与档位；改默认预设后 `/new`，确认新会话使用新预设。
- **文档同步**：
  - [config.md](../architecture/config.md)：分层表加入程序设置层、白名单、容错、`describeSettings`/`updateSettings`/`setDefaultModel`，默认模型改存设置层，shell 合成改为通用合并；
  - [provider-setup.md](../architecture/provider-setup.md)：`providers.json` 不再写 `model`；
  - [permissions.md](../architecture/permissions.md)：授权数据组加入 `settings.json`；
  - [tools.md](../architecture/tools.md) 第 6 节 shell 工具的「shell 选择」段：合成说明改为通用合并；
  - [tui.md](../apps/tui.md)、[cli.md](../apps/cli.md)：`/settings` 页与命令、斜杠命令表；
  - ADR-0022 加修订条目说明 shell 合成方式的变化；
  - 路线图条目、[decisions/README.md](README.md)、[docs/README.md](../README.md)。

## 后果

- **正面**：
  - 默认预设和默认档位不必手写 JSON，能在界面里改；
  - 默认模型和档位成对设置，不会再出现默认档位在默认模型上不可用的情况；
  - 以后的设置项（安全审计模型、模型角色、MCP 服务器）有了统一的存放位置、接口与页面；
  - shell 不再是特例，合并规则只有一套。
- **负面**：
  - 同一字段可能同时出现在 `settings.json` 和 `config.json` 里，用户需要借助来源标记才能看懂哪个生效；
  - 默认值只对新会话生效，用户改完可能以为当前会话也变了（页面顶部的说明用来减少这种误解）。
- **约束**：
  - 程序只写 `settings.json`，永远不改写 `config.json`；
  - 新增可写字段必须经 ADR 扩充白名单，不能随手往 `settings.json` 里加；
  - 能影响权限的设置文件都属于授权数据，受第 3 节的保护。

## 备选方案

- **程序直接改写 `config.json`**：只有一个文件，最直观，但会破坏用户手写的格式和排版，也违背「程序从不改写 config.json」这条已有约定（config.md 第 1 节）。
- **设置层高于 `config.json`**：界面改了就一定生效，但手写配置被程序悄悄覆盖，排查困难；路线图已定手写优先。
- **每项改动立即保存**：少一步操作，但和 ADR-0030 的对话框保存模式不一致，以后多字段的设置（如审查器的地址、密钥、阈值）需要一起保存和校验，立即保存不合适。
- **默认值同时应用到当前会话**：少一次 `/new`，但 Turn 进行中改默认值时，当前会话要么突变，要么排队等 Turn 结束，行为不好预测；当前会话已有专门的切换键。
- **默认档位与默认模型分开设置（现状）**：档位依赖模型，分开设置时一方变了另一方可能失效，只能静默降档。
- **把默认模型也做成可编辑项**：会和 `/model` 页的「设为默认」形成两个入口，而且模型选择需要列表和搜索，放在设置页里重复实现不划算。
