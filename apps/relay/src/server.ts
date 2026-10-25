import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, relative, extname, isAbsolute } from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  identityId,
  parseRelayMessage,
  registerTranscript,
  hostAuthTranscript,
  deviceAuthTranscript,
  verifySignature,
  type RelayMessage,
} from "@nocturne/remote";
import { APP_ORIGINS, config, type ConfigInput, type RelayConfig } from "./config.js";
import { Store, hash, type HostRecord, type DeviceRecord } from "./store.js";
import { PushService } from "./push.js";
import { staticCsp } from "./csp.js";

/** 由 scripts/release-version.mjs 与各包版本一起改写 */
export const RELAY_VERSION = "0.16.0";

interface Peer {
  ws: WebSocket;
  role: "host" | "device" | "pair";
  source: string;
  id?: string;
  hostId?: string;
  conn?: number;
  received: number;
  sent: number;
  alive: boolean;
}
interface HostPeer extends Peer {
  routes: Map<number, Peer>;
  next: number;
}
interface Slot {
  hostId: string;
  expiresAt: number;
}
export interface RelayLog {
  time: number;
  event: string;
  role?: string;
  id?: string;
  code?: number;
  received?: number;
  sent?: number;
  source?: string;
}
const bytes = (data: RawData): Buffer =>
  Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : data;
const decode = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(text, "base64url"));

export class RelayServer {
  readonly config: RelayConfig;
  readonly store: Store;
  readonly pushService: PushService;
  readonly http = createServer((req, res) => {
    void this.request(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  readonly hosts = new Map<string, HostPeer>();
  readonly peers = new Set<Peer>();
  readonly slots = new Map<string, Slot>();
  private readonly buckets = new Map<string, { tokens: number; time: number }>();
  private readonly pushes = new Map<string, number>();
  private readonly servers: Record<Peer["role"], WebSocketServer>;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private flush: ReturnType<typeof setInterval> | undefined;
  private dirty = false;
  private registration = Promise.resolve();
  constructor(
    input: ConfigInput,
    private readonly logger: (log: RelayLog) => void = (log) => {
      process.stdout.write(`${JSON.stringify(log)}\n`);
    },
  ) {
    this.config = config(input);
    this.store = new Store(this.config.dataDir);
    this.pushService = new PushService(this.config);
    this.servers = {
      host: new WebSocketServer({ noServer: true, maxPayload: this.config.limits.maxFrame + 4 }),
      device: new WebSocketServer({ noServer: true, maxPayload: this.config.limits.maxFrame }),
      pair: new WebSocketServer({ noServer: true, maxPayload: 4096 }),
    };
    this.http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", this.config.publicOrigin);
      const role =
        url.pathname === "/v1/host"
          ? "host"
          : url.pathname === "/v1/device"
            ? "device"
            : url.pathname === "/v1/pair"
              ? "pair"
              : undefined;
      const origin = req.headers.origin;
      // App 的 WebView 源只放行手机用的两个入口；电脑入口用 Node 客户端，不带 Origin
      const allowed =
        origin === undefined ||
        origin === this.config.publicOrigin ||
        (role !== "host" && APP_ORIGINS.includes(origin));
      if (!allowed) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      if (!role) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      this.servers[role].handleUpgrade(req, socket, head, (ws) => {
        this.connected(ws, role, this.source(req), url.searchParams.get("slot"));
      });
    });
  }
  private source(req: IncomingMessage): string {
    const forwarded = req.headers["x-forwarded-for"];
    return this.config.trustProxy && typeof forwarded === "string"
      ? (forwarded.split(",").at(-1)?.trim() ?? "unknown")
      : (req.socket.remoteAddress ?? "unknown");
  }
  private log(event: string, peer?: Peer, code?: number): void {
    this.logger({
      time: Date.now(),
      event,
      ...(peer
        ? {
            role: peer.role,
            source: peer.source,
            received: peer.received,
            sent: peer.sent,
            ...(peer.id ? { id: peer.id } : {}),
          }
        : {}),
      ...(code === undefined ? {} : { code }),
    });
  }
  private rate(source: string): boolean {
    const now = Date.now(),
      limit = this.config.limits.ratePerMinute;
    const bucket = this.buckets.get(source) ?? { tokens: limit, time: now };
    bucket.tokens = Math.min(limit, bucket.tokens + ((now - bucket.time) * limit) / 60000);
    bucket.time = now;
    this.buckets.set(source, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens--;
    return true;
  }
  private send(peer: Peer, data: RelayMessage | Buffer): void {
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    if (peer.ws.bufferedAmount > this.config.limits.slowConsumer) {
      peer.ws.close(4007, "slow_consumer");
      return;
    }
    const payload = Buffer.isBuffer(data) ? data : JSON.stringify(data);
    peer.sent += Buffer.byteLength(payload);
    peer.ws.send(payload);
  }
  private json(res: ServerResponse, status: number, value: object): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  }
  private async request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Content-Security-Policy", staticCsp(this.config.publicOrigin));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.method === "GET" && req.url === "/healthz") {
      res.end("ok");
      return;
    }
    if (req.method === "GET" && req.url === "/v1/info") {
      this.json(res, 200, {
        protocol: 1,
        relayVersion: RELAY_VERSION,
        vapidPublicKey: this.pushService.publicKey,
      });
      return;
    }
    if (req.method === "POST" && req.url === "/v1/register") {
      const source = this.source(req);
      if (!this.rate(source)) {
        this.json(res, 429, { error: "rate_limited" });
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const data = Buffer.from(chunk as Uint8Array);
        size += data.length;
        if (size > 16384) {
          this.json(res, 403, { error: "invalid_invite" });
          return;
        }
        chunks.push(data);
      }
      const operation = this.registration.then(async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            code: string;
            pub: string;
            sig: string;
          } | null;
          if (
            !body ||
            Object.keys(body).sort().join(",") !== "code,pub,sig" ||
            !/^[A-Za-z0-9_-]{24}$/.test(body.code) ||
            typeof body.pub !== "string" ||
            typeof body.sig !== "string"
          )
            throw new Error();
          const invite = this.store.data.invites.find(
            (i) => i.hash === hash(body.code) && !i.usedAt && i.expiresAt > Date.now(),
          );
          const pub = decode(body.pub),
            sig = decode(body.sig);
          if (
            Buffer.from(pub).toString("base64url") !== body.pub ||
            Buffer.from(sig).toString("base64url") !== body.sig ||
            !invite ||
            !(await verifySignature(
              pub,
              sig,
              registerTranscript(this.config.publicOrigin, body.code, pub),
            ))
          )
            throw new Error();
          const id = await identityId(pub);
          const existing = this.store.data.hosts.find((h) => h.id === id);
          if (existing?.revokedAt) throw new Error();
          if (existing) {
            this.json(res, 409, { error: "already_registered" });
            return;
          }
          invite.usedAt = Date.now();
          this.store.data.hosts.push({
            id,
            pub: body.pub,
            createdAt: Date.now(),
            ...(invite.note ? { note: invite.note } : {}),
          });
          await this.store.save();
          this.json(res, 200, { hostId: id });
          this.logger({ time: Date.now(), event: "register", role: "host", id, source });
        } catch {
          this.json(res, 403, { error: "invalid_invite" });
        }
      });
      this.registration = operation.catch(() => {
        /* HTTP 错误已处理。 */
      });
      await operation;
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const raw = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
      if (raw.includes("\\") || raw.includes("\0") || raw.split("/").includes(".."))
        throw new Error();
      const root = await realpath(this.config.webRoot);
      const file = await realpath(resolve(root, `.${raw === "/" ? "/index.html" : raw}`));
      const rel = relative(root, file);
      if (rel.startsWith("..") || isAbsolute(rel) || !(await stat(file)).isFile())
        throw new Error();
      const content = await readFile(file);
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".webmanifest": "application/manifest+json",
      };
      res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
      res.setHeader("Content-Length", content.length);
      res.setHeader("Cache-Control", rel === "index.html" ? "no-cache" : "public, max-age=300");
      res.end(req.method === "HEAD" ? undefined : content);
    } catch {
      res.writeHead(404);
      res.end();
    }
  }
  private connected(ws: WebSocket, role: Peer["role"], source: string, slot: string | null): void {
    const peer: Peer = { ws, role, source, received: 0, sent: 0, alive: true };
    this.peers.add(peer);
    this.log("connect", peer);
    ws.on("pong", () => {
      peer.alive = true;
    });
    ws.on("error", () => {
      /* close 负责清理。 */
    });
    let timer: ReturnType<typeof setTimeout>;
    let ready = false,
      queue = Promise.resolve();
    const nonce = randomBytes(32).toString("base64url");
    if (role === "pair") {
      timer = setTimeout(() => {
        ws.close(1000);
      }, this.config.limits.pairLifetimeMs);
      if (!this.rate(source)) ws.close(4005, "rate_limited");
      else {
        const offer = slot ? this.slots.get(slot) : undefined;
        const host = offer ? this.hosts.get(offer.hostId) : undefined;
        if (!offer || !host || offer.expiresAt <= Date.now()) ws.close(4008, "slot_invalid");
        else {
          this.slots.delete(slot ?? "");
          peer.hostId = offer.hostId;
          ready = this.attach(host, peer, slot ?? undefined);
        }
      }
    } else {
      timer = setTimeout(() => {
        ws.close(4004, "auth_failed");
      }, this.config.limits.authTimeoutMs);
      this.send(peer, { t: "challenge", n: nonce });
    }
    ws.on("message", (data, binary) => {
      const frame = bytes(data);
      peer.received += frame.length;
      queue = queue
        .then(async () => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (!binary && frame.length > 16384) {
            ws.close(4000, "protocol_error");
            return;
          }
          if (!ready) {
            if (role === "pair") return;
            let valid = false;
            try {
              if (binary) throw new Error();
              const msg = parseRelayMessage(frame.toString("utf8"));
              if (msg.t !== "auth") throw new Error();
              valid = await this.authenticate(peer, msg, nonce);
            } catch {
              valid = false;
            }
            if (!valid) {
              this.log("auth_failed", peer);
              ws.close(this.rate(source) ? 4004 : 4005, "auth_failed");
              return;
            }
            if (!this.isOpen(ws)) return;
            ready = true;
            clearTimeout(timer);
            this.log("auth_ok", peer);
            return;
          }
          if (binary) this.forward(peer, frame);
          else await this.control(peer, parseRelayMessage(frame.toString("utf8")));
        })
        .catch(() => {
          ws.close(4000, "protocol_error");
        });
    });
    ws.on("close", (code) => {
      clearTimeout(timer);
      this.peers.delete(peer);
      this.log("close", peer, code);
      if (peer.role === "host" && peer.id && this.hosts.get(peer.id)?.ws === ws) {
        const host = this.hosts.get(peer.id);
        this.hosts.delete(peer.id);
        for (const route of host?.routes.values() ?? []) route.ws.close(4002, "host_offline");
        for (const [key, value] of this.slots) if (value.hostId === peer.id) this.slots.delete(key);
      } else if (peer.hostId && peer.conn !== undefined) {
        const host = this.hosts.get(peer.hostId);
        if (host?.routes.get(peer.conn) === peer) {
          host.routes.delete(peer.conn);
          this.send(host, { t: "conn.close", conn: peer.conn });
        }
      }
    });
  }
  private isOpen(ws: WebSocket): boolean {
    return ws.readyState === WebSocket.OPEN;
  }
  private attach(host: HostPeer, peer: Peer, slot?: string): boolean {
    if (host.next > 0xffffffff) {
      peer.ws.close(4006, "limit");
      return false;
    }
    const conn = host.next++;
    peer.conn = conn;
    host.routes.set(conn, peer);
    this.send(
      host,
      peer.role === "pair"
        ? { t: "conn.open", conn, kind: "pair", slot: slot ?? "" }
        : { t: "conn.open", conn, kind: "device", device: peer.id ?? "" },
    );
    return true;
  }
  private async authenticate(
    peer: Peer,
    msg: Extract<RelayMessage, { t: "auth" }>,
    nonce: string,
  ): Promise<boolean> {
    if (peer.role === "host") {
      if (msg.host !== undefined) return false;
      const record = this.store.data.hosts.find((h) => h.id === msg.id && !h.revokedAt);
      if (
        !record ||
        !(await verifySignature(
          decode(record.pub),
          decode(msg.sig),
          hostAuthTranscript(this.config.publicOrigin, nonce, msg.id),
        ))
      )
        return false;
      if (
        peer.ws.readyState !== WebSocket.OPEN ||
        record.revokedAt ||
        !this.store.data.hosts.includes(record)
      )
        return false;
      peer.id = msg.id;
      const previous = this.hosts.get(msg.id);
      if (previous) {
        for (const route of previous.routes.values()) route.ws.close(4002, "host_offline");
        previous.ws.close(4001, "replaced");
      }
      const host = Object.assign(peer, { routes: new Map<number, Peer>(), next: 1 });
      this.hosts.set(msg.id, host);
      record.lastSeenAt = Date.now();
      this.dirty = true;
      this.send(peer, { t: "ok" });
      for (const device of this.peers)
        if (
          device.role === "device" &&
          device.hostId === msg.id &&
          device.id &&
          device.conn === undefined &&
          device.ws.readyState === WebSocket.OPEN
        ) {
          this.send(device, { t: "host", online: true });
          this.attach(host, device);
        }
      return true;
    }
    if (!msg.host) return false;
    const hostRecord = this.store.data.hosts.find((h) => h.id === msg.host && !h.revokedAt);
    const record = this.store.data.devices.find(
      (d) => d.id === msg.id && d.hostId === msg.host && !d.revokedAt,
    );
    if (
      !hostRecord ||
      !record ||
      !(await verifySignature(
        decode(record.pub),
        decode(msg.sig),
        deviceAuthTranscript(this.config.publicOrigin, nonce, msg.id, msg.host),
      ))
    )
      return false;
    if (
      peer.ws.readyState !== WebSocket.OPEN ||
      record.revokedAt ||
      hostRecord.revokedAt ||
      !this.store.data.devices.includes(record) ||
      !this.store.data.hosts.includes(hostRecord)
    )
      return false;
    if (
      [...this.peers].filter(
        (p) => p.role === "device" && p.hostId === msg.host && p.ws.readyState === WebSocket.OPEN,
      ).length >= this.config.limits.connections
    ) {
      peer.ws.close(4006, "limit");
      return true;
    }
    peer.id = msg.id;
    peer.hostId = msg.host;
    record.lastSeenAt = Date.now();
    this.dirty = true;
    const host = this.hosts.get(msg.host);
    this.send(peer, { t: "ok", online: !!host });
    if (host) this.attach(host, peer);
    return true;
  }
  private forward(peer: Peer, frame: Buffer): void {
    if (peer.role === "host") {
      if (frame.length < 4) {
        peer.ws.close(4000, "protocol_error");
        return;
      }
      const target = this.hosts.get(peer.id ?? "")?.routes.get(frame.readUInt32BE());
      if (target) {
        if (target.role === "pair" && frame.length - 4 > 4096) {
          peer.ws.close(4000, "protocol_error");
          return;
        }
        this.send(target, frame.subarray(4));
      }
    } else {
      const host = this.hosts.get(peer.hostId ?? "");
      if (!host || peer.conn === undefined) {
        peer.ws.close(4000, "protocol_error");
        return;
      }
      const header = Buffer.alloc(4);
      header.writeUInt32BE(peer.conn);
      this.send(host, Buffer.concat([header, frame]));
    }
  }
  private async control(peer: Peer, msg: RelayMessage): Promise<void> {
    if (peer.role === "device") {
      const record = this.store.data.devices.find(
        (d) => d.id === peer.id && d.hostId === peer.hostId && !d.revokedAt,
      );
      if (!record) {
        peer.ws.close(4003, "revoked");
        return;
      }
      if (msg.t === "push.subscribe") {
        if (!this.pushService.allowed(msg.endpoint)) {
          this.send(peer, { t: "error", code: "push_endpoint" });
          return;
        }
        record.push = { endpoint: msg.endpoint, p256dh: msg.p256dh, auth: msg.auth };
        await this.store.save();
        this.send(peer, { t: "push.subscribed" });
      } else if (msg.t === "push.unsubscribe") {
        delete record.push;
        await this.store.save();
        this.send(peer, { t: "push.unsubscribed" });
      } else peer.ws.close(4000, "protocol_error");
      return;
    }
    if (peer.role !== "host" || !peer.id) {
      peer.ws.close(4000, "protocol_error");
      return;
    }
    const hostId = peer.id;
    switch (msg.t) {
      case "pair.open": {
        for (const [key, value] of this.slots)
          if (value.expiresAt <= Date.now()) this.slots.delete(key);
        if ([...this.slots.values()].filter((s) => s.hostId === hostId).length >= 3) {
          this.send(peer, { t: "error", code: "limit" });
          break;
        }
        const slot = randomBytes(16).toString("base64url"),
          expiresAt = Date.now() + this.config.limits.slotLifetimeMs;
        this.slots.set(slot, { hostId, expiresAt });
        this.send(peer, { t: "pair.slot", slot, expiresAt });
        break;
      }
      case "device.allow": {
        if ((await identityId(decode(msg.pub))) !== msg.id) {
          this.send(peer, { t: "error", code: "protocol_error" });
          break;
        }
        if (this.store.data.devices.some((d) => d.id === msg.id && d.revokedAt)) {
          this.send(peer, { t: "error", code: "revoked" });
          break;
        }
        const existing = this.store.data.devices.find(
          (d) => d.id === msg.id && d.hostId === hostId,
        );
        if (existing) existing.name = msg.name;
        else if (
          this.store.data.devices.filter((d) => d.hostId === hostId && !d.revokedAt).length >=
          this.config.limits.devices
        ) {
          this.send(peer, { t: "error", code: "limit" });
          break;
        } else
          this.store.data.devices.push({
            id: msg.id,
            pub: msg.pub,
            hostId,
            name: msg.name,
            createdAt: Date.now(),
          });
        await this.store.save();
        this.send(peer, { t: "device.allowed", id: msg.id });
        break;
      }
      case "device.remove":
        this.store.data.devices = this.store.data.devices.filter(
          (d) => d.id !== msg.id || d.hostId !== hostId || !!d.revokedAt,
        );
        for (const device of this.peers)
          if (device.id === msg.id && device.hostId === hostId) device.ws.close(4003, "revoked");
        await this.store.save();
        this.send(peer, { t: "device.removed", id: msg.id });
        break;
      case "devices":
        if (msg.list !== undefined) {
          peer.ws.close(4000, "protocol_error");
          break;
        }
        this.send(peer, {
          t: "devices",
          list: this.store.data.devices
            .filter((d) => d.hostId === hostId && !d.revokedAt)
            .map((d) => ({
              id: d.id,
              name: d.name,
              createdAt: d.createdAt,
              lastSeenAt: d.lastSeenAt ?? null,
              push: !!d.push,
              online: [...this.peers].some(
                (p) =>
                  p.role === "device" &&
                  p.id === d.id &&
                  p.hostId === hostId &&
                  p.ws.readyState === WebSocket.OPEN,
              ),
            })),
        });
        break;
      case "push": {
        const now = Date.now();
        let count = 0;
        if (now - (this.pushes.get(hostId) ?? -Infinity) >= 30000) {
          this.pushes.set(hostId, now);
          const devices = this.store.data.devices.filter(
            (d) => d.hostId === hostId && !d.revokedAt && d.push,
          );
          count = (await Promise.all(devices.map((d) => this.pushService.send(d)))).filter(
            Boolean,
          ).length;
          await this.store.save();
          this.log("push", peer);
        }
        this.send(peer, { t: "push.sent", count });
        break;
      }
      case "conn.close":
        this.hosts.get(hostId)?.routes.get(msg.conn)?.ws.close(1000);
        break;
      case "unregister":
        this.store.data.hosts = this.store.data.hosts.filter(
          (h) => h.id !== hostId || !!h.revokedAt,
        );
        this.store.data.devices = this.store.data.devices.filter(
          (d) => d.hostId !== hostId || !!d.revokedAt,
        );
        for (const device of this.peers)
          if (device.hostId === hostId) device.ws.close(4003, "revoked");
        await this.store.save();
        this.send(peer, { t: "unregistered" });
        peer.ws.close(1000);
        break;
      default:
        peer.ws.close(4000, "protocol_error");
    }
  }
  async revoke(role: "host" | "device", id: string): Promise<void> {
    const records: (HostRecord | DeviceRecord)[] =
      role === "host" ? this.store.data.hosts : this.store.data.devices;
    for (const record of records) if (record.id === id) record.revokedAt = Date.now();
    for (const peer of this.peers)
      if (peer.id === id || (role === "host" && peer.hostId === id)) peer.ws.close(4003, "revoked");
    await this.store.save();
    this.logger({ time: Date.now(), event: "revoke", role, id });
  }
  async start(): Promise<number> {
    await this.store.open();
    await this.pushService.open();
    const match = /^(.*):(\d+)$/.exec(this.config.listen);
    if (!match) throw new Error("listen 格式错误");
    await new Promise<void>((resolveStart, reject) => {
      this.http.once("error", reject);
      this.http.listen(Number(match[2]), match[1], () => {
        this.http.removeListener("error", reject);
        resolveStart();
      });
    });
    this.heartbeat = setInterval(() => {
      for (const peer of this.peers) {
        if (!peer.alive) peer.ws.terminate();
        else {
          peer.alive = false;
          peer.ws.ping();
        }
      }
    }, this.config.limits.heartbeatMs);
    this.flush = setInterval(() => {
      if (this.dirty) {
        this.dirty = false;
        void this.store.save().catch(() => {
          this.dirty = true;
        });
      }
    }, 60000);
    const addr = this.http.address();
    if (!addr || typeof addr === "string") throw new Error("监听失败");
    return addr.port;
  }
  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    clearInterval(this.flush);
    for (const peer of this.peers) peer.ws.terminate();
    await new Promise<void>((done) => {
      this.http.close(() => {
        done();
      });
      this.http.closeAllConnections();
    });
    for (const server of Object.values(this.servers)) server.close();
    await this.registration;
    await this.store.save();
  }
}
