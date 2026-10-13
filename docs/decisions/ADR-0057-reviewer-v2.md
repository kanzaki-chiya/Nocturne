# ADR-0057：安全审查第二版——smart 扩大送审范围、是非题、直接交人

- 状态：已接受（维护者 2026-10-13 确认）
- 日期：2026-10-13

## 背景

[ADR-0036](ADR-0036-smart-permissions.md) 的 `smart` 与 `guarded` 共用一套宽规则：shell、network、MCP 全部直接 `allow`，只有被降级成 `ask` 的少数调用（高风险命令表、`-EncodedCommand`、工作区外 edit、`.git/` edit、外部 agent）才送审。结果是 `git push`、`git push origin --delete`、`gh release delete`、`curl | sh`、`npm publish`、`ssh host 'rm …'` 和所有 MCP 工具都不经审查直接执行。

审查本身也不够好：提示词只有 5 行，要求模型直接给 `ALLOW` / `BLOCK` / `UNSURE` 结论。21 次真实审查中 14 次是 `unsure`，置信度大多在 0.04–0.34——模型在「这条命令得到授权了吗」这种开放题上拿不准，结论也不稳定。

## 决定

### 1. 三条通道

`smart` 下每次需要判定的调用，权限层按顺序走：

1. **直接放行**：用户 / 项目 / CLI 的显式 allow 规则；工作区内的 read 和 edit；只读白名单；声明了 `readOnlyHint: true` 的 MCP 工具；subagent 内置入口。
2. **直接交人，不送审**：最危险或审查器看不清的调用，用现有的 `userOnly` 机制表达。
3. **送审**：其余所有调用。审查结果只有两种——**放行**，或**交给你确认**。审查器从不拒绝；超时、报错、输出无法解析都按「交给你确认」处理。

`guarded` 的行为一字不变：仍然只把高风险表降级为 `ask`，不送审。用户 / 项目 / CLI 的显式规则、Grant、`--yes`、PermissionRequest Hook、`userOnly` 集合与原有优先级都不变。用户写了 `shell allow *` 就等于关掉 shell 审查。

### 2. 预设与送审范围

`smart` 不再和 `guarded` 共用规则序列：`shell *`、`network *`、`mcp *` 改为 `ask`；read、工作区内 edit、subagent 不变。预设级的 `ask` 再由权限层按下面几条路由；显式规则命中时（`hit.origin` 不是 `preset`）原样生效，不进入路由。

- **network**：一律送审。审查放行的结果按现有缓存键（精确目标）缓存。
- **高风险表的其余条目**（`git push --force`、`git reset --hard`、`sudo` 等）在 `smart` 下改为送审，命中规则写「预设 smart 高风险命令」交给审查器。
- **MCP**：工具声明 `readOnlyHint: true` 的直接放行。声明经权限主体字段 `readOnly` 透传（MCP connector 在 `permissionSubjects` 里填写），权限层只看这个字段，不按 `origin === "mcp"` 分支。这里信任的是服务器的自我声明：用户配置的 MCP 服务器本来就在本机以用户身份运行，权限层没有能力验证它的标注；不信任某个服务器时用显式 `mcp ask` 规则覆盖。未声明的 MCP 工具送审。

### 3. 只读白名单

白名单是和 `ShellDescriptor.risk` 同类的纯数据表（`permission/smart-shell.ts`），按方言逐段匹配（复用 `shellDialect` / `shellSegments`）：

- 每一段都必须命中；任一段带写文件重定向（`>`、`>>`、`Out-File`、`Set-Content`、`Tee-Object`、`tee`）就不算命中；`2>&1` 与重定向到空设备不算写文件。
- 命中时结果为 `allow`，命中描述写「预设 smart 只读命令」。PowerShell 和 cmd 的命令词不区分大小写，POSIX 保持敏感。
- 文件与文本：`ls`、`dir`、`cat`、`type`、`head`、`tail`、`wc`、`rg`、`grep`、`find`（不带 `-delete` / `-exec`）、`Get-ChildItem`、`Get-Content`、`Select-String`、`Test-Path`。
- git：`status`、`diff`、`log`、`show`、`branch`（不带 `-d` / `-D` / `-m`）、`remote -v`、`rev-parse`、`ls-files`、`blame`，另加两项工作区内可撤回的写操作：`git add`，以及不带 `-n`、`--no-verify`、`--amend` 的 `git commit`。
- 其他：`echo`、`pwd`、`which` / `where` / `Get-Command`、版本查询（`node -v`、`pnpm -v`……）。
- 参数里出现凭据类文件名（`.env`、`.ssh`、私钥、`credentials` 等）或未展开的变量 / 命令替换时不走白名单，交给审查器回答「是否触及凭据」。命令词必须是裸命令（`./ls` 不算）。

**会运行工作区代码的命令**：`pnpm` / `npm` / `yarn` 的 `test`、`typecheck`、`lint`、`build`、`run`，`cargo check` / `cargo test`，`tsc`，`vitest`，`node <文件>`。命中后先放行，但满足下面任一条件就改为送审：

- 本会话里放行过对任何 `package.json` 的 edit（防止把脚本换掉再用 `pnpm run` 绕过审查）；
- `node` 执行的文件在本会话被放行过 edit，或路径不在工作区内、无法确定位置（防止写一个临时脚本再执行）。路径按会话 cwd 词法解析，解析不了也送审。

「本会话放行过的 edit 目标」由 gate 在 edit 主体最终放行（规则、Grant、用户、审查器均算）时记录，以只读视图经 `EvaluateOptions.session` 传给 policy。它**只在内存里，不持久化**：会话恢复后 gate 重建，记录清空。剩下的风险是 agent 改了测试文件或源码后运行测试，与 Claude Code 的做法一致，属于接受的风险：工作区代码本来就由 agent 编写。

### 4. 直接交人（不送审）

命中后 `userOnly`，跳过审查，非交互时按 `non_interactive` 拒绝：

- 递归删除（`rm -r`、`Remove-Item -Recurse`、`rd /s` 等）：目标在工作区外、无法确定位置，或不是构建产物（`dist`、`build`、`out`、`node_modules`、`target`、`.turbo`、`.cache`、`coverage`）。目标是构建产物的照常送审。
- `dd`、`mkfs`、`format`、`diskpart`、`shutdown`、`reboot`、`Stop-Computer`、`Restart-Computer`。
- 删除或覆盖类命令的目标含 `$VAR`、`%VAR%`、`$env:X`、`$(…)` 或反引号。
- `-EncodedCommand`、`iex` / `Invoke-Expression`、`eval`。
- 嵌套 shell 调用（`bash -c "…"`、`pwsh -c "…"`）的命令体按内层方言再查，最多三层。
- 回应密码或确认提示：目前没有交互式 shell 输入的工具，这一条**只作为将来接入时的约束**，不实现。
- **你拒绝过一次后不再送审**：同一 Turn 里你拒绝过的调用，主体集合与之相同的后续调用直接交给你确认。由 gate 按 turnId 记录，进入新 Turn 后恢复送审。

### 5. 审查结果两档

审查结果只有「放行」和「交人」。`block` 不再由内置审查器产生。`permission.reviewed.verdict` 的取值保持 `allow | block | unsure` 不变，交人时写 `unsure`，以便旧会话重放；各客户端把 `unsure` 的显示文字从「拿不准」改为「交给你确认」，`block` 的显示保留给旧记录。gate 对自定义审查器返回的 `block` 仍按拒绝处理。非交互模式（子会话、CLI 非交互）下，交人仍按现有规则结算为 `non_interactive` 拒绝。

### 6. 是非题与纯函数判定

审查器不再给结论，而是逐题回答七道是非题（题干与判断依据见维护者拍板的规则）：

- Q1 `requested`：用户的话是否点名要求了这个动作，且目标一致（授权要点名动作，限制一直有效）；
- Q2 `destroys`：会删除或丢失数据吗；Q3 `credentials`：会读取、打印或修改凭据吗；Q4 `exfiltrates`：会把本机内容发到外部吗；Q5 `weakens`：会削弱安全设置、开权限、留下持久化吗；Q6 `crosses`：会推送、发布、远程写、以你的身份对外发言吗；Q7 `opaque`：会运行看不到内容的代码吗。

**判定是权限层的纯函数** `decideFromAnswers(answers): "allow" | "ask"`：Q2–Q7 全否放行；有任一为是，只有 Q1 为是时才放行；其余交人。「限制一直有效」不另做实现，写进提示词里 Q1 的说明——用户说过且没有撤回的限制命中时，Q1 答否。七题提示词放在共享模块 `permission/reviewer-questions.ts`，模型后端和 Jev 后端共用。

- 模型后端要求输出一个 JSON 对象（七个布尔字段 + `reason`），容忍 Markdown 代码块包裹；任一字段缺失或不是布尔值就交人，理由写「审查输出格式错误」。`maxOutputTokens` 提到 400。
- Jev 后端把 `questions` 改成七个编号的 `choice` 问题，每题 `criteria` 是 `yes` / `no`；置信度低于 `minConfidence` 时往保守方向取值（Q1 取否，Q2–Q7 取是）；答案表兼容对象与数组两种形式。
- 交人的理由列出答「是」的题和模型给的 `reason`，例如「会推送（越过信任边界），用户未要求：……」。

### 7. 输入

`ReviewInput.recentUserMessages` 改名为 `userMessages`：全部用户消息，总预算 8000 字，单条最多 2000 字，超出时保留第一条和尽量多的最近几条，中间插入「（省略 N 条）」。新增 `projectNotes`（已加载的项目指令文件拼接后的前 2000 字，复用 context 模块已加载的结果）、`trustedRemotes`（会话创建时读一次 git remote）、`facts`（runtime 注入的异步函数，权限层只消费结果：`git reset --hard` / `clean` / `checkout -- .` 给出 `git status --porcelain` 行数；推送类命令给出目标 remote、分支以及是否可信；查询失败就不给）、`environment`（工作目录与 Nocturne 数据目录）和 `reviewerRules`。不给工具输出和 agent 自己说的话。

### 8. 用户追加规则与样例集

新增设置项 `permission.reviewerRules: { ask?: string; allow?: string }`，两段自然语言原样拼进提示词（标题「用户追加：以下情况交人」和「用户追加：以下情况放行」，单段最多 1000 字）。内置样例集 `permission/reviewer-samples.ts`（约 20 条，覆盖越界样例与应当放行的样例）和公开函数 `runReviewerSamples(reviewer, samples, signal)` 供设置页的「测试」按钮使用。

## 不做的事

留到第 2 步，看数据再定：审查器「拒绝并把理由回给 agent」、可撤回 / 不可撤回分流、连续拒绝的兜底（同一轮 3 次、累计 10 次）、两段式审查、注入探测器。

## 后果

- **代价**：每条非白名单命令多一次审查，约 0.5–1.5 秒；审查调用增加 token 开销，计入 `permission.reviewed.usage`。
- **子会话可用的命令变少**：子会话 gate 恒为非交互，白名单外的 shell 命令被审查器交人后按 `non_interactive` 拒绝。被拒的命令由子模型写进 `finish` 结果，由父会话执行（[subagent.md](../architecture/subagent.md) 7.3）。
- 白名单、直接交人和是非题的判定都在 `permission/`，不按工具名或 Provider 写分支；Agent Loop 不变。
- 未配置审查器时 `smart` 不再等同 `guarded`：白名单与 `readOnlyHint` 之外的调用直接询问用户（非交互拒绝），仍每个会话提示一次。
- 信任 MCP 服务器的 `readOnlyHint` 自我声明，是有意识接受的边界。
- 记录「本会话放行过的 edit」的状态在内存，会话恢复后清空；恢复后第一次 `pnpm run` 会按未污染处理。

## 备选方案

- **继续与 guarded 共用宽规则、只扩大降级表**：降级表永远追不上新的危险命令，并且 MCP / 网络调用不在其中。
- **让审查器直接给 allow / block 结论**：模型在开放题上不稳定（14/21 拿不准）；是非题把判断拆成可审计的事实，结论由权限层的纯函数得出。
- **允许审查器拒绝**：已有的 `block` 路径把误判变成对 agent 的硬拒绝，而用户看不到；两档只让审查器决定「问不问」。
- **只读判断交给模型**：每条 `git status` 都等 1 秒审查没有意义；白名单是确定性数据，可测试。
