# ADR-0024：模型设置编辑页：逐模型用户覆盖取代 `/provider image`

- 状态：已接受（维护者 2026-09-28 确认）；第 2 节「显式 none」规则被 [ADR-0025](ADR-0025-per-model-reasoning.md) 的「推理为否就没有档位」取代；编辑页第七个字段「协议」见 [ADR-0026](ADR-0026-per-model-protocol.md)
- 日期：2026-09-28

## 背景

[ADR-0023](ADR-0023-image-input.md) 第 1 节为图片输入新增了用户声明入口 `/provider image <服务商> <模型> on|off`，写入 providers.json 条目的 `userCapabilities`。实现后维护者指出这个入口只解决了一个字段。上游 `GET /models` 没声明或声明错的，其实还包括上下文长度、最大输出长度、推理能力和可用思考档位（[ADR-0016](ADR-0016-model-limits-from-upstream.md)、[ADR-0018](ADR-0018-reasoning-effort.md)）。照这个做法，每个字段都要加一条命令。常见 Agent 的做法是给每个模型一个编辑页，用户能看到当前值并逐项修改。

约束：

- 程序永远不改写 config.json（[ADR-0015](ADR-0015-provider-setup-credentials.md)）；用户的手写配置永远优先。
- `/provider refresh` 只重写上游列表，不能覆盖用户的修改。
- 服务商页的交互规范沿用 [ADR-0019](ADR-0019-tui-visual-provider-page.md)：是非题和多选都用方向键加空格/Enter 完成，不用键入 y/N；数字等自由值可以键入。
- `userCapabilities` 与 `/provider image` 只存在于本地未发布的提交中，没有已发布的数据需要迁移。

## 决定

### 1. 存储：`userModels` 取代 `userCapabilities`

providers.json 的服务商条目新增 `userModels`，按模型 id 存放用户修改过的字段。只记录用户改过的字段，没改的不出现：

```jsonc
"userModels": {
  "<模型 id>": {
    "displayName": "…",
    "contextWindow": 1000000,
    "maxOutputTokens": 128000,
    "capabilities": {
      "reasoning": "visible",          // none | hidden | visible
      "imageInput": true,
      "reasoningEffort": ["low", "medium", "high"]  // 空数组 = 明确无可用档位
    }
  }
}
```

- 可编辑字段就是上面六项。`toolCalls`、`parallelToolCalls`、`promptCache` 不提供编辑：运行时目前没有代码读取它们，改了也不起作用；Nocturne 本身也离不开工具调用。`pricing` 只用于显示，不提供编辑。
- `userCapabilities` 字段、`saveSetupImageInput` 与 `/provider image` 命令一并删除。
- `/provider refresh` 只重写 `models`，`userModels` 不受影响。用 `/provider add` 重新添加同名服务商时保留原有的 `userModels`。
- `/provider remove` 删除服务商条目时，该条目的 `userModels` 随条目一起删除（它本来就存在条目里），不单独保留。
- 上游后来删除了某个模型时，`userModels` 中对应的条目保留，不报错，也不自动删除；只要合并结果里没有这个模型，它就不起作用。
- 只能编辑服务商模型清单里的模型。清单外的模型在编辑页里看不到，Core 接口也会拒绝（`config_invalid`）。

### 2. 合并：逐字段取值，来源可解释

每个可编辑字段的取值优先级（高者覆盖低者）：

```text
手写配置   config.json / 项目 / 环境变量 / 命令行 等更高层的 models.<id>.<字段>
  > 用户编辑   providers.json 的 userModels.<id>.<字段>
  > 上游       providers.json 的 models.<id>.<字段>（向导或 refresh 写入）
  > 内置       内置模型目录
  > 默认       保守默认（contextWindow/maxOutputTokens 未声明，imageInput=false，reasoning="none"）
```

`reasoningEffort` 在"上游"之后还沿用 ADR-0018 第 2 节的后续环节：服务商级 `thinking.levels` > `reasoning ≠ "none"` 推导全档（例外见下文「推理能力与思考档位」）。

**`models.<id>` 的跨层合并从"整条替换"改为逐字段合并**（`capabilities` 内部同样逐键合并）。原规则下，config.json 只要写了某个模型的一个字段，就会整条替换向导层的该模型条目，其余字段的上游值会随之丢失。这既违背"只覆盖手写了的字段"的直觉，也让下面第 3 节的来源标注无法按字段成立。改为逐字段合并后，手写配置只覆盖它实际写出的字段。[config.md](../architecture/config.md) 第 2 节的合并表随之更新。

- **数组整体替换**：逐字段合并只下钻到对象；数组值（`reasoningEffort`）由较高层整体替换，不做并集。例如手写了 `["high"]`，结果就是 `["high"]`，不会和上游或用户编辑的档位合并。显式空数组同样整体生效（明确无档位）。
- **实现方式**：`userModels` 作为**独立的一层**参与分层合并，位置紧跟在向导层（providers.json 的 `models`）之后、用户级 config.json 之前：由向导层条目的 `userModels` 派生出一个只含 `providers[].models` 的合成层，与其他层走同一套逐字段合并。ADR-0023 实现中 `mergeLayers` 里的"向导层投影 + 合并后回填"逻辑（`projectSetupUserCapabilities` 等）整体删除，不在其上修补。合成层只作用于合并结果里存在的模型，不会为清单外模型新增条目（与第 1 节一致）。

**推理能力与思考档位**：推理能力（`reasoning`）被**显式**声明为 `none` 时，思考档位一律视为不可切换，不再从服务商级 `thinking.levels` 继承，也不采用任何层的逐模型档位声明。"显式"指生效值来自用户编辑或手写配置；来自内置目录或保守默认的 `none` 不算显式，仍按 ADR-0018 的声明链继承 `thinking.levels`。区分的原因是：内置目录和保守默认对大多数模型都给出 `reasoning: "none"`，ADR-0018 的 `/provider thinking` 正是为这类上游未声明思考能力的模型准备的，把规则扩到它们身上会让服务商级档位声明失效。实现上，合并结果中若 `reasoning` 由用户编辑层或手写层给出且为 `none`，就把该模型的 `capabilities.reasoningEffort` 置为空数组，交给 ADR-0018 声明链现有的"逐模型显式空数组 = 明确无档位"规则处理，provider 层不需要新增分支。界面上：推理为显式 `none` 时，思考档位一项显示「推理为 none，不可切换」且不可编辑；在推理为 `none` 的同时保存非空的用户档位属于校验失败，不予保存。

这条规则不能让用户编辑压过手写配置，两种冲突分别处理：

- **用户编辑的 `none` 与手写的非空档位冲突**：用户编辑把推理设为 `none`，而思考档位由手写配置给出非空值时，如果按"显式 `none` 优先"处理，用户编辑就压过了手写配置，违背"手写配置永远优先"。因此这种保存**校验失败**，提示「思考档位由 config.json 决定，不能把推理设为 none」（按实际层级与文件替换）。校验一律看保存后各字段合并出的**最终生效值**，不只看本次编辑的字段，与第 4 节"最大输出不超过上下文长度"的处理方式一致。
- **手写配置自身矛盾**：同一模型在手写配置中推理为 `none`、档位又非空，这是用户自己写出的矛盾。按"显式 `none` 优先"处理（档位不可切换），同时产生一条配置警告，与现有配置警告（如无效 `shellPath`）走同一通道，在会话中以 `runtime.warning` 展示。警告写明文件路径、服务商与模型 id，不静默处理。

### 3. 来源标注与只读规则

Core 提供只读查询，按字段返回 `{ value, source, editable }`。`source` 取以下之一：`upstream`（上游）、`user`（用户编辑）、`config`（手写配置，附定义它的文件）、`builtin`（内置）、`default`（默认）。

- 来源只按**实际参与合并的层**计算，与合并使用同一份层列表。未受信任的项目配置会被整体忽略（[ADR-0008](ADR-0008-project-trust-grants.md)），它写的字段不会标成「由项目配置决定」，也不会让编辑页把字段设成只读。
- 某个字段由更高层的手写配置决定时，这一项在编辑页**只读**，并注明「由 config.json 决定」（或实际的层级与文件）。这样可以避免用户改了之后发现不生效。
- 整个服务商都不在 providers.json（完全手写在 config.json 等高层）时，编辑页只能查看，同时提示去改对应的配置文件。
- 程序永远不改写 config.json。

### 4. TUI：服务商页新增「编辑模型」

- 已配置服务商的操作条增加「编辑模型」：打开该服务商的模型列表（可过滤），Enter 进入编辑页。
- 编辑页每行显示字段名、当前生效值和来源标注。
  - 数字字段（上下文长度、最大输出）可键入。**清空输入框表示不做用户编辑**，保存后回落到上游或更低层的值。
  - 图片输入与推理能力用 `←`/`→` 在「跟随（显示下层值）/ 各取值」之间切换；选「跟随」即清除用户编辑。
  - 思考档位用 ADR-0019 的多选勾选，首项「跟随」与其余选项互斥（选中表示清除用户编辑），另有「不支持思考强度」表示明确无档位（空数组）。
  - 只读字段显示为灰色，光标跳过。
- 保存前校验，不通过就不保存，并在页内提示原因：
  - 上下文长度、最大输出必须是正整数；
  - 最大输出不能大于上下文长度，比较的是保存后两者的**生效值**（任一方未声明时不比较）；
  - 推理为 `none` 时不能保存非空的思考档位；思考档位由手写配置给出非空值时，不能把推理设为 `none`（第 2 节）。
  - 所有校验都针对保存后合并出的最终生效值，而不只是本次编辑的字段。
- 保存后与 `/provider thinking` 一样调用 `updateProviders`：已打开的会话在下一个空闲边界采用新值。

### 5. 行式 CLI：`/provider model <服务商> <模型>`

行式 REPL 没有全屏页，改用逐行问答，每行显示当前值与来源：

- 直接回车：**保留**当前值（不改变用户编辑状态）；
- 输入 `-`：**清空**用户编辑，回落到上游或更低层的值（对应 TUI 里清空输入框或选「跟随」）；
- 其他输入按字段解析：数字字段为正整数；图片输入为 `y`/`n`；推理为 `none`/`hidden`/`visible`；思考档位为逗号分隔的档位名，或 `none` 表示明确无档位。
- 只读字段只显示、不提问；校验规则与 TUI 相同，失败时不保存并提示原因。

### 6. 与既有 ADR 的关系

- ADR-0023：第 1 节的声明入口（`/provider image`、`userCapabilities`）被本 ADR 取代；`imageInput` 的来源优先级不变，只是"用户声明"这一层改由 `userModels` 承载。其余各节不受影响。
- ADR-0016：限额"以上游声明为准"不变；本 ADR 在上游之上增加用户编辑层，用于上游未声明或声明有误的情况。
- ADR-0018：档位声明链的结构不变；逐模型声明现在也可以来自用户编辑（`userModels.<id>.capabilities.reasoningEffort`），位置在手写逐模型声明与服务商级 `thinking.levels` 之间。新增一条约束：推理能力被显式声明为 `none` 时档位不可切换（第 2 节），借用链上现有的"逐模型空数组"表达。
- 按 [ADR 规矩](README.md)，上述三个 ADR 的正文不改，只在状态行和索引里注明与本 ADR 的关联。

## 后果

- 上游缺失或错误的模型信息，用户可以在一个页面里逐项修正，不用手写 config.json，也不用记多条命令。
- 每个字段都能说明值从哪里来；手写配置决定的字段不可编辑，"改了不生效"的困惑从界面上就能看出来。
- `models.<id>` 改为逐字段合并是可观察的行为变化：config.json 里只写了部分字段的模型条目，其余字段不再丢失上游值，而是继承上游。这在语义上更合理，但属于行为变化，需要在 config.md 与变更说明中写明。
- 编辑页和来源查询增加了 Core 与 TUI 的代码量；来源查询需要逐层读取配置，而不是只用合并结果。
- 行式 CLI 的 `/provider model` 是交互式问答，非交互环境（`-p`）下不可用，与 `/provider add`、`/provider thinking` 一致。

## 备选方案

- **保留 `/provider image`，其他字段各加一条命令**：实现最简单，但命令会越来越多，用户也看不到当前值和来源。
- **编辑页直接写 providers.json 的 `models`**：`/provider refresh` 会整体覆盖它；还要给每个字段打"用户改过"的标记，不如单独一个 `userModels` 清楚。
- **保留 `models.<id>` 整条替换，只对用户编辑逐字段回填**：改动更小，但来源标注会出现"手写了一个字段，其余字段的上游值丢失、显示为内置或默认"的情况，用户难以理解。
- **允许编辑清单外的模型**：会为清单外的模型创建条目，把原本不严格的模型清单变成严格清单。用户想用的模型本应先出现在清单里（`/provider refresh`），编辑清单外的模型没有实际需求。
- **提供 `toolCalls` 等开关**：运行时不读取这些位，开关不会有任何效果，只会误导用户。
