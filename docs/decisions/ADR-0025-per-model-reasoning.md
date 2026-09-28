# ADR-0025：模型能力来源：接入 models.dev，推理与档位只按模型声明

- 状态：已接受（维护者 2026-09-28 确认：接入 models.dev、取消服务商级思考档位、不迁移旧档位）
- 日期：2026-09-28

## 背景

模型能力（是否支持推理、能否看图、上下文长度、最大输出长度）目前有三个来源：上游 `/models` 声明、内置目录（只有两个 DeepSeek 旧模型）、保守默认。[ADR-0016](ADR-0016-model-limits-from-upstream.md) 定下「以上游为准，不维护内置大表」。

实际使用中，上游经常什么都不声明。维护者的 command code 服务商有 81 个模型，`/models` 每个模型只返回 `id`、`name`、`context_length`、`supported_endpoints`，推理、看图、最大输出一项都没有。按现在的规则，这 81 个模型全部是「不支持推理、不能看图」。

为了弥补这一点，[ADR-0018](ADR-0018-reasoning-effort.md) 加了服务商级思考档位：`/provider thinking` 和添加服务商时向导里的「是否支持思考」写入 providers.json 条目的 `thinking.levels`，这个服务商下所有模型共用。但 command code、opencode、OpenRouter 这类聚合服务，同一个服务商下既有推理模型也有非推理模型，统一设置必然把一部分设错。这也让模型编辑页（[ADR-0024](ADR-0024-model-settings-editor.md)）的「推理」一栏自相矛盾：推理显示为 `none`，却能选思考档位。ADR-0024 为此加了「只有显式 none 才锁档位」的绕弯规则。

另外，`reasoning` 的三个取值中，运行时只判断是否为 `none`，`hidden` 与 `visible` 没有任何区别。

自己维护一张完整的模型表需要随发版更新，新模型出来时总会滞后：维护者用 omp 时就遇到过 DeepSeek-v4.1-Flash 的上下文、推理、看图都显示不出来。

models.dev（opencode 团队维护的开源模型目录，数据在 GitHub 上由社区更新，omp 与 opencode 都在使用）提供 `https://models.dev/models.json`：一个以 `<厂商>/<模型>` 为键的扁平表，每个模型有 `reasoning`、`attachment`、`modalities.input`、`limit.context`、`limit.output` 等字段。DeepSeek-v4.1-Flash 在发布当天（2026-09-10）就已收录。抽查 command code 的 12 个模型全部能找到，但 id 写法不完全一致：有的完全相同（`xai/grok-4.7`），有的只差大小写（`moonshotai/Kimi-K3` ↔ `moonshotai/kimi-k3`），有的缺厂商前缀（`claude-opus-5-5` ↔ `anthropic/claude-opus-5-5`），有的厂商前缀不同（`zai-org/GLM-5.3` ↔ `zhipuai/glm-5.3`）。models.dev 没有思考档位字段。

## 决定

### 1. models.dev 作为能力来源层

- 每个模型字段的取值优先级（高者覆盖低者）：

  ```text
  手写配置 > 用户编辑（userModels）> 上游 > models.dev > 内置目录 > 默认
  ```

  上游放在 models.dev 前面：服务商实际给的上限可能和官方不同（例如压小上下文长度）。
- **取用的字段**：`reasoning` → `capabilities.reasoning`（`true` 为 `visible`，`false` 为 `none`）；`modalities.input` 含 `image` → `capabilities.imageInput`（不用 `attachment`，它还包括 PDF 等文件）；`limit.context` → `contextWindow`；`limit.output` → `maxOutputTokens`。显示名、价格不取：显示名以上游为准，价格因服务商而异。
- **匹配规则**，按顺序取第一个唯一结果：
  1. 完全相同；
  2. 忽略大小写相同；
  3. 去掉 `:free` 这类冒号后缀后，比较最后一段模型名（`/` 之后的部分，忽略大小写），且 models.dev 中只有一个候选。

  有多个候选或都不匹配时，视为 models.dev 没有该模型，不猜。
- **数据来源与缓存**：
  - 添加服务商与刷新模型列表时，顺带拉取一次 `models.json`（超时 10 秒），裁剪为上面几个字段后缓存到 `<NOCTURNE_HOME>/cache/models-dev.json`，带拉取时间。平时启动不联网。
  - 拉取失败时沿用缓存，并在刷新结果里提示一行，不影响刷新本身。
  - 随版本内置一份同样裁剪过的快照，由发布脚本生成，保证首次使用和离线时也有数据。缓存比内置快照新时用缓存。
  - 匹配在加载配置时进行（不写入 providers.json），这样缓存更新后无需重新刷新即可生效，来源也能按层标注。
  - 只是 GET 一个公开文件，不发送任何数据。config.json 的 `modelsDev: false` 关闭联网拉取（仍使用内置快照），给完全离线的用户使用。
- 编辑页的来源标注增加「models.dev」。

### 2. 取消服务商级思考档位

- 删除 `/provider thinking` 命令（CLI 与 TUI）、服务商页操作条上的「调整思考档位」，以及添加服务商时向导里的「是否支持思考」这一步。
- providers.json 条目的 `thinking.levels` 与 `thinking.source` 不再参与合并。`thinking.format`（`openai`/`openrouter`，思考参数的协议格式）不受影响，照旧由预设填写。
- **不迁移**：旧的 `thinking.levels` 不复制到各个模型，否则会把非推理模型也标成支持推理。
- 读到带 `thinking.levels` 的旧条目时，每次启动发一条 `runtime.warning`（code `provider_thinking_levels_ignored`），写明服务商名，并提示「服务商级思考档位已停用，模型能力改由上游与 models.dev 提供，个别模型可在编辑模型里修改」。程序下次写入该条目时（刷新、换密钥、编辑模型等）顺带去掉这两个字段，之后不再提示。

### 3. 推理能力与思考档位只按模型

- 推理能力按第 1 节的层序逐字段取值。另加一条：**没有任何层声明 `reasoning`，但有层声明了非空的 `reasoningEffort`，视为支持推理**，这样只写了档位的手写配置照旧可用。都没有时默认不支持。
- **思考档位只在支持推理时存在**：支持推理时取逐模型声明的 `reasoningEffort`，没有声明时按 ADR-0018 取全部六档；不支持推理时没有档位，忽略所有层声明的档位。
- ADR-0018 的声明链因此变为：逐模型声明 > 支持推理时推导全档 > 无。ADR-0024 第 2 节的「显式 none」规则整段删除，由这条统一规则取代。
- 冲突处理沿用 ADR-0024 已实现的做法：用户编辑把推理设为「否」而手写配置声明了非空档位时，保存校验失败；手写配置自身同时写了推理 `none` 和非空档位时，推理为准，并发 `runtime.warning` 写明文件、服务商和模型。

### 4. 编辑页与行式 CLI

- 「推理」改为「跟随 / 是 / 否」。选「是」存为 `visible`，选「否」存为 `none`。数据层保留三个取值以兼容已有配置，已有的 `hidden` 显示为「是」。
- 思考档位一行只在推理的生效值为「是」时显示。
- 行式 CLI 的 `/provider model` 同样改为 `y`/`n`/`-`，推理为否时不询问档位。
- 模型选择页的 `R`、`I` 标记与详情按新的解析结果显示。

## 后果

- 上游不声明能力的聚合服务，绝大多数模型也能自动得到正确的推理、看图和限额信息，用户只需修正个别模型。
- 新模型的信息随 models.dev 更新，一般在刷新模型列表后就能拿到，不必等 Nocturne 发版。
- 多了一个外部数据依赖：models.dev 的数据有错时会影响显示和行为，但它在上游之下、用户编辑之上都能被覆盖，编辑页也会标明来源。
- 规则简化为「推理为否就没有档位」，编辑页里推理和档位不再矛盾。
- 依赖服务商级档位、且 models.dev 也没收录的模型，会变为不可切换档位，需要在编辑页里设置；启动提示会说明。
- 旧版本写入的 `thinking.levels` 会被新版本清掉，退回旧版本后需要重新设置。
- ADR-0016、ADR-0018、ADR-0024 的部分决定被修改或取代，正文不改，状态行注明。providers.md、provider-setup.md、provider-api.md、config.md、tui.md、cli.md、repository-layout.md、workflow.md（发布时更新快照）需要同步。

## 备选方案

- **自己维护一张完整的模型表**：可控，但要随发版更新，新模型总会滞后，正是 omp 出现过的问题。
- **只靠上游与用户编辑**：不引入外部数据，但上游不声明时，用户要手动编辑几十个模型。
- **models.dev 放在上游之上**：官方数据通常更全，但服务商实际给的上限可能不同，应以实际服务的声明为准。
- **保留服务商级档位，改成「默认推理与档位」**：对聚合服务仍然会统一设错。
- **自动迁移旧档位到所有模型**：会把非推理模型标成支持推理。
- **按过滤条件多选、批量编辑模型**：接入 models.dev 后需要手动修改的模型很少，暂不做；确有需要时作为编辑页的增强另行加入。
- **推理保留 none / hidden / visible 三个选项**：`hidden` 与 `visible` 在运行时没有区别，保留只会增加理解成本。
