import {
  connectChannel,
  connectDeviceRelay,
  FRAME_TYPES,
  RelayError,
  RemoteChannelError,
  type DeviceRelay,
  type FrameTransport,
  type SecureLineTransport,
} from "@nocturne/remote";
import {
  createRpcClient,
  RpcError,
  RPC_PROTOCOL_VERSION,
  type RpcClient,
} from "@nocturne/rpc/client";
import {
  retryDelay,
  versionMessage,
  type ConnectionState,
  type PhoneConnectionLike,
  type PhoneConnectionOptions,
} from "../../desktop/src/web/connection";
import { closeReason } from "../../desktop/src/web/local";
import { decode } from "../../desktop/src/web/storage";

export const LAN_RACE_TIMEOUT_MS = 1_500;
const STORAGE_KEY = "nocturne.lan.endpoints.v1";

export interface LanEndpointStore {
  get(hostId: string): string[];
  set(hostId: string, endpoints: readonly string[]): boolean;
}

export interface LanClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const defaultLanClock: LanClock = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function isPrivateIPv4Host(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return false;
    const n = Number(part);
    if (n < 0 || n > 255) return false;
    nums.push(n);
  }
  const a = nums[0] ?? -1;
  const b = nums[1] ?? -1;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 127
  );
}

export function normalizeLanEndpoints(raw: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    try {
      const url = new URL(item);
      if (url.protocol !== "ws:" || url.username || url.password || !url.port) continue;
      const port = Number(url.port);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) continue;
      if (!isPrivateIPv4Host(url.hostname)) continue;
      const normalized = `ws://${url.hostname}:${port}`;
      if (!seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    } catch {
      /* 忽略非法地址 */
    }
  }
  return out;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function memoryLanStore(): LanEndpointStore {
  const map = new Map<string, string[]>();
  return {
    get(hostId) {
      return [...(map.get(hostId) ?? [])];
    },
    set(hostId, endpoints) {
      const normalized = normalizeLanEndpoints(endpoints);
      const previous = map.get(hostId) ?? [];
      const changed = !sameList(previous, normalized);
      if (normalized.length === 0) map.delete(hostId);
      else map.set(hostId, normalized);
      return changed;
    },
  };
}

export function localStorageLanStore(key = STORAGE_KEY): LanEndpointStore {
  const readAll = (): Record<string, string[]> => {
    try {
      const text = localStorage.getItem(key);
      if (!text) return {};
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      const result: Record<string, string[]> = {};
      for (const [hostId, list] of Object.entries(parsed)) {
        if (Array.isArray(list)) {
          const clean = normalizeLanEndpoints(list);
          if (clean.length > 0) result[hostId] = clean;
        }
      }
      return result;
    } catch {
      return {};
    }
  };
  return {
    get(hostId) {
      return readAll()[hostId] ?? [];
    },
    set(hostId, endpoints) {
      const all = readAll();
      const previous = all[hostId] ?? [];
      const normalized = normalizeLanEndpoints(endpoints);
      const changed = !sameList(previous, normalized);
      const nextAll: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(all)) {
        if (k !== hostId) nextAll[k] = v;
      }
      if (normalized.length > 0) nextAll[hostId] = normalized;
      try {
        localStorage.setItem(key, JSON.stringify(nextAll));
      } catch {
        /* localStorage 不可写时退化为单次忽略 */
      }
      return changed;
    },
  };
}

/**
 * 传输层硬门卫：在 `allowDataFrames()` 调用之前（即含电脑公钥验签的完整握手落定前），
 * 严禁发出任何 `data` 数据帧。
 */
export function guardPreHandshakeTransport(raw: FrameTransport): {
  transport: FrameTransport;
  allowDataFrames(): void;
} {
  let verified = false;
  return {
    allowDataFrames() {
      verified = true;
    },
    transport: {
      send(frame) {
        if (!verified) {
          const type = frame[0];
          const isHandshakeControl =
            frame.byteLength > 0 &&
            (type === FRAME_TYPES.init ||
              type === FRAME_TYPES.finish ||
              type === FRAME_TYPES.error);
          if (!isHandshakeControl) {
            raw.close();
            throw new RemoteChannelError("protocol_error");
          }
        }
        raw.send(frame);
      },
      onFrame(handler) {
        raw.onFrame(handler);
      },
      onClose(handler) {
        raw.onClose(handler);
      },
      close() {
        raw.close();
      },
    },
  };
}

interface ListenerRegistration {
  attach(client: RpcClient): () => void;
  detach: (() => void) | undefined;
}

class SwitchingRpcFacade {
  private current: RpcClient;
  private readonly registrations = new Set<ListenerRegistration>();
  private cutoverPromise: Promise<void> | undefined;
  private releaseCutover: (() => void) | undefined;
  private resolveClosed!: () => void;
  readonly closedPromise: Promise<void>;
  private closedFlag = false;

  constructor(initial: RpcClient) {
    this.current = initial;
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  get active(): RpcClient {
    return this.current;
  }

  beginCutover(): void {
    if (this.cutoverPromise) return;
    this.cutoverPromise = new Promise<void>((resolve) => {
      this.releaseCutover = resolve;
    });
  }

  bindTarget(next: RpcClient): void {
    if (this.current === next) return;
    for (const reg of this.registrations) {
      reg.detach?.();
      reg.detach = reg.attach(next);
    }
    this.current = next;
  }

  completeCutover(next: RpcClient): void {
    this.bindTarget(next);
    const release = this.releaseCutover;
    this.cutoverPromise = undefined;
    this.releaseCutover = undefined;
    release?.();
  }

  abortCutover(fallback: RpcClient): void {
    this.bindTarget(fallback);
    const release = this.releaseCutover;
    this.cutoverPromise = undefined;
    this.releaseCutover = undefined;
    release?.();
  }

  markClosed(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    for (const reg of this.registrations) {
      reg.detach?.();
      reg.detach = undefined;
    }
    this.registrations.clear();
    const release = this.releaseCutover;
    this.cutoverPromise = undefined;
    this.releaseCutover = undefined;
    release?.();
    this.current.close();
    this.resolveClosed();
  }

  createProxy(options: { bypassDuringRecovery?: () => boolean } = {}): RpcClient {
    const register = (attach: (client: RpcClient) => () => void): (() => void) => {
      const reg: ListenerRegistration = {
        attach,
        detach: this.closedFlag ? undefined : attach(this.current),
      };
      if (!this.closedFlag) this.registrations.add(reg);
      return () => {
        reg.detach?.();
        reg.detach = undefined;
        this.registrations.delete(reg);
      };
    };

    const waitReady = async (): Promise<RpcClient> => {
      if (this.cutoverPromise && !options.bypassDuringRecovery?.()) {
        await this.cutoverPromise;
      }
      return this.current;
    };

    const wrapMethodObject = <T extends object>(select: (client: RpcClient) => T): T =>
      new Proxy({} as T, {
        get: (_target, prop) => {
          return (...args: unknown[]) =>
            waitReady().then((client) => {
              const obj = select(client) as Record<PropertyKey, unknown>;
              const fn = obj[prop];
              if (typeof fn !== "function") return fn;
              return (fn as (...a: unknown[]) => unknown).apply(obj, args);
            });
        },
      });

    const runtimeProxy = wrapMethodObject((c) => c.runtime);
    const providerProxy = wrapMethodObject((c) => c.provider);
    const loginProxy = wrapMethodObject((c) => c.login);
    const computerProxy: RpcClient["computer"] = {
      ...wrapMethodObject((c) => c.computer),
      onChanged: (handler) => register((c) => c.computer.onChanged(handler)),
    };

    return {
      computer: computerProxy,
      runtime: runtimeProxy,
      provider: providerProxy,
      login: loginProxy,
      onNotification: (method, handler) => register((c) => c.onNotification(method, handler)),
      onEvent: (handler) => register((c) => c.onEvent(handler)),
      onProvidersChanged: (handler) => register((c) => c.onProvidersChanged(handler)),
      onLoginCompleted: (handler) => register((c) => c.onLoginCompleted(handler)),
      initialize: () => waitReady().then((c) => c.initialize()),
      call: (method, params) => waitReady().then((c) => c.call(method, params)),
      session: (sessionId: string) => {
        type SessionHandle = ReturnType<RpcClient["session"]>;
        const base = wrapMethodObject<SessionHandle>((c) => c.session(sessionId));
        return new Proxy(base, {
          get: (target, prop): unknown => {
            if (prop === "id") return sessionId;
            if (prop === "subscribe") {
              return async (
                listener: Parameters<SessionHandle["subscribe"]>[0],
                subOptions?: Parameters<SessionHandle["subscribe"]>[1],
              ) => {
                const client = await waitReady();
                return client.session(sessionId).subscribe(listener, subOptions);
              };
            }
            return Reflect.get(target, prop) as unknown;
          },
        });
      },
      shutdown: () => waitReady().then((c) => c.shutdown()),
      close: () => {
        this.markClosed();
      },
      closed: this.closedPromise,
    };
  }
}

export interface LanPhoneConnectionOptions extends PhoneConnectionOptions {
  connectLan?: ((url: string) => Promise<FrameTransport>) | undefined;
  endpointStore?: LanEndpointStore | undefined;
  clock?: LanClock | undefined;
  raceTimeoutMs?: number | undefined;
  random?: (() => number) | undefined;
}

interface LanHandshakeSuccess {
  endpoint: string;
  raw: FrameTransport;
  channel: SecureLineTransport;
}

export class LanPhoneConnection implements PhoneConnectionLike {
  client: RpcClient | undefined;
  relay: DeviceRelay | undefined;
  state: ConnectionState = "offline";
  message = "";
  sessionsDir: string | undefined;
  /** 当前底层传输类型（仅用于内部测试观察，不暴露到任何界面） */
  transportKind: "none" | "lan" | "relay" = "none";

  private readonly store: LanEndpointStore;
  private readonly clock: LanClock;
  private readonly badEndpoints = new Set<string>();
  private facade: SwitchingRpcFacade | undefined;
  private activeRawTransport: FrameTransport | undefined;
  private generation = 0;
  private upgradeRunning = false;
  private attempt = 0;
  private timer: unknown;
  private activeRaceCleanup: (() => void) | undefined;
  private stopped = true;
  private visible = true;
  private connecting = false;

  constructor(private readonly options: LanPhoneConnectionOptions) {
    this.store = options.endpointStore ?? localStorageLanStore();
    this.clock = options.clock ?? defaultLanClock;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.cancelTimer();
    this.activeRaceCleanup?.();
    this.activeRaceCleanup = undefined;
    this.facade?.markClosed();
    this.facade = undefined;
    this.client = undefined;
    try {
      this.activeRawTransport?.close();
    } catch {
      /* 已关闭 */
    }
    this.activeRawTransport = undefined;
    try {
      this.relay?.transport.close();
    } catch {
      /* 已关闭 */
    }
    this.relay = undefined;
    this.transportKind = "none";
    this.connecting = false;
    this.upgradeRunning = false;
  }

  visibility(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.cancelTimer();
    } else if (!this.stopped && this.transportKind === "none" && !this.relay && !this.connecting) {
      this.cancelTimer();
      void this.connect();
    }
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private set(state: ConnectionState, message = ""): void {
    this.state = state;
    this.message = message;
    this.options.changed();
  }

  private updateStoredEndpoints(endpoints: readonly string[]): boolean {
    const changed = this.store.set(this.options.host.hostId, endpoints);
    if (changed) {
      this.badEndpoints.clear();
    }
    return changed;
  }

  private candidateEndpoints(): string[] {
    if (!this.options.connectLan) return [];
    return this.store
      .get(this.options.host.hostId)
      .filter((endpoint) => !this.badEndpoints.has(endpoint));
  }

  private retry(code?: number, reason = closeReason(code)): void {
    if (this.stopped) return;
    this.generation++;
    this.activeRaceCleanup?.();
    this.activeRaceCleanup = undefined;
    this.facade?.markClosed();
    this.facade = undefined;
    this.client = undefined;
    try {
      this.activeRawTransport?.close();
    } catch {
      /* 已关闭 */
    }
    this.activeRawTransport = undefined;
    try {
      this.relay?.transport.close();
    } catch {
      /* 已关闭 */
    }
    this.relay = undefined;
    this.transportKind = "none";
    this.connecting = false;
    this.upgradeRunning = false;
    this.options.disconnected(reason);
    if (code === 4003 || code === 4004) {
      this.stopped = true;
      this.set("revoked", "这台手机已被移除或吊销");
      return;
    }
    this.set("offline", "电脑已离线，等它上线会自动连接");
    if (!this.visible) return;
    const delay = code === 4002 ? 0 : retryDelay(this.attempt++, this.options.random);
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
  }

  private raceLanEndpoints(
    candidates: readonly string[],
    generation: number,
  ): Promise<LanHandshakeSuccess | undefined> {
    const connectLan = this.options.connectLan;
    if (!connectLan || candidates.length === 0) return Promise.resolve(undefined);

    return new Promise<LanHandshakeSuccess | undefined>((resolve) => {
      const state = { settled: false };
      const isSettled = () => state.settled;
      let failed = 0;
      const openTransports = new Set<FrameTransport>();
      const hostPublicKey = decode(this.options.host.hostPub);
      const timeoutMs = this.options.raceTimeoutMs ?? LAN_RACE_TIMEOUT_MS;

      const finish = (winner: LanHandshakeSuccess | undefined) => {
        if (state.settled) return;
        state.settled = true;
        this.clock.clearTimeout(raceTimer);
        if (this.activeRaceCleanup === cancelAll) {
          this.activeRaceCleanup = undefined;
        }
        for (const t of openTransports) {
          if (t !== winner?.raw) {
            try {
              t.close();
            } catch {
              /* 其余候选关闭 */
            }
          }
        }
        openTransports.clear();
        resolve(winner);
      };

      const cancelAll = () => {
        finish(undefined);
      };
      this.activeRaceCleanup = cancelAll;

      const raceTimer = this.clock.setTimeout(() => {
        finish(undefined);
      }, timeoutMs);

      for (const endpoint of candidates) {
        void (async () => {
          let raw: FrameTransport | undefined;
          try {
            raw = await connectLan(endpoint);
            if (isSettled() || !this.isCurrent(generation)) {
              raw.close();
              return;
            }
            openTransports.add(raw);
            const guarded = guardPreHandshakeTransport(raw);
            const channel = await (this.options.channel ?? connectChannel)(guarded.transport, {
              identity: this.options.identity,
              hostPublicKey,
            });
            if (isSettled() || !this.isCurrent(generation)) {
              channel.close();
              raw.close();
              return;
            }
            guarded.allowDataFrames();
            finish({ endpoint, raw, channel });
          } catch (error) {
            if (raw) {
              openTransports.delete(raw);
              try {
                raw.close();
              } catch {
                /* 已关闭 */
              }
            }
            if (
              error instanceof RemoteChannelError &&
              (error.code === "bad_signature" || error.code === "fingerprint_mismatch")
            ) {
              // 公钥验签失败的地址当作不可用，不提示、不重试直到地址列表更新
              this.badEndpoints.add(endpoint);
            }
            failed++;
            if (failed >= candidates.length) {
              finish(undefined);
            }
          }
        })();
      }
    });
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private isRelayActive(generation: number): boolean {
    return this.isCurrent(generation) && this.transportKind === "relay";
  }

  private async connect(): Promise<void> {
    if (this.stopped || !this.visible || this.connecting) return;
    this.connecting = true;
    const generation = ++this.generation;
    this.set("connecting");

    const candidates = this.candidateEndpoints();
    if (candidates.length > 0) {
      const direct = await this.raceLanEndpoints(candidates, generation);
      if (!this.isCurrent(generation)) {
        direct?.channel.close();
        direct?.raw.close();
        return;
      }
      if (direct) {
        const ok = await this.activateDirect(direct, generation);
        if (ok || !this.isCurrent(generation)) return;
      }
    }

    await this.connectViaRelay(generation);
  }

  private handleProtocolIncompatible(version: number): void {
    this.stop();
    this.set("incompatible", (this.options.versionMessage ?? versionMessage)(version));
  }

  private attachEndpointWatcher(facade: SwitchingRpcFacade, generation: number): void {
    const proxy = facade.createProxy();
    proxy.onNotification("remote.lanEndpointsChanged", ({ endpoints }) => {
      if (!this.isCurrent(generation)) return;
      this.updateStoredEndpoints(endpoints);
      if (this.isRelayActive(generation) && this.state === "online") {
        void this.tryBackgroundUpgrade(generation);
      }
    });
  }

  private async activateDirect(direct: LanHandshakeSuccess, generation: number): Promise<boolean> {
    const rawClient = createRpcClient(direct.channel, {
      clientName: "nocturne-phone",
      interactive: true,
    });
    try {
      const initialized = await rawClient.initialize();
      if (!this.isCurrent(generation)) {
        rawClient.close();
        direct.raw.close();
        return false;
      }
      this.sessionsDir = initialized.sessionsDir;
      this.options.initialized?.(initialized.nocturneVersion);
      if (initialized.protocolVersion !== RPC_PROTOCOL_VERSION) {
        rawClient.close();
        direct.raw.close();
        this.handleProtocolIncompatible(initialized.protocolVersion);
        return true;
      }
      const facade = new SwitchingRpcFacade(rawClient);
      const exposed = facade.createProxy();
      this.facade = facade;
      this.client = exposed;
      this.activeRawTransport = direct.raw;
      this.transportKind = "lan";
      this.attachEndpointWatcher(facade, generation);

      await this.options.connected(exposed, undefined);
      if (!this.isCurrent(generation)) {
        facade.markClosed();
        direct.raw.close();
        return false;
      }
      this.connecting = false;
      this.attempt = 0;
      this.set("online");
      // 也在直连上刷新一次最新地址列表
      void rawClient
        .call("remote.lanEndpoints", {})
        .then(({ endpoints }) => {
          if (this.isCurrent(generation)) {
            this.updateStoredEndpoints(endpoints);
          }
        })
        .catch(() => undefined);

      void rawClient.closed.then(() => {
        if (this.isCurrent(generation) && this.facade?.active === rawClient) {
          this.retry(undefined, "加密连接关闭");
        }
      });
      return true;
    } catch (error) {
      rawClient.close();
      direct.raw.close();
      if (!this.isCurrent(generation)) return false;
      if (error instanceof RpcError && error.code === "protocol_version_mismatch") {
        const version = /服务端\s+(\d+)/.exec(error.message)?.[1];
        this.handleProtocolIncompatible(Number(version ?? RPC_PROTOCOL_VERSION + 1));
        return true;
      }
      this.facade = undefined;
      this.client = undefined;
      this.activeRawTransport = undefined;
      this.transportKind = "none";
      return false;
    }
  }

  private async connectViaRelay(generation: number): Promise<void> {
    try {
      const relay = await (this.options.connect ?? connectDeviceRelay)({
        origin: this.options.origin,
        identity: this.options.identity,
        hostId: this.options.host.hostId,
      });
      if (!this.isCurrent(generation)) {
        relay.transport.close();
        return;
      }
      this.relay = relay;
      relay.onClose((code) => {
        if (this.isCurrent(generation) && this.relay === relay) {
          this.retry(code);
        }
      });
      if (!relay.online) this.set("offline", "电脑已离线，等它上线会自动连接");
      let started = false;
      relay.onHostOnline(() => {
        if (started || !this.isCurrent(generation) || this.relay !== relay) return;
        started = true;
        void this.handshakeRelay(relay, generation);
      });
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.retry(
          error instanceof RelayError ? error.closeCode : undefined,
          error instanceof RelayError ? closeReason(error.closeCode) : "无法连接中继",
        );
      }
    }
  }

  private async handshakeRelay(relay: DeviceRelay, generation: number): Promise<void> {
    try {
      const guarded = guardPreHandshakeTransport(relay.transport);
      const channel = await (this.options.channel ?? connectChannel)(guarded.transport, {
        identity: this.options.identity,
        hostPublicKey: decode(this.options.host.hostPub),
      });
      if (!this.isCurrent(generation)) {
        channel.close();
        return;
      }
      guarded.allowDataFrames();
      const relayClient = createRpcClient(channel, {
        clientName: "nocturne-phone",
        interactive: true,
      });
      const initialized = await relayClient.initialize();
      if (!this.isCurrent(generation)) {
        relayClient.close();
        return;
      }
      this.sessionsDir = initialized.sessionsDir;
      this.options.initialized?.(initialized.nocturneVersion);
      if (initialized.protocolVersion !== RPC_PROTOCOL_VERSION) {
        relayClient.close();
        this.handleProtocolIncompatible(initialized.protocolVersion);
        return;
      }
      const facade = new SwitchingRpcFacade(relayClient);
      const exposed = facade.createProxy();
      this.facade = facade;
      this.client = exposed;
      this.transportKind = "relay";
      this.attachEndpointWatcher(facade, generation);

      await this.options.connected(exposed, relay);
      if (!this.isCurrent(generation)) {
        facade.markClosed();
        return;
      }
      this.connecting = false;
      this.attempt = 0;
      this.set("online");
      void relayClient.closed.then(() => {
        if (this.isCurrent(generation) && this.facade?.active === relayClient) {
          this.retry(undefined, "加密连接关闭");
        }
      });

      // 每次经中继连上后取一次直连地址，按电脑 id 存本机；取到后后台尝试一次直连升级
      void this.fetchEndpointsAndMaybeUpgrade(relayClient, generation);
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      if (error instanceof RpcError && error.code === "protocol_version_mismatch") {
        const version = /服务端\s+(\d+)/.exec(error.message)?.[1];
        this.handleProtocolIncompatible(Number(version ?? RPC_PROTOCOL_VERSION + 1));
      } else {
        this.retry(
          undefined,
          `握手失败：${error instanceof Error ? error.message : String(error)}`,
        );
        relay.transport.close();
      }
    }
  }

  private async fetchEndpointsAndMaybeUpgrade(
    relayClient: RpcClient,
    generation: number,
  ): Promise<void> {
    try {
      const { endpoints } = await relayClient.call("remote.lanEndpoints", {});
      if (!this.isCurrent(generation)) return;
      this.updateStoredEndpoints(endpoints);
    } catch {
      if (!this.isCurrent(generation)) return;
    }
    if (this.isRelayActive(generation) && this.state === "online") {
      await this.tryBackgroundUpgrade(generation);
    }
  }

  private async tryBackgroundUpgrade(generation: number): Promise<void> {
    if (this.upgradeRunning || !this.isRelayActive(generation) || this.state !== "online") {
      return;
    }
    const candidates = this.candidateEndpoints();
    if (candidates.length === 0) return;

    this.upgradeRunning = true;
    try {
      const direct = await this.raceLanEndpoints(candidates, generation);
      const facade = this.facade;
      if (!direct || !this.isRelayActive(generation) || !facade) {
        direct?.channel.close();
        direct?.raw.close();
        return;
      }

      const oldRelayClient = facade.active;
      const oldRelay = this.relay;

      // 进入切换栅栏：此后外部新发起的 RPC 调用排队，不发往即将关闭的中继连接，也不重发旧在途请求
      facade.beginCutover();

      const directClient = createRpcClient(direct.channel, {
        clientName: "nocturne-phone",
        interactive: true,
      });
      let recovering = false;
      try {
        const initialized = await directClient.initialize();
        if (!this.isCurrent(generation) || this.facade !== facade) {
          directClient.close();
          direct.raw.close();
          return;
        }
        if (initialized.protocolVersion !== RPC_PROTOCOL_VERSION) {
          directClient.close();
          direct.raw.close();
          this.handleProtocolIncompatible(initialized.protocolVersion);
          return;
        }
        this.sessionsDir = initialized.sessionsDir;
        this.options.initialized?.(initialized.nocturneVersion);

        // 先切换底层目标以便恢复期间通知与会话重新订阅都在直连通道上建立
        facade.bindTarget(directClient);
        recovering = true;
        const recoveryHandle = facade.createProxy({
          bypassDuringRecovery: () => recovering,
        });
        await this.options.connected(recoveryHandle, undefined);
        recovering = false;

        if (!this.isCurrent(generation) || this.facade !== facade) {
          directClient.close();
          direct.raw.close();
          return;
        }

        // 先切走 relay 引用，使随后主动关闭旧中继连接不会触发断线回调
        this.relay = undefined;
        this.activeRawTransport = direct.raw;
        this.transportKind = "lan";

        // 释放切换期间排队的用户 RPC 调用到新的直连客户端
        facade.completeCutover(directClient);

        void directClient.closed.then(() => {
          if (this.isCurrent(generation) && this.facade?.active === directClient) {
            this.retry(undefined, "加密连接关闭");
          }
        });

        // 恢复完成后关闭中继上的设备连接
        oldRelayClient.close();
        oldRelay?.transport.close();
      } catch {
        recovering = false;
        directClient.close();
        direct.raw.close();
        if (this.isCurrent(generation) && this.facade === facade) {
          facade.abortCutover(oldRelayClient);
        }
      }
    } finally {
      this.upgradeRunning = false;
    }
  }
}
