import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, createServer } from "node:http";
import { createPublicKey, verify } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateIdentity,
  registerHost,
  connectHostRelay,
  connectDeviceRelay,
  connectPairRelay,
  hostAuthTranscript,
  type Identity,
  type RelayConnection,
} from "@nocturne/remote";
import { RelayServer, type RelayLog } from "../src/server.js";
import { startAdmin, requestAdmin } from "../src/admin.js";
import { staticCsp } from "../src/csp.js";
import { fetchSafeListen, listenFetchSafe } from "./ports.js";

const cleanups: (() => Promise<unknown>)[] = [];
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("测试预期值不存在");
  return value;
}
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function fixture(limits = {}) {
  const dir = await mkdtemp(join(tmpdir(), "relay-r3-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const logs: RelayLog[] = [];
  const relay = new RelayServer(
    {
      publicOrigin: "http://127.0.0.1:1",
      listen: await fetchSafeListen(),
      dataDir: dir,
      limits: { ratePerMinute: 1000, ...limits },
      allowInsecurePush: true,
      pushHosts: ["127.0.0.1"],
    },
    (log) => logs.push(log),
  );
  const port = await relay.start();
  relay.config.publicOrigin = `http://127.0.0.1:${port}`;
  cleanups.push(() => relay.close());
  const origin = relay.config.publicOrigin;
  const identity = await generateIdentity({ extractable: true });
  const invite = await relay.store.invite(origin, 86400000);
  const code = required(invite.split("/").at(-1));
  const register = () => registerHost({ origin, code, identity });
  return { relay, dir, logs, origin, identity, code, register };
}
async function hostFixture(limits = {}) {
  const f = await fixture(limits);
  await f.register();
  const host = await connectHostRelay({
    origin: f.origin,
    identity: f.identity,
    hostId: f.identity.id,
  });
  return { ...f, host };
}
function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", resolve));
}
function onceConnection(
  host: Awaited<ReturnType<typeof connectHostRelay>>,
): Promise<RelayConnection> {
  return new Promise((resolve) => host.onConnection(resolve));
}
async function rawAuth(
  origin: string,
  identity: Identity,
  id = identity.id,
  signingOrigin = origin,
) {
  const ws = new WebSocket(`${origin.replace("http", "ws")}/v1/host`);
  const code = closeCode(ws);
  ws.once("message", (data) => {
    const msg = JSON.parse(data.toString()) as { n: string };
    void crypto.subtle
      .sign(
        { name: "ECDSA", hash: "SHA-256" },
        identity.privateKey,
        hostAuthTranscript(signingOrigin, msg.n, id),
      )
      .then((sig) => {
        ws.send(JSON.stringify({ t: "auth", id, sig: Buffer.from(sig).toString("base64url") }));
      });
  });
  return { ws, code };
}
describe("relay", () => {
  it("容器监听 0.0.0.0 可由本机访问，管理 socket 位于数据目录", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-container-listen-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const relay = new RelayServer({
      listen: await fetchSafeListen("0.0.0.0"),
      publicOrigin: "http://127.0.0.1:8787",
      dataDir: dir,
    });
    const port = await relay.start();
    cleanups.push(() => relay.close());
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    const admin = await startAdmin(relay);
    cleanups.push(() => new Promise<void>((done) => admin.close(() => done())));
    expect((await requestAdmin(dir, { command: "invite create", note: "container" })).ok).toBe(
      true,
    );
    expect((await requestAdmin(dir, { command: "invite list" })).output).toContain("container");
  });
  it("生成邀请、登记成功、同一邀请第二次返回 403，数据不存明文", async () => {
    const f = await fixture();
    expect(await f.register()).toEqual({ hostId: f.identity.id });
    await expect(f.register()).rejects.toMatchObject({ code: "invalid_invite" });
    expect(await readFile(join(f.dir, "relay-data.json"), "utf8")).not.toContain(f.code);
  });
  it("过期邀请和错误签名均返回 403", async () => {
    const f = await fixture();
    required(f.relay.store.data.invites[0]).expiresAt = 0;
    await expect(f.register()).rejects.toMatchObject({ code: "invalid_invite" });
    const response = await fetch(`${f.origin}/v1/register`, {
      method: "POST",
      body: JSON.stringify({ code: f.code, pub: "wrong", sig: "wrong" }),
    });
    expect(response.status).toBe(403);
  });
  it("已登记公钥用新邀请返回 409", async () => {
    const f = await fixture();
    await f.register();
    const code = required((await f.relay.store.invite(f.origin, 10000)).split("/").at(-1));
    await expect(
      registerHost({ origin: f.origin, identity: f.identity, code }),
    ).rejects.toMatchObject({ code: "already_registered" });
  });
  it("来源登记令牌桶超限返回 429", async () => {
    const f = await fixture({ ratePerMinute: 1 });
    await f.register();
    await expect(f.register()).rejects.toMatchObject({ code: "rate_limited" });
  });
  it.each(["unknown", "signature", "origin", "revoked"])(
    "电脑认证失败 %s 返回 4004",
    async (reason) => {
      const f = await fixture();
      await f.register();
      if (reason === "revoked") await f.relay.revoke("host", f.identity.id);
      const identity =
        reason === "signature" ? await generateIdentity({ extractable: true }) : f.identity;
      const raw = await rawAuth(
        f.origin,
        identity,
        reason === "unknown" ? "AAAAAAAAAAAAAAAAAAAAAA" : f.identity.id,
        reason === "origin" ? "https://other.example" : f.origin,
      );
      expect(await raw.code).toBe(4004);
    },
  );
  it("第二条电脑认证连接替换第一条 4001", async () => {
    const f = await hostFixture();
    const closed = new Promise<number>((done) => f.host.onClose(done));
    const next = await connectHostRelay({
      origin: f.origin,
      identity: f.identity,
      hostId: f.identity.id,
    });
    expect(await closed).toBe(4001);
    next.close();
  });
  it("不回 auth 的连接超时 4004", async () => {
    const f = await fixture({ authTimeoutMs: 30 });
    const ws = new WebSocket(`${f.origin.replace("http", "ws")}/v1/host`);
    expect(await closeCode(ws)).toBe(4004);
  });
  it("设备 id 不匹配被拒，第六台超过默认限额", async () => {
    const f = await hostFixture();
    const phone = await generateIdentity({ extractable: false });
    await expect(
      f.host.allowDevice({ id: f.identity.id, publicKey: phone.publicKey, name: "手机" }),
    ).rejects.toMatchObject({ code: "protocol_error" });
    for (let i = 0; i < 5; i++) {
      const device = await generateIdentity({ extractable: false });
      await f.host.allowDevice({ ...device, name: `手机${i}` });
    }
    await expect(f.host.allowDevice({ ...phone, name: "第六台" })).rejects.toMatchObject({
      code: "limit",
    });
  });
  it("未知设备认证被拒", async () => {
    const f = await hostFixture();
    const phone = await generateIdentity({ extractable: false });
    await expect(
      connectDeviceRelay({ origin: f.origin, identity: phone, hostId: f.identity.id }),
    ).rejects.toMatchObject({ code: "closed" });
  });
  it("等待电脑上线期间二进制帧被关闭为 4000", async () => {
    const f = await hostFixture();
    const phone = await generateIdentity({ extractable: false });
    await f.host.allowDevice({ ...phone, name: "手机" });
    const offline = new Promise<number>((done) => f.host.onClose(done));
    f.host.close();
    await offline;
    const device = await connectDeviceRelay({
      origin: f.origin,
      identity: phone,
      hostId: f.identity.id,
    });
    const closed = new Promise<number>((done) => device.onClose(done));
    device.transport.send(new Uint8Array([1]));
    expect(await closed).toBe(4000);
  });
  it("电脑向未知 conn 发帧静默丢弃，严格控制帧错误关闭且日志无帧内容", async () => {
    const f = await hostFixture();
    const peer = required(f.relay.hosts.get(f.identity.id));
    const marker = "PRIVATE_FRAME_MARKER";
    const frame = Buffer.concat([Buffer.from([255, 255, 255, 255]), Buffer.from(marker)]);
    peer.ws.emit("message", frame, true);
    expect(await f.host.listDevices()).toEqual([]);
    const closed = new Promise<number>((done) => f.host.onClose(done));
    peer.ws.emit("message", Buffer.from('{"t":"push","extra":1}'), false);
    expect(await closed).toBe(4000);
    expect(JSON.stringify(f.logs)).not.toContain(marker);
    expect(JSON.stringify(f.logs)).not.toContain(f.code);
  });
  it("超过 16 KiB 的文本控制帧关闭 4000", async () => {
    const f = await hostFixture();
    const peer = required(f.relay.hosts.get(f.identity.id));
    const closed = new Promise<number>((done) => f.host.onClose(done));
    peer.ws.emit("message", Buffer.alloc(16385, 32), false);
    expect(await closed).toBe(4000);
  });
  it("离线等待上线收到通知，电脑断开设备 4002", async () => {
    const f = await hostFixture();
    const phone = await generateIdentity({ extractable: false });
    await f.host.allowDevice({ ...phone, name: "手机" });
    const closedHost = new Promise((done) => f.host.onClose(done));
    f.host.close();
    await closedHost;
    const device = await connectDeviceRelay({
      origin: f.origin,
      identity: phone,
      hostId: f.identity.id,
    });
    expect(device.online).toBe(false);
    const online = new Promise<void>((done) => device.onHostOnline(done));
    const host = await connectHostRelay({
      origin: f.origin,
      identity: f.identity,
      hostId: f.identity.id,
    });
    const conn = await onceConnection(host);
    await online;
    expect(conn.device).toBe(phone.id);
    const closed = new Promise<number>((done) => device.onClose(done));
    host.close();
    expect(await closed).toBe(4002);
  });
  it("remove 断开设备 4003，重连 4004，可重新配对", async () => {
    const f = await hostFixture();
    const phone = await generateIdentity({ extractable: false });
    await f.host.allowDevice({ ...phone, name: "手机" });
    const device = await connectDeviceRelay({
      origin: f.origin,
      identity: phone,
      hostId: f.identity.id,
    });
    const closed = new Promise<number>((done) => device.onClose(done));
    await f.host.removeDevice(phone.id);
    expect(await closed).toBe(4003);
    await expect(
      connectDeviceRelay({ origin: f.origin, identity: phone, hostId: f.identity.id }),
    ).rejects.toMatchObject({ code: "closed" });
    await f.host.allowDevice({ ...phone, name: "手机" });
  });
  it("第十一条设备连接超过限额", async () => {
    const f = await hostFixture();
    const phone = await generateIdentity({ extractable: false });
    await f.host.allowDevice({ ...phone, name: "手机" });
    for (let i = 0; i < 10; i++)
      await connectDeviceRelay({ origin: f.origin, identity: phone, hostId: f.identity.id });
    const ws = new WebSocket(`${f.origin.replace("http", "ws")}/v1/device`);
    const closed = closeCode(ws);
    ws.once("message", (data) => {
      const { n } = JSON.parse(data.toString());
      import("@nocturne/remote")
        .then(({ deviceAuthTranscript }) =>
          crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            phone.privateKey,
            deviceAuthTranscript(f.origin, n, phone.id, f.identity.id),
          ),
        )
        .then((sig) =>
          ws.send(
            JSON.stringify({
              t: "auth",
              id: phone.id,
              host: f.identity.id,
              sig: Buffer.from(sig).toString("base64url"),
            }),
          ),
        );
    });
    expect(await closed).toBe(4006);
  });
  it("配对一次占用，第二条连接 4008，槽位最多三个", async () => {
    const f = await hostFixture();
    const { slot } = await f.host.openPairingSlot();
    const conn = onceConnection(f.host);
    await connectPairRelay({ origin: f.origin, slot });
    expect((await conn).kind).toBe("pair");
    const ws = new WebSocket(`${f.origin.replace("http", "ws")}/v1/pair?slot=${slot}`);
    expect(await closeCode(ws)).toBe(4008);
    for (let i = 0; i < 3; i++) await f.host.openPairingSlot();
    await expect(f.host.openPairingSlot()).rejects.toMatchObject({ code: "limit" });
  });
  it("配对过期槽位拒绝，存活时间到关闭", async () => {
    const f = await hostFixture({ slotLifetimeMs: 20, pairLifetimeMs: 30 });
    const expired = await f.host.openPairingSlot();
    await new Promise((done) => setTimeout(done, 30));
    const bad = new WebSocket(`${f.origin.replace("http", "ws")}/v1/pair?slot=${expired.slot}`);
    expect(await closeCode(bad)).toBe(4008);
    const fresh = await f.host.openPairingSlot();
    const ws = new WebSocket(`${f.origin.replace("http", "ws")}/v1/pair?slot=${fresh.slot}`);
    expect(await closeCode(ws)).toBe(1000);
  });
  it("配对超过 4 KiB 被关闭", async () => {
    const f = await hostFixture();
    const { slot } = await f.host.openPairingSlot();
    const ws = new WebSocket(`${f.origin.replace("http", "ws")}/v1/pair?slot=${slot}`);
    const closed = closeCode(ws);
    ws.once("open", () => ws.send(Buffer.alloc(4097)));
    expect(await closed).toBe(1009);
  });
  it("多设备二进制双向原样转发不串线，conn.close 关闭", async () => {
    const f = await hostFixture();
    const routes: RelayConnection[] = [];
    f.host.onConnection((conn) => {
      routes.push(conn);
      conn.transport.onFrame((frame) => conn.transport.send(frame));
    });
    for (let i = 0; i < 2; i++) {
      const phone = await generateIdentity({ extractable: false });
      await f.host.allowDevice({ ...phone, name: "手机" });
      const d = await connectDeviceRelay({
        origin: f.origin,
        identity: phone,
        hostId: f.identity.id,
      });
      const frame = new Uint8Array([0, 1, 2, i, 255]);
      const receive = new Promise<Uint8Array>((done) => d.transport.onFrame(done));
      d.transport.send(frame);
      expect(await receive).toEqual(frame);
      const closed = new Promise<void>((done) => d.transport.onClose(done));
      required(routes[i]).transport.close();
      await closed;
    }
  });
  it("慢消费者阈值触发 4007", async () => {
    const f = await hostFixture();
    const phone = await generateIdentity({ extractable: false });
    await f.host.allowDevice({ ...phone, name: "手机" });
    const d = await connectDeviceRelay({
      origin: f.origin,
      identity: phone,
      hostId: f.identity.id,
    });
    const closed = new Promise<number>((done) => d.onClose(done));
    const peer = required([...f.relay.peers].find((p) => p.role === "device"));
    Object.defineProperty(peer.ws, "bufferedAmount", { get: () => 9 * 1024 * 1024 });
    const host = required(f.relay.hosts.get(f.identity.id));
    const head = Buffer.alloc(5);
    head.writeUInt32BE(required(peer.conn));
    host.ws.emit("message", head, true);
    expect(await closed).toBe(4007);
  });
  it("管理通道创建邀请、列电脑、吊销设备与电脑立即断开，保留墓碑", async () => {
    const f = await hostFixture();
    const admin = await startAdmin(f.relay);
    cleanups.push(() => new Promise<void>((done) => admin.close(() => done())));
    expect((await requestAdmin(f.dir, { command: "invite create" })).output).toMatch(
      /^nocturne-invite:/,
    );
    expect((await requestAdmin(f.dir, { command: "host list" })).output).toContain(f.identity.id);
    const phone = await generateIdentity({ extractable: false });
    await f.host.allowDevice({ ...phone, name: "手机" });
    const d = await connectDeviceRelay({
      origin: f.origin,
      identity: phone,
      hostId: f.identity.id,
    });
    const closed = new Promise<number>((done) => d.onClose(done));
    await requestAdmin(f.dir, { command: "device revoke", id: phone.id });
    expect(await closed).toBe(4003);
    await f.host.removeDevice(phone.id);
    await expect(f.host.allowDevice({ ...phone, name: "手机" })).rejects.toMatchObject({
      code: "revoked",
    });
    const hostClosed = new Promise<number>((done) => f.host.onClose(done));
    await requestAdmin(f.dir, { command: "host revoke", id: f.identity.id });
    expect(await hostClosed).toBe(4003);
  });
  it("管理服务未运行返回中文错误", async () => {
    const f = await fixture();
    await expect(requestAdmin(f.dir, { command: "host list" })).rejects.toThrow("中继未运行");
  });
  it("静态 HEAD 安全头齐全，路径穿越 404，health/info 可用", async () => {
    const f = await fixture();
    const res = await fetch(f.origin, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("content-security-policy")).toBe(staticCsp(f.origin));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    for (const path of ["/../index.html", "/%2e%2e/index.html"]) {
      const status = await new Promise<number>((done) => {
        const req = httpRequest(`${f.origin}`, { path }, (res) => {
          res.resume();
          done(required(res.statusCode));
        });
        req.end();
      });
      expect(status).toBe(404);
    }
    expect(await (await fetch(`${f.origin}/healthz`)).text()).toBe("ok");
    expect(await (await fetch(`${f.origin}/v1/info`)).json()).toMatchObject({ protocol: 1 });
  });
  it("错误 Origin 的 upgrade 返回 403", async () => {
    const f = await fixture();
    const ws = new WebSocket(`${f.origin.replace("http", "ws")}/v1/host`, {
      origin: "https://other.example",
    });
    ws.on("error", () => {
      /* 错误 Origin 预期失败。 */
    });
    expect(
      await new Promise<number>((done) =>
        ws.once("unexpected-response", (_, res) => {
          done(required(res.statusCode));
          res.resume();
          ws.terminate();
        }),
      ),
    ).toBe(403);
  });
  describe("App WebView 源", () => {
    const APP = "http://tauri.localhost";
    function upgrade(f: { origin: string }, path: string, origin: string | undefined) {
      const ws = new WebSocket(
        `${f.origin.replace("http", "ws")}${path}`,
        origin ? { origin } : {},
      );
      return new Promise<{ status: number } | { first: string } | { closed: number }>((done) => {
        ws.once("unexpected-response", (_, res) => {
          done({ status: required(res.statusCode) });
          res.resume();
          ws.terminate();
        });
        ws.once("message", (data) => {
          done({ first: data.toString() });
          ws.terminate();
        });
        ws.once("close", (code) => {
          done({ closed: code });
        });
        ws.once("error", () => {
          /* 拒绝升级由 unexpected-response 报告。 */
        });
      });
    }
    it("允许表内的源可以升级手机入口（device、pair）", async () => {
      const f = await fixture();
      const device = await upgrade(f, "/v1/device", APP);
      expect(device).toHaveProperty("first");
      expect(JSON.parse((device as { first: string }).first)).toMatchObject({ t: "challenge" });
      const pair = await upgrade(f, "/v1/pair?slot=unknown", APP);
      expect(pair).toEqual({ closed: 4008 });
    });
    it("App 源不能连电脑入口，其他源仍然拒绝，没有 Origin 的行为不变", async () => {
      const f = await fixture();
      expect(await upgrade(f, "/v1/host", APP)).toEqual({ status: 403 });
      for (const origin of [
        "http://tauri.localhost:80",
        "https://tauri.localhost",
        "http://localhost",
        "tauri://localhost",
        "null",
      ])
        expect(await upgrade(f, "/v1/device", origin)).toEqual({ status: 403 });
      expect(await upgrade(f, "/v1/device", undefined)).toHaveProperty("first");
      expect(await upgrade(f, "/v1/device", f.origin)).toHaveProperty("first");
      expect(await upgrade(f, "/v1/host", undefined)).toHaveProperty("first");
    });
    it("HTTP 接口不为 App 源增加 CORS 头", async () => {
      const f = await fixture();
      const response = await fetch(`${f.origin}/v1/info`, { headers: { origin: APP } });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });
  });
  it("本地无载荷推送请求 JWT 正确、410 删除订阅、30 秒限频与允许表", async () => {
    const f = await hostFixture();
    let calls = 0;
    const push = createServer((req, res) => {
      calls++;
      expect(req.headers["content-length"]).toBe("0");
      expect(req.headers.ttl).toBe("86400");
      expect(req.headers.urgency).toBe("high");
      const token = required(
        required(/vapid t=([^,]+), k=/.exec(required(req.headers.authorization)))[1],
      );
      const [header, claims, sig] = token.split(".");
      const body = JSON.parse(Buffer.from(required(claims), "base64url").toString());
      expect(body.aud).toBe(endpoint.slice(0, endpoint.lastIndexOf("/")));
      expect(body.exp).toBeGreaterThan(Date.now() / 1000 + 43190);
      const pub = Buffer.from(f.relay.pushService.publicKey, "base64url");
      const key = createPublicKey({
        key: {
          kty: "EC",
          crv: "P-256",
          x: pub.subarray(1, 33).toString("base64url"),
          y: pub.subarray(33).toString("base64url"),
        },
        format: "jwk",
      });
      expect(
        verify(
          "sha256",
          Buffer.from(`${header}.${claims}`),
          { key, dsaEncoding: "ieee-p1363" },
          Buffer.from(required(sig), "base64url"),
        ),
      ).toBe(true);
      res.writeHead(410);
      res.end();
    });
    await listenFetchSafe(push);
    cleanups.push(() => new Promise<void>((done) => push.close(() => done())));
    const addr = push.address() as { port: number };
    const endpoint = `http://127.0.0.1:${addr.port}/push`;
    const phone = await generateIdentity({ extractable: false });
    await f.host.allowDevice({ ...phone, name: "手机" });
    const d = await connectDeviceRelay({
      origin: f.origin,
      identity: phone,
      hostId: f.identity.id,
    });
    const sub = {
      endpoint,
      p256dh: Buffer.from(phone.publicKey).toString("base64url"),
      auth: Buffer.alloc(16).toString("base64url"),
    };
    await expect(
      d.subscribePush({ ...sub, endpoint: "https://bad.example/push" }),
    ).rejects.toMatchObject({ code: "push_endpoint" });
    await d.subscribePush(sub);
    expect(await f.host.push()).toBe(1);
    expect(calls).toBe(1);
    expect(required((await f.host.listDevices())[0]).push).toBe(false);
    await d.subscribePush(sub);
    expect(await f.host.push()).toBe(0);
    expect(calls).toBe(1);
    expect(JSON.stringify(f.logs)).not.toContain(endpoint);
  });
});

it.each([
  ["https://relay.example", "wss://relay.example"],
  ["http://127.0.0.1:12345", "ws://127.0.0.1:12345"],
])("CSP 从 %s 推导 WebSocket 源与 worker/manifest 范围", (origin, websocket) => {
  const policy = staticCsp(origin ?? "");
  expect(policy).toContain(`connect-src 'self' ${websocket}`);
  expect(policy).toContain("worker-src 'self'");
  expect(policy).toContain("manifest-src 'self'");
  expect(policy).toContain("img-src 'self' data: blob:");
  expect(policy).not.toContain("unsafe-inline");
  expect(policy).not.toContain("unsafe-eval");
});
