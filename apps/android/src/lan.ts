import {
  connectChannel,
  connectDeviceRelay,
  FRAME_TYPES,
  RemoteChannelError,
  type DeviceRelay,
  type FrameTransport,
  type SecureLineTransport,
} from "@nocturne/remote";
import { createRpcClient, RPC_PROTOCOL_VERSION, type RpcClient } from "@nocturne/rpc/client";
import {
  CHANNEL_CLOSED_REASON,
  closeOutcome,
  handshakeFailure,
  HOST_OFFLINE_MESSAGE,
  nextRetryDelay,
  relayConnectFailure,
  versionMessage,
  type ConnectionState,
  type PhoneConnectionLike,
  type PhoneConnectionOptions,
} from "../../desktop/src/web/connection";
import { closeReason } from "../../desktop/src/web/local";
import { decode } from "../../desktop/src/web/storage";

export const LAN_STORAGE_KEY = "nocturne.lan.endpoints.v1";
export const OLD_RELAY_DRAIN_TIMEOUT_MS = 5_000;

export interface LanEndpointStore {
  get(hostId: string): string[];
  set(hostId: string, endpoints: readonly string[]): boolean;
}

export interface LanClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const defaultLanClock: LanClock = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
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
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** 校验并去重局域网直连地址列表（只保留 tcp://<私有网段 IPv4>:<端口>） */
export function normalizeLanEndpoints(raw: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed.startsWith("tcp://")) continue;
    const rest = trimmed.slice("tcp://".length);
    const clean = rest.endsWith("/") ? rest.slice(0, -1) : rest;
    if (!clean || /[/?#@]/.test(clean)) continue;
    const colon = clean.indexOf(":");
    if (colon <= 0 || colon !== clean.lastIndexOf(":")) continue;
    const host = clean.slice(0, colon);
    const portStr = clean.slice(colon + 1);
    if (!isPrivateIPv4Host(host) || !/^[1-9]\d{0,4}$/.test(portStr)) continue;
    const port = Number(portStr);
    if (port < 1 || port > 65535) continue;
    const canonical = `tcp://${host}:${port}`;
    if (!seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, idx) => v === b[idx]);
}

export function memoryLanStore(initial: Record<string, string[]> = {}): LanEndpointStore {
  const map = new Map<string, string[]>();
  for (const [hostId, list] of Object.entries(initial)) {
    const normalized = normalizeLanEndpoints(list);
    if (normalized.length > 0) map.set(hostId, normalized);
  }
  return {
    get(hostId) {
      return [...(map.get(hostId) ?? [])];
    },
    set(hostId, endpoints) {
      const previous = map.get(hostId) ?? [];
      const normalized = normalizeLanEndpoints(endpoints);
      const changed = !sameList(previous, normalized);
      if (normalized.length === 0) map.delete(hostId);
      else map.set(hostId, normalized);
      return changed;
    },
  };
}

export function localStorageLanStore(key = LAN_STORAGE_KEY): LanEndpointStore {
  const readAll = (): Record<string, string[]> => {
    try {
      const raw = globalThis.localStorage.getItem(key);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const result: Record<string, string[]> = {};
      for (const [hostId, list] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(list)) {
          const normalized = normalizeLanEndpoints(list);
          if (normalized.length > 0) result[hostId] = normalized;
        }
      }
      return result;
    } catch {
      return {};
    }
  };

  const writeAll = (all: Record<string, string[]>): void => {
    try {
      globalThis.localStorage.setItem(key, JSON.stringify(all));
    } catch {
      /* 存储受限时静默退化为当次运行态 */
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
      if (normalized.length === 0) {
        const rest = Object.fromEntries(Object.entries(all).filter(([k]) => k !== hostId));
        writeAll(rest);
        return changed;
      }
      all[hostId] = normalized;
      writeAll(all);
      return changed;
    },
  };
}

export interface GuardedHandshakeTransport {
  readonly transport: FrameTransport;
  readonly sentFrameTypes: readonly number[];
  allowDataFrames(): void;
}

/**
 * 传输层守卫：在 `allowDataFrames()` 被调用（即 `connectChannel` 完成电脑公钥验签）前，
 * 严禁发送任何 `FRAME_TYPES.data` 数据帧；若出现非握手控制帧，立即关闭连接并抛错。
 */
export function guardPreHandshakeTransport(raw: FrameTransport): GuardedHandshakeTransport {
  let unlocked = false;
  const sentTypes: number[] = [];
  return {
    sentFrameTypes: sentTypes,
    allowDataFrames() {
      unlocked = true;
    },
    transport: {
      send(frame) {
        const type = frame[0];
        if (!unlocked) {
          if (
            type === undefined ||
            (type !== FRAME_TYPES.init && type !== FRAME_TYPES.finish && type !== FRAME_TYPES.error)
          ) {
            raw.close();
            throw new RemoteChannelError("protocol_error");
          }
        }
        if (type !== undefined) sentTypes.push(type);
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

export interface LanPhoneConnectionOptions extends PhoneConnectionOptions {
  connectLan?: ((url: string) => Promise<FrameTransport>) | undefined;
  endpointStore?: LanEndpointStore | undefined;
  clock?: LanClock | undefined;
  random?: (() => number) | undefined;
}

interface ListenerRegistration {
  attach(client: RpcClient): () => void;
  detach: (() => void) | undefined;
}

interface ClientInflight {
  count: number;
  waiters: Set<() => void>;
}

/**
 * 可平滑切换底层 `RpcClient` 的代理门面：
 * - 跨底层连接切换时自动重绑全部通知监听器；
 * - 在 `beginCutover()` 到 `completeCutover()` 窗口期内，外部新发起的 RPC 调用排队挂起，
 *   待直连通道初始化与会话恢复完成后精确转发一次到新通道；
 * - 记录经本门面发往各底层客户端尚未落定的在途调用数，切换后等旧客户端在途调用落定再关。
 */
class SwitchingRpcFacade {
  private current: RpcClient;
  private readonly registrations = new Set<ListenerRegistration>();
  private readonly inflightByClient = new Map<RpcClient, ClientInflight>();
  private cutoverPromise: Promise<void> | undefined;
  private releaseCutover: (() => void) | undefined;
  private closedFlag = false;
  private readonly closedDeferred: Promise<void>;
  private resolveClosed!: () => void;

  constructor(initial: RpcClient) {
    this.current = initial;
    this.closedDeferred = new Promise<void>((resolve) => {
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

  private trackCall<R>(client: RpcClient, invokeFn: () => Promise<R>): Promise<R> {
    let bucket = this.inflightByClient.get(client);
    if (!bucket) {
      bucket = { count: 0, waiters: new Set() };
      this.inflightByClient.set(client, bucket);
    }
    bucket.count++;
    const currentBucket = bucket;
    return Promise.resolve()
      .then(invokeFn)
      .finally(() => {
        currentBucket.count--;
        if (currentBucket.count <= 0) {
          this.inflightByClient.delete(client);
          const waiters = [...currentBucket.waiters];
          currentBucket.waiters.clear();
          for (const w of waiters) w();
        }
      });
  }

  /** 等待指定客户端上经本门面发出的在途调用全部落定，或到达最长等待时间 */
  waitForDrain(
    client: RpcClient,
    clock: LanClock,
    timeoutMs = OLD_RELAY_DRAIN_TIMEOUT_MS,
  ): Promise<void> {
    const bucket = this.inflightByClient.get(client);
    if (!bucket || bucket.count <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        bucket.waiters.delete(onDrained);
        clock.clearTimeout(timer);
        resolve();
      };
      const onDrained = () => {
        done();
      };
      const timer = clock.setTimeout(() => {
        done();
      }, timeoutMs);
      bucket.waiters.add(onDrained);
    });
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
              return this.trackCall(client, () =>
                Promise.resolve((fn as (...a: unknown[]) => unknown).apply(obj, args)),
              );
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
      closed: this.closedDeferred,
      initialize: () => waitReady().then((c) => this.trackCall(c, () => c.initialize())),
      shutdown: () => waitReady().then((c) => this.trackCall(c, () => c.shutdown())),
      close: () => {
        this.markClosed();
      },
      call: (method, params) =>
        waitReady().then((c) => this.trackCall(c, () => c.call(method, params))),
      onNotification: (method, handler) => register((c) => c.onNotification(method, handler)),
      onEvent: (handler) => register((c) => c.onEvent(handler)),
      onProvidersChanged: (handler) => register((c) => c.onProvidersChanged(handler)),
      onLoginCompleted: (handler) => register((c) => c.onLoginCompleted(handler)),
      runtime: runtimeProxy,
      provider: providerProxy,
      login: loginProxy,
      computer: computerProxy,
      session: (sessionId: string) => {
        type SessionHandle = ReturnType<RpcClient["session"]>;
        const sessionBase = wrapMethodObject<SessionHandle>((c) => c.session(sessionId));
        return new Proxy(sessionBase, {
          get: (target, prop): unknown => {
            if (prop === "id") return sessionId;
            if (prop === "subscribe") {
              return async (
                listener: Parameters<SessionHandle["subscribe"]>[0],
                subOptions?: Parameters<SessionHandle["subscribe"]>[1],
              ) => {
                const client = await waitReady();
                return this.trackCall(client, () =>
                  client.session(sessionId).subscribe(listener, subOptions),
                );
              };
            }
            return Reflect.get(target, prop) as unknown;
          },
        });
      },
    };
  }
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
  private readonly drainingCleanups = new Set<() => void>();
  private facade: SwitchingRpcFacade | undefined;
  private activeRawTransport: FrameTransport | undefined;
  private generation = 0;
  private upgradeRunning = false;
  private lanAttemptRunning = false;
  private pendingEndpointsRefreshUpgrade = false;
  private activeRaceCleanup: (() => void) | undefined;
  private activeRelayAttemptAbort: (() => void) | undefined;
  private attempt = 0;
  private timer: unknown;
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
    this.activeRelayAttemptAbort?.();
    this.activeRelayAttemptAbort = undefined;
    for (const cleanup of [...this.drainingCleanups]) {
      cleanup();
    }
    this.drainingCleanups.clear();
    this.facade?.markClosed();
    this.facade = undefined;
    this.client = undefined;
    try {
      this.activeRawTransport?.close();
    } catch {
      /* ignore */
    }
    this.activeRawTransport = undefined;
    this.relay?.transport.close();
    this.relay = undefined;
    this.transportKind = "none";
    this.connecting = false;
    this.lanAttemptRunning = false;
    this.upgradeRunning = false;
    this.pendingEndpointsRefreshUpgrade = false;
  }

  visibility(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.cancelTimer();
    } else if (!this.stopped && !this.relay && this.transportKind === "none" && !this.connecting) {
      this.cancelTimer();
      void this.connect();
    }
  }

  private set(state: ConnectionState, message = ""): void {
    this.state = state;
    this.message = message;
    this.options.changed();
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private retry(code?: number, reason = closeReason(code)): void {
    if (this.stopped) return;
    this.generation++;
    this.activeRaceCleanup?.();
    this.activeRaceCleanup = undefined;
    this.activeRelayAttemptAbort?.();
    this.activeRelayAttemptAbort = undefined;
    this.facade?.markClosed();
    this.facade = undefined;
    this.client = undefined;
    try {
      this.activeRawTransport?.close();
    } catch {
      /* ignore */
    }
    this.activeRawTransport = undefined;
    this.relay?.transport.close();
    this.relay = undefined;
    this.transportKind = "none";
    this.connecting = false;

    this.options.disconnected(reason);
    const outcome = closeOutcome(code);
    if (outcome.stop) {
      this.stopped = true;
      this.set(outcome.state, outcome.message);
      return;
    }
    this.set(outcome.state, outcome.message);
    if (!this.visible) return;
    const { delay, nextAttempt } = nextRetryDelay(code, this.attempt, this.options.random);
    this.attempt = nextAttempt;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
  }

  private handleProtocolIncompatible(serverProtocolVersion: number): void {
    this.stop();
    this.set(
      "incompatible",
      (this.options.versionMessage ?? versionMessage)(serverProtocolVersion),
    );
  }

  private candidateEndpoints(): string[] {
    const stored = this.store.get(this.options.host.hostId);
    return stored.filter((ep) => !this.badEndpoints.has(ep));
  }

  private updateStoredEndpoints(endpoints: readonly string[]): boolean {
    const changed = this.store.set(this.options.host.hostId, endpoints);
    if (changed) {
      this.badEndpoints.clear();
    }
    return changed;
  }

  private attachEndpointWatcher(facade: SwitchingRpcFacade, generation: number): void {
    const proxy = facade.createProxy();
    proxy.onNotification("remote.lanEndpointsChanged", ({ endpoints }) => {
      if (!this.isCurrent(generation)) return;
      const changed = this.updateStoredEndpoints(endpoints);
      if (this.isRelayActive(generation) && this.state === "online") {
        if (this.lanAttemptRunning || this.upgradeRunning) {
          if (changed) this.pendingEndpointsRefreshUpgrade = true;
          return;
        }
        void this.tryBackgroundUpgrade(generation);
      }
    });
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private isRelayActive(generation: number): boolean {
    return this.isCurrent(generation) && this.transportKind === "relay";
  }

  /**
   * 发起一次并行局域网直连竞速（保证同一时刻最多一个直连尝试在进行）：
   * 首个完成加密握手的地址胜出并关闭其余候选；不设回退等待定时器，单个连接超时由 Rust 侧负责。
   */
  private runSingleLanRace(
    candidates: readonly string[],
    generation: number,
  ): Promise<LanHandshakeSuccess | undefined> {
    const connectLan = this.options.connectLan;
    if (!connectLan || candidates.length === 0 || this.lanAttemptRunning) {
      return Promise.resolve(undefined);
    }

    this.lanAttemptRunning = true;
    const channelFactory = this.options.channel ?? connectChannel;
    const hostPublicKey = decode(this.options.host.hostPub);

    return new Promise<LanHandshakeSuccess | undefined>((resolve) => {
      const state = { settled: false };
      const isSettled = () => state.settled;
      let failed = 0;
      const openTransports = new Set<FrameTransport>();

      const finish = (winner: LanHandshakeSuccess | undefined) => {
        if (state.settled) return;
        state.settled = true;
        this.activeRaceCleanup = undefined;
        this.lanAttemptRunning = false;
        for (const t of openTransports) {
          if (t !== winner?.raw) {
            try {
              t.close();
            } catch {
              /* ignore */
            }
          }
        }
        openTransports.clear();
        resolve(winner);

        if (
          !winner &&
          this.pendingEndpointsRefreshUpgrade &&
          this.isRelayActive(generation) &&
          this.state === "online"
        ) {
          this.pendingEndpointsRefreshUpgrade = false;
          void this.tryBackgroundUpgrade(generation);
        } else {
          this.pendingEndpointsRefreshUpgrade = false;
        }
      };

      this.activeRaceCleanup = () => {
        finish(undefined);
      };

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
            const channel = await channelFactory(guarded.transport, {
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
                /* ignore */
              }
            }
            if (
              error instanceof RemoteChannelError &&
              (error.code === "bad_signature" || error.code === "fingerprint_mismatch")
            ) {
              // 公钥验签不符：记为不可用，不提示、不重试该地址直到地址列表更新
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

  private async connect(): Promise<void> {
    if (this.stopped || !this.visible || this.connecting) return;
    this.connecting = true;
    this.cancelTimer();
    const generation = ++this.generation;
    this.set("connecting");

    const candidates = this.candidateEndpoints();
    if (candidates.length === 0 || !this.options.connectLan) {
      await this.connectRelayOnly(generation);
      return;
    }

    await this.connectSimultaneous(candidates, generation);
  }

  /** 存有直连地址时，直连竞速与中继连接同时发起 */
  private async connectSimultaneous(
    candidates: readonly string[],
    generation: number,
  ): Promise<void> {
    const state: {
      winner: "none" | "lan" | "relay";
      relayAborted: boolean;
      lanFinished: boolean;
      hostOnlineStarted: boolean;
      relayRef: DeviceRelay | undefined;
      relayFailure: { code: number | undefined; reason: string } | undefined;
    } = {
      winner: "none",
      relayAborted: false,
      lanFinished: false,
      hostOnlineStarted: false,
      relayRef: undefined,
      relayFailure: undefined,
    };
    const getWinner = () => state.winner;
    const isRelayAborted = () => state.relayAborted;
    const isLanFinished = () => state.lanFinished;
    const isHostOnlineStarted = () => state.hostOnlineStarted;
    let relayChannelRef: SecureLineTransport | undefined;
    let relayReadyPromise: Promise<boolean> | undefined;

    const abortRelay = () => {
      if (state.relayAborted) return;
      state.relayAborted = true;
      this.activeRelayAttemptAbort = undefined;
      try {
        relayChannelRef?.close();
      } catch {
        /* ignore */
      }
      try {
        state.relayRef?.transport.close();
      } catch {
        /* ignore */
      }
      // 直连胜出后不再持有这条已关闭的中继连接
      if (state.relayRef !== undefined && this.relay === state.relayRef) this.relay = undefined;
    };
    this.activeRelayAttemptAbort = abortRelay;

    const handleRelayEarlyFailure = (code?: number, reason = closeReason(code)) => {
      if (isRelayAborted() || !this.isCurrent(generation) || getWinner() === "lan") return;
      state.relayFailure = { code, reason };
      if (closeOutcome(code).stop || (isLanFinished() && getWinner() === "none")) {
        this.retry(code, reason);
      }
    };

    // 1. 启动直连竞速分支
    const lanFlow = (async () => {
      const direct = await this.runSingleLanRace(candidates, generation);
      state.lanFinished = true;
      if (!this.isCurrent(generation)) {
        direct?.channel.close();
        direct?.raw.close();
        return;
      }
      if (!direct) {
        if (getWinner() === "none") {
          if (state.relayFailure) {
            this.retry(state.relayFailure.code, state.relayFailure.reason);
          } else if (state.relayRef && !isHostOnlineStarted()) {
            // 直连竞速失败且中继已连上但电脑不在线：切回 offline，避免一直卡在 connecting
            this.set("offline", HOST_OFFLINE_MESSAGE);
          }
        }
        return;
      }

      if (getWinner() === "none") {
        // 直连先完成加密握手：采用直连，立即关闭这次的中继连接且不触发断线回调或重试
        state.winner = "lan";
        abortRelay();
        await this.activateDirectInitial(direct, generation);
        return;
      }

      if (getWinner() === "relay" && relayReadyPromise) {
        // 中继已先完成握手：等待中继上线落定后，复用后台升级路径无缝切到这条已握手的直连
        const relayOk = await relayReadyPromise;
        if (relayOk && this.isRelayActive(generation) && this.state === "online") {
          await this.upgradeWithEstablishedDirect(direct, generation);
        } else {
          direct.channel.close();
          direct.raw.close();
        }
      } else {
        direct.channel.close();
        direct.raw.close();
      }
    })();

    // 2. 同时启动中继连接分支
    const relayFlow = (async () => {
      let relay: DeviceRelay;
      try {
        relay = await (this.options.connect ?? connectDeviceRelay)({
          origin: this.options.origin,
          hostId: this.options.host.hostId,
          identity: this.options.identity,
        });
      } catch (error) {
        if (isRelayAborted() || !this.isCurrent(generation) || getWinner() === "lan") return;
        const failure = relayConnectFailure(error);
        handleRelayEarlyFailure(failure.code, failure.reason);
        return;
      }

      if (isRelayAborted() || !this.isCurrent(generation) || getWinner() === "lan") {
        relay.transport.close();
        return;
      }
      state.relayRef = relay;
      this.relay = relay;

      relay.onClose((code) => {
        if (isRelayAborted() || !this.isCurrent(generation) || getWinner() === "lan") return;
        if (getWinner() === "none") {
          handleRelayEarlyFailure(code);
          return;
        }
        if (this.relay === relay) {
          this.retry(code);
        }
      });

      if (!relay.online && isLanFinished() && getWinner() === "none") {
        this.set("offline", HOST_OFFLINE_MESSAGE);
      }

      const startRelayHandshake = () => {
        if (isRelayAborted() || !this.isCurrent(generation) || getWinner() !== "none") return;
        void (async () => {
          const guarded = guardPreHandshakeTransport(relay.transport);
          try {
            const channel = await (this.options.channel ?? connectChannel)(guarded.transport, {
              identity: this.options.identity,
              hostPublicKey: decode(this.options.host.hostPub),
            });
            relayChannelRef = channel;
            if (isRelayAborted() || !this.isCurrent(generation) || getWinner() !== "none") {
              channel.close();
              relay.transport.close();
              return;
            }
            guarded.allowDataFrames();
            state.winner = "relay";
            this.activeRelayAttemptAbort = undefined;
            this.relay = relay;
            relayReadyPromise = this.activateRelayInitial(relay, channel, generation);
            await relayReadyPromise;
          } catch (error) {
            if (isRelayAborted() || !this.isCurrent(generation) || getWinner() === "lan") return;
            const outcome = handshakeFailure(error, this.options.versionMessage ?? versionMessage);
            if (outcome.kind === "incompatible") {
              this.stop();
              this.set("incompatible", outcome.message);
            } else {
              relay.transport.close();
              handleRelayEarlyFailure(undefined, outcome.reason);
            }
          }
        })();
      };

      relay.onHostOnline(() => {
        if (
          isHostOnlineStarted() ||
          isRelayAborted() ||
          !this.isCurrent(generation) ||
          getWinner() !== "none"
        ) {
          return;
        }
        state.hostOnlineStarted = true;
        startRelayHandshake();
      });
    })();

    await Promise.all([lanFlow, relayFlow]);
  }

  private async connectRelayOnly(generation: number): Promise<void> {
    try {
      const relay = await (this.options.connect ?? connectDeviceRelay)({
        origin: this.options.origin,
        hostId: this.options.host.hostId,
        identity: this.options.identity,
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
      if (!relay.online) this.set("offline", HOST_OFFLINE_MESSAGE);
      let started = false;
      relay.onHostOnline(() => {
        if (started || !this.isCurrent(generation) || this.relay !== relay) return;
        started = true;
        void this.handshakeRelayOnly(relay, generation);
      });
    } catch (error) {
      if (this.isCurrent(generation)) {
        const failure = relayConnectFailure(error);
        this.retry(failure.code, failure.reason);
      }
    }
  }

  private async handshakeRelayOnly(relay: DeviceRelay, generation: number): Promise<void> {
    const guarded = guardPreHandshakeTransport(relay.transport);
    try {
      const channel = await (this.options.channel ?? connectChannel)(guarded.transport, {
        identity: this.options.identity,
        hostPublicKey: decode(this.options.host.hostPub),
      });
      if (!this.isCurrent(generation) || this.relay !== relay) {
        channel.close();
        return;
      }
      guarded.allowDataFrames();
      await this.activateRelayInitial(relay, channel, generation);
    } catch (error) {
      if (!this.isCurrent(generation) || this.relay !== relay) return;
      const outcome = handshakeFailure(error, this.options.versionMessage ?? versionMessage);
      if (outcome.kind === "incompatible") {
        this.stop();
        this.set("incompatible", outcome.message);
      } else {
        this.retry(undefined, outcome.reason);
        relay.transport.close();
      }
    }
  }

  private async activateDirectInitial(
    direct: LanHandshakeSuccess,
    generation: number,
  ): Promise<void> {
    const rawClient = createRpcClient(direct.channel, {
      clientName: "nocturne-phone",
      interactive: true,
    });
    try {
      const initialized = await rawClient.initialize();
      if (!this.isCurrent(generation)) {
        rawClient.close();
        direct.raw.close();
        return;
      }
      this.sessionsDir = initialized.sessionsDir;
      this.options.initialized?.(initialized.nocturneVersion);
      if (initialized.protocolVersion !== RPC_PROTOCOL_VERSION) {
        rawClient.close();
        direct.raw.close();
        this.handleProtocolIncompatible(initialized.protocolVersion);
        return;
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
        return;
      }
      this.connecting = false;
      this.attempt = 0;
      this.set("online");
      void rawClient.closed.then(() => {
        if (this.isCurrent(generation) && this.facade?.active === rawClient) {
          this.retry(undefined, CHANNEL_CLOSED_REASON);
        }
      });
    } catch (error) {
      rawClient.close();
      direct.raw.close();
      if (!this.isCurrent(generation)) return;
      const outcome = handshakeFailure(error, this.options.versionMessage ?? versionMessage);
      if (outcome.kind === "incompatible") {
        this.stop();
        this.set("incompatible", outcome.message);
      } else {
        this.retry(undefined, outcome.reason);
      }
    }
  }

  private async activateRelayInitial(
    relay: DeviceRelay,
    channel: SecureLineTransport,
    generation: number,
  ): Promise<boolean> {
    const relayClient = createRpcClient(channel, {
      clientName: "nocturne-phone",
      interactive: true,
    });
    try {
      const initialized = await relayClient.initialize();
      if (!this.isCurrent(generation)) {
        relayClient.close();
        return false;
      }
      this.sessionsDir = initialized.sessionsDir;
      this.options.initialized?.(initialized.nocturneVersion);
      if (initialized.protocolVersion !== RPC_PROTOCOL_VERSION) {
        relayClient.close();
        this.handleProtocolIncompatible(initialized.protocolVersion);
        return false;
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
        return false;
      }
      this.connecting = false;
      this.attempt = 0;
      this.set("online");
      void relayClient.closed.then(() => {
        if (this.isCurrent(generation) && this.facade?.active === relayClient) {
          this.retry(undefined, CHANNEL_CLOSED_REASON);
        }
      });

      // 每次经中继连上后取一次直连地址，按电脑 id 存本机；若无进行中的直连尝试则后台尝试升级
      void this.fetchEndpointsAndMaybeUpgrade(relayClient, generation);
      return true;
    } catch (error) {
      relayClient.close();
      if (!this.isCurrent(generation)) return false;
      const outcome = handshakeFailure(error, this.options.versionMessage ?? versionMessage);
      if (outcome.kind === "incompatible") {
        this.stop();
        this.set("incompatible", outcome.message);
      } else {
        this.retry(undefined, outcome.reason);
        relay.transport.close();
      }
      return false;
    }
  }

  private async fetchEndpointsAndMaybeUpgrade(
    relayClient: RpcClient,
    generation: number,
  ): Promise<void> {
    let changed = false;
    try {
      const { endpoints } = await relayClient.call("remote.lanEndpoints", {});
      if (!this.isCurrent(generation)) return;
      changed = this.updateStoredEndpoints(endpoints);
    } catch {
      if (!this.isCurrent(generation)) return;
    }
    if (this.isRelayActive(generation) && this.state === "online") {
      if (this.lanAttemptRunning || this.upgradeRunning) {
        if (changed) this.pendingEndpointsRefreshUpgrade = true;
        return;
      }
      await this.tryBackgroundUpgrade(generation);
    }
  }

  private async tryBackgroundUpgrade(generation: number): Promise<void> {
    if (
      this.upgradeRunning ||
      this.lanAttemptRunning ||
      !this.isRelayActive(generation) ||
      this.state !== "online"
    ) {
      return;
    }
    const candidates = this.candidateEndpoints();
    if (candidates.length === 0) return;

    const direct = await this.runSingleLanRace(candidates, generation);
    if (!direct) return;
    await this.upgradeWithEstablishedDirect(direct, generation);
  }

  /** 将当前在线的中继连接无缝切换至已完成加密握手的直连，并排空旧连接在途请求后再关闭旧连接 */
  private async upgradeWithEstablishedDirect(
    direct: LanHandshakeSuccess,
    generation: number,
  ): Promise<void> {
    const facade = this.facade;
    if (
      this.upgradeRunning ||
      !this.isRelayActive(generation) ||
      !facade ||
      this.state !== "online"
    ) {
      direct.channel.close();
      direct.raw.close();
      return;
    }

    this.upgradeRunning = true;
    try {
      const oldRelayClient = facade.active;
      const oldRelay = this.relay;

      // 进入切换栅栏：此后新发起的 RPC 调用排队，不发往即将退役的中继连接
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

        // 先切走 relay 引用，使后续关闭旧中继连接不会触发断线回调
        this.relay = undefined;
        this.activeRawTransport = direct.raw;
        this.transportKind = "lan";

        // 释放切换期间排队的新 RPC 调用到直连客户端
        facade.completeCutover(directClient);

        void directClient.closed.then(() => {
          if (this.isCurrent(generation) && this.facade?.active === directClient) {
            this.retry(undefined, CHANNEL_CLOSED_REASON);
          }
        });

        // 等旧客户端上的在途调用全部落定（最多 5 秒）后再关闭旧客户端和中继连接
        this.drainAndCloseOldRelay(facade, oldRelayClient, oldRelay);
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

  private drainAndCloseOldRelay(
    facade: SwitchingRpcFacade,
    oldRelayClient: RpcClient,
    oldRelay: DeviceRelay | undefined,
  ): void {
    let closed = false;
    const closeNow = () => {
      if (closed) return;
      closed = true;
      this.drainingCleanups.delete(closeNow);
      try {
        oldRelayClient.close();
      } catch {
        /* ignore */
      }
      try {
        oldRelay?.transport.close();
      } catch {
        /* ignore */
      }
    };
    this.drainingCleanups.add(closeNow);
    void facade.waitForDrain(oldRelayClient, this.clock, OLD_RELAY_DRAIN_TIMEOUT_MS).then(() => {
      closeNow();
    });
  }
}
