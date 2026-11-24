# ADR-0118：子目录 AGENTS.md 按需加载

- 状态：已接受（2026-11-24）
- 相关：[上下文管理](../architecture/context.md)、[ADR-0028](ADR-0028-session-task-list.md)、[ADR-0095](ADR-0095-session-notes-board-read.md)、[ADR-0071](ADR-0071-mcp-availability-notes.md)

## 背景

项目指令在打开会话时收集，包括用户级 `<NOCTURNE_HOME>/AGENTS.md`，以及从 `workspaceRoot` 到 `cwd` 路径上各级目录的 `AGENTS.md`。模型从仓库根目录访问 `packages/core/` 时，也需要看到 `packages/core/AGENTS.md`。按需加载使各目录可以维护自己的指令，并在摘要后保留原文。

## 1. 触发

工具成功结算后，取已批准权限主体的 `resolved` 路径（[事件协议](../protocols/events.md#4-公共数据类型)）。文件从父目录查找，目录从自身查找。沿工作区根目录到目标目录自顶向下查找 `AGENTS.md`，跳过已经放入 system 或在本会话有效日志中记录过的文件。只处理实际位于工作区内的路径。命令主体只提供命令文本。`task` 子代理与合奏成员各自计算其有效加载记录。

## 2. 记录与注入

在触发的 `tool.completed` 之后追加 `instructions.loaded { files: { source, content, truncated? }[], skipped? }`。`source` 与 `skipped` 使用工作区相对路径。每条事件折叠成一条 user 角色 note，同批工具的全部结果就位后才投影。回放和恢复使用保存的文件快照。

```text
Project instructions for a directory you just accessed. They apply to files under that directory and take precedence over default practices:
<instructions source="packages/core/AGENTS.md">
…
</instructions>
```

每个文件最多读取 64 KiB 的正文，截断会标注。会话正文上限见[上下文管理](../architecture/context.md#3-组装顺序稳定的放前面)。超出后，前言之后的一行列出跳过的文件。按需注入只追加历史，保留已有的请求前缀与 system。

事件 schema 沿用非严格对象，不提升 `formatVersion`。旧 Runtime 遇到该未知持久事件会报 `session_log_newer` 并拒绝恢复，旧只读客户端会忽略该事件。

## 3. 压缩

L1 保留 note。每次 L2 摘要生效时，在摘要后、会话笔记与任务清单补注前，按 `source` 顺序重新注入当时仍有效的快照。此后的新事件继续追加到历史，直到下一次摘要。摘要固定指令保持原样。

历史中的 note 计入 `history.breakdown.user`。摘要后的补注在 `ContextReport` 中单列 `subdirInstructions`，`source` 记录文件列表。桌面上下文面板与 TUI `/context` 显示「子目录说明」。

## 4. 回退与分叉

已加载集合以有效事件为准。会话回退撤销加载记录后，下次访问会重新读取。分叉继承来源前缀中的加载记录。仅还原文件时保留加载记录。

## 5. 范围

目录使用 `AGENTS.md`，加载依据是工具批准的目标路径。客户端只在上下文统计中显示补注。修改磁盘文件后，可在新会话或撤销加载记录后重新访问该目录来读取新版。
