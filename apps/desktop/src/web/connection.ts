import {
  connectChannel,
  connectDeviceRelay,
  RelayError,
  type DeviceRelay,
  type Identity,
} from "@nocturne/remote";
import {
  createRpcClient,
  RpcError,
  RPC_PROTOCOL_VERSION,
  type RpcClient,
} from "@nocturne/rpc/client";
import { closeReason } from "./local";
import { decode, type PairedHost } from "./storage";

export type ConnectionState = "connecting" | "offline" | "online" | "revoked" | "incompatible";
export const HOST_OFFLINE_MESSAGE = "电脑已离线，等它上线会自动连接";
export const DEVICE_REVOKED_MESSAGE = "这台手机已被移除或吊销";
export const RELAY_CONNECT_FAILED_REASON = "无法连接中继";
export const CHANNEL_CLOSED_REASON = "加密连接关闭";

export function versionMessage(version: number): string {
  return version > RPC_PROTOCOL_VERSION
    ? "手机网页版本过旧，请联系中继管理员更新"
    : "请更新电脑上的 Nocturne";
}
export function retryDelay(attempt: number, random = Math.random): number {
  return Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) * (0.8 + random() * 0.4);
}
export function closeOutcome(code?: number): {
  state: "revoked" | "offline";
  message: string;
  stop: boolean;
} {
  if (code === 4003 || code === 4004) {
    return { state: "revoked", message: DEVICE_REVOKED_MESSAGE, stop: true };
  }
  return { state: "offline", message: HOST_OFFLINE_MESSAGE, stop: false };
}
export function nextRetryDelay(
  code: number | undefined,
  attempt: number,
  random = Math.random,
): { delay: number; nextAttempt: number } {
  if (code === 4002) return { delay: 0, nextAttempt: attempt };
  return { delay: retryDelay(attempt, random), nextAttempt: attempt + 1 };
}
export function relayConnectFailure(error: unknown): {
  code: number | undefined;
  reason: string;
} {
  return {
    code: error instanceof RelayError ? error.closeCode : undefined,
    reason:
      error instanceof RelayError ? closeReason(error.closeCode) : RELAY_CONNECT_FAILED_REASON,
  };
}
export function handshakeFailure(
  error: unknown,
  formatVersion: (protocolVersion: number) => string = versionMessage,
): { kind: "incompatible"; message: string } | { kind: "retry"; reason: string } {
  if (error instanceof RpcError && error.code === "protocol_version_mismatch") {
    // 当前 RPC 错误只给中文 message，不含结构化服务端版本；不更改协议。
    const version = /服务端\s+(\d+)/.exec(error.message)?.[1];
    return {
      kind: "incompatible",
      message: formatVersion(Number(version ?? RPC_PROTOCOL_VERSION + 1)),
    };
  }
  return {
    kind: "retry",
    reason: `握手失败：${error instanceof Error ? error.message : String(error)}`,
  };
}
export interface PhoneConnectionOptions {
  origin: string;
  identity: Identity;
  host: PairedHost;
  changed: () => void;
  connected: (client: RpcClient, relay?: DeviceRelay) => Promise<void>;
  /** reason：断线原因（中文），供手机本地的连接诊断记录 */
  disconnected: (reason: string) => void;
  connect?: typeof connectDeviceRelay;
  channel?: typeof connectChannel;
  initialized?: (version: string) => void;
  versionMessage?: (protocolVersion: number) => string;
}
export interface PhoneConnectionLike {
  readonly state: ConnectionState;
  readonly message: string;
  readonly sessionsDir: string | undefined;
  start(): void;
  stop(): void;
  visibility(visible: boolean): void;
}
export class PhoneConnection implements PhoneConnectionLike {
  client: RpcClient | undefined;
  relay: DeviceRelay | undefined;
  state: ConnectionState = "offline";
  message = "";
  /** 电脑的会话目录（initialize 的只读信息），用来推导普通对话工作区 */
  sessionsDir: string | undefined;
  private generation = 0;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private visible = true;
  private connecting = false;
  constructor(private readonly options: PhoneConnectionOptions) {}
  start(): void {
    this.stopped = false;
    void this.connect();
  }
  stop(): void {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.client?.close();
    this.relay?.transport.close();
    this.client = undefined;
    this.relay = undefined;
    this.connecting = false;
  }
  visibility(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      clearTimeout(this.timer);
      this.timer = undefined;
    } else if (!this.stopped && !this.relay && !this.connecting) {
      clearTimeout(this.timer);
      this.timer = undefined;
      void this.connect();
    }
  }
  private set(state: ConnectionState, message = ""): void {
    this.state = state;
    this.message = message;
    this.options.changed();
  }
  private retry(code?: number, reason = closeReason(code)): void {
    if (this.stopped) return;
    this.generation++;
    this.client?.close();
    this.client = undefined;
    this.relay = undefined;
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
    const { delay, nextAttempt } = nextRetryDelay(code, this.attempt);
    this.attempt = nextAttempt;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
  }
  private async connect(): Promise<void> {
    if (this.stopped || !this.visible || this.connecting) return;
    this.connecting = true;
    const generation = ++this.generation;
    this.set("connecting");
    try {
      const relay = await (this.options.connect ?? connectDeviceRelay)({
        origin: this.options.origin,
        identity: this.options.identity,
        hostId: this.options.host.hostId,
      });
      if (generation !== this.generation) {
        relay.transport.close();
        return;
      }
      this.relay = relay;
      relay.onClose((code) => {
        if (generation === this.generation) this.retry(code);
      });
      if (!relay.online) this.set("offline", HOST_OFFLINE_MESSAGE);
      let started = false;
      relay.onHostOnline(() => {
        if (started || generation !== this.generation) return;
        started = true;
        void this.handshake(relay, generation);
      });
    } catch (error) {
      if (generation === this.generation) {
        const failure = relayConnectFailure(error);
        this.retry(failure.code, failure.reason);
      }
    }
  }
  private async handshake(relay: DeviceRelay, generation: number): Promise<void> {
    try {
      const channel = await (this.options.channel ?? connectChannel)(relay.transport, {
        identity: this.options.identity,
        hostPublicKey: decode(this.options.host.hostPub),
      });
      if (generation !== this.generation) {
        channel.close();
        return;
      }
      const client = createRpcClient(channel, { clientName: "nocturne-phone", interactive: true });
      this.client = client;
      const initialized = await client.initialize();
      if (generation !== this.generation) return;
      this.sessionsDir = initialized.sessionsDir;
      this.options.initialized?.(initialized.nocturneVersion);
      if (initialized.protocolVersion !== RPC_PROTOCOL_VERSION) {
        this.stop();
        this.set(
          "incompatible",
          (this.options.versionMessage ?? versionMessage)(initialized.protocolVersion),
        );
        return;
      }
      await this.options.connected(client, relay);
      if (generation !== this.generation) return;
      this.connecting = false;
      this.attempt = 0;
      this.set("online");
      void client.closed.then(() => {
        if (generation === this.generation) this.retry(undefined, CHANNEL_CLOSED_REASON);
      });
    } catch (error) {
      if (generation !== this.generation) return;
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
}
