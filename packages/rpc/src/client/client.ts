/**
 * RPC 客户端（ADR-0044）：类型化封装。运行时只依赖 `@nocturne/core/protocol`，
 * 对 `@nocturne/core` 只有类型导入（由 dependency-cruiser 规则强制），桌面端前端
 * 打包不会带进 Node 代码。
 */
import {
  createSessionView,
  reduceSessionView,
  type SessionView,
  type RuntimeEvent,
} from "@nocturne/core/protocol";
import type {
  CreateSessionOptions,
  FileIndexEntry,
  JevEndpoint,
  JevReviewerConfig,
  ModelInfo,
  ModelRef,
  ModelRole,
  ModelRoleInfo,
  PermissionReply,
  ProviderOverview,
  QuestionReply,
  ReasoningEffort,
  RewindMode,
  RewindTarget,
  SessionRewoundPayload,
  SessionSummary,
  SettingItem,
  SettingsPatch,
  SubmitInput,
  TurnEndReason,
} from "@nocturne/core";

import {
  encodeMessage,
  isRpcId,
  parseLine,
  RPC_CODE_NAMES,
  RPC_PROTOCOL_VERSION,
  type RpcErrorObject,
  type RpcId,
} from "../shared/jsonrpc.js";
import type {
  ContextSummary,
  InitializeResult,
  RpcMethodName,
  RpcParams,
  RpcResult,
  SessionOpened,
  SessionStateSummary,
} from "../shared/methods.js";
import type { LineTransport } from "../shared/transport.js";

/**
 * 调用失败。`code` 是进程内错误的字符串码（`session_busy`、`unknown_request` 等，
 * 来自响应的 `data.code`），客户端按它分支，与进程内按 `error.code` 分支等价；
 * `message` 是原文案；`rpcCode` 是 JSON-RPC 数字码。
 */
export class RpcError extends Error {
  readonly code: string;
  readonly rpcCode: number;
  /** 原始错误类名（RuntimeCommandError、SessionError……） */
  readonly errorName: string | undefined;

  constructor(code: string, message: string, rpcCode = 0, errorName?: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.rpcCode = rpcCode;
    this.errorName = errorName;
  }

  static fromObject(error: RpcErrorObject): RpcError {
    return new RpcError(
      error.data?.code ?? RPC_CODE_NAMES[error.code] ?? "server_error",
      error.message,
      error.code,
      error.data?.name,
    );
  }
}

export interface RpcClientOptions {
  clientName: string;
  /** 能否回复权限与提问请求，默认 true；false 时服务端按非交互规则处理 */
  interactive?: boolean;
}

export type EventListener = (event: RuntimeEvent) => void;

export interface SubscribeOptions {
  /** 只要 seq 大于它的持久事件的回放；默认 0（全部） */
  afterSeq?: number;
}

export interface Subscription {
  /** 回放与实时衔接完成时已推送的最后一个持久事件的 seq */
  lastSeq: number;
  /** 停止交付并通知服务端停推（已被后来的订阅替换时无操作） */
  unsubscribe(): Promise<void>;
}

/** 与进程内 `RuntimeSession` 同名的方法，全部异步化；`sessionId` 已绑定 */
export interface RpcSession {
  readonly id: string;
  /**
   * 订阅：先回放 afterSeq 之后的持久事件，再接实时事件（持久与临时都推）。
   * 同一会话同一时刻只有一路订阅，再次调用替换之前的监听器；需要多个消费者时用 `RpcClient.onEvent` 分发。
   */
  subscribe(listener: EventListener, options?: SubscribeOptions): Promise<Subscription>;
  /** 挂到 Turn 结束，结果与进程内 `submit()` 的 resolve 时机相同 */
  submit(input: SubmitInput): Promise<TurnEndReason>;
  /** 中断运行中的 Turn（通知，无应答）；submit 随后以 aborted 返回 */
  interrupt(): void;
  respondPermission(requestId: string, reply: PermissionReply): Promise<void>;
  respondQuestion(requestId: string, reply: QuestionReply): Promise<void>;
  setModel(model: string | ModelRef): Promise<void>;
  setPermissionPreset(name: string): Promise<void>;
  setReasoningEffort(level: string): Promise<void>;
  setShell(kind: string): Promise<void>;
  compact(): Promise<void>;
  rewindTargets(): Promise<RewindTarget[]>;
  rewind(targetSeq: number, mode: RewindMode): Promise<SessionRewoundPayload["files"]>;
  state(): Promise<SessionStateSummary>;
  describeContext(): Promise<ContextSummary>;
  reasoningEffortInfo(): Promise<RpcResult<"session.reasoningEffortInfo">>;
  shellInfo(): Promise<RpcResult<"session.shellInfo">>;
  listShells(): Promise<RpcResult<"session.listShells">>;
  visionInfo(): Promise<RpcResult<"session.visionInfo">>;
  mcpServers(): Promise<RpcResult<"session.mcpServers">>;
  fileIndex(): Promise<FileIndexEntry[]>;
  readInputHistory(): Promise<string[]>;
  recordInputHistory(text: string): Promise<void>;
  close(): Promise<void>;
}

/** 与进程内 `Runtime` 同名的方法；`undefined` 的返回在线上是 `null`，这里还原 */
export interface RpcRuntime {
  listSessions(filter?: { cwd?: string; includeSubagents?: boolean }): Promise<SessionSummary[]>;
  createSession(
    options: CreateSessionOptions,
  ): Promise<{ opened: SessionOpened; session: RpcSession }>;
  resumeSession(
    id: string,
    options?: { model?: string | ModelRef; force?: boolean },
  ): Promise<{ opened: SessionOpened; session: RpcSession }>;
  forkSession(id: string, options?: { targetSeq?: number }): Promise<string>;
  listModels(): Promise<ModelInfo[]>;
  defaultModel(): Promise<ModelRef | undefined>;
  listRecentModels(): Promise<ModelRef[]>;
  describeSettings(): Promise<SettingItem[]>;
  updateSettings(patch: SettingsPatch, options?: { reviewerKey: string }): Promise<SettingItem[]>;
  setDefaultModel(model: string, reasoningEffort: ReasoningEffort | null): Promise<SettingItem[]>;
  describeModelRoles(): Promise<ModelRoleInfo[]>;
  setModelRole(role: ModelRole, ref: string | null): Promise<SettingItem[]>;
  getPreference(key: string): Promise<string | undefined>;
  setPreference(key: string, value: string | undefined): Promise<void>;
  listReviewerProviders(): Promise<ProviderOverview[]>;
  defaultReviewer(endpoint: JevEndpoint, baseURL?: string): Promise<JevReviewerConfig>;
  listReviewerModels(reviewer: JevReviewerConfig): Promise<{ models: string[]; warning?: string }>;
}

export interface RpcClient {
  /** 握手：必须是第一个调用；协议版本不一致时抛 `protocol_version_mismatch` */
  initialize(): Promise<InitializeResult>;
  readonly runtime: RpcRuntime;
  /** 已打开会话的句柄（`createSession`/`resumeSession` 返回的就是它） */
  session(sessionId: string): RpcSession;
  /** 任意方法的类型化调用（上面的封装都建立在它上面） */
  call<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
  /** 收到任意会话的事件 */
  onEvent(handler: (sessionId: string, event: RuntimeEvent) => void): () => void;
  /** 请求服务端清理并退出，回复后关闭传输 */
  shutdown(): Promise<void>;
  /** 直接关闭传输（服务端按"连接断开"清理） */
  close(): void;
  /** 连接结束（对端关闭、进程退出、本端 close）时 resolve */
  readonly closed: Promise<void>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export function createRpcClient(transport: LineTransport, options: RpcClientOptions): RpcClient {
  let nextId = 1;
  let isClosed = false;
  const pending = new Map<RpcId, Pending>();
  const sessionListeners = new Map<string, Set<EventListener>>();
  const globalListeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const connectionClosed = () => new RpcError("connection_closed", "与 Nocturne 后台的连接已断开");

  const dispatchEvent = (sessionId: string, event: RuntimeEvent): void => {
    for (const listener of [...(sessionListeners.get(sessionId) ?? [])]) {
      try {
        listener(event);
      } catch {
        // 订阅者异常不影响其他订阅者（events.md 第 6 节）
      }
    }
    for (const handler of [...globalListeners]) {
      try {
        handler(sessionId, event);
      } catch {
        // 同上
      }
    }
  };

  transport.onLine((line) => {
    if (line.trim() === "") return;
    const parsed = parseLine(line);
    if (parsed.kind === "error") return;
    const message = parsed.message;
    const id = message.id;
    if (isRpcId(id) && ("result" in message || "error" in message)) {
      const entry = pending.get(id);
      if (entry === undefined) return;
      pending.delete(id);
      const error = message.error as RpcErrorObject | undefined;
      if (error !== undefined) entry.reject(RpcError.fromObject(error));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "event") {
      const params = message.params as { sessionId?: unknown; event?: unknown } | undefined;
      if (typeof params?.sessionId === "string" && typeof params.event === "object") {
        dispatchEvent(params.sessionId, params.event as RuntimeEvent);
      }
    }
  });
  transport.onClose(() => {
    isClosed = true;
    for (const entry of pending.values()) entry.reject(connectionClosed());
    pending.clear();
    resolveClosed();
  });

  const call = <M extends RpcMethodName>(
    method: M,
    params: RpcParams<M>,
  ): Promise<RpcResult<M>> => {
    if (isClosed) return Promise.reject(connectionClosed());
    const id = nextId++;
    return new Promise<RpcResult<M>>((resolve, reject) => {
      pending.set(id, { resolve: resolve, reject });
      try {
        transport.send(encodeMessage({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const notify = (method: string, params: unknown): void => {
    if (isClosed) return;
    transport.send(encodeMessage({ jsonrpc: "2.0", method, params }));
  };

  const sessionHandles = new Map<string, RpcSession>();
  const session = (sessionId: string): RpcSession => {
    const existing = sessionHandles.get(sessionId);
    if (existing !== undefined) return existing;
    const p = { sessionId };
    const handle: RpcSession = {
      id: sessionId,
      async subscribe(listener, subscribeOptions) {
        // 同一会话同一时刻一个订阅：再次订阅替换之前的监听器（重连、换视图时用）。
        // 回放是推给"这一路订阅"的，保留旧监听器会让它收到重复的回放
        const listeners = new Set<EventListener>([listener]);
        sessionListeners.set(sessionId, listeners);
        try {
          const { lastSeq } = await call("session.subscribe", {
            ...p,
            afterSeq: subscribeOptions?.afterSeq ?? 0,
          });
          return {
            lastSeq,
            async unsubscribe() {
              // 已被后来的订阅替换：什么都不做
              if (sessionListeners.get(sessionId) !== listeners) return;
              sessionListeners.delete(sessionId);
              if (!isClosed) await call("session.unsubscribe", p).catch(() => undefined);
            },
          };
        } catch (error) {
          if (sessionListeners.get(sessionId) === listeners) sessionListeners.delete(sessionId);
          throw error;
        }
      },
      submit: async (input) => {
        const attachments = input.attachments?.map((a) => ({
          data: encodeBase64(a.data),
          mimeType: a.mimeType,
          ...(a.label !== undefined ? { label: a.label } : {}),
        }));
        return await call("session.submit", {
          ...p,
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.content !== undefined ? { content: input.content } : {}),
          ...(attachments !== undefined ? { attachments } : {}),
        });
      },
      interrupt: () => {
        notify("session.interrupt", p);
      },
      respondPermission: async (requestId, reply) => {
        await call("session.respondPermission", { ...p, requestId, reply });
      },
      respondQuestion: async (requestId, reply) => {
        await call("session.respondQuestion", { ...p, requestId, reply });
      },
      setModel: async (model) => {
        await call("session.setModel", { ...p, model });
      },
      setPermissionPreset: async (name) => {
        await call("session.setPermissionPreset", { ...p, name });
      },
      setReasoningEffort: async (level) => {
        await call("session.setReasoningEffort", { ...p, level });
      },
      setShell: async (kind) => {
        await call("session.setShell", { ...p, kind });
      },
      compact: async () => {
        await call("session.compact", p);
      },
      rewindTargets: () => call("session.rewindTargets", p),
      rewind: (targetSeq, mode) => call("session.rewind", { ...p, targetSeq, mode }),
      state: () => call("session.state", p),
      describeContext: () => call("session.describeContext", p),
      reasoningEffortInfo: () => call("session.reasoningEffortInfo", p),
      shellInfo: () => call("session.shellInfo", p),
      listShells: () => call("session.listShells", p),
      visionInfo: () => call("session.visionInfo", p),
      mcpServers: () => call("session.mcpServers", p),
      fileIndex: () => call("session.fileIndex", p),
      readInputHistory: () => call("session.readInputHistory", p),
      recordInputHistory: async (text) => {
        await call("session.recordInputHistory", { ...p, text });
      },
      close: async () => {
        try {
          await call("session.close", p);
        } finally {
          sessionHandles.delete(sessionId);
          sessionListeners.delete(sessionId);
        }
      },
    };
    sessionHandles.set(sessionId, handle);
    return handle;
  };

  const runtime: RpcRuntime = {
    listSessions: (filter) => call("runtime.listSessions", filter ?? {}),
    createSession: async (createOptions) => {
      const opened = await call("runtime.createSession", createOptions);
      return { opened, session: session(opened.sessionId) };
    },
    resumeSession: async (id, resumeOptions) => {
      const opened = await call("runtime.resumeSession", { sessionId: id, ...resumeOptions });
      return { opened, session: session(opened.sessionId) };
    },
    forkSession: async (id, forkOptions) =>
      (await call("runtime.forkSession", { sessionId: id, ...forkOptions })).sessionId,
    listModels: () => call("runtime.listModels", {}),
    defaultModel: async () => (await call("runtime.defaultModel", {})) ?? undefined,
    listRecentModels: () => call("runtime.listRecentModels", {}),
    describeSettings: () => call("runtime.describeSettings", {}),
    updateSettings: (patch, updateOptions) =>
      call("runtime.updateSettings", {
        patch,
        ...(updateOptions !== undefined ? { reviewerKey: updateOptions.reviewerKey } : {}),
      }),
    setDefaultModel: (model, reasoningEffort) =>
      call("runtime.setDefaultModel", { model, reasoningEffort }),
    describeModelRoles: () => call("runtime.describeModelRoles", {}),
    setModelRole: (role, ref) => call("runtime.setModelRole", { role, ref }),
    getPreference: async (key) => (await call("runtime.getPreference", { key })) ?? undefined,
    setPreference: async (key, value) => {
      await call("runtime.setPreference", { key, value: value ?? null });
    },
    listReviewerProviders: () => call("runtime.listReviewerProviders", {}),
    defaultReviewer: (endpoint, baseURL) =>
      call("runtime.defaultReviewer", {
        endpoint,
        ...(baseURL !== undefined ? { baseURL } : {}),
      }),
    listReviewerModels: (reviewer) => call("runtime.listReviewerModels", { reviewer }),
  };

  return {
    async initialize() {
      const result = await call("initialize", {
        protocolVersion: RPC_PROTOCOL_VERSION,
        clientName: options.clientName,
        capabilities: { interactive: options.interactive ?? true },
      });
      if (result.protocolVersion !== RPC_PROTOCOL_VERSION) {
        throw new RpcError(
          "protocol_version_mismatch",
          `协议版本不一致：客户端 ${RPC_PROTOCOL_VERSION}，服务端 ${result.protocolVersion}`,
        );
      }
      return result;
    },
    runtime,
    session,
    call,
    onEvent(handler) {
      globalListeners.add(handler);
      return () => {
        globalListeners.delete(handler);
      };
    },
    async shutdown() {
      try {
        await call("shutdown", {});
      } finally {
        transport.close();
      }
    },
    close() {
      transport.close();
    },
    closed,
  };
}

/** 浏览器与 Node 都有 btoa；分块拼接避免大数组展开超出调用栈 */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export interface SessionViewTracker {
  /** 当前视图；每个事件归约后原地更新 */
  readonly view: SessionView;
  /** 回放与实时衔接已完成时已处理到的最后一个持久事件 seq */
  readonly lastSeq: number;
  stop(): Promise<void>;
}

/**
 * 订阅会话并用 protocol 的同一个 reducer 折叠视图（view.md 第 6 节）；
 * 每处理一个事件调用 `onChange`。重连时用 `afterSeq` 与已有 `view` 续接。
 */
export async function trackSessionView(
  session: RpcSession,
  onChange?: (view: SessionView, event: RuntimeEvent) => void,
  options: SubscribeOptions & { view?: SessionView } = {},
): Promise<SessionViewTracker> {
  const view = options.view ?? createSessionView();
  const subscription = await session.subscribe(
    (event) => {
      reduceSessionView(view, event);
      onChange?.(view, event);
    },
    { afterSeq: options.afterSeq ?? 0 },
  );
  return {
    view,
    lastSeq: subscription.lastSeq,
    stop: () => subscription.unsubscribe(),
  };
}
