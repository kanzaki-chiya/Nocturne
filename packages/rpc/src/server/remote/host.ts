import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { CredentialStore } from "@nocturne/core";
import {
  acceptChannel,
  acceptPairingHello,
  connectHostRelay,
  createPairingOffer,
  exportIdentity,
  generateIdentity,
  importIdentity,
  parseInvite,
  registerHost,
  RelayError,
  RemoteChannelError,
  type HostRelay,
  type Identity,
  type PairingSecret,
  type RelayConnection,
  type RelayDevice,
  type SecureLineTransport,
} from "@nocturne/remote";
import type { RemoteStatus } from "../../shared/methods.js";
import type { LineTransport } from "../../shared/transport.js";
import type { RpcMessage } from "../../shared/jsonrpc.js";
import { RpcProtocolError } from "../errors.js";
import {
  formatLanEndpoints,
  listenLanDirect,
  listPrivateIPv4Addresses,
  type LanDirectListener,
  type LanInboundConnection,
} from "./lan.js";
import {
  deleteRegistration,
  loadRegistration,
  preserveCorruptRegistration,
  saveRegistration,
  type RemoteRegistration,
} from "./storage.js";

const CREDENTIAL = "remote/host-identity";
const DEFAULT_MAX_CONNECTIONS = 10;
const DEFAULT_LAN_POLL_MS = 5_000;

export interface RemoteHostLanOptions {
  host?: string | undefined;
  listAddresses?: (() => readonly string[]) | undefined;
  addressPollMs?: number | undefined;
  handshakeTimeoutMs?: number | undefined;
  maxHandshaking?: number | undefined;
  resolveRemoteAddress?:
    ((socket: Socket, req?: IncomingMessage) => string | undefined) | undefined;
  onAccepted?:
    ((info: { deviceId: string; remoteAddress: string; port: number }) => void) | undefined;
}

export interface RemoteHostOptions {
  home: string;
  credentials: CredentialStore;
  connect?: { connectHostRelay?: typeof connectHostRelay; registerHost?: typeof registerHost };
  diagnostics?: (state: RemoteStatus["connection"]) => void;
  maxConnections?: number | undefined;
  lan?: RemoteHostLanOptions | undefined;
}

export class RemoteError extends RpcProtocolError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "RemoteError";
  }
}

interface ActiveLanConnection {
  deviceId: string;
  name: string;
  since: number;
  channel: SecureLineTransport;
  inbound: LanInboundConnection;
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, idx) => item === b[idx]);
}

export class RemoteHost {
  private registration: RemoteRegistration | undefined;
  private identity: Identity | undefined;
  private relay: HostRelay | undefined;
  private state: RemoteStatus["connection"] = "off";
  private warnings: string[] = [];
  private devices: RelayDevice[] = [];
  private active = false;
  private generation = 0;
  private retry = 1000;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private pairing:
    | {
        secret: PairingSecret;
        expiresAt: number;
        timer: ReturnType<typeof setTimeout>;
        connection?: RelayConnection;
      }
    | undefined;
  private readonly connections = new Map<
    RelayConnection,
    { deviceId: string; name: string; since: number }
  >();
  private readonly routes = new Set<RelayConnection>();
  private lanListener: LanDirectListener | undefined;
  private lanGeneration = 0;
  private lanPoll: ReturnType<typeof setInterval> | undefined;
  private lastAnnouncedEndpoints: string[] = [];
  private readonly lanConnections = new Set<ActiveLanConnection>();
  private readonly lanInbound = new Set<LanInboundConnection>();
  private lanQueue: Promise<void> = Promise.resolve();
  private readonly loaded: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: RemoteHostOptions,
    private readonly notify: (message: RpcMessage) => void,
    private readonly serve: (transport: LineTransport) => Promise<void>,
    private readonly notifyRemote?: (message: RpcMessage) => void,
  ) {
    this.loaded = loadRegistration(options.home).then((loaded) => {
      this.registration = loaded.registration;
      if (loaded.warning) this.warnings.push(loaded.warning);
    });
  }

  get listeningLanPort(): number | undefined {
    return this.lanListener?.port;
  }

  async describe(): Promise<RemoteStatus> {
    await this.loaded;
    const r = this.registration;
    const onlineDeviceIds = new Set<string>();
    for (const c of this.connections.values()) onlineDeviceIds.add(c.deviceId);
    for (const c of this.lanConnections) onlineDeviceIds.add(c.deviceId);

    const activeConnections = [
      ...this.connections.values(),
      ...[...this.lanConnections].map(({ deviceId, name, since }) => ({ deviceId, name, since })),
    ];

    return {
      registered: r !== undefined,
      ...(r ? { relay: { origin: r.origin, hostId: r.hostId } } : {}),
      enabled: r?.enabled ?? false,
      lanDirect: r?.lanDirect === true,
      connection: this.state,
      devices: this.devices.length
        ? this.devices.map(({ lastSeenAt, ...d }) => ({
            ...d,
            online: d.online || onlineDeviceIds.has(d.id),
            ...(lastSeenAt !== null ? { lastSeenAt } : {}),
          }))
        : (r?.devices ?? []).map(({ pub: _pub, ...d }) => ({
            ...d,
            online: onlineDeviceIds.has(d.id),
            push: false,
          })),
      connections: activeConnections,
      ...(this.pairing ? { pairing: { expiresAt: this.pairing.expiresAt } } : {}),
      warnings: [...this.warnings],
    };
  }

  private changed(): void {
    void this.describe().then((status) => {
      this.notify({ jsonrpc: "2.0", method: "remote.statusChanged", params: { status } });
    });
  }

  private transition(state: RemoteStatus["connection"]): void {
    if (this.state === state) return;
    this.state = state;
    try {
      this.options.diagnostics?.(state);
    } catch {
      /* 诊断不影响连接 */
    }
    this.changed();
  }

  async start(): Promise<void> {
    await this.loaded;
    this.active = true;
    await this.syncLan();
    this.connect();
  }

  stop(): void {
    this.active = false;
    this.disconnect();
    void this.stopLan();
    this.transition("off");
  }

  private disconnect(): void {
    this.generation++;
    clearTimeout(this.timer);
    clearInterval(this.poll);
    this.timer = undefined;
    this.poll = undefined;
    const relay = this.relay;
    this.relay = undefined;
    relay?.close();
    this.cancelPairing();
    for (const route of this.routes) {
      try {
        route.transport.close();
      } catch {
        /* 中继已关闭 */
      }
    }
    this.routes.clear();
    this.connections.clear();
    this.devices = this.devices.map((d) => ({ ...d, online: false }));
  }

  private shouldListenLan(): boolean {
    return (
      this.active &&
      this.registration !== undefined &&
      this.registration.enabled &&
      this.registration.lanDirect === true
    );
  }

  private currentRegistration(): RemoteRegistration | undefined {
    return this.registration;
  }

  private async loadHostIdentity(r: RemoteRegistration): Promise<Identity> {
    const raw = await this.options.credentials.get(CREDENTIAL);
    if (!raw)
      throw new RemoteError("credential_missing", "电脑身份凭据不可用，请退出登记后重新登记");
    const identity = await importIdentity(raw, { extractable: true });
    if (identity.id !== r.hostId)
      throw new RemoteError("credential_missing", "电脑身份与登记不匹配");
    this.identity = identity;
    return identity;
  }

  private computeLanEndpoints(): string[] {
    if (!this.shouldListenLan() || !this.lanListener) return [];
    const addresses = (this.options.lan?.listAddresses ?? listPrivateIPv4Addresses)();
    return formatLanEndpoints(addresses, this.lanListener.port);
  }

  lanEndpoints(): { endpoints: string[] } {
    return { endpoints: this.computeLanEndpoints() };
  }

  refreshLanAddresses(): void {
    if (!this.lanListener || !this.shouldListenLan()) return;
    const next = this.computeLanEndpoints();
    if (!sameStringList(next, this.lastAnnouncedEndpoints)) {
      this.lastAnnouncedEndpoints = next;
      this.notifyRemote?.({
        jsonrpc: "2.0",
        method: "remote.lanEndpointsChanged",
        params: { endpoints: next },
      });
    }
  }

  private syncLan(): Promise<void> {
    const run = this.lanQueue.then(async () => {
      if (!this.shouldListenLan()) {
        await this.stopLanInternal();
        return;
      }
      const r = this.registration;
      if (!r) return;
      if (this.lanListener) {
        this.refreshLanAddresses();
        return;
      }
      let identity: Identity;
      try {
        identity = await this.loadHostIdentity(r);
      } catch (error) {
        if (error instanceof RemoteError && !this.warnings.includes(error.message)) {
          this.warnings.push(error.message);
          this.changed();
        }
        return;
      }
      if (!this.shouldListenLan() || this.registration !== r) return;
      const lanGen = ++this.lanGeneration;
      const listener = await listenLanDirect({
        host: this.options.lan?.host ?? "0.0.0.0",
        preferredPort: r.lanPort,
        maxHandshaking: this.options.lan?.maxHandshaking,
        resolveRemoteAddress: this.options.lan?.resolveRemoteAddress,
        onConnection: (inbound) => {
          void this.acceptLan(inbound, identity, lanGen);
        },
      });
      if (!this.shouldListenLan() || lanGen !== this.lanGeneration) {
        await listener.close();
        return;
      }
      this.lanListener = listener;
      const latestReg = this.registration;
      if (latestReg.lanPort !== listener.port) {
        const updated: RemoteRegistration = { ...latestReg, lanPort: listener.port };
        await saveRegistration(this.options.home, updated);
        if (this.currentRegistration()?.hostId === updated.hostId) {
          this.registration = updated;
        }
      }
      const endpoints = this.computeLanEndpoints();
      this.lastAnnouncedEndpoints = endpoints;
      this.notifyRemote?.({
        jsonrpc: "2.0",
        method: "remote.lanEndpointsChanged",
        params: { endpoints },
      });
      const pollMs = this.options.lan?.addressPollMs ?? DEFAULT_LAN_POLL_MS;
      clearInterval(this.lanPoll);
      if (pollMs > 0) {
        this.lanPoll = setInterval(() => {
          this.refreshLanAddresses();
        }, pollMs);
        this.lanPoll.unref();
      }
    });
    this.lanQueue = run.catch(() => undefined);
    return run;
  }

  private stopLan(): Promise<void> {
    const run = this.lanQueue.then(() => this.stopLanInternal());
    this.lanQueue = run.catch(() => undefined);
    return run;
  }

  private async stopLanInternal(): Promise<void> {
    this.lanGeneration++;
    clearInterval(this.lanPoll);
    this.lanPoll = undefined;
    const hadListener = this.lanListener !== undefined || this.lastAnnouncedEndpoints.length > 0;
    const listener = this.lanListener;
    this.lanListener = undefined;
    this.lastAnnouncedEndpoints = [];
    if (hadListener) {
      this.notifyRemote?.({
        jsonrpc: "2.0",
        method: "remote.lanEndpointsChanged",
        params: { endpoints: [] },
      });
    }
    for (const inbound of this.lanInbound) {
      try {
        inbound.close();
      } catch {
        /* 已关闭 */
      }
    }
    this.lanInbound.clear();
    const hadActive = this.lanConnections.size > 0;
    for (const active of this.lanConnections) {
      try {
        active.channel.close();
        active.inbound.close();
      } catch {
        /* 已关闭 */
      }
    }
    this.lanConnections.clear();
    if (listener) await listener.close();
    if (hadActive) this.changed();
  }

  private lookupRegisteredDevice(id: string): Promise<Uint8Array | undefined> {
    if (!this.active || !this.registration?.enabled) return Promise.resolve(undefined);
    const d = this.registration.devices.find((entry) => entry.id === id);
    return Promise.resolve(d ? Buffer.from(d.pub, "base64url") : undefined);
  }

  private canAcceptDeviceConnection(deviceId: string, viaLan: boolean): boolean {
    const limit = this.options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    const total = this.connections.size + this.lanConnections.size;
    if (total < limit) return true;
    // 允许已在中继在线的同一台设备建立直连完成切换（随后会关闭其中继连接）
    if (
      viaLan &&
      [...this.connections.values()].some((c) => c.deviceId === deviceId) &&
      ![...this.lanConnections].some((c) => c.deviceId === deviceId)
    ) {
      return true;
    }
    return false;
  }

  private connect(): void {
    const r = this.registration;
    if (!this.active || !r?.enabled || this.relay || this.timer) return;
    const generation = ++this.generation;
    this.transition("connecting");
    void (async () => {
      const identity = await this.loadHostIdentity(r);
      const relay = await (this.options.connect?.connectHostRelay ?? connectHostRelay)({
        origin: r.origin,
        hostId: r.hostId,
        identity,
      });
      if (generation !== this.generation || !this.active) {
        relay.close();
        return;
      }
      this.identity = identity;
      this.relay = relay;
      this.retry = 1000;
      relay.onClose((code) => {
        if (generation !== this.generation) return;
        this.disconnect();
        if (code === 4003 || code === 4004) {
          void this.stopLan();
          this.transition("revoked");
        } else if (code === 4001) this.transition("replaced");
        else this.reconnect();
      });
      relay.onConnection((route) => {
        void this.accept(route, generation);
      });
      this.transition("online");
      await this.serialized(() => this.refresh(relay, generation));
      if (generation === this.generation)
        this.poll = setInterval(() => {
          void this.serialized(() => this.refresh(relay, generation)).catch(() => undefined);
        }, 10000);
    })().catch((error: unknown) => {
      if (generation !== this.generation) return;
      this.disconnect();
      if (error instanceof RemoteError) {
        void this.stopLan();
        this.warnings.push(error.message);
        this.transition("off");
      } else if (
        error instanceof RelayError &&
        (error.closeCode === 4003 || error.closeCode === 4004)
      ) {
        void this.stopLan();
        this.transition("revoked");
      } else if (error instanceof RelayError && error.closeCode === 4001) {
        this.transition("replaced");
      } else this.reconnect();
    });
  }

  private reconnect(): void {
    if (!this.active || !this.registration?.enabled) return;
    this.transition("offline");
    const delay = this.retry * (0.8 + Math.random() * 0.4);
    this.retry = Math.min(60000, this.retry * 2);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, delay);
  }

  private async refresh(relay: HostRelay, generation = this.generation): Promise<void> {
    const list = await relay.listDevices();
    const r = this.registration;
    if (generation !== this.generation || !r) return;
    const devices = r.devices.flatMap((d) => {
      const remote = list.find((entry) => entry.id === d.id);
      return remote
        ? [
            {
              ...d,
              name: remote.name,
              ...(remote.lastSeenAt !== null ? { lastSeenAt: remote.lastSeenAt } : {}),
            },
          ]
        : [];
    });
    const next = { ...r, devices };
    const unchanged =
      devices.length === r.devices.length &&
      devices.every((d, index) => {
        const previous = r.devices[index];
        return (
          d.id === previous?.id &&
          d.name === previous.name &&
          d.pub === previous.pub &&
          d.createdAt === previous.createdAt &&
          d.lastSeenAt === previous.lastSeenAt
        );
      });
    if (!unchanged) await saveRegistration(this.options.home, next);
    if (generation !== this.generation) return;
    this.registration = next;
    this.devices = list;
    const allowedIds = new Set(devices.map((d) => d.id));
    for (const active of [...this.lanConnections]) {
      if (!allowedIds.has(active.deviceId)) {
        active.channel.close();
        active.inbound.close();
        this.lanConnections.delete(active);
      }
    }
    this.changed();
  }

  private async accept(route: RelayConnection, generation: number): Promise<void> {
    if (generation !== this.generation) {
      route.transport.close();
      return;
    }
    this.routes.add(route);
    try {
      if (route.kind === "pair") {
        await this.acceptPair(route, generation);
        return;
      }
      if (!this.identity) {
        route.transport.close();
        return;
      }
      const accepted = await acceptChannel(route.transport, {
        identity: this.identity,
        lookupDevice: (id) => {
          if (id !== route.device || generation !== this.generation)
            return Promise.resolve(undefined);
          return this.lookupRegisteredDevice(id);
        },
      });
      if (
        generation !== this.generation ||
        !this.registration?.devices.some((d) => d.id === accepted.deviceId) ||
        !this.canAcceptDeviceConnection(accepted.deviceId, false)
      ) {
        accepted.channel.close();
        return;
      }
      const name =
        this.registration.devices.find((d) => d.id === accepted.deviceId)?.name ?? "手机";
      this.connections.set(route, { deviceId: accepted.deviceId, name, since: Date.now() });
      this.changed();
      await this.serve(accepted.channel);
    } catch {
      try {
        route.transport.close();
      } catch {
        /* 仅关闭失败连接 */
      }
    } finally {
      this.routes.delete(route);
      this.connections.delete(route);
      this.changed();
    }
  }

  private async acceptLan(
    inbound: LanInboundConnection,
    identity: Identity,
    lanGen: number,
  ): Promise<void> {
    if (lanGen !== this.lanGeneration || !this.shouldListenLan()) {
      inbound.close();
      return;
    }
    this.lanInbound.add(inbound);
    let record: ActiveLanConnection | undefined;
    try {
      const accepted = await acceptChannel(inbound.transport, {
        identity,
        ...(this.options.lan?.handshakeTimeoutMs !== undefined
          ? { timeoutMs: this.options.lan.handshakeTimeoutMs }
          : {}),
        lookupDevice: (id) => {
          if (lanGen !== this.lanGeneration || !this.shouldListenLan()) {
            return Promise.resolve(undefined);
          }
          return this.lookupRegisteredDevice(id);
        },
      });
      if (
        lanGen !== this.lanGeneration ||
        !this.shouldListenLan() ||
        !this.registration?.devices.some((d) => d.id === accepted.deviceId) ||
        !this.canAcceptDeviceConnection(accepted.deviceId, true)
      ) {
        accepted.channel.close();
        inbound.close();
        return;
      }
      inbound.markAuthenticated();
      const name =
        this.registration.devices.find((d) => d.id === accepted.deviceId)?.name ?? "手机";
      record = {
        deviceId: accepted.deviceId,
        name,
        since: Date.now(),
        channel: accepted.channel,
        inbound,
      };
      this.lanConnections.add(record);
      try {
        this.options.lan?.onAccepted?.({
          deviceId: accepted.deviceId,
          remoteAddress: inbound.remoteAddress,
          port: this.lanListener?.port ?? 0,
        });
      } catch {
        /* 诊断回调不影响连接 */
      }
      this.changed();
      await this.serve(accepted.channel);
    } catch {
      try {
        inbound.close();
      } catch {
        /* 仅关闭失败连接 */
      }
    } finally {
      this.lanInbound.delete(inbound);
      if (record) {
        this.lanConnections.delete(record);
        this.changed();
      }
    }
  }

  private async acceptPair(route: RelayConnection, generation: number): Promise<void> {
    const pairing = this.pairing,
      identity = this.identity,
      relay = this.relay;
    if (
      !pairing ||
      !identity ||
      !relay ||
      pairing.secret.slot !== route.slot ||
      pairing.connection ||
      pairing.expiresAt <= Date.now()
    ) {
      route.transport.close();
      return;
    }
    pairing.connection = route;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const frame = await new Promise<Uint8Array>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new RemoteChannelError("timeout"));
        }, 60000);
        route.transport.onFrame(resolve);
        route.transport.onClose(() => {
          reject(new RemoteChannelError("closed"));
        });
      });
      const result = await acceptPairingHello(identity, pairing.secret, frame);
      await this.serialized(async () => {
        if (generation !== this.generation || this.pairing !== pairing) return;
        await relay.allowDevice(result.device);
        const r = this.registration;
        if (!r || generation !== this.generation || this.pairing !== pairing) return;
        const device = {
          id: result.device.id,
          name: result.device.name,
          pub: Buffer.from(result.device.publicKey).toString("base64url"),
          createdAt: Date.now(),
        };
        const next = { ...r, devices: [...r.devices.filter((d) => d.id !== device.id), device] };
        await saveRegistration(this.options.home, next);
        this.registration = next;
        route.transport.send(result.reply);
        await this.refresh(relay, generation);
        this.notify({
          jsonrpc: "2.0",
          method: "remote.paired",
          params: { device: { id: device.id, name: device.name } },
        });
      });
    } catch (error) {
      if (this.pairing === pairing)
        this.notify({
          jsonrpc: "2.0",
          method: "remote.pairingFailed",
          params: {
            code:
              error instanceof RemoteChannelError || error instanceof RelayError
                ? error.code
                : "protocol_error",
          },
        });
    } finally {
      clearTimeout(timer);
      if (this.pairing === pairing) this.cancelPairing();
      try {
        route.transport.close();
      } catch {
        /* 连接已关闭 */
      }
    }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await this.loaded;
      return operation();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  register(invite: string): Promise<RemoteStatus> {
    return this.serialized(async () => {
      if (this.registration)
        throw new RemoteError("remote_already_registered", "已登记中继，请先退出登记");
      if (this.options.credentials.backend() === "none")
        throw new RemoteError(
          "credential_backend_unavailable",
          "没有可用的系统凭据后端，无法安全保存电脑身份私钥",
        );
      const parsed = parseInvite(invite),
        identity = await generateIdentity({ extractable: true });
      const { hostId } = await (this.options.connect?.registerHost ?? registerHost)({
        ...parsed,
        identity,
      });
      let wrote = false;
      let backupWarning: string | undefined;
      try {
        await this.options.credentials.set(CREDENTIAL, await exportIdentity(identity));
        wrote = true;
        const registration: RemoteRegistration = {
          version: 1,
          origin: parsed.origin,
          hostId,
          enabled: true,
          lanDirect: false,
          devices: [],
        };
        backupWarning = await preserveCorruptRegistration(this.options.home);
        await saveRegistration(this.options.home, registration);
        this.registration = registration;
      } catch {
        if (wrote) await this.options.credentials.delete(CREDENTIAL);
        throw new RemoteError("remote_storage_failed", "无法保存远程登记，已撤销本地凭据写入");
      }
      this.warnings = backupWarning ? [backupWarning] : [];
      this.connect();
      this.changed();
      return this.describe();
    });
  }

  unregister(): Promise<RemoteStatus> {
    return this.serialized(async () => {
      let removed = false;
      if (this.relay) {
        try {
          await this.relay.unregister();
          removed = true;
        } catch {
          /* 离线仍允许退出 */
        }
      }
      this.disconnect();
      await this.stopLan();
      await this.options.credentials.delete(CREDENTIAL);
      await deleteRegistration(this.options.home);
      this.registration = undefined;
      this.identity = undefined;
      this.devices = [];
      this.warnings = removed ? [] : ["中继上的登记未能删除，可请中继管理员吊销"];
      this.transition("off");
      return this.describe();
    });
  }

  setEnabled(enabled: boolean): Promise<RemoteStatus> {
    return this.serialized(async () => {
      if (!this.registration) throw new RemoteError("remote_not_registered", "尚未登记中继");
      const next = { ...this.registration, enabled };
      await saveRegistration(this.options.home, next);
      this.registration = next;
      if (!enabled) {
        this.disconnect();
        await this.stopLan();
        this.transition("off");
      } else {
        await this.syncLan();
        this.connect();
      }
      this.changed();
      return this.describe();
    });
  }

  setLanDirect(enabled: boolean): Promise<RemoteStatus> {
    return this.serialized(async () => {
      if (!this.registration) throw new RemoteError("remote_not_registered", "尚未登记中继");
      const next: RemoteRegistration = { ...this.registration, lanDirect: enabled };
      await saveRegistration(this.options.home, next);
      this.registration = next;
      await this.syncLan();
      this.changed();
      return this.describe();
    });
  }

  private online(): HostRelay {
    if (!this.relay || this.state !== "online")
      throw new RemoteError("remote_offline", "中继尚未在线，请稍后重试");
    return this.relay;
  }

  startPairing(): Promise<{ url: string; expiresAt: number }> {
    return this.serialized(async () => {
      this.cancelPairing();
      const relay = this.online(),
        generation = this.generation;
      const { slot, expiresAt } = await relay.openPairingSlot();
      if (!this.identity || generation !== this.generation)
        throw new RemoteError("remote_offline", "中继已离线");
      const offer = await createPairingOffer(this.identity, slot);
      this.pairing = {
        secret: offer.secret,
        expiresAt,
        timer: setTimeout(
          () => {
            this.notify({
              jsonrpc: "2.0",
              method: "remote.pairingFailed",
              params: { code: "timeout" },
            });
            this.cancelPairing();
          },
          Math.max(0, expiresAt - Date.now()),
        ),
      };
      this.changed();
      return { url: `${this.registration?.origin ?? ""}/#${offer.fragment}`, expiresAt };
    });
  }

  cancelPairing(): null {
    const pairing = this.pairing;
    this.pairing = undefined;
    if (pairing) {
      clearTimeout(pairing.timer);
      try {
        pairing.connection?.transport.close();
      } catch {
        /* 已关闭 */
      }
      this.changed();
    }
    return null;
  }

  disconnectDevice(id: string): null {
    for (const route of this.routes) {
      if (route.device === id) {
        route.transport.close();
        this.connections.delete(route);
      }
    }
    for (const active of [...this.lanConnections]) {
      if (active.deviceId === id) {
        active.channel.close();
        active.inbound.close();
        this.lanConnections.delete(active);
      }
    }
    this.changed();
    return null;
  }

  removeDevice(id: string): Promise<RemoteStatus> {
    return this.serialized(async () => {
      const relay = this.online();
      await relay.removeDevice(id);
      if (this.registration) {
        const next: RemoteRegistration = {
          ...this.registration,
          devices: this.registration.devices.filter((d) => d.id !== id),
        };
        await saveRegistration(this.options.home, next);
        this.registration = next;
      }
      this.disconnectDevice(id);
      await this.refresh(relay);
      return this.describe();
    });
  }

  async push(): Promise<{ sent: number }> {
    return { sent: this.relay && this.state === "online" ? await this.relay.push() : 0 };
  }
}
