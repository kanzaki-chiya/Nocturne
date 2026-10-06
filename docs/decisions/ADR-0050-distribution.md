# ADR-0050：分发——npm 单文件包、桌面端随附 Node 与自动更新、打标签触发的发布流水线

- 状态：已接受（维护者 2026-10-06 拍板，见文末「已拍板」）
- 日期：2026-10-06

## 背景

到 0.5.0 为止，Nocturne 只有一种装法：自备 Node 24.14+ 和 pnpm，从源码 `pnpm install`、`pnpm build`，再 `npm link`。npm 上没有发布过任何包。桌面端能在本机打出 NSIS 安装包（ADR-0046），但要求用户自装 Node，没有自动更新，也没有构建和发布流水线。路线图 v0.7 把「分发：npm 发布或单文件可执行，一行命令安装」列为待设计。

已经具备的条件：

- `scripts/bundle-nctrn.mjs` 能把 `apps/cli` 连同全部依赖打成一个自包含的 `nctrn.mjs`，复制到没有 `node_modules` 的目录也能运行 `--version`、`--help` 和 `rpc --stdio`（ADR-0046 修订第 5 条）。
- 桌面端查找 Node 的顺序里预留了「资源目录里随附的 `node(.exe)`」这一步（ADR-0046 第 2 节），随附 Node 不需要改查找逻辑。
- 仓库目前是私有的。维护者要先看过一次完整的发布流程和产物，并会在下一个正式版本发布之前公开仓库。

维护者已确定：npm 发布需要注册账号，可以接受；桌面端要做自动更新；桌面端随附 Node，安装包大几十 MB 可以接受；发布流程先跑通、产物先不公开，看过之后在下一个正式版本前公开仓库。

## 决定

### 1. CLI / TUI：npm 单文件包 `nctrn`

- **包名**：`nctrn`，与命令同名，不带 scope，用 `npm i -g nctrn` 安装。发布前确认该名字仍然未被占用；如果已被占用，改用 `@kanzaki-chiya/nctrn`，命令仍然是 `nctrn`。
- **内容**：只有一个打包好的入口文件，外加 `package.json`、`README.md`、`LICENSE` 和 `THIRD-PARTY-NOTICES.md`。没有运行时 `dependencies`，安装时不拉取任何依赖，也不运行安装脚本。
  - 入口文件就是 `bundle-nctrn.mjs` 的产物。脚本要能指定输出目录：桌面端放进 `src-tauri/resources`，npm 包放进发布暂存目录，两者内容完全相同。
  - `package.json` 由发布脚本根据模板生成，字段包括 `name`、`version`、`bin.nctrn`、`engines.node: ">=24.14"`、`license`、`repository`、`files`。
- **其余工作区包不发布**：`@nocturne/core`、`@nocturne/tui`、`@nocturne/cli`、`@nocturne/rpc`、`@nocturne/mcp` 都标为 `private: true`。Core 目前没有承诺对外的库 API，日后需要再单独决定。
- **平台**：npm 包本身跨平台，但只在 Windows 上做完整验收。macOS 和 Linux 只在流水线里做安装冒烟（第 4 节），README 写明这一点。
- **CLI 不自我更新**：升级就是 `npm i -g nctrn@latest`。`nctrn --version` 照常显示版本，不在启动时联网检查新版本，与「运行时启动不联网」的约定一致（workflow.md）。

### 2. 桌面端随附 Node

- 安装包里随附官方 Windows x64 版的 `node.exe`，放在资源目录的 `node/node.exe`，再附上 Node 的 `LICENSE`。查找顺序不变：`NOCTURNE_NODE` 优先，其次随附的 Node，最后是 `PATH`。所以装好就能用，想用自己的 Node 时设置 `NOCTURNE_NODE`。
- **版本固定**：在仓库里的一个文件中写死 Node 版本号和该版本 `node-vX-win-x64.zip` 的 SHA-256，例如 `scripts/node-version.json`。构建时下载官方压缩包，校验哈希，只取出 `node.exe` 和 `LICENSE`。校验失败就中止构建，不允许跳过。
  - 选 24.x 里的最新 LTS 补丁版本，且不低于 `engines` 要求的 24.14。
  - 升级 Node 就是改这个文件，随下一个版本一起发布。
- 「找不到 Node」说明页保留，用于 `NOCTURNE_NODE` 指向错误或随附文件被删的情况。
- **体积**：`node.exe` 约 80 MB，NSIS 压缩后安装包预计在 40 MB 左右，以实测为准。维护者已接受。

### 3. 桌面端自动更新

- **机制**：使用 Tauri 官方的 `tauri-plugin-updater` 和 `tauri-plugin-process`，构建时打开 `bundle.createUpdaterArtifacts`。每次发布生成安装包对应的 `.sig` 签名，以及一份 `latest.json`（版本号、发布说明、下载地址、签名）。
- **更新签名密钥**：这是 Tauri 更新包专用的 minisign 密钥对，和代码签名无关。
  - 由维护者在本机用 `tauri signer generate` 生成，设置密码。
  - 私钥和密码存进 GitHub Actions secrets；公钥写进 `tauri.conf.json`。
  - **私钥一旦丢失，已经装好的客户端就再也无法自动更新**，只能手动下载新安装包重装。维护者须另外离线备份私钥。
  - 私钥、密码和备份位置都不进仓库，也不进任何文档或日志。
- **更新地址**：`https://github.com/kanzaki-chiya/Nocturne/releases/latest/download/latest.json`。仓库私有时这个地址无法匿名访问，检查会失败；这是预期行为，公开以后自然就能用。
- **检查时机**：应用启动后在后台检查一次，之后每 24 小时最多检查一次；另外提供手动检查。
  - 设置 › 常规新增「自动检查更新」开关（默认开）和「检查更新」按钮。开关状态写进桌面端自己的设置。
  - 自动检查失败只写入后台日志，不打扰用户；手动检查失败时显示原因，例如「无法连接更新服务器」。
- **安装要经过用户同意**：发现新版本时，在窗口里显示一条不打断操作的提示，内容是版本号、发布说明摘要、「立即更新」和「稍后」。永远不在用户不知情时安装。
  - 点「立即更新」后，下载并校验签名，签名不对就中止并提示。
  - 如果有会话正在运行 Turn，先提示「将中断 N 个正在运行的会话」，用户确认后再继续。
  - 安装用 NSIS 的 passive 模式，装完重启应用。后台进程随窗口关闭由 Job Object 回收；会话从日志恢复，与崩溃恢复同一条路径。
- **降级与跳过**：不提供降级。「稍后」只对本次运行有效，下次启动会再提示；不做「跳过此版本」。
- **代码签名**：继续不做，README 保留关于 SmartScreen 的说明。

### 4. 发布流水线

- **版本号**：新增 `scripts/release-version.mjs <version>`，一次改齐所有 `package.json`、`tauri.conf.json`、`Cargo.toml` 的版本号，以及 npm 包模板里的版本号。流水线会检查标签与这些版本号是否全部一致，不一致就失败。
- **对外日志**：`CHANGELOG.md` 照现有格式手写。发布脚本从中提取当前版本那一节，作为 GitHub Release 的说明和 `latest.json` 的 `notes`。
- **触发**：推送 `v*` 标签后，GitHub Actions 的 `.github/workflows/release.yml` 在 `windows-latest` 上依次执行：
  1. `pnpm install --frozen-lockfile`，然后跑完整检查：typecheck、lint、format:check、depcheck、build、test；
  2. `bundle-nctrn` 生成单文件，用 `npm pack` 打出 `nctrn-<version>.tgz`；
  3. 下载并校验 Node，`cargo test`，带更新签名密钥执行 `tauri build`；
  4. 冒烟：在干净目录 `npm i -g ./nctrn-<version>.tgz`，运行 `nctrn --version`，并完成一次 `rpc --stdio` 握手；
  5. 创建一个 **草稿（draft）** GitHub Release，上传 `Nocturne_<version>_x64-setup.exe`、`.sig`、`latest.json` 和 `nctrn-<version>.tgz`。
- 另有一个 `ubuntu-latest` 和 `macos-latest` 任务，只对第 2 步的 tgz 做第 4 步的安装冒烟，不阻塞 Windows 产物，但失败要在 Release 说明里注明。
- **人工把关，与公开解耦**：流水线只生成草稿，不做任何公开动作。
  - 维护者下载草稿里的产物检查，确认后手动把草稿发布为正式 Release。发布之后 `latest.json` 才会出现在 `releases/latest` 下。
  - npm 发布单独做，是一个手动触发的 workflow：`publish-npm.yml`，`workflow_dispatch`，输入版本号，从对应的 Release 下载 tgz 发布，不重新构建。只能由维护者手动触发。
  - **npm 包一经发布，打包进去的源码就公开了**，而且 npm 只允许在发布后 72 小时内撤回。因此 npm 发布排在维护者决定公开仓库之后。
- **npm 凭据**：维护者注册 npmjs.com 账号并开启双重验证。
  - 优先使用 npm 的「受信发布」（Trusted Publishing，GitHub Actions OIDC），不在 secrets 里存长期 token。
  - 受信发布要求包已经存在、并在包设置里绑定仓库和 workflow，所以首个版本由维护者在本机 `npm publish` 一次，之后改由 workflow 发布。
  - 公开仓库后再加 `--provenance`。
- **私有仓库的额度**：私有仓库的 Actions 用的是免费分钟数，Windows 运行器按两倍计费。发布流水线只在打标签时运行，日常提交不跑 CI。日常 CI 不在本 ADR 范围内。

### 5. 文档

- workflow.md：新增「发布」一节，写明版本号脚本、CHANGELOG、打标签、审草稿、发布 Release、npm 发布的顺序，以及首次发布 npm 和生成更新密钥的一次性步骤。这一节是发布流程的主文档。
- README：安装一节改为 `npm i -g nctrn`，以及从 Releases 下载桌面安装包、桌面端已自带 Node；从源码构建移到靠后位置。只写面向用户的内容。
- desktop.md：随附 Node、自动更新、设置 › 常规新增的两项。
- ADR-0046：在「## 修订」下追加一条，说明第 2 节「第一版不随附 Node」由本 ADR 改为随附，第 5 节「不包含自动更新」由本 ADR 补上。
- roadmap.md：v0.7「分发」条目指向本 ADR。

## 后果

- 用户装 CLI 只需要 Node 和一行 `npm i -g nctrn`；装桌面端什么都不用预先准备。
- 桌面安装包从十几 MB 涨到四十 MB 左右。Node 的安全更新要靠我们发版跟进，有了自动更新，这一点才可行。
- 维护者需要保管两样东西：npm 账号，以及更新签名私钥。私钥丢失的后果不可逆。
- 公开之前，自动更新无法真正走通，私有阶段只能验证「检查失败时安静降级」和「签名产物生成正确」。维护者会在下一个正式版本前公开仓库，因此「旧版本检测到新版本并完成安装」安排在公开后、正式版发布前实测：先发布 `v0.6.0-rc.1`，装好后再发布 `v0.6.0-rc.2`，确认 rc.1 能检测到并完成更新，再发布正式版。
- 新增 GitHub Actions 配置。仓库此前没有 `.github/`。

## 备选方案

- **发布全部工作区包，`nctrn` 依赖它们**：可以让 Core 作为库被复用，但要维护五个包的版本和公开 API，安装时还要拉取依赖树。现在没有库用户，不采用。
- **单文件可执行（Node SEA / Bun 编译）代替 npm 包**：免装 Node，但每个平台要单独构建，体积大，Core 依赖的 Node 24 行为在 Bun 下需要重新验证。桌面端已经随附 Node，CLI 用户本来就是开发者。以后有需要再评估，不采用。
- **桌面端继续要求自装 Node**：维护者已改为随附，不采用。
- **自建更新服务器或用 lan gitea 托管 `latest.json`**：外网访问不到 lan，自建服务器又要另外维护。GitHub Releases 是 Tauri 官方推荐的做法，不采用。
- **流水线直接发布正式 Release 和 npm 包**：与维护者「先看产物再公开」的要求冲突，不采用。

## 实施顺序

1. 发布脚本：`bundle-nctrn` 支持指定输出目录；npm 包模板与暂存目录；`release-version.mjs`；从 CHANGELOG 提取说明；工作区包加 `private`。本机能打出 tgz，并在干净目录完成安装冒烟。
2. 桌面端：Node 下载与校验脚本，随附 Node；更新插件与设置项、更新提示 UI；更新签名用一对测试密钥在本机跑通，生成签名产物，并验证「地址不可达时安静失败」。前端测试与 Rust 测试补齐。
3. 流水线：`release.yml`、`publish-npm.yml`。维护者生成正式更新密钥并存入 secrets；推送一个预发布标签（如 `v0.6.0-rc.1`），产出草稿 Release 交维护者检查。
4. 公开仓库后的端到端验收：发布 rc.1 并安装，再发布 rc.2，确认自动更新完整走通；首次 `npm publish` 由维护者在本机完成并绑定受信发布；之后发布 0.6.0 正式版。
5. 文档同步（第 5 节，随各步更新，最迟在第 3 步完成）。

## 已拍板

1. **包名**：`nctrn`；发布前已被占用时改用 `@kanzaki-chiya/nctrn`（第 1 节）。
2. **更新检查**：默认开启，每 24 小时最多一次，可在设置里关闭（第 3 节）。
3. **macOS / Linux 冒烟**：失败不阻塞发布，只在 Release 说明里注明（第 4 节）。
4. **版本号**：首个带分发的版本为 0.6.0，试跑用 `v0.6.0-rc.1`（实施顺序第 3、4 步）。
5. **公开时机**：维护者看过草稿产物后，在 0.6.0 正式版之前公开仓库；npm 发布与自动更新的端到端验收都排在公开之后。
