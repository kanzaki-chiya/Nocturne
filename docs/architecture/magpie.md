# Magpie 接入

> 状态：已接受 v0.1 ｜ 前置阅读：[config.md](config.md)、[providers.md](providers.md) ｜ 决策：[ADR-0062](../decisions/ADR-0062-magpie-agent-plugin.md) ｜ 用户说明：[packaging/magpie-plugin/README.md](../../packaging/magpie-plugin/README.md)

Magpie 是本机网关，持有上游订阅账号与 API 服务商。Magpie 的 Agent 插件（本仓库 `packaging/magpie-plugin`）让用户在 Magpie 的 Agent 页连接 Nocturne、选模型；Nocturne 把 Magpie 当作一个只读的服务商来源。Agent Loop、上下文、工具与权限完全留在 Nocturne，上游路由与订阅鉴权完全留在 Magpie。

## 1. 分工

| | Magpie | Nocturne |
|---|---|---|
| 插件 | 加载 `agent.js`，调用 `connect`，逐键写入、暂存原值、断开时还原 | 不感知插件 |
| 文件 | 写 `<NOCTURNE_HOME>/magpie.json`（默认 `~/.nocturne/magpie.json`） | 只读；从不写、从不复制其中的 key |
| 服务商 | 上游账号与 API key | 一条名为 `magpie` 的服务商，指向本机网关 |
| 模型 | 清单、上下文、档位、直通接口、价格 | 把清单声明当作逐模型配置，高于 models.dev |

## 2. `magpie.json` 契约

由插件 `connect` 的返回值按点路径写成，形状如下（Nocturne 只读取这些字段，未知字段忽略）：

```json
{
  "model": "magpie/or/anthropic/claude-sonnet",
  "magpie": {
    "baseURL": "http://127.0.0.1:3425/v1",
    "key": "magpie-nctrn",
    "models": [
      {
        "id": "or/anthropic/claude-sonnet",
        "name": "claude-sonnet · OR",
        "context": 200000,
        "output": 64000,
        "images": true,
        "efforts": ["low", "medium", "high"],
        "endpoints": ["/v1/messages"],
        "pricing": { "input": 3, "output": 15, "cacheRead": 0.3 }
      }
    ]
  }
}
```

| 字段 | 含义 |
|---|---|
| `model` | 默认模型，`magpie/<网关模型 id>`；不以 `magpie/` 开头时忽略 |
| `magpie.baseURL` | 网关 OpenAI 兼容地址（以 `/v1` 结尾）。**存在即视为已接入** |
| `magpie.key` | Magpie 为 Nocturne 签发的本机网关 key，不是上游凭据；只由 `external-file` 鉴权在请求时读取 |
| `models[].id` | 网关返回的完整模型 id，请求体里原样作为 `model`，可含多个斜杠 |
| `models[].name` | 显示名 |
| `context` / `output` | 上下文窗口与最大输出；未知时省略（不写 0） |
| `images` | 是否接受图片输入；未知时省略 |
| `efforts` | 思考档位；只认 Nocturne 已知六档（`minimal`…`max`），未知值忽略；空则省略 |
| `endpoints` | 网关不经翻译直通的接口路径（Magpie 的 `native_endpoints`） |
| `pricing` | USD / 每百万 token（`input`、`output`、`cacheRead`、`cacheWrite`）；插件把 Magpie 的 USD/token 字符串换算而来 |

无效的模型条目逐条忽略并告警，其余继续生效。

## 3. 加载与合并

`loadMagpieLayer`（`packages/core/src/config/magpie.ts`）在 `loadConfig` 时读取一次文件，转成一份 `ConfigFile` 层（`kind: "magpie"`）：

```text
… < 程序设置 < 用户配置 < Magpie 接入 < 项目配置 < 环境变量 < 命令行参数
```

层里只有两项：`model` 与一条服务商条目：

```jsonc
{
  "id": "magpie",
  "displayName": "Magpie",
  "type": "openai-compatible",
  "baseURL": "<magpie.baseURL>",
  "auth": { "kind": "external-file", "path": "<magpie.json 的路径>", "keyPath": ["magpie", "key"], "renewHint": "在 Magpie 的 Agent 页重新连接 Nocturne" },
  "sessionHeader": "X-Magpie-Session",
  "models": { "<id>": { "displayName", "contextWindow", "maxOutputTokens", "capabilities", "endpoints", "pricing" } }
}
```

- 协议按 ADR-0026 推导：`endpoints` 含 `/chat/completions` → Chat，含 `/messages` → Messages，含 `/responses` → Responses；没有声明（路由组、经网关翻译的订阅模型）回落到条目类型 Chat。Core 与 Agent Loop 不出现服务商分支。
- 用户级条目：项目配置不能改它的 `baseURL`、`headers`、`auth`（ADR-0042 §2）。
- 模型字段来源标为「上游」，不可在 Nocturne 内编辑；`/provider` 里该条目只读（`managed: false`、`origin: "magpie"`）。
- 价格来自 Magpie 里用户设定的有效价格；订阅账号的真实额度与计费以 Magpie 为准，Nocturne 的费用只是估算（[usage.md](usage.md)）。

## 4. 生命周期

| 操作 | Magpie 写入 | Nocturne 行为 |
|---|---|---|
| 连接 | `model` 与 `magpie.{baseURL,key,models}` | 下次启动/重载起出现服务商 `magpie`，默认模型为所选模型 |
| 切换模型 | 只改 `model`（并重写同样的 `magpie.*`） | 下次新会话的默认模型随之改变；已有会话不变 |
| 模型清单变化 | Magpie 的模型变化时再次调用 `connect`，重写 `magpie.models` | 重启或重载后出现新模型 |
| 轮换 key | 重写 `magpie.key` | 下一次请求读到新 key，无需重启 |
| 断开 / 选 Nocturne 自己的模型 | 还原：删除写过的键（原先已有的键恢复原值） | 视为未接入，默认模型回到 settings / config 的值；残留的 `{"magpie": {}}` 无影响 |

Nocturne 其他配置文件、凭据与会话从不被 Magpie 触碰。断开时 `magpie.json` 被改回写入前的内容；写入前文件不存在时留下 `{"magpie": {}}`（Magpie 不删除文件）。

## 5. 失败与诊断

| 现象 | 原因与处理 |
|---|---|
| `/provider` 里没有 `magpie` | 文件不存在、没有 `magpie.baseURL`（已断开），或 Nocturne 数据目录不是 `~/.nocturne`（见下） |
| 启动告警 `magpie_config_invalid` | 文件损坏或形状不符；重新在 Magpie 里连接。无效模型条目只忽略该条 |
| 请求报「未找到可用的外部登录凭据，请先执行 在 Magpie 的 Agent 页重新连接 Nocturne」 | `magpie.key` 缺失或文件被改坏；重新连接 |
| 401 | 网关 key 被撤销或 Magpie 重置了 key；重新连接，或在 Magpie 里检查该 key |
| 模型不可用 / 不在清单里 | 该模型在 Magpie 里被移除；在 Magpie 页重新选择并重启 nctrn |
| 请求连不上 | Magpie 没有运行，或网关地址/端口变了；启动 Magpie，必要时重新连接 |

自定义 `NOCTURNE_HOME`：插件的文件路径固定为 `~/.nocturne/magpie.json`（插件路径里的 `$VAR` 未设置时会展开为空串，故不使用变量）。需要时把 `<NOCTURNE_HOME>/magpie.json` 链接到该文件。

## 6. 测试

`packages/core/test/magpie-layer.test.ts`：层加载、优先级、断开残留、损坏文件、项目重定向防护、概览、按模型选协议、插件契约（调用真实的 `agent.js`），以及本地模拟网关上的流式与工具调用往返（Chat、Messages）、key 轮换。真实 Magpie 应用与真实上游的联调见 [ADR-0062](../decisions/ADR-0062-magpie-agent-plugin.md) 的「验证」。
