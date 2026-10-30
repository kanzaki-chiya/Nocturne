import { randomUUID } from "node:crypto";
import type { PermissionPresetName } from "@nocturne/core";
import { normalizePermissionPreset, PERMISSION_PRESET_NAMES } from "@nocturne/core";
import {
  acceptChannel,
  fingerprint,
  generateIdentity,
  type FrameTransport,
  type Identity,
} from "@nocturne/remote";
import { RpcProtocolError } from "../errors.js";
import { InvalidParamsError } from "../params.js";
import type {
  AgentPairingRequest,
  AgentProcessInfo,
  AgentScope,
  AgentStatus,
  RpcServerNotifications,
} from "../../shared/methods.js";
import type { LineTransport } from "../../shared/transport.js";
import {
  ensureHostIdentity,
  loadAgents,
  saveAgents,
  type StoredAgentDevice,
} from "../remote/storage.js";
import { listenAgentPipe, type AgentPipeListener } from "./pipe.js";

export const DEFAULT_AGENT_PAIRING_TIMEOUT_MS = 120_000;

export const AGENT_READONLY_METHODS = [
  "initialize",
  "runtime.initialize",
  "shutdown",
  "runtime.shutdown",
  "runtime.listSessions",
  "runtime.listModels",
  "runtime.defaultModel",
  "runtime.resumeSession",
  "session.open",
  "session.subscribe",
  "session.unsubscribe",
  "session.state",
  "session.pendingInputs",
  "session.close",
] as const;

export const AGENT_RUN_METHODS = [
  ...AGENT_READONLY_METHODS,
  "runtime.createSession",
  "session.submit",
  "session.enqueueInput",
  "session.interrupt",
  "session.abort",
] as const;

const READONLY_SET = new Set<string>(AGENT_READONLY_METHODS);
const RUN_SET = new Set<string>(AGENT_RUN_METHODS);

const VALID_PRESET_SET = new Set<string>(PERMISSION_PRESET_NAMES);

function isPresetName(value: string): value is PermissionPresetName {
  return VALID_PRESET_SET.has(value);
}

export function parsePermissionPreset(raw: string): PermissionPresetName | undefined {
  let normalized: string;
  try {
    normalized = normalizePermissionPreset(raw);
  } catch {
    return undefined;
  }
  return isPresetName(normalized) ? normalized : undefined;
}

export function presetRank(preset: PermissionPresetName): number {
  const idx = PERMISSION_PRESET_NAMES.indexOf(preset);
  return idx >= 0 ? idx : 1;
}

export function lowerPermissionPreset(
  a: PermissionPresetName,
  b: PermissionPresetName,
): PermissionPresetName {
  return presetRank(a) <= presetRank(b) ? a : b;
}

export function formatFingerprintHex(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex").slice(0, 16);
  return hex.match(/.{1,4}/g)?.join(":") ?? hex;
}

export interface AgentConnectionContext {
  readonly connectionId: string;
  agentId: string;
  publicKey: string;
  fingerprint: string;
  name: string;
  processInfo?: AgentProcessInfo | undefined;
  readonly close: () => void;
}

interface PendingPairingInternal extends AgentPairingRequest {
  pub: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface AgentHostOptions {
  home?: string | undefined;
  credentials?:
    | {
        get(id: string): Promise<string | undefined>;
        set(id: string, value: string): Promise<void>;
      }
    | undefined;
  pipe?: boolean | string | undefined;
  pairingTimeoutMs?: number | undefined;
  serve: (transport: LineTransport, context: AgentConnectionContext) => Promise<void>;
  notify: <N extends keyof RpcServerNotifications>(
    method: N,
    params: RpcServerNotifications[N],
  ) => void;
  onStatusChanged?: (() => void) | undefined;
}

export class AgentHost {
  private readonly home: string | undefined;
  private readonly credentials: AgentHostOptions["credentials"];
  private readonly pipeOption: boolean | string | undefined;
  private readonly pairingTimeoutMs: number;
  private readonly serve: AgentHostOptions["serve"];
  private readonly notify: AgentHostOptions["notify"];
  private readonly onStatusChanged: (() => void) | undefined;

  private identity: Identity | undefined;
  private listener: AgentPipeListener | undefined;
  private agents: StoredAgentDevice[] = [];
  private readonly pending = new Map<string, PendingPairingInternal>();
  private readonly connections = new Map<string, AgentConnectionContext>();
  private stopped = false;

  constructor(options: AgentHostOptions) {
    this.home = options.home;
    this.credentials = options.credentials;
    this.pipeOption = options.pipe;
    this.pairingTimeoutMs = options.pairingTimeoutMs ?? DEFAULT_AGENT_PAIRING_TIMEOUT_MS;
    this.serve = options.serve;
    this.notify = options.notify;
    this.onStatusChanged = options.onStatusChanged;
  }

  get pipeAddress(): string | undefined {
    return this.listener?.address;
  }

  async start(): Promise<void> {
    if (this.home !== undefined) {
      this.agents = await loadAgents(this.home).catch(() => []);
    }
    if (this.pipeOption === undefined || this.pipeOption === false) {
      return;
    }
    if (this.home !== undefined && this.credentials !== undefined) {
      const ensured = await ensureHostIdentity(this.home, this.credentials);
      this.identity = ensured.identity;
    } else {
      this.identity = await generateIdentity({ extractable: false });
    }
    this.listener = await listenAgentPipe({
      home: this.home,
      pipePath: typeof this.pipeOption === "string" ? this.pipeOption : undefined,
      onConnection: (frameTransport) => {
        void this.acceptPipeConnection(frameTransport);
      },
    });
  }

  private async acceptPipeConnection(frameTransport: FrameTransport): Promise<void> {
    if (this.stopped || this.identity === undefined) {
      frameTransport.close();
      return;
    }
    const isStopped = (): boolean => this.stopped;
    try {
      const { deviceId, devicePublicKey, channel } = await acceptChannel(frameTransport, {
        identity: this.identity,
        lookupDevice: (id) => {
          const existing = this.agents.find((a) => a.id === id);
          if (existing === undefined) return Promise.resolve(undefined);
          return Promise.resolve(new Uint8Array(Buffer.from(existing.pub, "base64url")));
        },
        allowUnknownDevice: true,
      });
      if (isStopped()) {
        channel.close();
        return;
      }
      const fpBytes = await fingerprint(devicePublicKey);
      const fpText = formatFingerprintHex(fpBytes);
      const pubB64 = Buffer.from(devicePublicKey).toString("base64url");
      const existing = this.agents.find((a) => a.id === deviceId);
      const ctx: AgentConnectionContext = {
        connectionId: randomUUID(),
        agentId: deviceId,
        publicKey: pubB64,
        fingerprint: existing?.fingerprint ?? fpText,
        name: existing?.name ?? "MCP Bridge",
        close: () => {
          channel.close();
        },
      };
      this.registerConnection(ctx);
      try {
        await this.serve(channel, ctx);
      } finally {
        this.unregisterConnection(ctx.connectionId);
      }
    } catch {
      frameTransport.close();
    }
  }

  registerConnection(ctx: AgentConnectionContext): void {
    this.connections.set(ctx.connectionId, ctx);
    const existing = this.agents.find((a) => a.id === ctx.agentId);
    if (existing !== undefined) {
      existing.lastSeenAt = Date.now();
      void this.persist();
    }
    this.emitStatus();
  }

  unregisterConnection(connectionId: string): void {
    if (this.connections.delete(connectionId)) {
      this.emitStatus();
    }
  }

  /**
   * 在 initialize 握手时记录客户端自报的名称与进程信息；
   * 若该身份尚未登记批准，立即向本机桌面端发起配对请求并推 `agent.pairingRequested`。
   */
  onInitialize(
    ctx: AgentConnectionContext,
    info: { clientName?: string | undefined; processInfo?: AgentProcessInfo | undefined },
  ): void {
    if (info.clientName !== undefined && info.clientName.trim() !== "") {
      ctx.name = info.clientName.trim();
    }
    if (info.processInfo !== undefined) {
      ctx.processInfo = info.processInfo;
    }
    const existing = this.agents.find((a) => a.id === ctx.agentId);
    if (existing !== undefined) {
      existing.lastSeenAt = Date.now();
      if (info.clientName !== undefined && info.clientName.trim() !== "") {
        existing.name = info.clientName.trim();
      }
      void this.persist();
      this.emitStatus();
      return;
    }
    this.ensurePairingRequested(ctx);
  }

  /**
   * 确保未登记的桥发起或刷新配对请求。
   */
  ensurePairingRequested(ctx: AgentConnectionContext): AgentPairingRequest {
    const current = this.pending.get(ctx.agentId);
    if (current !== undefined) {
      if (ctx.name && ctx.name !== "MCP Bridge") {
        current.name = ctx.name;
        current.clientName = ctx.name;
      }
      if (ctx.processInfo !== undefined) current.processInfo = ctx.processInfo;
      return this.toPublicRequest(current);
    }
    const now = Date.now();
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      if (this.pending.get(ctx.agentId)?.requestId === requestId) {
        this.pending.delete(ctx.agentId);
        this.emitStatus();
      }
    }, this.pairingTimeoutMs);
    timer.unref();
    const resolvedName = ctx.name || "MCP Bridge";
    const entry: PendingPairingInternal = {
      requestId,
      agentId: ctx.agentId,
      clientName: resolvedName,
      name: resolvedName,
      fingerprint: ctx.fingerprint,
      ...(ctx.processInfo !== undefined ? { processInfo: ctx.processInfo } : {}),
      requestedAt: now,
      expiresAt: now + this.pairingTimeoutMs,
      pub: ctx.publicKey,
      timer,
    };
    this.pending.set(ctx.agentId, entry);
    const pubReq = this.toPublicRequest(entry);
    this.notify("agent.pairingRequested", pubReq);
    this.emitStatus();
    return pubReq;
  }

  /**
   * 校验 `origin: "agent"` 连接的方法调用权限（ADR-0074 §3）：
   * - `initialize` / `runtime.initialize` / `shutdown` / `runtime.shutdown` 始终放行；
   * - 未登记批准时触发配对请求并抛 `-32004 / agent_pairing_pending`；
   * - 已登记批准时按实时 `scope` 校验方法白名单，越界抛 `-32004 / agent_not_allowed`。
   */
  checkMethod(ctx: AgentConnectionContext, method: string): StoredAgentDevice | undefined {
    if (
      method === "initialize" ||
      method === "runtime.initialize" ||
      method === "shutdown" ||
      method === "runtime.shutdown"
    ) {
      return this.agents.find((a) => a.id === ctx.agentId);
    }
    const registered = this.agents.find((a) => a.id === ctx.agentId);
    if (registered === undefined) {
      this.ensurePairingRequested(ctx);
      throw new RpcProtocolError(
        "agent_pairing_pending",
        "Waiting for the user to approve this agent in Nocturne.",
      );
    }
    registered.lastSeenAt = Date.now();
    const allowed = registered.scope === "run" ? RUN_SET : READONLY_SET;
    if (!allowed.has(method)) {
      throw new RpcProtocolError("agent_not_allowed", `外部 agent 无权调用 ${method}`);
    }
    return registered;
  }

  getRegisteredAgent(agentId: string): StoredAgentDevice | undefined {
    return this.agents.find((a) => a.id === agentId);
  }

  describe(): AgentStatus {
    const onlineIds = new Set<string>();
    for (const conn of this.connections.values()) {
      onlineIds.add(conn.agentId);
    }
    return {
      agents: this.agents.map((a) => ({
        kind: "agent" as const,
        id: a.id,
        name: a.name,
        fingerprint: a.fingerprint,
        scope: a.scope,
        maxPermissionPreset: a.maxPermissionPreset,
        createdAt: a.createdAt,
        ...(a.lastSeenAt !== undefined ? { lastSeenAt: a.lastSeenAt } : {}),
        online: onlineIds.has(a.id),
      })),
      pendingPairings: [...this.pending.values()].map((p) => this.toPublicRequest(p)),
    };
  }

  async respondPairing(params: {
    requestId?: string | undefined;
    agentId?: string | undefined;
    approved: boolean;
    scope?: AgentScope | undefined;
    maxPermissionPreset?: PermissionPresetName | undefined;
  }): Promise<AgentStatus> {
    if (typeof params.approved !== "boolean") {
      throw new InvalidParamsError("respondPairing 需要 approved 布尔值");
    }
    let found: PendingPairingInternal | undefined;
    if (typeof params.requestId === "string" && params.requestId !== "") {
      for (const item of this.pending.values()) {
        if (item.requestId === params.requestId || item.agentId === params.requestId) {
          found = item;
          break;
        }
      }
    } else if (typeof params.agentId === "string" && params.agentId !== "") {
      found = this.pending.get(params.agentId);
    }
    if (found === undefined) {
      throw new InvalidParamsError("配对请求不存在或已过期");
    }
    clearTimeout(found.timer);
    this.pending.delete(found.agentId);

    if (params.approved) {
      const scope: AgentScope = params.scope === "run" ? "run" : "read-only";
      let maxPreset: PermissionPresetName = "default";
      if (params.maxPermissionPreset !== undefined) {
        const normalized = parsePermissionPreset(params.maxPermissionPreset);
        if (normalized === undefined) {
          throw new InvalidParamsError(`无效的权限上限预设: ${params.maxPermissionPreset}`);
        }
        maxPreset = normalized;
      }
      const now = Date.now();
      const existingIdx = this.agents.findIndex((a) => a.id === found.agentId);
      const entry: StoredAgentDevice = {
        kind: "agent",
        id: found.agentId,
        name: found.name,
        pub: found.pub,
        fingerprint: found.fingerprint,
        scope,
        maxPermissionPreset: maxPreset,
        createdAt: existingIdx >= 0 ? (this.agents[existingIdx]?.createdAt ?? now) : now,
        lastSeenAt: now,
      };
      if (existingIdx >= 0) {
        this.agents[existingIdx] = entry;
      } else {
        this.agents.push(entry);
      }
      await this.persist();
    }
    this.emitStatus();
    return this.describe();
  }

  async setScope(params: {
    id: string;
    scope: AgentScope;
    maxPermissionPreset?: PermissionPresetName | undefined;
  }): Promise<AgentStatus> {
    if (typeof params.id !== "string" || params.id === "") {
      throw new InvalidParamsError("需要外部 agent id");
    }
    const rawScope: string = params.scope;
    if (rawScope !== "read-only" && rawScope !== "run") {
      throw new InvalidParamsError("scope 必须为 read-only 或 run");
    }
    const target = this.agents.find((a) => a.id === params.id);
    if (target === undefined) {
      throw new InvalidParamsError(`未找到外部 agent: ${params.id}`);
    }
    target.scope = params.scope;
    if (params.maxPermissionPreset !== undefined) {
      const normalized = parsePermissionPreset(params.maxPermissionPreset);
      if (normalized === undefined) {
        throw new InvalidParamsError(`无效的权限上限预设: ${params.maxPermissionPreset}`);
      }
      target.maxPermissionPreset = normalized;
    }
    await this.persist();
    this.emitStatus();
    return this.describe();
  }

  async revoke(id: string): Promise<AgentStatus> {
    if (typeof id !== "string" || id === "") {
      throw new InvalidParamsError("需要外部 agent id");
    }
    const before = this.agents.length;
    this.agents = this.agents.filter((a) => a.id !== id);
    if (this.agents.length !== before) {
      await this.persist();
    }
    const pending = this.pending.get(id);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
    }
    for (const conn of [...this.connections.values()]) {
      if (conn.agentId === id) {
        this.connections.delete(conn.connectionId);
        conn.close();
      }
    }
    this.emitStatus();
    return this.describe();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
    }
    this.pending.clear();
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
    if (this.listener !== undefined) {
      await this.listener.close();
      this.listener = undefined;
    }
  }

  private toPublicRequest(entry: PendingPairingInternal): AgentPairingRequest {
    return {
      requestId: entry.requestId,
      agentId: entry.agentId,
      clientName: entry.clientName,
      name: entry.name,
      fingerprint: entry.fingerprint,
      ...(entry.processInfo !== undefined ? { processInfo: entry.processInfo } : {}),
      requestedAt: entry.requestedAt,
      expiresAt: entry.expiresAt,
    };
  }

  private async persist(): Promise<void> {
    if (this.home !== undefined) {
      await saveAgents(this.home, this.agents);
    }
  }

  private emitStatus(): void {
    const status = this.describe();
    this.notify("agent.statusChanged", status);
    this.onStatusChanged?.();
  }
}
