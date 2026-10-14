# 中继协议

> 状态：已接受 v1（2026-10-14）｜决策：[ADR-0052](../decisions/ADR-0052-remote-web-client.md)｜实现：`packages/remote/src/relay`、`apps/relay`

本文是中继线上协议的唯一主文档。部署、存储和管理见 [中继应用](../apps/relay.md)，加密通道见 [remote-channel.md](remote-channel.md)。

## 1. 编码与来源

`origin` 是中继配置的 `publicOrigin`：小写 URL origin，无尾斜杠。客户端签名用自己连接的 origin，不同 origin 签名不互通。编码、身份 id、64 字节 P-256 ECDSA 签名与转录 `T` 沿用加密通道第 1 节。

控制消息为 WebSocket 文本帧里的 JSON 对象，`t` 为类型，字段必须恰好匹配；多余、缺失、未知类型或超过 16 KiB（UTF-8 字节）为 `protocol_error`。二进制帧承载通道帧；中继只处理路由头，不解析通道内容。

## 2. 邀请与 HTTP

邀请码 `code=b64u(random(18))`，24 字符；只存 SHA-256(code)。邀请串 `nocturne-invite:<host[:port]>/<code>`。`parseInvite` 接受首尾空白、主机名转小写，返回 `{origin:"https://<host[:port]>",code}`；拒绝路径、查询、用户信息、http 和其他格式，抛 `RemoteChannelError("protocol_error")`。

`POST /v1/register` 请求 `{code,pub,sig}`；签名为 `Sign_IdH(T("nocturne/relay/v1/register",origin,code,pubH))`（pubH 为 raw 字节）。成功 `200 {hostId}`，邀请同时作废。不存在、过期、已用、签名错误、已吊销身份统一 `403 {error:"invalid_invite"}`；同公钥已登记未吊销 `409 {error:"already_registered"}`；来源超限 `429`。

`GET /v1/info` 返回 `{protocol:1,relayVersion,vapidPublicKey}`（raw P-256 公钥的 b64u）；`GET /healthz` 返回 `ok`。

所有 HTTP 接口与静态资源带 CSP：`default-src 'self'`、`script-src 'self'`、`style-src 'self'`，`connect-src 'self'` 加配置 `publicOrigin` 对应的 `wss://`（http 开发环境为 `ws://`）源，`worker-src 'self'`、`manifest-src 'self'`、`img-src 'self' data:`、`object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`；不允许 unsafe-inline/unsafe-eval。另带 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。手机 SW 不拦截 fetch、不缓存页面，行为见 [手机网页](../apps/desktop.md#8-手机网页)。

## 3. 电脑入口 `/v1/host`

中继先发 `{t:"challenge",n:b64u(random(32))}`，10 秒内须回 `{t:"auth",id:hostId,sig}`。签名 `Sign_IdH(T("nocturne/relay/v1/host",origin,n,hostId))`，按已登记且未吊销公钥验签。成功 `{t:"ok"}`。失败或超时统一 `4004 auth_failed`，不说明原因。同 hostId 只允许一条连接，新连接认证成功后旧连接 `4001 replaced`。

| 电脑 → 中继 | 回复 / 行为 |
|---|---|
| `{t:"pair.open"}` | `{t:"pair.slot",slot,expiresAt}`，slot 为 16 字节 b64u，5 分钟一次性，最多 3 个未用槽位，超出 `{t:"error",code:"limit"}` |
| `{t:"device.allow",id,pub,name}` | 校验 id(pub)===id，name 1–64 Unicode 码点、管理员未吊销、设备数小于上限（默认 5）；成功 `{t:"device.allowed",id}`；失败 error code 为 limit、revoked 或 protocol_error；同 host/id 已存在时更新 name |
| `{t:"device.remove",id}` | 删除未吊销记录（允许重新配对），断开该设备在本电脑的全部连接 4003，回 `{t:"device.removed",id}` |
| `{t:"devices"}` | `{t:"devices",list:[{id,name,createdAt,lastSeenAt,online,push}]}`；push 为订阅存在布尔值，尚无 lastSeenAt 时用 null |
| `{t:"push"}` | 每电脑每 30 秒最多一次无载荷推送，回 `{t:"push.sent",count}`，count 为实际发出的请求数；限频回 count:0，不发请求 |
| `{t:"conn.close",conn}` | 关闭对应配对或设备连接 |
| `{t:"unregister"}` | 删除电脑及全部未吊销设备，断开全部相关连接，回 `{t:"unregistered"}` 后 1000 关闭 |

**2026-10-14 维护者澄清**：remove/unregister 不删除管理员吊销墓碑；吊销的电脑/设备公钥永久拒绝重新登记/允许，避免删除绕过吊销。

中继通知电脑：`{t:"conn.open",conn,kind:"device",device:id}` 或 `{t:"conn.open",conn,kind:"pair",slot}`；关闭通知 `{t:"conn.close",conn}`。conn 是 u32，在本次电脑连接内不重复。

电脑与中继的二进制帧为 `u32be(conn) ‖ 通道帧`；中继与设备、配对端不带路由头。双向仅加头、去头；电脑发给不存在 conn 的帧静默丢弃。

## 4. 手机入口 `/v1/device`

挑战与超时同电脑；回复 `{t:"auth",id:deviceId,host:hostId,sig}`，签名 `Sign_IdP(T("nocturne/relay/v1/device",origin,n,deviceId,hostId))`。检查设备属于该电脑、设备与电脑均未吊销、公钥验签通过。

电脑在线：手机收到 `{t:"ok",online:true}`，电脑收到 conn.open。离线：`{t:"ok",online:false}`，保持等待；电脑上线后手机收到 `{t:"host",online:true}`，电脑收到 conn.open。连通后电脑断开，手机 `4002 host_offline`，由手机自己重连。等待期间发送二进制帧为 protocol_error。每电脑同时最多 10 条设备连接，超出 `4006 limit`。

| 手机 → 中继 | 回复 |
|---|---|
| `{t:"push.subscribe",endpoint,p256dh,auth}` | 保存/覆盖订阅，`{t:"push.subscribed"}`；endpoint 必须 https 且主机在允许表，否则 `{t:"error",code:"push_endpoint"}`；测试配置可允许 http |
| `{t:"push.unsubscribe"}` | 删除订阅，`{t:"push.unsubscribed"}` |

## 5. 配对入口 `/v1/pair?slot=<slot>`

无认证。槽位不存在、过期、占用或电脑离线统一 `4008 slot_invalid`。第一条连接占用后槽位立即作废，电脑收到 conn.open kind:pair。双向单帧最多 4096 字节，存活最长 60 秒，按来源限流。电脑配对完成发 conn.close。

## 6. 关闭码

| 码 | 含义 |
|---|---|
| 1000 | 正常 |
| 4000 | protocol_error |
| 4001 | replaced |
| 4002 | host_offline |
| 4003 | revoked（管理员吊销或 device.remove） |
| 4004 | auth_failed |
| 4005 | rate_limited |
| 4006 | limit |
| 4007 | slow_consumer，发送缓冲超过 8 MiB |
| 4008 | slot_invalid |

WebSocket 实现检测超 maxPayload 的帧时使用标准 1009 关闭。

## 7. 无载荷推送

首次启动生成 P-256 VAPID 密钥，存在 dataDir/vapid.json（POSIX 0600）。向订阅 endpoint 发 POST，无载荷，Content-Length:0；TTL:86400、Urgency:high、`Authorization: vapid t=<JWT>, k=<b64u raw 公钥>`。

JWT header `{typ:"JWT",alg:"ES256"}`，claims `{aud:endpoint.origin,exp:now+12h,sub}`，sub 为 vapidSubject，默认 publicOrigin。Node crypto.sign 用 SHA-256、`dsaEncoding:"ieee-p1363"`。404/410 删除订阅，其余失败只记日志。不跟随重定向，10 秒超时。p256dh/auth 预存供以后带载荷使用；当前 service worker 显示固定文案，不向推送服务提供会话内容。

默认 pushHosts 后缀允许表：fcm.googleapis.com、updates.push.services.mozilla.com、web.push.apple.com、notify.windows.com（精确主机或点分隔子域匹配）。只有测试 allowInsecurePush:true 允许 http。

## 8. 客户端 API

所有客户端只用全局 WebSocket（binaryType=arraybuffer）和 fetch，无自动重连。origin 允许 https，另允许 http://127.0.0.1:<port> 离线测试。

`registerHost({origin,code,identity,fetch?}):Promise<{hostId}>`，403/409/429 对应 RelayError 的 invalid_invite/already_registered/rate_limited。

认证完成之前的 WebSocket 关闭也通过 `RelayError.closeCode` 保留数值关闭码，供主机判断吊销、认证失败与被替换后停止重连。

`connectHostRelay({origin,identity,hostId}):Promise<HostRelay>`：onConnection 接收 `{conn,kind,device?,slot?,transport:FrameTransport}`；openPairingSlot、allowDevice({id,publicKey,name})、removeDevice、listDevices、push、unregister 的请求串行化；close 和 onClose(code)。

`connectDeviceRelay({origin,identity,hostId}):Promise<DeviceRelay>`：online、onHostOnline、transport、subscribePush、unsubscribePush、onClose(code)。

`connectPairRelay({origin,slot}):Promise<FrameTransport>`：WebSocket 打开即返回，槽位拒绝通过 transport.onClose 通知（配对协议没有成功控制回复）。

签名辅助 API：registerTranscript(origin,code,pub)、hostAuthTranscript(origin,nonce,hostId)、deviceAuthTranscript(origin,nonce,deviceId,hostId) 返回 Uint8Array；verifySignature(pub,sig,data):Promise<boolean>。控制解析器 parseRelayMessage(json):RelayMessage，关闭码 RELAY_CLOSE_CODES。
