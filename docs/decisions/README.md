# 架构决策记录（ADR）

ADR 只记录满足以下至少一条的决定：难以逆转；影响多个模块；存在明显取舍；将来很可能有人问"为什么当初这么设计"。日常的小决定写在对应设计文档里即可。

## 索引

| 编号 | 标题 | 状态 |
|---|---|---|
| [ADR-0001](ADR-0001-typescript-node.md) | 使用 TypeScript + Node.js 实现 | 已接受 |
| [ADR-0002](ADR-0002-ui-independent-core.md) | Core 与 UI 解耦：命令进、事件出 | 已接受 |
| [ADR-0003](ADR-0003-session-event-log.md) | 追加式事件日志作为会话唯一事实来源 | 已接受（第 2 版） |
| [ADR-0004](ADR-0004-permission-rules.md) | 规则化的权限策略层 | 已接受（第 2 版） |
| [ADR-0005](ADR-0005-own-provider-interface.md) | 自有 Provider 接口，不暴露第三方 SDK 类型 | 已接受（第 2 版） |
| [ADR-0006](ADR-0006-anthropic-transport.md) | anthropic 适配器使用 @ai-sdk/anthropic 传输 | 已接受 |
| [ADR-0007](ADR-0007-config-format.md) | 配置文件格式与分层 | 已接受 |
| [ADR-0008](ADR-0008-project-trust-grants.md) | 项目配置信任模型与 Grant 持久化 | 已接受 |
| [ADR-0009](ADR-0009-session-lock.md) | 会话锁机制 | 已接受 |
| [ADR-0010](ADR-0010-tui-rendering.md) | TUI 渲染方案：Ink + React | 已接受 |
| [ADR-0011](ADR-0011-mcp-client.md) | MCP 客户端：独立包 + 官方 SDK + 自定义 stdio 传输 | 已接受 |
| [ADR-0012](ADR-0012-hooks.md) | Hooks：外部命令 + JSON 契约 + 复用项目信任 | 已接受 |
| [ADR-0013](ADR-0013-subagent.md) | Subagent：注入式 launcher、非交互权限收敛、普通会话日志 | 已接受 |
| [ADR-0014](ADR-0014-stream-timeout-empty-response.md) | 流式超时与空响应的失败语义 | 已接受 |
| [ADR-0015](ADR-0015-provider-setup-credentials.md) | 服务商配置向导、机器维护的向导配置层与操作系统凭据后端 | 已接受 |
| [ADR-0016](ADR-0016-model-limits-from-upstream.md) | 模型上下文窗口与最大输出长度以上游声明为准 | 已接受 |
| [ADR-0017](ADR-0017-model-picker-alternate-screen.md) | 模型选择页使用终端备用屏幕 | 已接受 |
| [ADR-0018](ADR-0018-reasoning-effort.md) | 思考强度：统一中性档位、按声明决定可用档位、适配器归一化 | 已接受 |
| [ADR-0019](ADR-0019-tui-visual-provider-page.md) | TUI 视觉风格与服务商页重构 | 提议 |

状态取值：`提议`（等待确认）、`已接受`、`已废弃`、`被 ADR-xxxx 取代`。已接受的 ADR 不修改正文；改变决定时新增 ADR 并更新旧 ADR 的状态。

## 模板

```markdown
# ADR-xxxx：标题

- 状态：提议
- 日期：YYYY-MM-DD

## 背景
需要做决定的原因与约束。

## 决定
决定了什么。

## 后果
正面与负面影响，以及由此带来的约束。

## 备选方案
考虑过但没有采用的方案，以及理由。
```
