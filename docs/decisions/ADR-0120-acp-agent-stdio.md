# ADR-0120：通过 `nctrn acp` 让外部宿主运行 Nocturne

- 状态：已接受（维护者确认：首版支持接单和经宿主 MCP 派单；公开 SDK 与跨进程恢复后置）
- 日期：2026-11-26

## 背景

用户希望从 Paseo 等多 agent 宿主选择 Nocturne，指派工作目录、跟进任务、查看工具调用，并在宿主里处理审批。已有三个相关入口，各自解决了其中一部分问题。

| 入口 | 当前用途 |
|---|---|
| `@nocturne/acp` | Nocturne 作为 ACP 客户端启动外部 agent，将其用作子代理。见 [ADR-0049](ADR-0049-external-agent-subagent.md)。 |
| `nctrn mcp` | 外部 agent 通过本机配对，调用已运行的桌面后台管理会话。见 [ADR-0074](ADR-0074-mcp-server-for-outside-agents.md)。 |
| `nctrn rpc --stdio` | 进程外客户端可使用 Nocturne 的 JSON-RPC 方法和事件；仓库内已有类型化客户端。见 [RPC 契约](../protocols/rpc.md)。 |

Paseo 已有通用 ACP provider：它能启动配置中的命令、进行协议握手，并把会话更新和权限请求呈现在自己的界面里。要接通这条链路，缺的是 **Nocturne 的 ACP agent 端**。[Paseo 自定义 provider](https://paseo.sh/docs/custom-providers)

## 决定

### 1. 入口与所有权

新增本地命令 `nctrn acp`，由宿主启动，无需打开 Nocturne 桌面端。`apps/cli` 负责装配现有 Runtime 和 provider、工具、配置、持久化及信任机制；在 `packages/acp` 增设独立的 agent 端入口，使用官方 ACP SDK，将消息映射到 Core 公开 API。既有外部子代理 connector 保持其客户端职责。Core 不依赖 ACP SDK，Agent Loop 无须识别 Paseo 或其他宿主。

一个 stdio 连接管理本进程创建的会话。`session/new` 校验并使用宿主给出的绝对 `cwd` 作为工作区；Paseo 已分配工作树时直接在该目录工作。工作树的创建、删除和分支合并由分配它的一方管理。模型及凭据沿用 Nocturne 本地配置。未配置可用模型时，返回可操作的配置错误，指引用户运行 `nctrn setup`。stdout 专用于协议帧，诊断走 stderr。

### 2. 第一版会话与审批契约

| ACP 交互 | Nocturne 的行为 |
|---|---|
| `initialize` | 协商协议版本，如实声明已实现的能力。首版承诺文本输入、同一连接内的多轮对话；跨进程 `session/load`、附件和动态切换模型另行扩展。 |
| `session/new`、`session/prompt` | 每个 ACP 会话绑定独立的 Core 会话。发送同一会话的后续 prompt 时保留上下文；同一会话忙时明确拒绝重入，其他会话的输出按会话 ID 隔离。 |
| `session/update` | 转发回复文本增量及工具的开始、更新和结束；同一次工具调用沿用同一个 ID，适当提供读、改、执行等类型及位置。最终 prompt 响应跟在该轮最后一次更新之后。 |
| `session/request_permission` | Core 权限层判为 `ask` 时，由适配器把该请求转给宿主，再把其一次性允许或拒绝回送给原请求。宿主拒绝、取消或断线时，待审操作不得执行。已有拒绝规则和项目可信度继续生效。 |
| `session/cancel`、EOF | 取消对应会话的在途 turn，收束审批和工具执行，向仍连接的宿主报告取消。关闭连接时只释放本进程持有的会话与资源，保留正常会话日志和宿主工作树。 |

### 3. 首版支持通过宿主 MCP 派单

`session/new.mcpServers` 为空时，Nocturne 可以独立接单。Paseo 开启工具注入后，Nocturne 在该会话中发现并调用宿主提供的编排工具，例如发起一项审查、查收另一 agent 的结果并向用户汇总。子任务的创建、跟踪和结果由宿主负责。工具名与参数取自 MCP 发现结果，适配器不绑定 Paseo 的名称或特定模型。[Paseo 编排说明](https://paseo.sh/docs/orchestration)

宿主声明来自启动本地 ACP 进程的客户端，只在对应会话内有效。复用已有 MCP 客户端的 stdio 和 Streamable HTTP 能力；握手按实际支持声明，无法接入的传输或同名冲突在建会话时明确报错并回收已分配资源。宿主注入不写入用户或项目 MCP 配置，不授予项目额外信任。注入工具与本地工具经过同一权限层；宿主随声明提供的环境值和请求头只交给目标服务器，不进入模型上下文、会话日志或其他会话。取消只中止本轮在途操作，宿主已启动任务的状态按宿主返回结果呈现。连接关闭时释放该连接拥有的 MCP 资源。

### 4. Paseo 接入验收

实现交付后的配置示例如下，位于 **Paseo 宿主**的 `~/.paseo/config.json`；宿主环境须能找到安装好的 `nctrn`。

```json
{
  "agents": {
    "providers": {
      "nocturne": {
        "extends": "acp",
        "label": "Nocturne",
        "command": ["nctrn", "acp"]
      }
    }
  }
}
```

1. 协议集成测试启动实际 CLI 子进程，以脚本化 provider 验证握手、双会话隔离、流式更新顺序、连续两轮、拒绝审批、运行中取消和断线收尾；检查 stdout 每一帧均可解析。以临时 MCP 服务验证空列表、非空注入、两会话同名服务器的工具与凭据隔离、拒绝时零执行，以及部分启动失败后的清理。
2. 真实 Paseo 使用发行版 CLI，关闭 Nocturne 桌面端，在宿主分配的临时工作树中发起两轮任务。核对工作目录、上下文延续和工具卡片；分别批准、拒绝一次文件修改，直接检查磁盘结果。
3. 从 Paseo 停止一项仍在运行的任务，核对对应工具结束、会话可接受下一轮，另一个会话与宿主工作树仍可用。记录系统、Paseo 版本、Nocturne 提交及 CLI 安装方式。单元测试通过与真实宿主验收分别记录。
4. 在隔离的 Paseo 配置中开启宿主工具注入，让 Nocturne 把一项只读审查派给另一个已配置的 agent，取得结果后在原会话汇总。核对宿主任务 ID、工具调用和实际产出；仅列出工具或在回复里声称已派单，都不足以通过这一项。

## 后果与备选方案

- 标准 ACP 入口可以由多个宿主复用。发布时需把 agent 端打入 CLI 安装包，并承担所声明能力的跨版本兼容测试；Nocturne 原生事件中超出 ACP 表达能力的细节仍可在本地会话记录查看。
- **Paseo 专用插件**可以直接消费现有 RPC，但需要维护 Paseo 专属的会话、事件和审批映射。通用 ACP provider 已能承载本轮目标；以后确有专属展示需求时，再评估插件。[Paseo provider 插件](https://paseo.sh/docs/plugins/providers)
- **公开 TypeScript SDK**服务于自行编写客户端的开发者。仓库已有 `@nocturne/rpc/client`，其包目前为 `private`。有独立消费者后再决定公开包名、支持的 Node 版本、进程生命周期和兼容承诺；首版交付 CLI 协议入口。
