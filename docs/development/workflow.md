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
pnpm test           # vitest run，默认测试集：完全离线，不依赖网络/API key/外部服务；各包依次运行，TUI 包内限 4 个 worker，避免渲染测试在并行负载下超时
pnpm depcheck       # dependency-cruiser 依赖方向检查（modules.md 依赖图固化为规则）
pnpm build          # tsdown 构建 packages/core/dist
```

core 的默认测试经 `test/setup-offline.ts` 把全局 `fetch` 限制为只能访问本机地址，访问外网直接报错；需要网络行为的用例自行注入 fetch（如 `modelsDevFetch`）或用 `vi.stubGlobal` 桩掉。rpc 包的同名文件还把 `NOCTURNE_HOME` 指向每个测试文件独立的临时目录，测试不得读写维护者的真实数据目录。

发布前手动运行 `node scripts/update-models-dev-snapshot.mjs` 更新随版本内置的 models.dev 裁剪快照；检查生成文件的模型数、大小与变更，再执行完整验证。运行时启动不联网，添加服务商或刷新模型列表才更新本地缓存（[config.md](../architecture/config.md)）。

真实 OpenAI 兼容服务冒烟测试与默认测试集分离，不进 `pnpm test`：

```bash
# 需要环境变量（凭据只从环境变量读取）：
#   NOCTURNE_SMOKE_BASE_URL  例如 https://api.deepseek.com/v1
#   NOCTURNE_SMOKE_API_KEY   服务凭据
#   NOCTURNE_SMOKE_MODEL     模型 id，例如 deepseek-chat
pnpm test:smoke     # vitest run --config vitest.smoke.config.ts；未设置时跳过
```

这三个变量也可以写在仓库根目录的 `.env`（`KEY=value` 格式，已被 `.gitignore` 忽略，不得提交）；冒烟配置启动时加载它，已设置的环境变量优先。冒烟测试覆盖纯文本 Turn、`read` 工具、假 MCP 服务器 `echo` 工具、子代理往返，均在临时生成的工作区中运行。若另设 `NOCTURNE_SMOKE_DEEPSEEK_REASONING_MODEL`（同一 OpenAI 兼容端点上支持推理内容的模型 id），还会验证含 reasoning 历史的多轮回传与聊天模板标记不泄漏；未设时该专项跳过，不把普通 DeepSeek 模型误报为推理模型。另设 `NOCTURNE_SMOKE_IMAGE=1`（要求 `NOCTURNE_SMOKE_MODEL` 真能看图）时，会跑读图冒烟：临时工作区写一张小 PNG，让模型用 `read` 读取并回答主色，断言回复命中颜色词；模型不能看图时该用例会失败而非跳过，故默认不开启。

Core 冒烟配置在加载 `.env` 后自动初始化环境代理：设置 `HTTPS_PROXY` / `HTTP_PROXY` 即可，无需额外设置 `NODE_USE_ENV_PROXY=1`（Node 24.14.0 起；版本与绕过规则见[网络代理说明](../architecture/config.md#网络代理)）。

Anthropic 适配器的冒烟用独立变量，与 `NOCTURNE_SMOKE_*` 分离、互不影响：

```bash
#   NOCTURNE_SMOKE_ANTHROPIC_API_KEY   Anthropic 凭据
#   NOCTURNE_SMOKE_ANTHROPIC_MODEL     模型 id，例如 claude-sonnet-4-5
#   NOCTURNE_SMOKE_ANTHROPIC_BASE_URL  可选；缺省用官方端点
#   NOCTURNE_SMOKE_ANTHROPIC_THINKING_MODEL  可选；同端点支持扩展思考的模型 id
```

未设置时跳过；扩展思考模型变量未设置时，只跳过“缺 finish → 催促 → 兜底轮强制 finish”专项。该用例前两轮临时从模型请求中隐藏 `finish` 工具，以稳定触发原有兜底路径；首轮与催促轮仍由真实服务生成带 thinking 的响应，第三轮仍由真实服务接受含历史 thinking 的强制工具请求。只验证到跳过路径时在汇报中如实说明。

按模型选择协议的冒烟（ADR-0026 §8，`test/per-model-protocol.smoke.ts`）：复用 Anthropic 冒烟的凭据变量，另需一个 Chat Completions 模型 id——

```bash
#   NOCTURNE_SMOKE_ANTHROPIC_API_KEY   双协议网关凭据（两协议共用同一密钥）
#   NOCTURNE_SMOKE_ANTHROPIC_BASE_URL  同时提供 /chat/completions 与 /messages 的网关
#   NOCTURNE_SMOKE_ANTHROPIC_MODEL     Messages 协议模型 id
#   NOCTURNE_SMOKE_MODEL               Chat Completions 协议模型 id（复用 openai 冒烟变量）
```

四个变量齐备才运行（缺一即跳过）：在同一个 `openai-compatible` 条目、同一密钥下，默认协议模型请求 `<baseURL>/chat/completions`，手写 `protocol: "anthropic"` 的模型请求 `<baseURL>/messages`，各跑一轮纯文本对话并断言 `message.assistant.protocol` 分别为 `openai-compatible`/`anthropic`。

OpenCode Go 的三协议冒烟（ADR-0031 §5，`test/opencode.smoke.ts`）用独立变量——

```bash
#   NOCTURNE_SMOKE_OPENCODE_API_KEY            OpenCode Zen/Go 凭据
#   NOCTURNE_SMOKE_OPENCODE_CHAT_MODEL         Chat Completions 模型 id（如 claude-sonnet-4-5）
#   NOCTURNE_SMOKE_OPENCODE_MESSAGES_MODEL     Messages 协议模型 id
#   NOCTURNE_SMOKE_OPENCODE_RESPONSES_MODEL    Responses 协议模型 id
```

四个变量齐备才运行（缺一即跳过）：在 `opencode-go` 预设形态（baseURL + `x-opencode-session` + `modelsDevProvider`）下，三个模型各跑一轮带 `read` 工具调用的对话，断言 `message.assistant.protocol` 分别为 `openai-compatible`/`anthropic`/`openai-responses`、每次请求都写 `x-opencode-session`、不出现网关「缺少 x-opencode-session」报错；Responses 模型额外断言推理加密内容的多轮回传。若某 id 实际不走对应协议（models.dev 接口声明与假设不符）会失败而非跳过，此时应核对 models.dev 对该模型的 `npm` 声明。

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

## 8. 发布

> 决策见 [ADR-0050](../decisions/ADR-0050-distribution.md)。npm 包名 `nctrn`；桌面端 Windows x64 安装包内随附官方 Node.js 并支持自动更新。

### 8.1 常规发布顺序

1. **版本号**：`node scripts/release-version.mjs <version>` 一次改齐所有 `package.json`、`tauri.conf.json`、`Cargo.toml`、`Cargo.lock`、npm 模板，以及源码里的版本常量（core `NOCTURNE_VERSION`、mcp `CLIENT_VERSION`、cli `VERSION`、tui `APP_VERSION`）；重复执行同一版本号不报错；`--check <version>` 只校验不写（流水线用它核对标签）。
2. **CHANGELOG.md**：为 `<version>` 补一节（`## <version>` 标题格式），[release-notes.mjs](../../scripts/release-notes.mjs) 提取该节作为 Release 说明与 `latest.json` 的 `notes`；找不到对应小节会让发布构建失败。
3. **打标签**：审阅变更后 `git tag v<version>` 并推送标签。
4. **流水线**：`.github/workflows/release.yml` 在 windows-latest 上跑完整检查（typecheck / lint / format / depcheck / build / test）、版本一致性校验、`pnpm release:build`（带签名环境变量）、tgz 安装冒烟，然后 `gh release create --draft`（版本号含 `-` 时另加 `--prerelease`）上传 `setup.exe`、`.sig`、`latest.json`、`nctrn-<version>.tgz`；ubuntu-latest 与 macos-latest 仅对 tgz 做安装冒烟，结果追加进草稿说明。
5. **审草稿**：核对产物、说明与冒烟结果，确认无误后发布 Release（草稿转正式）。
6. **npm 发布**：`.github/workflows/publish-npm.yml`（workflow_dispatch，输入版本号）从已发布的 Release 下载 tgz 后 `npm publish`，走 npm 受信发布（OIDC）；预发布号挂 `next` 标签，不动 `latest`；版本号输入只经环境变量进入 shell，并先按 semver 正则校验。

### 8.2 预发布版（rc）策略

- 预发布版（版本号含 `-`，如 `0.6.0-rc.1`）**不进入 updater 与 npm `latest`**：流水线把它建成 prerelease 草稿；GitHub 的「latest release」不含预发布，桌面端 updater 端点 `/releases/latest/download/latest.json` 因此只指向正式版；npm 侧挂 `next` 标签。
- **唯一例外**：0.6.0 之前用 rc.1 → rc.2 做端到端更新测试。此时还没有正式版用户，维护者发布 rc 草稿时手动取消 prerelease 并勾选「Set as the latest release」，让 updater 能拿到 rc；测试结束后由 0.6.0 正式版发布接替 latest。
- 已装 rc 的用户能收到对应正式版：版本比较按 semver，`0.6.0` > `0.6.0-rc.2`（桌面端 `compareVersions`）。

### 8.3 本地演练

`pnpm release:build`（[release-build.mjs](../../scripts/release-build.mjs)）与 CI 调用同一个入口，产物统一收集到 `release/<version>/`（已被 `.gitignore`；每次构建先清空该版本目录）。本机演练时用临时测试密钥签名，并给 `release-build.mjs --config <覆盖.json>` 只覆盖 `plugins.updater.pubkey`，不得把测试公钥写进仓库配置。

```bash
# 测试密钥放 %TEMP%（示例），用完删除
pnpm --dir apps/desktop exec tauri signer generate --ci -p <临时密码> -w <临时目录>/test.key
TAURI_SIGNING_PRIVATE_KEY=<临时目录>/test.key \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<临时密码> \
node scripts/release-build.mjs --config <临时目录>/config-override.json
node scripts/smoke-nctrn.mjs release/<version>/nctrn-<version>.tgz   # tgz 安装冒烟
```

### 8.4 一次性配置（维护者）

- **更新签名密钥**：正式密钥已由维护者生成，公钥固定在 `apps/desktop/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。私钥留在维护者本机，**必须离线备份**——丢失后已发布版本将无法升级到新签名。仓库 Actions 需要配置 secrets：`TAURI_SIGNING_PRIVATE_KEY`（私钥内容）与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（密码）。私钥与密码不进仓库、不进文档。
- **npm 首次发布**：受信发布（trusted publishing）要求包已存在并完成绑定。首个 `nctrn` 版本由维护者本机执行 `npm publish packaging` 产物手动发布，随后在 npmjs.com 为包绑定本仓库的 GitHub Actions 受信发布（workflow `publish-npm.yml` + 指定 environment 可选）。绑定后 CI 发布不再需要 `NPM_TOKEN`。
