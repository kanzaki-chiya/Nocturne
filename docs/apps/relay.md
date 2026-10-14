# 中继服务

> 状态：第 3 轮已实现｜前置：[ADR-0052](../decisions/ADR-0052-remote-web-client.md)｜线上协议：[relay.md](../protocols/relay.md)

`@nocturne/relay` 是独立 Node ≥24 服务，使用 Node http 与 ws noServer；只依赖 remote 和 ws，不依赖 Core/RPC，后两者只用于开发测试。不解析、不缓存密文内容。默认 public/index.html 保留中文占位页，第 5 轮手机网页用 `--web-root apps/desktop/dist-web` 托管；发布物集成与 HTTPS 真机验收在第 6 轮。

## 配置

优先级：命令行 > NOCTURNE_RELAY_* 环境变量 > dataDir/relay.json > 默认值。dataDir 先从参数/环境变量定位，默认 ./relay-data。

| 字段 | 参数 / 环境变量后缀 | 默认值 |
|---|---|---|
| listen | --listen / LISTEN | 127.0.0.1:8787 |
| publicOrigin | --public-origin / PUBLIC_ORIGIN | 必填，小写 origin 无尾斜杠 |
| dataDir | --data-dir / DATA_DIR | ./relay-data |
| webRoot | --web-root / WEB_ROOT | 包内 public/ |
| trustProxy | --trust-proxy / TRUST_PROXY | false；启用后取 X-Forwarded-For 最右项 |
| pushHosts | --push-hosts / PUSH_HOSTS | 协议第 7 节允许表；参数/环境变量逗号分隔 |
| vapidSubject | --vapid-subject / VAPID_SUBJECT | publicOrigin |
| allowInsecurePush | --allow-insecure-push / ALLOW_INSECURE_PUSH | false，仅本地测试用 |
| limits | --limits / LIMITS | JSON 对象，默认如下 |

limits：devices=5、connections=10、ratePerMinute=10、maxFrame=1048576、slowConsumer=8388608、authTimeoutMs=10000、pairLifetimeMs=60000、slotLifetimeMs=300000、heartbeatMs=30000。超时字段可缩短供离线测试；设备/帧/限流配置可调整。host maxPayload=maxFrame+4、device=maxFrame、pair=4096。控制帧硬上限 16 KiB。来源令牌桶计入登记、配对与认证失败（邀请码错误由登记计入），默认每分钟补充 10 个令牌，容量 10。

## 数据与管理

relay-data.json v1 存 invites(hash/note?/createdAt/expiresAt/usedAt?)、hosts(id/pub/note?/createdAt/lastSeenAt?/revokedAt?)、devices(id/hostId/pub/name/createdAt/lastSeenAt?/revokedAt?/push?)；时间为 Unix 毫秒。push 为 endpoint/p256dh/auth。先临时写入再 rename，写操作串行。POSIX 目录 0700、文件 0600。lastSeenAt 最多每 60 秒合并写盘，关闭刷盘。管理员吊销墓碑永久保留；remove/unregister 不得清除墓碑。

管理命令（中文输出，列表时间为本地时间）：

```text
nocturne-relay serve [配置参数]
nocturne-relay invite create [--note <名字>] [--expires 7d] [--data-dir <目录>]
nocturne-relay invite list [--data-dir <目录>]
nocturne-relay host list [--data-dir <目录>]
nocturne-relay host revoke <id> [--data-dir <目录>]
nocturne-relay device list [--host <id>] [--data-dir <目录>]
nocturne-relay device revoke <id> [--data-dir <目录>]
```

expires 支持正整数 h/d，默认 7 天。invite create 输出明文邀请一次；invite list 仅显示有效邀请 hash 前 8 位、备注、过期时间。服务未运行时「中继未运行」，退出码 1。管理命令只连接服务，不直接改数据文件。吊销立即断开 4003，并拒绝重新认证。

管理通道为逐行 JSON request/response；POSIX dataDir/admin.sock（0600），Windows `\\.\pipe\nocturne-relay-<SHA-256(dataDir绝对路径)前16位hex>`。依赖 OS 权限，不设令牌。不抢占已有 socket。

## 网络、安全与日志

有 Origin 的 upgrade 必须等于 publicOrigin，否则 HTTP 403；无 Origin 放行。每 30 秒 ping，下一周期未 pong terminate。转发前目标 bufferedAmount 超 8 MiB，4007 关闭目标。

GET/HEAD 静态路径需位于 webRoot 内（也检查 realpath，拒绝穿越/外部符号链接）。按扩展名 Content-Type；index no-cache，其余 max-age=300。统一 CSP、nosniff、no-referrer，精确 CSP 见源码与线上协议。
connect-src 根据 publicOrigin 显式允许对应 WebSocket 源；worker 与 manifest 仅同源，不开放内联脚本/样式或 eval，精确主表在 [relay 协议第 2 节](../protocols/relay.md#2-邀请与-http)。

stdout JSON 行只含 time、event(connect/auth_ok/auth_failed/close/register/revoke/push)、role、id、code、received/sent 字节数、source。**不记帧内容、邀请码、签名、推送 endpoint**；邀请码只由管理命令返回。

信任边界：必须信任维护者及服务器未篡改下发网页，端到端加密不能阻止恶意网页取走解密后的内容，见 [ADR-0052 第 4 节](../decisions/ADR-0052-remote-web-client.md#4-端到端加密)。

部署示例：待第 6 轮补充。
