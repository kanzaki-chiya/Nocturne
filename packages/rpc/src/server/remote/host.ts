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
} from "@nocturne/remote";
import type { RemoteStatus } from "../../shared/methods.js";
import type { LineTransport } from "../../shared/transport.js";
import type { RpcMessage } from "../../shared/jsonrpc.js";
import { RpcProtocolError } from "../errors.js";
import {
  deleteRegistration,
  loadRegistration,
  preserveCorruptRegistration,
  saveRegistration,
  type RemoteRegistration,
} from "./storage.js";

const CREDENTIAL = "remote/host-identity";
export interface RemoteHostOptions {
  home: string;
  credentials: CredentialStore;
  connect?: { connectHostRelay?: typeof connectHostRelay; registerHost?: typeof registerHost };
  diagnostics?: (state: RemoteStatus["connection"]) => void;
}
export class RemoteError extends RpcProtocolError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "RemoteError";
  }
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
  private readonly loaded: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly options: RemoteHostOptions,
    private readonly notify: (message: RpcMessage) => void,
    private readonly serve: (transport: LineTransport) => Promise<void>,
  ) {
    this.loaded = loadRegistration(options.home).then((loaded) => {
      this.registration = loaded.registration;
      if (loaded.warning) this.warnings.push(loaded.warning);
    });
  }
  async describe(): Promise<RemoteStatus> {
    await this.loaded;
    const r = this.registration;
    return {
      registered: r !== undefined,
      ...(r ? { relay: { origin: r.origin, hostId: r.hostId } } : {}),
      enabled: r?.enabled ?? false,
      connection: this.state,
      devices: this.devices.length
        ? this.devices.map(({ lastSeenAt, ...d }) => ({
            ...d,
            ...(lastSeenAt !== null ? { lastSeenAt } : {}),
          }))
        : (r?.devices ?? []).map(({ pub: _pub, ...d }) => ({ ...d, online: false, push: false })),
      connections: [...this.connections.values()],
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
    this.connect();
  }
  stop(): void {
    this.active = false;
    this.disconnect();
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
  private connect(): void {
    const r = this.registration;
    if (!this.active || !r?.enabled || this.relay || this.timer) return;
    const generation = ++this.generation;
    this.transition("connecting");
    void (async () => {
      const raw = await this.options.credentials.get(CREDENTIAL);
      if (!raw)
        throw new RemoteError("credential_missing", "电脑身份凭据不可用，请退出登记后重新登记");
      const identity = await importIdentity(raw, { extractable: true });
      if (identity.id !== r.hostId)
        throw new RemoteError("credential_missing", "电脑身份与登记不匹配");
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
        if (code === 4003 || code === 4004) this.transition("revoked");
        else if (code === 4001) this.transition("replaced");
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
        this.warnings.push(error.message);
        this.transition("off");
      } else if (
        error instanceof RelayError &&
        (error.closeCode === 4003 || error.closeCode === 4004)
      )
        this.transition("revoked");
      else if (error instanceof RelayError && error.closeCode === 4001) this.transition("replaced");
      else this.reconnect();
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
          const d = this.registration?.devices.find((entry) => entry.id === id);
          return Promise.resolve(d ? Buffer.from(d.pub, "base64url") : undefined);
        },
      });
      if (
        generation !== this.generation ||
        !this.registration?.devices.some((d) => d.id === accepted.deviceId)
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
        this.transition("off");
      } else this.connect();
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
    for (const route of this.routes)
      if (route.device === id) {
        route.transport.close();
        this.connections.delete(route);
      }
    this.changed();
    return null;
  }
  removeDevice(id: string): Promise<RemoteStatus> {
    return this.serialized(async () => {
      const relay = this.online();
      await relay.removeDevice(id);
      this.disconnectDevice(id);
      await this.refresh(relay);
      return this.describe();
    });
  }
  async push(): Promise<{ sent: number }> {
    return { sent: this.relay && this.state === "online" ? await this.relay.push() : 0 };
  }
}
