# 记忆

Nocturne 支持跨会话记忆，让模型把用户的偏好、纠正过的做法与项目约束保存下来，并在后续新会话启动时自动带上目录索引。

## 存储位置与范围

所有记忆文件都保存在用户数据目录 `~/.nocturne/memory/`（可通过 `NOCTURNE_HOME` 修改）下，**不会写入任何工作区仓库**：

- **全局记忆（`global`）**：`~/.nocturne/memory/global/`，对所有工作区生效。
- **项目记忆（`project`）**：`~/.nocturne/memory/projects/<目录名>-<8 位哈希>/`，仅在当前工作区生效，目录下附带 `workspace.json` 记录主仓库路径。
  - 如果工作区位于 Git 仓库中，项目键取**主仓库**根目录的规范路径哈希：主目录与通过 `git worktree` 创建的工作树共用同一份项目记忆。
  - 普通对话使用的默认工作区（`~/.nocturne/workspace`）没有项目范围，仅使用全局记忆。

## 文件格式

每条记忆是一个独立的 `<name>.md` 文件，名称需满足 `^[a-z0-9][a-z0-9-]*$`（同范围内唯一），顶部带有 YAML 前言：

```markdown
---
name: build-command
description: 提交前需先通过 typecheck 与 lint
type: project
---

修改 TypeScript 代码后先运行 pnpm typecheck 与 pnpm lint。
```

- `type` 取值为 `user`、`feedback`、`project` 或 `reference`。
- Nocturne 不维护单独的索引文件，每次快照直接扫描目录中的 `.md` 文件并解析前言；前言损坏或文件名不规范的条目会跳过并记入警告。你可以直接用编辑器修改或删除这些 Markdown 文件。

## 如何进入上下文

- 在「项目指令（`AGENTS.md`）」之后、「技能目录」之前，Nocturne 会为每个已开启且可用的范围注入一个 `<memory scope="...">` 索引块，每条占一行（`- <name> (<type>): <description>`），空范围显示为 `(empty)`。
- 系统提示里只放索引，不放正文；模型需要某条记忆的详细内容时，通过 `memory_read` 按需读取全文。
- 单个范围的索引上限为 `25,000` 字符，超出后按行截断并标记。
- 索引快照在**会话打开（新建、恢复、分叉）**和**每次 L2 摘要压缩完成后**各取一次；普通对话轮次之间不刷新，以免打断提示词缓存前缀。会话中途写入的新记忆不会改写当前会话的系统提示，模型通过工具返回结果即可知晓已保存的内容。

## 读写权限

不同会话角色对长期记忆的权限不同：

- **可读写**（注入索引，可使用 `memory_read`、`memory_write`、`memory_delete`）：用户发起的交互顶层会话（桌面端、手机端、TUI、交互式 CLI）以及合奏指挥。
- **只读**（注入索引，仅可使用 `memory_read`）：合奏成员、外部 Agent 经 MCP 开启的会话、定时任务会话以及 `nctrn -p` 等非交互运行。
- **不可用**（不注入索引，也不挂载任何记忆工具）：一次性 `task` 子代理（含 `explore`）与外部 ACP Agent。

## 开关、压缩与回退

- 开关存放在用户级 `~/.nocturne/settings.json` 的 `memory.global` 与 `memory.project`（默认均为 `true`）。项目级 `.nocturne/config.json` 中的 `memory` 配置会被忽略。
- 关闭某个范围后，该范围不再注入上下文也不能被工具读写，但已有记忆文件会保留在磁盘上；开关变更对之后打开的会话生效。
- 记忆文件独立于会话日志：**回退（rewind）** 与 **分叉（fork）** 不会撤销或复制已写入的记忆文件；L2 摘要也不会把记忆内容重复总结进摘要文本。
