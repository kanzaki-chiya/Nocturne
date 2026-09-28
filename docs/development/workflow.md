# 开发流程

> 状态：已接受 v0.2 ｜ 规则摘要见 [AGENTS.md](../../AGENTS.md)，本文是完整版本。

## 1. 顺序：先契约，后代码

```text
研究 → 设计文档 → 接口 / 协议 → 实现 → 测试 → 文档复核
```

- 新增或改变行为前，先确认对应的设计文档是否覆盖；没有覆盖就先补文档，写清楚：规则、状态归属、接口、验收场景。
- 涉及公开接口、事件、工具接口、Provider 接口的修改，先改 `docs/protocols/` 中的对应文档。
- 影响多个模块、难以逆转或有明显取舍的决定，新增 ADR（见 [decisions/README.md](../decisions/README.md)）。

## 2. 文档同步清单

每个改动（以及每个阶段结束时）逐项检查：

- [ ] 代码是否改变了设计？→ 更新 `docs/architecture/` 对应文档。
- [ ] 设计是否改变了协议？→ 更新 `docs/protocols/` 对应文档，并检查演进规则（兼容 / 不兼容）。
- [ ] 是否新增了模块或包？→ 更新 [modules.md](../architecture/modules.md)、[repository-layout.md](repository-layout.md)，包内加简短 README。
- [ ] 是否新增了重要文档？→ 更新 [docs/README.md](../README.md)。
- [ ] 是否需要更新 [AGENTS.md](../../AGENTS.md) 中的阅读清单？
- [ ] 是否产生了需要 ADR 的决定？
- [ ] 用户可见行为是否变化？→ 更新 README 或用户文档中的用法说明。

**实现与文档不一致时**，不能默认代码是对的。必须二选一并写明原因：修改实现使之符合文档；或正式修改文档（重大变化配 ADR）。

## 3. 文档写作规则

- 一个概念一个主文档；其他地方一句摘要 + 链接。
- 渐进披露：总览只讲是什么和去哪里找；细节在模块文档；精确字段在协议文档。
- 每篇文档开头写明状态、前置阅读与相关文档。
- 描述当前设计与已排期的计划；不写"以后也许"的长篇设想。明确不做的事写在"暂不设计"一节即可。
- 研究记录放在 `docs/research/`，注明是快照，不作为约束来源。

## 4. 测试要求

- 修改代码 → 运行相关测试 → 必要时补充或更新测试 → 检查对应文档。
- Agent Loop、会话恢复、权限求值、Provider 流式归一化必须有测试覆盖，包括失败路径：
  - Agent Loop：Provider 错误与重试、各种结束原因（`length`、`content_filter`、意外原因）、工具失败、权限拒绝、"拒绝并停止"、中断；每个出口都满足"每个调用恰好一个 `tool.completed`"；
  - 会话：损坏尾部截断、中间损坏拒绝打开、两个进程同时恢复、写入失败进入 `failed`、未结算调用与未结束 Turn 的修复、版本高于自身时拒绝恢复；
  - 权限：不可信项目规则只能收紧、Grant 不能改变 deny、符号链接与 `..` 逃逸、枚举结果过滤、shell 组合命令；
  - 压缩：边界不拆分工具调用对、多次压缩叠加、摘要失败与必须压缩时失败。
- Agent Loop 的测试使用脚本化的假 Provider，不访问真实模型服务；真实 Provider 的冒烟测试单独运行，不进入默认测试集。
- 涉及文件系统与子进程的行为需考虑 Windows、macOS、Linux 差异；无法在当前平台验证的，在变更说明中如实写明。
- 代码、测试、文档三者冲突时必须显式指出，不得静默跳过或修改测试迁就实现。

## 5. 验证命令

在仓库根目录运行（以 `package.json` scripts 为准）：

```bash
pnpm install        # 安装依赖
pnpm typecheck      # tsc --noEmit（src 与 test 两套 tsconfig）
pnpm lint           # eslint（strictTypeChecked + stylisticTypeChecked）
pnpm format:check   # prettier --check；修复用 pnpm format
pnpm test           # vitest run，默认测试集：完全离线，不依赖网络/API key/外部服务
pnpm depcheck       # dependency-cruiser 依赖方向检查（modules.md 依赖图固化为规则）
pnpm build          # tsdown 构建 packages/core/dist
```

真实 OpenAI 兼容服务冒烟测试与默认测试集分离，不进 `pnpm test`：

```bash
# 需要环境变量（凭据只从环境变量读取）：
#   NOCTURNE_SMOKE_BASE_URL  例如 https://api.deepseek.com/v1
#   NOCTURNE_SMOKE_API_KEY   服务凭据
#   NOCTURNE_SMOKE_MODEL     模型 id，例如 deepseek-chat
pnpm test:smoke     # vitest run --config vitest.smoke.config.ts；未设置时跳过
```

这三个变量也可以写在仓库根目录的 `.env`（`KEY=value` 格式，已被 `.gitignore` 忽略，不得提交）；冒烟配置启动时加载它，已设置的环境变量优先。冒烟测试覆盖纯文本 Turn、`read` 工具、假 MCP 服务器 `echo` 工具、子代理往返，均在临时生成的工作区中运行。若另设 `NOCTURNE_SMOKE_DEEPSEEK_REASONING_MODEL`（同一 OpenAI 兼容端点上支持推理内容的模型 id），还会验证含 reasoning 历史的多轮回传与聊天模板标记不泄漏；未设时该专项跳过，不把普通 DeepSeek 模型误报为推理模型。另设 `NOCTURNE_SMOKE_IMAGE=1`（要求 `NOCTURNE_SMOKE_MODEL` 真能看图）时，会跑读图冒烟：临时工作区写一张小 PNG，让模型用 `read` 读取并回答主色，断言回复命中颜色词；模型不能看图时该用例会失败而非跳过，故默认不开启。

Anthropic 适配器的冒烟用独立变量，与 `NOCTURNE_SMOKE_*` 分离、互不影响：

```bash
#   NOCTURNE_SMOKE_ANTHROPIC_API_KEY   Anthropic 凭据
#   NOCTURNE_SMOKE_ANTHROPIC_MODEL     模型 id，例如 claude-sonnet-4-5
#   NOCTURNE_SMOKE_ANTHROPIC_BASE_URL  可选；缺省用官方端点
#   NOCTURNE_SMOKE_ANTHROPIC_THINKING_MODEL  可选；同端点支持扩展思考的模型 id
```

未设置时跳过；扩展思考模型变量未设置时，只跳过“缺 finish → 催促 → 兜底轮强制 finish”专项。该用例前两轮临时从模型请求中隐藏 `finish` 工具，以稳定触发原有兜底路径；首轮与催促轮仍由真实服务生成带 thinking 的响应，第三轮仍由真实服务接受含历史 thinking 的强制工具请求。只验证到跳过路径时在汇报中如实说明。

Phase 2 的 CLI 冒烟（`apps/cli`）：在临时目录生成一个含失败测试的 fixture 仓库，以非交互模式 `nctrn --yes -p "<任务>"` 驱动真实模型完成"阅读项目 → 定位 bug → 修改文件 → 运行测试 → 报告结果"，断言 fixture 的测试在运行后通过。纯文本回复或只读工具调用不算验收。

仅在不含敏感信息的测试工作区中运行冒烟测试——工作区内容会发送给模型服务。文档改动至少检查所有相对链接可达。

## 6. 许可证与第三方代码

- Nocturne 以 GPL-3.0 发布（见仓库根目录 `LICENSE`）。各包的 `package.json` 使用 `"license": "GPL-3.0-only"`。
- 引入第三方代码、提示词或素材前，确认其许可证与 GPL-3.0 兼容（例如 MIT、BSD、Apache-2.0 可以并入；许可证不明或不兼容的不能并入）。
- 从参考项目复制或改写代码时，保留原版权与许可声明；Apache-2.0 来源（如 ZCode、Codex）还需保留其 NOTICE 中适用的内容，并在文件中注明修改。来源记录在根目录 `THIRD-PARTY-NOTICES.md`（首次引入第三方代码时创建）。
- npm 依赖的许可证同样需要与 GPL-3.0 兼容，新增依赖时检查；v0.1.0 直接依赖的许可证核对见根目录 [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md)。

## 7. 安全与隐私

- 文档、示例、测试数据、日志、提交信息中不得出现真实凭据、个人路径或未授权内容；示例使用占位值。
- 凭据只通过环境变量或用户级凭据文件读取，不写入会话日志与事件。
