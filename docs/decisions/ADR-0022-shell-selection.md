# ADR-0022：shell 工具可选 shell（pwsh / Git Bash / cmd）

- 状态：提议
- 日期：2026-09-28

## 背景

v0.4 实测中，模型在 Windows 上反复按 bash 习惯写命令，而 shell 工具固定用 `cmd /d /s /c` 执行：

- `脚本 > out.txt 2>&1 & echo started` 以为进了后台，cmd 的 `&` 却是顺序执行，等满 120 秒超时；
- 接 `| more`，被 more 按 GBK 转写改坏 UTF-8 输出，有时卡住等按键；
- `findstr "通过"` 用中文关键词匹配不到 UTF-8 输出；
- 自己加 `chcp 65001` 试图绕过编码，顺带改了用户终端所在控制台的代码页。

这些都是「模型熟悉的语法」与「实际执行的 shell」不一致造成的，提示词只能缓解。模型对 PowerShell 与 bash 的掌握远好于 cmd。维护者本机装有 PowerShell 7（pwsh）与 Git Bash。

现状的限制：`NOCTURNE_SHELL` 只替换可执行文件，Windows 上参数仍是 cmd 的 `/d /s /c "…"`，设成 pwsh 会直接报参数错误，实际只能换成另一个 cmd。权限层的 shell 分段与内置高风险命令表也只按 cmd/sh 语法写，其中高风险表只有 POSIX 写法（`rm -rf`、`sudo` 等），cmd 的 `rd /s`、`del /s` 目前都不在内。

## 决定

### 1. shell 种类

shell 工具支持以下种类，每种有自己固定的调用方式、输出编码处理、分段规则、高风险命令表与环境信息说明：

| 种类 | 平台 | 可执行文件 | 调用方式 |
|---|---|---|---|
| `pwsh` | Windows / POSIX | PowerShell 7+ | `-NoLogo -NoProfile -NonInteractive -EncodedCommand <前导语句 + 命令，UTF-16LE Base64>` |
| `powershell` | Windows | Windows PowerShell 5.1 | 同上 |
| `bash` | Windows（Git Bash）/ POSIX | Git for Windows 的 `bin\bash.exe`；POSIX 为 `bash` | `-c <命令>`（Windows 下不经 cmd 转义，参数原样传入） |
| `cmd` | Windows | `%COMSPEC%` 或 `cmd.exe` | `/d /s /c "<命令>"`（现状） |
| `sh` | POSIX | `/bin/sh` | `-c <命令>`（现状） |

- **PowerShell 前导语句**：把 `[Console]::OutputEncoding` 与 `$OutputEncoding` 设为无 BOM 的 UTF-8，`$ProgressPreference='SilentlyContinue'`（避免进度条在重定向输出里写出 CLIXML 垃圾）。不改执行策略。退出码：最后一条是原生命令时取它的 `$LASTEXITCODE`，否则成功为 0、出错为 1。
- **命令文本用 `-EncodedCommand` 传入**：引号、`$`、`&`、`|` 都不经过任何一层命令行转义，避免 cmd 式转义把命令弄坏。
- **Git Bash 的定位**：从 `git.exe` 所在目录推出 `..\bin\bash.exe`，或取默认安装路径；**不得**选到 `C:\Windows\System32\bash.exe`（那是 WSL 入口，会把命令跑进 Linux）。
- **输出解码**：沿用逐行 UTF-8 判定（tools.md 第 6 节）。pwsh 与 bash 本身输出 UTF-8，GBK 回退只在遇到旧程序时起作用。
- **进程树终止**：沿用现状（Windows `taskkill /T`）。

### 2. 选择与优先级

`NOCTURNE_SHELL` 环境变量 > 手写 `config.json` 的 `shell` > 程序维护的 `settings.json` 的 `shell` > 自动。

- 取值为种类名：`auto | pwsh | powershell | bash | cmd | sh`；另可用 `shellPath` 指定非标准安装位置的可执行文件，种类仍由 `shell` 决定。
- `NOCTURNE_SHELL` 保持兼容：值是路径或文件名时，按文件名（`pwsh`、`powershell`、`bash`、`cmd`、`sh`，忽略大小写与 `.exe`）识别种类并用该种类的调用方式；识别不了时启动时报一条警告并回退自动选择，不再用 cmd 参数硬套。
- **自动**：Windows 依次选 pwsh 7 → Git Bash → cmd；Windows PowerShell 5.1 只在显式选择时使用（它的原生命令 stderr 会被包装成 `NativeCommandError` 文本，编码处理也更差）。POSIX 用 `/bin/sh`（现状）。
- 选中的 shell 找不到可执行文件时：显式选择的报错并提示可选项；自动选择顺延到下一个。
- 检测结果在进程内缓存。

### 3. `settings.json`（设置层的第一个字段）

新增程序维护的 `<NOCTURNE_HOME>/settings.json`，本 ADR 只放 `shell`（与可选的 `shellPath`）。它就是路线图 v0.5「设置层与 `/settings` 页」的那个文件：程序原子写入、只写自己的文件；与手写 `config.json` 分层合并，同名字段手写优先；程序仍不改写 `config.json`。v0.5 的其他偏好以后加在这里，不另起文件。

### 4. `/shell` 选择页

- TUI：`/shell` 打开选择列表（复用 `PickList`），列出本机检测到的种类与可执行文件路径，未安装的灰显不可选，当前值高亮；另有「自动（当前为 pwsh）」一项。Enter 应用并写入 `settings.json`，Esc 取消。`/shell <种类>` 直接切换。
- 当 `config.json` 或 `NOCTURNE_SHELL` 已指定 shell 时，页面顶部说明「当前由 config.json / 环境变量指定」，此时仍可写 `settings.json`，但提示它不会生效，直到移除上层设置。
- CLI 逐行模式：`/shell` 打印编号列表，`/shell <种类>` 切换。
- **生效时机**：从下一次 shell 工具调用开始（Turn 进行中也可切，已在执行的命令不受影响）。环境信息随之更新，下一次模型请求带上新的 shell 说明；提示缓存因此失效一次。
- 不记入会话日志：shell 是本机偏好，恢复会话时用当前设置。

### 5. 环境信息

- `pwsh` / `powershell`：说明「命令由 PowerShell 执行，用 PowerShell 语法」；pwsh 7 注明支持 `&&` / `||`；5.1 注明不支持 `&&`。
- `bash`（Git Bash）：说明「Git Bash，用 bash 语法；Windows 路径写成 `C:/…` 或 `/c/…`；以 `/` 开头的参数会被 MSYS 当成路径转换」。
- `cmd`：保留现有两句，加上 ADR-0021 第 9 条补的「`&` 不是后台」。
- `sh`：现状。

### 6. 权限层：按种类分段与高风险命令

- **分段**：`shellSegments` 按种类切分。PowerShell 除 `;`、`|`、`&&`、`||`、`$(` 外，还要切开脚本块 `{ … }`（如 `ForEach-Object { Remove-Item … }`），`&`（调用运算符）后面的内容照常作为一段求值。cmd、sh、bash 保持现有规则。
- **组合命令判定**（`isCompositeShell`，决定模式 allow 是否适用）同样按种类，PowerShell 的脚本块与 `;` 算组合。
- **高风险命令**（full-access 下仍询问，permissions.md 第 6 节第 5 项）按种类补全：
  - PowerShell：`Remove-Item` 及其别名（`rm`、`ri`、`del`、`erase`、`rd`、`rmdir`）同时带递归与强制参数（`-Recurse`、`-Force`，允许 PowerShell 的参数前缀缩写与任意顺序）；`Format-Volume`、`Clear-Disk`；`Stop-Computer`、`Restart-Computer`；`Invoke-Expression` / `iex`（动态代码无法静态审查）；`git push --force` / `-f`、`git reset --hard`。
  - cmd（补上现有缺口）：`rd /s`、`rmdir /s`、`del /s`、`erase /s`、`format`。
  - bash：沿用 POSIX 表。
- 模式匹配大小写：PowerShell 与 cmd 按不区分大小写匹配。
- 用户自己的 allow/deny 规则照旧按命令原文匹配，不因种类改变语义。

### 7. 分页工具拦截（接 ADR-0021 第 9 条）

按种类识别末尾分页：cmd 为 `more`；PowerShell 为 `more`、`Out-Host -Paging`（及 `oh -Paging`）；bash/sh 为 `more`、`less`。

## 后果

- 默认行为变化：装有 pwsh 7 的 Windows 机器，shell 工具从 cmd 换成 pwsh。模型写 cmd 专属语法（`%VAR%`、`dir /b`）会出错；环境信息已说明语法，模型下一步会改。CHANGELOG 写明，并提示可用 `/shell cmd` 换回。
- pwsh 每条命令多约 0.2–0.5 秒启动开销（`-NoProfile` 已去掉 profile 加载）。
- 权限层分段与高风险表按种类分支，测试面变大；安全相关部分要有逐条测试。
- `settings.json` 提前落地，v0.5 的设置层在此基础上扩展。
- 受影响文档：tools.md 第 6 节、permissions.md（分段与高风险表）、config.md（`shell`、`shellPath`、`settings.json`）、context.md 第 3 节、cli.md 与 tui.md（`/shell`）、`NOCTURNE_SHELL` 说明。
- Hooks（`spawnPipe` 直接启动可执行文件）与 MCP 不受影响。

## 备选方案

| 方案 | 结论 | 理由 |
|---|---|---|
| 保持 cmd，只靠提示词纠正语法 | 否决 | 已实测约束不住（`| more`、`&` 后台、中文 findstr、自行 chcp） |
| 只修 `NOCTURNE_SHELL`，按文件名配参数，不做选择页与设置 | 否决 | 用户要能在界面里选；环境变量对日常使用不友好 |
| 默认 Git Bash | 否决（作为第二顺位） | 模型最熟 bash，但 MSYS 路径转换常把 `/d`、`/s` 这类 Windows 参数改坏，Windows 原生工具调用别扭 |
| 默认 Windows PowerShell 5.1（系统自带） | 否决 | 原生命令 stderr 包装、编码处理差、不支持 `&&` |
| 用 `-Command "<命令>"` 传入 PowerShell | 否决 | 要再做一层 Windows 命令行转义，含引号的命令容易被改坏；`-EncodedCommand` 没有这个问题 |
| 选择写进会话日志、按会话记忆 | 否决 | shell 是本机环境偏好，不是会话内容；恢复到别的机器时旧值可能不存在 |
