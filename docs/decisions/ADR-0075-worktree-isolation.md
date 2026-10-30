# ADR-0075：后台子代理的工作树隔离

- 状态：已接受
- 日期：2026-10-31
- 修订：[ADR-0073](ADR-0073-background-subagents.md)（第 2 节准入、第 3 节结果、第 4 节生命周期，按其第 8 节的接缝扩展）、[subagent.md](../architecture/subagent.md)、[tools.md](../architecture/tools.md)、[permissions.md](../architecture/permissions.md)、[events.md](../protocols/events.md)

## 背景

ADR-0073 的后台子代理只能只读：它和主代理共用一个工作区，主代理在前台继续改文件时，后台写入会互相覆盖，检查点也分不清改动来自哪边。想要的用法是「让一个子代理在后台修 A，主代理接着和用户做 B」，以及以后的多代理攻坚（roadmap「之后」的 `/boost`），都需要可写的并行子代理。

做法沿用 Claude Code 的子代理工作树隔离：给子代理一份独立的 git worktree 和一个分支，它在里面改代码、跑测试、提交；结束后副本和分支留在磁盘上，由主对话里的 agent 或用户用 git 合并。另外提供一个并回工具，在主工作区有未提交改动时也能稳妥地把改动带回来，并记入检查点。

## 决定

### 1. 启用：`task.isolation`

- `task` 输入增加可选 `isolation: "none" | "worktree"`，缺省 `"none"`。**只在 `background: true` 时可用**；同步调用带 `"worktree"` 报 `invalid_input`（同步时主代理在等，不存在并发写，隔离没有收益）。
- 字段与 `background` 同时出现或同时隐藏（ADR-0073 第 5 节的宿主开关、子会话不出现）。
- 准入（ADR-0073 第 8 节的接缝）：`backgroundAdmission` 增加一条——隔离方式为 `"worktree"` 时放行可写的工具集。外部 agent（ACP）仍不放行。
- 后台调用的工具集含可写工具、但没有声明 `isolation: "worktree"` 时，报错文案改为提示用法：「后台子代理需要写入时请加 `isolation: "worktree"`；否则只能只读」。
- 前提检查，任一不满足报 `invalid_input` 并说明原因，不创建子会话：会话工作区位于 git 仓库内（`git rev-parse --show-toplevel` 成功）、能找到 `git` 可执行文件、仓库不是裸仓库。普通对话工作区多数不是 git 仓库，在那里只能用只读后台子代理。

### 2. 创建副本与分支

- **位置**：`<sessionsDir>/worktrees/<childSessionId>/`，不放进被操作的仓库的工作目录。git 的登记信息写在仓库的 `.git/worktrees/` 下，这是 git worktree 的机制。
- **分支**：`git worktree add -b nocturne/<子会话 id> <path> HEAD`，用完整的子会话 id（如 `nocturne/202610311032-a1b2c3d4`），保证唯一并能直接对应会话。分支建在用户的仓库里，用户和主代理都能直接用 git 操作它。
- **基线 `base`**：子代理应当看到用户眼前的代码，包括未提交的改动。
  - 主工作区干净时，`base` 就是当时的 `HEAD`。
  - 有未提交改动时，把它们同步进副本：已跟踪文件的改动（含暂存区）由主工作区 `git diff --binary HEAD` 生成、在副本里 `git apply --binary`；未跟踪且未被忽略的文件（`git ls-files --others --exclude-standard -z`）逐个复制。然后在副本的分支上提交一次「快照提交」，`base` 指向它。快照提交只在这个分支上，不碰用户的其他分支和工作区。
- **被忽略的文件**：沿用 Claude Code 与 Codex 共用的 `.worktreeinclude`：仓库根目录下的这个文件用 gitignore 语法列出模式，**既匹配模式、又被 git 忽略**的文件才复制进副本（例如 `.env.local`）。只在项目可信时读取（[config.md](../architecture/config.md) 第 3 节的信任模型），不可信时忽略并在结果里注明。不提供软链接，依赖由子代理在副本里自己安装。
- **提交身份**：Nocturne 在副本里做的提交（快照提交、第 4 节的结果提交）一律带 `--no-verify` 与 `-c user.name=Nocturne -c user.email=nocturne@localhost -c commit.gpgsign=false`，不读写用户的 git 配置，不触发仓库的提交钩子。
- 任一步失败：删除已创建的副本与分支，`task` 以 `tool_failed` 结算并带 git 的错误摘要，不启动子会话。
- 主工作区不在仓库根目录时（`workspaceRoot` 是仓库的子目录），副本仍是整个仓库；子会话的 `cwd` 与 `workspaceRoot` 映射到副本里对应的子目录。

### 3. 子会话的工作区与权限

- 子会话的 `cwd`、`workspaceRoot` 是副本里的对应路径。
- 权限沿用子会话的规则（[subagent.md](../architecture/subagent.md) 第 7 节：同一预设、合并规则、共享会话 Grant、非交互），**只把构造预设时的 `workspaceRoot` 换成副本路径**：
  - 副本内的改动按「工作区内」规则判定；`default` 预设下工作区内写入是 `ask`，非交互即拒绝——与同步子代理一样，可写子代理需要 `guarded` / `smart` / `bypass` 或相应授权。
  - 主工作区对子会话是「工作区外」，写入按工作区外规则判定（`ask` → 非交互拒绝）。
  - 项目配置的信任与规则来自主工作区（与父会话相同的已解析配置），副本里的 `.nocturne/` 文件不产生任何效果。
- **shell 的隔离检查**（参照 Claude Code 对隔离子代理的做法），在权限层对工作树子会话追加两条 `deny`，求值顺序同高风险命令（[permissions.md](../architecture/permissions.md) 第 6 节），不受预设与 Grant 放宽：
  - 命令的工作目录解析后不在副本内；
  - 命令文本里出现把 git 指向副本以外的写法：`git -C <路径>`、`--git-dir=`、`--work-tree=`、`GIT_DIR=` / `GIT_WORK_TREE=` 赋值，且路径解析后不在副本内。
  - 拒绝说明告诉子模型：「This subagent is isolated in its own worktree; commands must stay inside it.」
  - 与高风险命令表一样，这是基于命令文本的检查，不是沙箱。
- 检查点：副本里的改动不记入根会话的检查点（它们不在用户的工作区里）。

### 4. 收束：提交结果

子代理收束时（任何状态：`ok`、`error`、`timeout`、`cancelled`），在交付之前：

1. 副本里 `git add -A`；有改动就在分支上提交一次「结果提交」，提交说明取任务描述的第一行（截断到 72 字符）。子代理自己做过的提交保留，结果提交只收尾未提交的部分。
2. 记下分支末端 `head`，用 `git diff --numstat --no-renames <base> <head>` 统计改动文件。
3. **没有任何改动**（`head` 等于 `base`）：移除副本，删除分支，结果里不带改动。
4. **有改动**：副本与分支保留在磁盘上（第 6 节说明何时清理）。

### 5. 交付与合并

- **结果消息**：使用 ADR-0073 第 8 节预留的改动摘要位置。`message.user.subagent` 增加可选字段：

```ts
changes?: {
  branch: string           // 如 "nocturne/202610311032-a1b2c3d4"
  base: string             // 基线提交
  head: string             // 分支末端
  snapshot: boolean        // base 是否为第 2 节的快照提交
  worktree: string         // 副本的绝对路径
  files: Array<{ path: string; status: "added" | "modified" | "deleted"; additions?: number; deletions?: number }>
  // path 相对仓库根目录；二进制文件不给行数
}
```

- `<subagent-result>` 正文末尾追加一段英文说明：改动文件（至多 50 行，超出写「and N more」）、分支名、`base..head`，以及两种合并方式：
  - 推荐：`apply_subagent_changes`（见下），主工作区有未提交改动时也能用，改动记入检查点、可以回退；
  - 也可以自己用 git：`git merge <branch>` 或 `git cherry-pick <base>..<head>`。`snapshot` 为真时提示：分支里第一个提交是启动时未提交改动的快照，直接 `merge` 会把它也作为提交带进来，应当只取 `<base>..<head>`。
- **用 git 自己合并**：主代理或用户在主工作区运行 `git merge` / `git cherry-pick` 等命令，走普通的 shell 权限。冲突时 git 照常往文件里写冲突标记，由 agent 自己解决。这条路径与其他 shell 命令一样不记入检查点（ADR-0041 第 1 节）。
- **并回工具 `apply_subagent_changes`**：输入 `{ id: childSessionId, mode?: "clean" | "3way" }`，缺省 `"clean"`；只在主会话、后台工作树功能开启时注册。
  - 内容是 `git diff --binary --no-renames <base> <head>`，在仓库根目录用 `git apply` 应用到工作区（不提交、不切分支，效果是未暂存的修改）。
  - `traits.mutates = true`；`permissionSubjects` 为改动文件在主工作区的绝对路径（`edit` 主体）。权限层照常判定；执行器按 `edit` 主体记录检查点（ADR-0041），所以并回可以回退。
  - `"clean"`：先 `git apply --check`，能干净应用才应用；不能时以 `tool_failed` 结算，`modelContent` 列出冲突文件，并提示可以改用 `mode: "3way"` 或自己用 git 合并。
  - `"3way"`：`git apply --3way`。能自动合并的合上，合不上的在文件里写冲突标记；结算为 `ok` 并在 `modelContent` 列出带冲突标记的文件，由主代理继续解决。冲突标记同样在检查点之后写入，回退可以撤销。
  - 改动路径一律相对仓库根目录解析，拒绝绝对路径和 `..`。
  - 同一个 `id` 已成功并回过（按有效事件里该工具的 `ok` 结果判断）：报 `invalid_input`。回退掉那次并回后可以再次并回。

### 6. 保留与清理

原则同 Claude Code：**只在不会丢失改动时自动清理**。

- **自动清理**（移除副本、删除分支）：
  - 收束时没有改动（第 4 节）；
  - 分支末端已包含在主工作区当前 `HEAD` 中（`git merge-base --is-ancestor <head> HEAD`，即已经用 git 合并过）。在父会话加载时和每个主 Turn 结束时检查。
- **并回工具成功后**：移除副本目录（省磁盘），**保留分支**，以便回退后再次并回。
- **其余情况保留**：副本与分支留在磁盘上，包括取消、超时、失败的子代理（改动可能是半成品，状态如实标注）。
- **手动清理**：TUI `/subagents` 与桌面端子代理概览列出本会话保留的副本与分支（分支名、改动文件数、是否已并回），可以逐个删除；未合并、未并回的删除前确认「其中的改动会丢失」。
- **删除父会话**：删除确认里列出该会话保留的副本与分支，确认后一并删除。（实现时 Nocturne 还没有删除会话的功能，这一条留待该功能落地时接入；在那之前，保留项通过概览与 `/subagents` 手动删除，Core 公开 `listSubagentWorktrees` / `deleteSubagentWorktree`。）
- **移除方式**：`git worktree remove --force <path>`，失败时删除目录后 `git worktree prune`；删除分支用 `git branch -D`，只删 `nocturne/` 前缀且登记在本会话结果里的分支。失败只发 `runtime.warning`（`worktree_cleanup_failed`），不影响其他流程。
- **不交付的情形**（父会话关闭、回退到启动之前，ADR-0073 第 4 节）：照第 4 节提交结果后按上述规则保留或清理，不交付消息；保留的副本照常出现在手动清理列表里。
- **重启**：进程意外退出时副本留在磁盘上。父会话加载时，ADR-0073 的重启补报照常生成 `interrupted` 条目；对应副本仍存在时先按第 4 节提交结果，补报条目带上 `changes`。
- **分叉**：运行中的副本不继承（ADR-0073）。分支在仓库里，分叉出的会话可以用已交付结果里的 `changes` 并回；保留与清理只由创建它的会话管理。

### 7. 界面

- 结果卡片（桌面端、手机）与 TUI 结果行：有改动时显示「改动 N 个文件 · <分支名>」，展开逐行列出文件与增删行数。桌面端点击文件在面板里显示 `base..head` 中该文件的差异。
- 子代理概览里，工作树子代理标记为「后台 · 隔离」；保留的副本与分支在概览里单列，可删除（第 6 节）。
- `apply_subagent_changes` 的工具行显示「并回子代理改动 · N 个文件」，`3way` 有冲突时显示「有冲突 · N 个文件」。

### 8. 限制

- 子模块不在副本里初始化；Git LFS 文件按指针检出。子代理需要它们时自己执行相应命令。
- 被忽略的文件默认不复制，依赖要在副本里重新安装。
- 副本是整份检出，大仓库的创建耗时与磁盘占用较高；并发上限沿用 `maxBackground`（默认 3），保留的副本不计入并发。
- 用户的仓库里会出现 `nocturne/` 前缀的分支，直到按第 6 节清理。
- 外部 agent 仍不能后台运行。

## 后果

- 后台子代理可以改代码、跑测试、提交，主代理同时在主工作区工作，两边互不覆盖。
- 改动以分支形式留在仓库里，主代理和用户可以用熟悉的 git 方式查看、合并；工作区有未提交改动时有并回工具兜底，且可以回退。
- 冲突处理与 git 一致：用 git 合并或 `3way` 并回时写冲突标记，由主代理解决。
- 非 git 工作区仍只能用只读后台子代理。

## 备选方案

- **用完即删、只留补丁文件**：不在用户仓库里留分支，但用户和主代理不能用 git 直接查看、合并；不采用。
- **收束时自动并回**：主代理没机会审查，冲突时只能失败或写冲突标记；不采用。
- **只提供 git 合并、不提供并回工具**：主工作区有未提交改动时 `merge` / `cherry-pick` 容易失败，且改动不进检查点；保留工具作为推荐路径。
- **基线只用 `HEAD`**（Claude Code 的默认）：用户未提交的改动对子代理不可见，子代理会在过时的代码上工作；不采用。
- **同步子代理也支持工作树**：同步时主代理在等，没有并发写；不做。
- **项目级初始化脚本**（Cursor 的 `.cursor/worktrees.json`、Codex 的本地环境脚本）与**目录软链接**（Claude Code 的 `symlinkDirectories`）：能省去每次装依赖，第一版不做，以后作为可信项目的可选配置另议。

## 参照：其他工具的做法（2026-10-31 调研）

| | 基线 | 改动怎么回来 | 清理 |
|---|---|---|---|
| Claude Code（子代理 `isolation: worktree`） | 默认仓库默认分支，可设为当前 HEAD；不含未提交改动 | 副本与分支留在磁盘，由主对话里的 agent 或用户用 git 合并 | 无改动即删除；有改动的在不会丢失改动时由定期清扫移除 |
| Cursor（`/worktree`、`/best-of-n`、并行子代理） | 当前分支 | 从不自动合并；`/apply-worktree` 把改动作为未暂存修改带回当前检出，或在副本里提交、开 PR | 超过数量上限按旧到新清理 |
| Codex 桌面（Worktree 模式） | 可选分支，含当前分支及未提交改动；游离 HEAD | Handoff 把分支连同对话移回本地检出 | 由应用管理 |
| Antigravity `/boost` | 短暂隔离工作树 | 协调器自己汇总、跑回归后交付 | 用后即删 |

本 ADR 的取舍：保留副本与分支、用 git 合并、只在不丢改动时清理，同 Claude Code；基线取当前状态含未提交改动，同 Codex；并回工具把改动作为未暂存修改带回，接近 Cursor 的 `/apply-worktree`，另外经过权限与检查点；被忽略文件沿用 `.worktreeinclude`。
