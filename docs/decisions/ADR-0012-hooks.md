# ADR-0012：Hooks——外部命令 + JSON 契约 + 复用项目信任

- 状态：已接受
- 日期：2026-09-24
- 相关：[architecture/hooks.md](../architecture/hooks.md)、[ADR-0008](ADR-0008-project-trust-grants.md)、[permissions.md](../architecture/permissions.md)

## 背景

Phase 5 要给 Runtime 加 Hook：在固定事件点（PreToolUse、PostToolUse、PermissionRequest、会话/Turn 生命周期）允许配置驱动的外部干预。要决定 Hook 的形态、输出语义与信任模型。

## 决定

1. **形态：外部命令**。每个 Hook 条目是 `command + args`，stdin 收 JSON 上下文、stdout 回 JSON 结果，退出码非零或输出不可解析记失败。进程经 `platform.spawnPipe` 启动（与 MCP 共用），超时强杀进程树。
2. **输出是建议，权限留在权限层**：Hook 输出的 `deny`/`ask`/`updatedInput`/`feedback`/`block` 按点位限定语义；`PreToolUse` **没有 `allow`**——它在权限主体解析之前运行，看到的是未解析的原始输入（`foo/link` 可能解析到工作区外），不能基于它批准解析后才知道目标的操作；放宽 `ask` 的唯一点位是 `PermissionRequest`（拿到已解析主体），其 `allow` 也永远不能越过规则 `deny`。Hook 强制的 `ask` 跳过 Grant 与 `autoApproveAsk` 提升——收紧不能被自动批准抵消。决策合并进既有管线，权限求值仍在 permission 层。
3. **失败 = 无效果 + 警告**：超时/非零退出/输出过大/无法解析都不阻塞管线，`runtime.warning{code:"hook_failed"}` + 诊断记录。例外是 `PermissionRequest`——失败即"没有回答"，继续询问用户。
4. **信任复用 `trust.json`**：项目级 `hooks` 段在 `.nocturne/config.json` 未信任时**整段不执行**（不是运行后限制输出——进程一启动就没有输出语义可约束），与 ADR-0008 的"项目配置默认收紧、显式信任后才完整生效"同一条线。

## 备选方案

| 方案 | 评价 |
|---|---|
| 进程内 JS Hook（在 Runtime 里跑用户脚本） | 需要沙箱（VM 隔离、资源限制、能力收敛）才有意义，裸跑等于把 Runtime 内部状态交给第三方代码；外部命令天然有进程边界——放弃 |
| 声明式 Hook（配置里写 allow/deny 规则，不执行命令） | 权限规则本身已经覆盖收紧语义；Hook 的价值恰恰在"执行外部逻辑"（审批网关、审计、自定义检查），声明式没有增量价值 |
| 未信任项目 Hook 也执行，但输出 clamp 到收紧 | Hook 一旦执行就是任意代码——clamp 输出约束不了进程本身的副作用（联网外传、改文件）。未信任 = 不执行，是 ADR-0008 语义的正确延伸 |
| Hook 信任单独一套（`hooks.trust` 独立标志） | 项目级配置已经有统一的信任判定；为 Hook 再开一套会让"信任"语义碎片化——复用 `trust.json` |
| 失败时 fail-closed（Hook 挂了就拒绝工具调用） | 把 Runtime 可用性绑在外部脚本正确性上；Hook 是可选增强，不该成为新的单点故障——采用降级为无效果 + 警告 |

## 后果

- `PermissionSource` 枚举新增 `"hook"`（`permission.resolved.source` 可取值）；协议层面是纯增量的兼容变更。
- 不为 Hook 新增持久事件：效果已体现在 `permission.resolved`/`tool.completed`/`turn.completed`；诊断走 `hook.run`/`hook.done`（observability.md）。
- 未配置 Hook 时 Runtime 行为与事件序列和 Phase 4 完全一致（验收的回归断言）。
- 上下文注入类 Hook（SessionStart 附加提示词等）本阶段不做，见 hooks.md 第 8 节。
