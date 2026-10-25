# Nocturne 的 Magpie Agent 插件

让 [Magpie](https://usemagpie.ai) 的 Agent 页多出一行 **Nocturne**：在 Magpie 里连接、选模型，Nocturne（`nctrn`）就用 Magpie 管理的订阅账号和 API 服务商。Nocturne 仍然自己负责对话、上下文、工具和权限；上游账号与密钥只留在 Magpie。

## 安装

需要已安装 Magpie 与 Nocturne。在本目录（或把本目录拷到任意位置）执行：

```bash
magpie plugin add <本目录的路径>
```

也可以在 Magpie 的「设置 › 插件」里添加本地目录。安装后打开 Agent 页，应能看到 **Nocturne**。没看到时见下面的排查。

## 连接

1. 在 Magpie 的 Agent 页找到 Nocturne，打开开关或在模型列表里选一个 Magpie 的模型。
2. 重启 `nctrn`（或在桌面版里重新打开），Nocturne 会出现名为 **Magpie** 的服务商，选中的模型成为默认模型。用 `/provider` 可以看到它（只读），`/model` 里能看到 Magpie 的全部模型。

接入后 Nocturne 里的其他服务商、默认值和设置都原样保留。

## 切换模型

在 Magpie 的 Agent 页换一个模型，重启 `nctrn` 后生效（新会话使用新的默认模型）。正在进行的会话继续用自己的模型；会话内仍可用 `/model` 临时切换到 Magpie 的任意模型。

接入期间，默认模型由 Magpie 决定：在 Nocturne 里「设为默认」会被 Magpie 的选择覆盖（设置页会标出来源是 Magpie）。想用别的默认模型，就在 Magpie 里选，或断开。环境变量 `NOCTURNE_MODEL` 与命令行 `--model` 仍然优先。

## 模型列表更新

在 Magpie 里添加或移除服务商、账号后，Magpie 会自动更新写给 Nocturne 的模型清单。重启 `nctrn` 后新清单生效。模型名称 id 以 Magpie 返回的为准（形如 `provider/model`，可能含多个斜杠），不要自己改写。

## 断开

在 Magpie 的 Agent 页关掉 Nocturne 的开关，或选 Nocturne「自己的模型」。Magpie 会还原它写过的内容，Nocturne 回到原来的服务商与默认模型。之后重启 `nctrn`。此前用过 Magpie 模型的会话，恢复时按「模型不可用」处理，需要换一个模型。

## 它写了什么

Magpie 只改一个文件：`~/.nocturne/magpie.json`（`NOCTURNE_HOME` 默认位置下），内容是网关地址、Magpie 为 Nocturne 签发的本机客户端 key 和模型清单。Nocturne 只读这个文件。`config.json`、`providers.json`、`settings.json` 与凭据存储不会被改动，上游 API key 与订阅登录也不会复制进 Nocturne。

文件契约与分层规则见 Nocturne 文档 `docs/architecture/magpie.md`。

## 故障排查

| 现象 | 处理 |
|---|---|
| Magpie 的 Agent 页没有 Nocturne | 确认插件已启用（设置 › 插件）；插件页若显示加载失败，按提示修正。Magpie 通过 `~/.nocturne` 目录或 `nctrn` 命令判断是否已安装，未检测到时先安装 Nocturne |
| 连接后 `/provider` 里没有 Magpie | 重启 `nctrn`。仍没有就检查 `~/.nocturne/magpie.json` 里是否有 `magpie.baseURL`；用了自定义 `NOCTURNE_HOME` 时见下一行 |
| 自定义了 `NOCTURNE_HOME` | 插件只会写 `~/.nocturne/magpie.json`。把 `<NOCTURNE_HOME>/magpie.json` 链接到该文件 |
| 请求连不上 | Magpie 没在运行，或网关端口变了：启动 Magpie；端口变了就在 Agent 页重新连接 |
| 401 / 「请在 Magpie 的 Agent 页重新连接 Nocturne」 | 网关 key 被撤销或文件被改坏：在 Agent 页断开再连接 |
| 启动告警 `magpie_config_invalid` | `magpie.json` 损坏或被手改；在 Magpie 里重新连接。无效的模型条目会被单独忽略 |
| 选了模型但 Nocturne 用的是别的 | 优先级更高的来源在覆盖：`NOCTURNE_MODEL`、命令行 `--model`、可信项目配置里的 `model`。`/settings` 的默认模型会标出来源 |
| 模型不在 `/model` 列表里 | 在 Magpie 里该模型已被移除或服务商未启用；重启 `nctrn` 刷新 |

## 开发

插件由 `package.json` 的 `magpie.agent` 指向 `agent.js`。它运行在 Magpie 进程内的 moejs 中，没有 Node API，只导出 `agent` 与 `connect`，不含网络请求。改动后在 Magpie 里重新加载插件即可。
