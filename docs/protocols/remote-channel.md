# 远程加密通道协议

> 状态：已接受 v1（2026-10-14）｜决策：[ADR-0052](../decisions/ADR-0052-remote-web-client.md)｜代码：`packages/remote`

本文是配对、签名握手与加密帧的唯一主文档。通道不负责真实网络、身份持久化或 RPC 方法权限；每条消息承载一条 UTF-8 JSON-RPC 报文，不含换行。
信任边界包含中继下发的网页未被篡改，见 [ADR-0052 第 4 节「绕不开的信任点」](../decisions/ADR-0052-remote-web-client.md#4-端到端加密)。

## 1. 编码

- `b64u`：无填充 base64url；非法字符、填充、非规范尾位均报 `protocol_error`。
- 公钥：P-256 未压缩点，`exportKey("raw")`，65 字节，首字节 `0x04`；长度、首字节或导入失败报 `protocol_error`。
- 签名：ECDSA P-256 + SHA-256，WebCrypto 原生 64 字节 `r‖s`。
- `fp(pub) = SHA-256(pub)`，32 字节；`id(pub) = b64u(fp(pub)[0..16])`，22 字符。
- 转录 `T(label, f1, …, fn) = utf8(label) ‖ for each fi: u32be(len(fi)) ‖ fi`。label 不加长度前缀。
- 字符串进转录前 NFC 规范化，再 UTF-8 编码；所有签名、MAC、salt 的字段顺序如下。
- 帧体 JSON 必须是对象且字段恰好匹配，额外、缺失字段报 `protocol_error`；握手/配对帧整帧不超过 4 KiB。

## 2. 长期身份

电脑和每台手机各有一对 ECDSA P-256 长期密钥，只签名；ECDH 只用临时密钥。同一 `CryptoKey` 不能兼任 ECDSA/ECDH，手机私钥不可导出，不能转换用途。

```ts
interface Identity {
  privateKey: CryptoKey;
  publicKey: Uint8Array;
  id: string;
}
generateIdentity(options: { extractable: boolean }): Promise<Identity>;
exportIdentity(identity: Identity): Promise<string>;
importIdentity(json: string, options: { extractable: boolean }): Promise<Identity>;
fingerprint(pub: Uint8Array): Promise<Uint8Array>;
identityId(pub: Uint8Array): Promise<string>;
```

手机用 `extractable: false`，电脑用 `true` 以便存入凭据后端。导出为含 `d` 的私钥 JWK JSON；不可导出时报 `protocol_error`。导入从 JWK `x/y` 还原公钥，校验曲线与密钥，按指定可导出性导入。

## 3. 扫码配对

参与者：电脑 H（`IdH/pubH`）、手机 P（`IdP/pubP`）；`slot` 由中继分配，本包仅接受调用者传入。必须为 16 字节的规范 b64u（22 字符），否则 `protocol_error`。

1. H 生成 `K = random(32)`，邀请片段 `pair=<slot>.<b64u K>.<b64u fp(pubH)>`。解析接受有/无开头 `#`，其他格式报 `protocol_error`。`PairingSecret` 持有 slot/K，`acceptPairingHello` 调用一次后无论成败作废，再用报 `protocol_error`；K 不在可枚举字段暴露。
2. `macKey = HKDF-SHA256(ikm=K, salt=utf8("nocturne/pair/v1"), info=utf8("mac:" + slot), 32 字节)`，导入 HMAC-SHA256。
3. P 生成 `nP=random(32)`；设备名先 trim、NFC，长度 1–64 个 Unicode 码点，否则 `protocol_error`。
   - `Th=T("nocturne/pair/v1/hello", slot, pubP, deviceName, nP)`。
   - `pair.hello`：`{v:1,pub:b64u(pubP),name:deviceName,n:b64u(nP),sig:b64u(Sign_IdP(Th)),mac:b64u(HMAC(macKey,Th))}`。
4. H 检查 `v===1`（否则 `version_mismatch`），用 `subtle.verify` 验 MAC（`bad_mac`），再用 pubP 验签（`bad_signature`）。生成 `nH=random(32)`：
   - `Ta=T("nocturne/pair/v1/accept", slot, pubP, deviceName, nP, pubH, nH)`。
   - `pair.accept`：`{v:1,pub:b64u(pubH),n:b64u(nH),sig:b64u(Sign_IdH(Ta)),mac:b64u(HMAC(macKey,Ta))}`。
   - 返回设备 `{id,publicKey,name}`。
5. P 校验版本和字段格式后，**先**对比 `fp(pubH)` 与邀请指纹（不符 `fingerprint_mismatch`），再校验 MAC（`bad_mac`）、签名（`bad_signature`），返回 `{hostId,hostPublicKey}`。

验收澄清（2026-10-14，维护者确认）：中继替换电脑公钥时，无论是否掌握 K，都先报 `fingerprint_mismatch`；公钥未替换但 K/MAC 错误才报 `bad_mac`。不改变上述检查顺序。

```ts
interface ParsedOffer { slot: string; key: Uint8Array; hostFingerprint: Uint8Array }
interface PairingSecret { readonly slot: string } // K 由实现私有持有
interface PairingState { readonly slot: string }  // 转录状态由实现私有持有
createPairingOffer(host: Identity, slot: string): Promise<{fragment: string; secret: PairingSecret}>;
parsePairingFragment(fragment: string): ParsedOffer;
createPairingHello(phone: Identity, offer: ParsedOffer, deviceName: string): Promise<{message: Uint8Array; state: PairingState}>;
acceptPairingHello(host: Identity, secret: PairingSecret, message: Uint8Array): Promise<{reply: Uint8Array; device: {id: string; publicKey: Uint8Array; name: string}}>;
finishPairing(state: PairingState, reply: Uint8Array): Promise<{hostId: string; hostPublicKey: Uint8Array}>;
```

message/reply 包含下节规定的类型字节，不只是 JSON 帧体。`PairingState` 完成时消耗一次。

## 4. 每次连接的握手

P 记着 pubH；H 根据设备 id 查 pubP，未知/已吊销返回 undefined。P 发起，双方各生成临时 ECDH P-256 密钥和 32 字节随机 nonce。

`F=(pubH,pubP,eP,eH,nP,nH)`；临时公钥 raw 为 65 字节。

1. P→H `hs.init`：`{v:1,id:id(pubP),e:b64u(eP),n:b64u(nP)}`。H 版本不符回 `version_mismatch` 错误帧并关闭；找不到设备回 `unknown_device` 并关闭。
2. H→P `hs.resp`：`{v:1,e:b64u(eH),n:b64u(nH),sig:b64u(Sign_IdH(T("nocturne/hs/v1/resp",...F)))}`。P 用记下的 pubH 验签，失败 `bad_signature` 并关闭，**不发 hs.fin**。
3. P→H `hs.fin`：`{sig:b64u(Sign_IdP(T("nocturne/hs/v1/fin",...F)))}`。H 用登记的 pubP 验签，失败 `bad_signature` 并关闭。
4. 双方派生：
   - `shared=ECDH(eP,eH)`，`deriveBits` 256 位。
   - `salt=SHA-256(T("nocturne/hs/v1/salt",...F))`。
   - `kP2H=HKDF-SHA256(shared,salt,utf8("nocturne/hs/v1/p2h"),32 字节)`。
   - `kH2P` 同上，info 为 `utf8("nocturne/hs/v1/h2p")`。
   - 均导入不可导出 AES-256-GCM key；临时私钥仅在内存，结束后不再引用。

P 发出 hs.fin 后可立即发数据；H 必须验证 hs.fin 后才处理/发送数据。hs.fin 前数据帧报 `protocol_error`。握手默认 10 秒，可设 `timeoutMs`；超时报 `timeout` 并关闭底层。失败 promise 以 `RemoteChannelError` 拒绝，底层已关闭。

## 5. 帧与消息

底层按帧收发 `Uint8Array`，第一字节类型，帧体如下。`FRAME_TYPES` 导出对应命名常量。

| 类型 | 常量名 | 含义 | 帧体 |
|---|---|---|---|
| `0x01` | `init` | hs.init | UTF-8 JSON |
| `0x02` | `response` | hs.resp | UTF-8 JSON |
| `0x03` | `finish` | hs.fin | UTF-8 JSON |
| `0x08` | `pairingHello` | pair.hello | UTF-8 JSON |
| `0x09` | `pairingAccept` | pair.accept | UTF-8 JSON |
| `0x10` | `data` | 数据 | counter(u64be,8 字节) ‖ AES-GCM 密文（含 16 字节 tag） |
| `0x7f` | `error` | 仅握手阶段错误 | UTF-8 JSON `{code}`，不带其他信息 |

- 每方向单独 key/counter，从 0 开始，每帧加 1。
- nonce：`00 00 00 00 ‖ u64be(counter)`（12 字节）。AAD：头 9 字节 `0x10 ‖ counter`。
- 明文：`flag(1 字节) ‖ chunk`；`0x00` 消息结束，`0x01` 还有分片；其他 flag 为 `protocol_error`。
- 收方 counter 必须严格等于期望值，否则 `replay`；解密失败 `decrypt_failed`。都直接关闭，**不回错误帧**，避免 oracle。
- `MAX_FRAME=1_048_576` 字节（含类型）；每分片容量 `MAX_FRAME-9-16-1`。
- `MAX_MESSAGE=16*1024*1024` 字节，发送自动分片，重组或发送超限均 `frame_too_large` 并关闭，记录 closeReason。
- counter 到 `2^53-1` 关闭，不溢出。
- 关闭丢弃未完成分片，不交付半条消息。完整消息按原始 UTF-8 保留，不做 NFC。

## 6. 传输 API 与生命周期

```ts
interface FrameTransport {
  send(frame: Uint8Array): void;
  onFrame(handler: (frame: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}
createMemoryFramePair(): [FrameTransport, FrameTransport];
interface SecureLineTransport {
  send(line: string): void;
  onLine(handler: (line: string) => void): void;
  onClose(handler: () => void): void;
  flush(): Promise<void>;
  close(): void;
  readonly closeReason: RemoteChannelError | undefined;
}
interface ConnectChannelOptions {
  identity: Identity;
  hostPublicKey: Uint8Array;
  timeoutMs?: number;
}
interface AcceptChannelOptions {
  identity: Identity;
  lookupDevice: (id: string) => Promise<Uint8Array | undefined>;
  timeoutMs?: number;
}
connectChannel(transport: FrameTransport, options: ConnectChannelOptions): Promise<SecureLineTransport>;
acceptChannel(transport: FrameTransport, options: AcceptChannelOptions): Promise<{deviceId: string; channel: SecureLineTransport}>;
```

- 注册前到达的帧/行要缓冲；内存帧管道复制帧并按发送顺序异步交付，语义同 RPC 内存管道。
- send 同步入队，异步加密串行，保证 counter/调用顺序一致；收方串行解密、按序交付。
- flush 等待调用时已 send 的消息加密并交给底层；不等待对端交付。
- close 幂等，先刷已 send 的队列再关底层。对端先交付已解密的完整消息，再 onClose；底层关闭也触发 onClose，仅一次，迟注册仍可通知。
- 正常关闭 closeReason 为 undefined，异常关闭记录中文错误。关闭后 send 不再接受消息。
- SecureLineTransport 与 RPC LineTransport 结构兼容，可直接用于 serve/client；不依赖 rpc 包。

## 7. 错误

`RemoteChannelError extends Error`，导出 `RemoteChannelErrorCode` 类型，`code` 为下表；message 用中文且不含任何密钥材料或报文内容。

| code | 含义 |
|---|---|
| protocol_error | 编码、字段、帧顺序或 flag 不合法 |
| version_mismatch | 版本不兼容 |
| unknown_device | 设备未知或吊销 |
| bad_mac | 配对 MAC 校验失败 |
| bad_signature | 身份签名校验失败 |
| fingerprint_mismatch | 邀请与电脑公钥指纹不符 |
| decrypt_failed | AES-GCM 校验/解密失败 |
| replay | counter 不符合期望（重放、丢帧、乱序） |
| frame_too_large | 帧或消息超限 |
| timeout | 握手超时 |
| closed | 握手底层关闭或 counter 已达上限 |

固定离线测试向量在 `packages/remote/test/vectors.json`；测试用 Node crypto 独立交叉校验转录、ECDH、HKDF、HMAC 和完整数据帧，运行实现只使用标准 Web API。
