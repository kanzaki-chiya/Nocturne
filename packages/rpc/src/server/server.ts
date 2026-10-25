/**
 * RPC 服务端（ADR-0044）：给定一个 Runtime，把公开 API 映射成 JSON-RPC 方法，
 * 把会话事件推成 `event` 通知。与传输无关：只接收按行收发的 LineTransport。
 *
 * 后台级共享状态在 `Hub`（hub.ts），`Connection` 只保留单条连接自己的状态。
 * 一个服务端共享 Runtime，服务一条本机连接与多条远程连接。权限判定仍只在
 * Runtime 的权限层——这里只转发 `permission.requested` 事件与回复（AGENTS.md 硬性约束）。
 */
import { randomUUID } from "node:crypto";

import {
  commitProvider,
  describeAccountStorage,
  describeProviderSetup,
  discardDraftLogin,
  discardProvider,
  isReasoningEffort,
  listProviderPresets,
  logoutProvider,
  MODEL_ROLES,
  prepareProvider,
  probeSetupProviderModels,
  ProviderLoginError,
  SessionError,
  startDraftProviderLogin,
  startProviderLogin,
  updateSetupProvider,
  type AddProviderInput,
  type ContentBlock,
  type CreateSessionOptions,
  type JevEndpoint,
  type JevReviewerConfig,
  type LoginResult,
  type LoginSession,
  type ModelRole,
  type PermissionReply,
  type ProviderCredentialInput,
  type ProviderLoginOptions,
  type QuestionReply,
  type RewindMode,
  type Runtime,
  type RuntimeConfig,
  type RuntimeEvent,
  type RuntimeSession,
  type SettingsPatch,
  type SubagentObservation,
  type SubmitInput,
  type UpdateSetupProviderPatch,
} from "@nocturne/core";

import {
  encodeMessage,
  invalidRequestFailure,
  isRpcId,
  parseLine,
  RPC_PROTOCOL_VERSION,
  type RpcErrorObject,
  type RpcFailure,
  type RpcId,
  type RpcMessage,
} from "../shared/jsonrpc.js";
import {
  RPC_METHOD_NAMES,
  type LoginCompleted,
  type LoginStarted,
  type RpcMethodName,
  type RpcMethods,
  type SessionOpened,
  type WireAttachment,
} from "../shared/methods.js";
import type { LineTransport } from "../shared/transport.js";
import { MethodNotFoundError, RpcProtocolError, toRpcError } from "./errors.js";
import { Hub, type HubPeer, type ProviderState, type RpcRuntimeHandle } from "./hub.js";
import { RemoteHost, type RemoteHostOptions } from "./remote/host.js";
import { MAX_MESSAGE } from "@nocturne/remote";
import {
  asParams,
  decodeBase64,
  InvalidParamsError,
  optBool,
  optInt,
  optString,
  reqInt,
  reqModel,
  reqObject,
  reqString,
  type Params,
} from "./params.js";

export type { RpcRuntimeHandle } from "./hub.js";

/**
 * 参数里可能含秘密值的方法（ADR-0044 第 6 节：密钥明文只在两个进程的管道里）：
 * 请求失败时把错误 message 与 data 各字符串中出现的每个非空秘密值替换为
 * `[redacted]`，避免密钥随报错文本回流客户端或进入日志。诊断记录本来就不含参数。
 */
export const SENSITIVE_METHODS: Partial<Record<RpcMethodName, (p: Params) => string[]>> = {
  "remote.register": (p) => (typeof p.invite === "string" ? [p.invite] : []),
  "runtime.updateSettings": (p) => (typeof p.reviewerKey === "string" ? [p.reviewerKey] : []),
  "provider.prepareProvider": (p) => {
    const credential = p.credential;
    if (typeof credential !== "object" || credential === null) return [];
    const { kind, key } = credential as { kind?: unknown; key?: unknown };
    return kind === "apiKey" && typeof key === "string" ? [key] : [];
  },
  "provider.setCredential": (p) => (typeof p.key === "string" ? [p.key] : []),
  // 自定义请求头值可能含密钥：报错文本里按秘密值遮蔽
  "provider.updateSetupProvider": (p) => headerSecrets(p.patch),
  "provider.probeSetupProviderModels": (p) => headerSecrets(p),
  "login.submitManual": (p) => (typeof p.text === "string" ? [p.text] : []),
};

function headerSecrets(p: unknown): string[] {
  if (typeof p !== "object" || p === null) return [];
  const headers = (p as { headers?: unknown }).headers;
  if (typeof headers !== "object" || headers === null) return [];
  return Object.values(headers as Record<string, unknown>).filter(
    (v): v is string => typeof v === "string" && v !== "",
  );
}

export interface RpcServerOptions {
  remote?: RemoteHostOptions | undefined;
  nocturneVersion: string;
  /**
   * 握手后创建 Runtime：客户端声明的 `interactive` 能力决定 Runtime 的 `interactive`
   * （权限请求能否交给客户端；false 时按非交互规则处理）。
   */
  createRuntime(init: { clientName: string; interactive: boolean }): Promise<RpcRuntimeHandle>;
  /** 订阅回放每批推送的事件数，批间让出事件循环（默认 256） */
  replayChunkSize?: number | undefined;
  /** 回放批间的让出点，默认 setImmediate；测试可注入以在回放中途暂停，制造"回放期间有新事件" */
  replayYield?: (() => Promise<void>) | undefined;
  /** 诊断记录：只含方法名与结果，永远不含参数（参数里可能有密钥明文） */
  diagnostics?: ((record: RpcDiagnostic) => void) | undefined;
  /** 远程单条报文上限（缺省 REMOTE_MESSAGE_LIMIT）；测试可缩小 */
  remoteMessageLimit?: number | undefined;
}

export type RpcDiagnostic =
  | { kind: "connection"; state: "open" | "closed"; origin: "local" | "remote" }
  | { kind: "request"; id: RpcId; method: string }
  | { kind: "notification"; method: string }
  | { kind: "response"; id: RpcId | null; ok: boolean; errorCode?: string };

export interface RpcServer {
  /** 本服务端实现的请求方法（不含通知）；覆盖测试用它与公开 API 对照 */
  readonly methods: readonly RpcMethodName[];
  /**
   * 一条传输对应一条连接，缺省本机；本机断开收尾整个后台，远程只释放自身引用。
   * 本机 shutdown 先清理再回复，远程不得 shutdown。
   */
  serve(transport: LineTransport, options?: { origin?: "local" | "remote" }): Promise<void>;
}

/**
 * ADR-0052 修订（2026-10-15）：显式能力白名单，新增方法默认不开放给远程连接。
 * 原则是撤销手机后不留后患：会话内操作放开，设置、凭据、持久授权、项目信任只在本机。
 * `session.setShell` 会写 settings.json（与 `runtime.setShellSetting` 同一处），不放开。
 */
export const REMOTE_METHODS = [
  "initialize",
  "runtime.listSessions",
  "runtime.usageStats",
  "runtime.createSession",
  "runtime.resumeSession",
  "runtime.forkSession",
  "runtime.listModels",
  "runtime.defaultModel",
  "runtime.listRecentModels",
  "runtime.describeModelRoles",
  "runtime.listShells",
  // ADR-0064：手机能看任务与历史、立即运行（不改任务、跑完不留撤销后仍生效的东西，等同会话内操作）；
  // schedule.save / schedule.delete 改持久配置（含启停），只在本机
  "schedule.list",
  "schedule.history",
  "schedule.runNow",
  "session.subscribe",
  "session.unsubscribe",
  "session.close",
  "session.state",
  "session.submit",
  "session.interrupt",
  "session.respondPermission",
  "session.respondQuestion",
  "session.setModel",
  "session.setReasoningEffort",
  "session.setPermissionPreset",
  "session.compact",
  "session.rewind",
  "session.rewindTargets",
  "session.turnChanges",
  "session.turnChangeDiff",
  "session.describeContext",
  "session.describeSkills",
  "session.describeExternalAgents",
  "session.mcpServers",
  "session.listShells",
  "session.shellInfo",
  "session.reasoningEffortInfo",
  "session.visionInfo",
  "session.fileIndex",
  "session.resolveFiles",
  "session.readAttachment",
  "session.readInputHistory",
  "session.recordInputHistory",
] as const satisfies readonly RpcMethodName[];

/**
 * 远程单条报文的上限：加密通道单条消息超过 MAX_MESSAGE 会整条关闭，
 * 这里留 64 KiB 给 JSON 包装与转义余量。
 */
export const REMOTE_MESSAGE_LIMIT = MAX_MESSAGE - 64 * 1024;
/** 远程读取附件的原始字节上限：base64 后仍在报文上限之内 */
export function remoteAttachmentLimit(messageLimit = REMOTE_MESSAGE_LIMIT): number {
  return Math.floor((messageLimit * 3) / 4) - 1024;
}

const DEFAULT_REPLAY_CHUNK = 256;

/** 本连接已打开的会话及其订阅状态（会话本身登记在 Hub） */
interface OpenSession {
  session: RuntimeSession;
  unsubscribe: (() => void) | undefined;
  /** 每次 subscribe/unsubscribe/close 递增；回放循环发现自己过期就停手 */
  generation: number;
}

/** 进行中的登录会话：saved 是已保存服务商的重新登录，draft 是表单里未保存的草稿登录 */
interface LoginEntry {
  session: LoginSession;
  kind: "saved" | "draft";
  /** 创建登录时用的配置对象（草稿登录的暂存凭据按它登记） */
  config: RuntimeConfig;
  /** 对应 start/startDraft 响应写出后 resolve——login.completed 绝不先于它到达 */
  started: Promise<void>;
  resolveStarted: () => void;
  /** 无系统后端时经 onUnstoredKey 记录的密钥（只记第一次；随 login.completed 发出后丢弃） */
  unstored: { value: { key: string; envName: string } | undefined };
}

/** 本连接对一个子会话的只读观察（含还在建立中的）；与 RuntimeSession 订阅互不相干 */
interface SubagentWatch {
  subscriptionId: string;
  parentSessionId: string;
  childSessionId: string;
  /** 取消尚在建立中的观察；建立完成后改用 observation.unsubscribe */
  controller: AbortController;
  observation: SubagentObservation | undefined;
  /** unsubscribe / 替换 / 父会话关闭 / 断线 / shutdown 已撤销；迟到的异步结果据此立即退订 */
  cancelled: boolean;
  /** 已自然结束（closed 已发出），表项随即释放 */
  ended: boolean;
}

type Handler<K extends RpcMethodName> = (
  params: Params,
) => Promise<RpcMethods[K]["result"]> | RpcMethods[K]["result"];
type HandlerTable = { [K in RpcMethodName]: Handler<K> };

export function createRpcServer(options: RpcServerOptions): RpcServer {
  const hub = new Hub();
  let serving = false;
  const remote = options.remote
    ? new RemoteHost(
        options.remote,
        (message) => {
          hub.notifyLocal(message);
        },
        (transport) => server.serve(transport, { origin: "remote" }),
      )
    : undefined;
  const server: RpcServer = {
    methods: RPC_METHOD_NAMES,
    async serve(transport, connectionOptions) {
      const origin = connectionOptions?.origin ?? "local";
      if (hub.stopping) throw new RpcProtocolError("shutting_down", "服务端正在关闭");
      if (origin === "local" && serving)
        throw new Error("RPC 服务端同一时刻只接一个客户端（本机连接）");
      if (origin === "local") serving = true;
      const connection = new Connection(options, hub, transport, origin, remote);
      hub.attach(connection);
      try {
        await connection.run();
      } finally {
        hub.detach(connection);
        if (origin === "local") serving = false;
      }
    },
  };
  return server;
}

class Connection implements HubPeer {
  private initPromise: Promise<void> | undefined;
  /** 本连接已完成握手（Hub 的广播只发给已握手的连接） */
  initialized = false;
  private shuttingDown = false;
  private closed = false;
  private inputEnded = false;
  private readonly requests = new Set<Promise<void>>();
  private cleanupPromise: Promise<void> | undefined;
  private readonly sessions = new Map<string, OpenSession>();
  /** 子会话只读观察表：subscriptionId → 观察；pair 表用于「同一 child 再订阅替换旧观察」 */
  private readonly subagentWatches = new Map<string, SubagentWatch>();
  private readonly subagentPairs = new Map<string, string>();
  private readonly opening = new Set<Promise<unknown>>();
  private readonly openingIds = new Set<string>();
  private readonly abort = new AbortController();
  private readonly handlers: HandlerTable;
  /** draftId → 创建草稿时的配置对象（与该登录的创建配置一致；见 buildHandlers 的 prepareProvider） */
  private readonly providerDrafts = new Map<
    string,
    { config: RuntimeConfig; loginId?: string | undefined }
  >();
  /** loginId → 本连接 login.startDraft 创建时的配置对象（进行中或已完成未提交） */
  private readonly draftLogins = new Map<string, RuntimeConfig>();
  /** 进行中的登录会话（loginId → 条目）；完成或取消时移出并推 login.completed */
  private readonly logins = new Map<string, LoginEntry>();

  constructor(
    private readonly options: RpcServerOptions,
    private readonly hub: Hub,
    private readonly transport: LineTransport,
    readonly origin: "local" | "remote",
    private readonly remote: RemoteHost | undefined,
  ) {
    this.handlers = this.buildHandlers();
  }

  run(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.diagnose({ kind: "connection", state: "open", origin: this.origin });
      this.transport.onLine((line) => {
        this.onLine(line);
      });
      this.transport.onClose(() => {
        this.inputEnded = true;
        // 子会话观察不等在途请求：断线时立即撤监听、取消尚在建立的回放
        this.cancelSubagentWatches();
        if (this.origin === "local") {
          if (this.cleanupPromise === undefined) this.hub.stopping = true;
          this.remote?.stop();
          void this.hub.closeRemotes();
          this.hub.interruptAll();
        } else {
          this.closed = true;
        }
        void (async () => {
          if (this.origin === "local") await Promise.allSettled([...this.requests]);
          await this.transport.flush?.();
          await this.cleanup();
          this.closed = true;
          this.diagnose({ kind: "connection", state: "closed", origin: this.origin });
          resolve();
        })();
      });
    });
  }

  // ── 报文收发 ─────────────────────────────────────────────

  disconnect(): Promise<void> {
    this.closed = true;
    this.transport.close();
    return this.cleanup();
  }

  private diagnose(record: RpcDiagnostic): void {
    try {
      this.options.diagnostics?.(record);
    } catch {
      // 诊断回调出错不影响服务
    }
  }

  send(message: RpcMessage): void {
    this.sendLine(encodeMessage(message));
  }

  private sendLine(line: string): void {
    if (this.closed) return;
    try {
      this.transport.send(line);
    } catch {
      // 传输已断开：由 onClose 收尾
    }
  }

  private fail(failure: RpcFailure): void {
    this.diagnose({
      kind: "response",
      id: failure.id,
      ok: false,
      ...(failure.error.data?.code !== undefined ? { errorCode: failure.error.data.code } : {}),
    });
    this.send(failure);
  }

  private onLine(line: string): void {
    if (line.trim() === "") return;
    const parsed = parseLine(line);
    if (parsed.kind === "error") {
      this.fail(parsed.failure);
      return;
    }
    const message = parsed.message;
    const id = message.id;
    const method = message.method;
    if (message.jsonrpc !== "2.0") {
      this.fail(invalidRequestFailure(isRpcId(id) ? id : null, 'jsonrpc 必须是 "2.0"'));
      return;
    }
    if (typeof method !== "string") {
      // 客户端发来的应答：服务端不发请求，直接忽略
      if ("result" in message || "error" in message) return;
      this.fail(invalidRequestFailure(isRpcId(id) ? id : null, "缺少 method"));
      return;
    }
    if (id === undefined) {
      this.onNotification(method, message.params);
      return;
    }
    if (!isRpcId(id)) {
      this.fail(invalidRequestFailure(null, "id 必须是字符串或数字"));
      return;
    }
    const request = this.onRequest(id, method, message.params);
    this.requests.add(request);
    void request.finally(() => this.requests.delete(request));
  }

  private onNotification(method: string, params: unknown): void {
    this.diagnose({ kind: "notification", method });
    if (method === "session.interrupt") this.interrupt(params);
    // 其他通知没有定义，忽略
  }

  private interrupt(params: unknown): void {
    try {
      const sessionId = reqString(asParams(params), "sessionId");
      this.sessions.get(sessionId)?.session.interrupt();
    } catch {
      // 通知没有应答：参数不对就当没发
    }
  }

  private async onRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    this.diagnose({ kind: "request", id, method });
    try {
      if (this.origin === "remote") await this.checkRemote(method, params);
      let result: unknown;
      if (method === "session.interrupt") {
        // 允许以请求形式发中断（便于需要确认送达的客户端）
        this.interrupt(params);
        result = null;
      } else {
        result = await this.dispatch(method, params);
      }
      const line = encodeMessage({ jsonrpc: "2.0", id, result: result ?? null });
      this.checkRemoteSize(method, line);
      this.diagnose({ kind: "response", id, ok: true });
      this.sendLine(line);
      // login.completed 绝不先于对应 start 响应到达（rpc.md 3.4）
      if (method === "login.start" || method === "login.startDraft") {
        const loginId = (result as { loginId?: unknown } | null)?.loginId;
        if (typeof loginId === "string") this.logins.get(loginId)?.resolveStarted();
      }
      if (method === "shutdown") this.transport.close();
    } catch (error) {
      const err = this.redactSecrets(method, params, toRpcError(error));
      this.fail({ jsonrpc: "2.0", id, error: err });
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (this.origin === "remote" && (this.inputEnded || this.closed || this.hub.stopping)) {
      throw new RpcProtocolError("shutting_down", "连接正在关闭");
    }
    if (!Object.hasOwn(this.handlers, method)) {
      throw new MethodNotFoundError(method);
    }
    const name = method as RpcMethodName;
    if (name !== "initialize" && name !== "shutdown") {
      // 管线化的客户端可能在 initialize 未返回时就发后续请求：等握手结束
      if (this.initPromise !== undefined) await this.initPromise.catch(() => undefined);
      if (!this.initialized) {
        throw new RpcProtocolError("not_initialized", "第一条请求必须是 initialize");
      }
      if (this.shuttingDown) throw new RpcProtocolError("shutting_down", "服务端正在关闭");
    }
    const handler = this.handlers[name] as (p: Params) => unknown;
    const result = handler(asParams(params));
    // EOF 可能发生在等待 initialize 时；刚开始的 Turn/压缩同样必须中断。
    if (this.inputEnded && this.origin === "local") this.hub.interruptAll();
    return await result;
  }

  private async checkRemote(method: string, params: unknown): Promise<void> {
    const deny = (message: string): never => {
      throw new RpcProtocolError("remote_not_allowed", message);
    };
    if (!(REMOTE_METHODS as readonly string[]).includes(method)) {
      deny(`远程连接不允许调用 ${method}`);
    }
    const p = asParams(params);
    if (method !== "initialize" && this.initPromise !== undefined)
      await this.initPromise.catch(() => undefined);
    // 持久授权（写入项目 Grant）只能在电脑上选；会话级与单次批准照常
    if (method === "session.respondPermission" && reqObject(p, "reply").remember === "project") {
      deny("远程连接不能保存项目级授权；请求仍待处理，请在本机回复");
    }
    if (method === "runtime.createSession" && this.initialized && this.hub.available) {
      await this.hub.checkRemoteWorkspace(optString(p, "cwd"), optString(p, "workspaceRoot"));
    }
  }

  private get remoteLimit(): number {
    return this.options.remoteMessageLimit ?? REMOTE_MESSAGE_LIMIT;
  }

  /** 远程连接的结果超过通道上限时改报错误，避免整条加密通道被关闭 */
  private checkRemoteSize(method: string, line: string): void {
    if (this.origin !== "remote" || Buffer.byteLength(line, "utf8") <= this.remoteLimit) return;
    throw new RpcProtocolError(
      "response_too_large",
      `${method} 的结果过大，无法经远程连接传输，请在电脑上查看`,
    );
  }

  // ── 生命周期 ─────────────────────────────────────────────

  /** 中断运行中的 Turn、关闭全部会话、释放 Runtime 资源；幂等 */
  private cleanup(): Promise<void> {
    this.cleanupPromise ??= (async () => {
      this.shuttingDown = true;
      if (this.origin === "local") {
        this.hub.stopping = true;
        this.remote?.stop();
        await this.hub.closeRemotes();
        this.hub.interruptAll();
      }
      this.abort.abort();
      // 握手与会话打开可能还在途中：等它们落定，新打开的会话在 register 里被直接关闭
      await this.initPromise?.catch(() => undefined);
      await Promise.allSettled([...this.opening]);
      // 进行中的登录先取消（关闭回环端口）；其 login.completed 仍照常推送
      for (const entry of this.logins.values()) {
        entry.resolveStarted();
        entry.session.cancel();
      }
      // 本连接的未提交草稿绑定其创建配置；丢弃只释放内存，不写盘也不消费登录
      for (const [draftId, record] of this.providerDrafts) {
        discardProvider(record.config, draftId);
      }
      this.providerDrafts.clear();
      // 完成未提交的草稿登录：丢弃暂存凭据
      for (const [loginId, config] of this.draftLogins) {
        discardDraftLogin(config, loginId);
      }
      this.draftLogins.clear();
      // 子会话观察：撤监听、取消回放、丢缓冲；不触碰子会话的运行、锁与并发槽
      this.cancelSubagentWatches();
      for (const entry of this.sessions.values()) {
        entry.generation++;
        entry.unsubscribe?.();
      }
      const sessionIds = [...this.sessions.keys()];
      this.sessions.clear();
      if (this.origin === "remote") this.requests.clear();
      // 整个后台收尾：中断并关闭全部会话、释放 Runtime 资源
      if (this.origin === "local") await this.hub.shutdown();
      else await Promise.all(sessionIds.map((id) => this.hub.release(id)));
    })();
    return this.cleanupPromise;
  }

  private runtime(): Runtime {
    return this.hub.runtime();
  }

  private providerConfig(): ProviderState {
    return this.hub.providerConfig();
  }

  private workspaceOf(p: Params): Promise<string | undefined> {
    return this.hub.workspaceOf(p);
  }

  private enqueueConfig<T>(task: (config: RuntimeConfig) => Promise<T>): Promise<T> {
    return this.hub.enqueueConfig(task);
  }

  private reloadProviders(notify = true): Promise<void> {
    return this.hub.reloadProviders(notify);
  }

  private mutateAndReload<T>(
    mutate: (config: RuntimeConfig) => Promise<T>,
    notify = true,
  ): Promise<T> {
    return this.hub.mutateAndReload(mutate, notify);
  }

  // ── 登录会话 ─────────────────────────────────────────────

  private loginOptions(p: Params, unstored: LoginEntry["unstored"]): ProviderLoginOptions {
    const options: ProviderLoginOptions = {
      onUnstoredKey: (key, envName) => {
        unstored.value ??= { key, envName };
      },
    };
    const remote = optBool(p, "remote");
    if (remote !== undefined) options.remote = remote;
    const accountStorage = optString(p, "accountStorage");
    if (accountStorage !== undefined) {
      if (accountStorage !== "plaintext" && accountStorage !== "memory") {
        throw new InvalidParamsError(`accountStorage 必须是 "plaintext" 或 "memory"`);
      }
      options.accountStorage = accountStorage;
    }
    return options;
  }

  private loginStarted(loginId: string, session: LoginSession): LoginStarted {
    return {
      loginId,
      authorizeUrl: session.authorizeUrl,
      manualInput: session.manualInput,
      ...(session.userCode !== undefined ? { userCode: session.userCode } : {}),
      expiresAt: session.expiresAt,
    };
  }

  private registerLogin(
    loginId: string,
    kind: LoginEntry["kind"],
    config: RuntimeConfig,
    session: LoginSession,
    unstored: LoginEntry["unstored"],
  ): void {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    this.logins.set(loginId, { session, kind, config, started, resolveStarted, unstored });
    void session.completion.then(
      (result) => this.finishLogin(loginId, result),
      (error: unknown) => this.finishLogin(loginId, undefined, error),
    );
  }

  /**
   * 登录完成：移出进行中表，先等对应 start 响应写出（顺序保证），
   * saved 成功时先串行重载（providersChanged），最后推 login.completed。
   */
  private async finishLogin(loginId: string, result?: LoginResult, error?: unknown): Promise<void> {
    const entry = this.logins.get(loginId);
    if (entry === undefined) return;
    this.logins.delete(loginId);
    if (result === undefined) this.draftLogins.delete(loginId);
    await entry.started;
    let warning: string | undefined;
    if (result !== undefined && entry.kind === "saved") {
      try {
        await this.enqueueConfig(() => this.reloadProviders());
      } catch (e) {
        // 凭据已写入但 Runtime 仍用旧配置：结果照常推，附重载失败提示
        warning = e instanceof Error ? e.message : String(e);
      }
    }
    const params: LoginCompleted = { loginId };
    if (result !== undefined) {
      params.result = {
        providerId: result.providerId,
        ...(result.account !== undefined ? { account: result.account } : {}),
      };
    } else {
      // ProviderLoginError 只有固定文案；其他异常不能把授权内容带给客户端（同 safeLoginError）
      params.error =
        error instanceof ProviderLoginError
          ? { code: error.code, message: error.message }
          : { code: "failed", message: "登录未完成，请重新登录" };
    }
    if (entry.unstored.value !== undefined) {
      params.unstoredKey = entry.unstored.value;
      entry.unstored.value = undefined;
    }
    if (warning !== undefined) params.warning = warning;
    this.send({ jsonrpc: "2.0", method: "login.completed", params });
  }

  /** 请求失败时把敏感参数值从错误文本中抹掉（SENSITIVE_METHODS） */
  private redactSecrets(method: string, params: unknown, error: RpcErrorObject): RpcErrorObject {
    const extract = SENSITIVE_METHODS[method as RpcMethodName];
    if (extract === undefined) return error;
    const p =
      typeof params === "object" && params !== null && !Array.isArray(params)
        ? (params as Params)
        : {};
    const secrets = extract(p).filter((secret) => secret !== "");
    if (secrets.length === 0) return error;
    const redact = (text: string): string =>
      secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
    const data =
      error.data === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(error.data).map(([key, value]) => [
              key,
              typeof value === "string" ? redact(value) : value,
            ]),
          );
    return {
      code: error.code,
      message: redact(error.message),
      ...(data !== undefined ? { data } : {}),
    };
  }

  private session(p: Params): OpenSession {
    const sessionId = reqString(p, "sessionId");
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) {
      throw new RpcProtocolError("unknown_session", `没有打开的会话：${sessionId}`);
    }
    return entry;
  }

  /** 登记一个新打开的会话；服务端已在关闭时直接关掉它 */
  private async register(session: RuntimeSession, acquired = false): Promise<SessionOpened> {
    if (!acquired) this.hub.addSession(session);
    if (this.shuttingDown) {
      await this.hub.release(session.id).catch(() => undefined);
      throw new RpcProtocolError("shutting_down", "服务端正在关闭");
    }
    this.sessions.set(session.id, { session, unsubscribe: undefined, generation: 0 });
    const state = session.state();
    return {
      sessionId: session.id,
      meta: state.meta,
      config: state.config,
      warnings: [...session.warnings],
      ...(session.recovery !== undefined ? { recovery: session.recovery } : {}),
      lastSeq: state.lastSeq,
    };
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.opening.add(promise);
    const done = () => {
      this.opening.delete(promise);
    };
    promise.then(done, done);
    return promise;
  }

  // ── 订阅与回放 ───────────────────────────────────────────

  /**
   * 先挂监听并缓冲，再推 seq > afterSeq 的持久事件（分批，批间让出事件循环），
   * 之后按 seq 去重冲刷缓冲，再转实时（events.md 第 1 节、ADR-0044 第 5 节）。
   * 临时事件不回放，只有订阅之后发生的才会推。
   */
  private async subscribe(entry: OpenSession, afterSeq: number): Promise<number> {
    entry.unsubscribe?.();
    const generation = ++entry.generation;
    const sessionId = entry.session.id;
    const chunk = Math.max(1, this.options.replayChunkSize ?? DEFAULT_REPLAY_CHUNK);
    let lastSeq = afterSeq;
    let replaying = true;
    const buffer: RuntimeEvent[] = [];

    const push = (event: RuntimeEvent): void => {
      if (entry.generation !== generation) return;
      if ("seq" in event) {
        // 持久事件按 seq 去重：已在回放里推过的（含"已写日志、尚未分发给监听器"的）跳过
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
      }
      this.send({ jsonrpc: "2.0", method: "event", params: { sessionId, event } });
    };

    entry.unsubscribe = entry.session.subscribe((event) => {
      if (replaying) buffer.push(event);
      else push(event);
    });

    const snapshot = entry.session.durableEvents().filter((event) => event.seq > afterSeq);
    for (let i = 0; i < snapshot.length; i += chunk) {
      if (entry.generation !== generation) return lastSeq;
      for (const event of snapshot.slice(i, i + chunk)) push(event);
      if (i + chunk < snapshot.length) {
        await (this.options.replayYield?.() ?? new Promise<void>((r) => setImmediate(r)));
      }
    }
    replaying = false;
    for (const event of buffer.splice(0)) push(event);
    return lastSeq;
  }

  // ── 子会话只读观察 ────────────────────────────────────────

  private releaseSubagentWatch(watch: SubagentWatch): void {
    if (this.subagentWatches.get(watch.subscriptionId) === watch) {
      this.subagentWatches.delete(watch.subscriptionId);
    }
    const pair = subagentPairKey(watch.parentSessionId, watch.childSessionId);
    if (this.subagentPairs.get(pair) === watch.subscriptionId) this.subagentPairs.delete(pair);
  }

  private cancelSubagentWatch(watch: SubagentWatch): void {
    if (!watch.cancelled) {
      watch.cancelled = true;
      watch.controller.abort();
      watch.observation?.unsubscribe();
    }
    this.releaseSubagentWatch(watch);
  }

  private cancelSubagentWatches(match?: (watch: SubagentWatch) => boolean): void {
    for (const watch of [...this.subagentWatches.values()]) {
      if (match === undefined || match(watch)) this.cancelSubagentWatch(watch);
    }
  }

  private async subscribeSubagent(p: Params): Promise<RpcMethods["subagent.subscribe"]["result"]> {
    const parentSessionId = reqString(p, "parentSessionId");
    const childSessionId = reqString(p, "childSessionId");
    const subscriptionId = reqString(p, "subscriptionId");
    if (subscriptionId === "" || subscriptionId.length > 128) {
      throw new InvalidParamsError("subscriptionId 必须是 1 到 128 个字符的非空字符串");
    }
    const afterSeq = optInt(p, "afterSeq");
    if (afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
      throw new InvalidParamsError("afterSeq 必须是非负整数");
    }
    if (this.subagentWatches.has(subscriptionId)) {
      throw new InvalidParamsError("subscriptionId 已在使用");
    }
    if (this.shuttingDown || this.closed) {
      throw new RpcProtocolError("shutting_down", "服务端正在关闭");
    }
    // 同一 (parent, child) 再订阅替换旧观察；其他 child 与其他连接互不影响
    const pair = subagentPairKey(parentSessionId, childSessionId);
    const previous = this.subagentPairs.get(pair);
    const previousWatch = previous === undefined ? undefined : this.subagentWatches.get(previous);
    if (previousWatch !== undefined) this.cancelSubagentWatch(previousWatch);

    const watch: SubagentWatch = {
      subscriptionId,
      parentSessionId,
      childSessionId,
      controller: new AbortController(),
      observation: undefined,
      cancelled: false,
      ended: false,
    };
    this.subagentWatches.set(subscriptionId, watch);
    this.subagentPairs.set(pair, subscriptionId);
    const cancelled = (): RpcProtocolError =>
      new RpcProtocolError("subscription_cancelled", "子会话观察已被取消或替换");
    try {
      const observation = await this.runtime().observeSubagent(
        {
          parentSessionId,
          childSessionId,
          ...(afterSeq !== undefined ? { afterSeq } : {}),
          signal: watch.controller.signal,
        },
        {
          onEvent: (event) => {
            if (watch.cancelled || watch.ended || event.sessionId !== childSessionId) return;
            this.send({
              jsonrpc: "2.0",
              method: "subagent.event",
              params: { subscriptionId, parentSessionId, childSessionId, event },
            });
          },
          onEnd: (end) => {
            if (watch.cancelled || watch.ended) return;
            watch.ended = true;
            this.send({
              jsonrpc: "2.0",
              method: "subagent.closed",
              params: { subscriptionId, parentSessionId, childSessionId, end },
            });
            // 自然 closed 后释放表项
            this.releaseSubagentWatch(watch);
          },
        },
      );
      if (watch.cancelled) {
        // 建立期间被撤销：返回的观察不得复活
        observation.unsubscribe();
        throw cancelled();
      }
      watch.observation = observation;
      return {
        lastSeq: observation.lastSeq,
        summary: observation.summary,
        mode: observation.mode,
      };
    } catch (error) {
      if (watch.cancelled) throw cancelled();
      this.cancelSubagentWatch(watch);
      if (error instanceof SessionError && error.code === "invalid_after_seq") {
        throw new InvalidParamsError(error.message);
      }
      throw error;
    }
  }

  // ── 方法表 ───────────────────────────────────────────────

  private buildHandlers(): HandlerTable {
    const remote = (): RemoteHost => {
      if (!this.remote)
        throw new RpcProtocolError("remote_unavailable", "服务端未提供远程主机功能");
      return this.remote;
    };
    return {
      "remote.describe": () => remote().describe(),
      "remote.register": (p) => remote().register(reqString(p, "invite")),
      "remote.unregister": () => remote().unregister(),
      "remote.setEnabled": (p) => {
        const enabled = optBool(p, "enabled");
        if (enabled === undefined) throw new InvalidParamsError("enabled 必须是布尔值");
        return remote().setEnabled(enabled);
      },
      "remote.startPairing": () => remote().startPairing(),
      "remote.cancelPairing": () => remote().cancelPairing(),
      "remote.removeDevice": (p) => remote().removeDevice(reqString(p, "id")),
      "remote.disconnectDevice": (p) => remote().disconnectDevice(reqString(p, "id")),
      "remote.push": () => remote().push(),
      initialize: async (p) => {
        if (this.initPromise !== undefined) {
          throw new RpcProtocolError("already_initialized", "initialize 只能调用一次");
        }
        const version = reqInt(p, "protocolVersion");
        if (version !== RPC_PROTOCOL_VERSION) {
          throw new RpcProtocolError(
            "protocol_version_mismatch",
            `协议版本不一致：客户端 ${version}，服务端 ${RPC_PROTOCOL_VERSION}`,
          );
        }
        const clientName = reqString(p, "clientName");
        const interactive = optBool(reqObject(p, "capabilities"), "interactive") ?? false;
        if (this.origin === "remote" && !this.hub.available) {
          throw new RpcProtocolError(
            "runtime_unavailable",
            "本机连接尚未完成握手，Runtime 不可用；可稍后重试",
          );
        }
        const init = (
          this.origin === "local"
            ? this.options.createRuntime({ clientName, interactive })
            : Promise.resolve(undefined)
        )
          .then(async (handle) => {
            if (handle !== undefined) this.hub.setHandle(handle);
            this.initialized = true;
            if (this.origin === "local" && !this.hub.stopping) await this.remote?.start();
          })
          .catch((error: unknown) => {
            // 创建失败：允许客户端修正后重试
            this.initPromise = undefined;
            throw error;
          });
        this.initPromise = init;
        await init;
        return {
          protocolVersion: RPC_PROTOCOL_VERSION,
          nocturneVersion: this.options.nocturneVersion,
          ...(this.hub.sessionsDir !== undefined ? { sessionsDir: this.hub.sessionsDir } : {}),
        };
      },
      shutdown: async () => {
        await this.cleanup();
        return null;
      },

      "runtime.listSessions": (p) => {
        const cwd = optString(p, "cwd");
        const includeSubagents = optBool(p, "includeSubagents");
        return this.runtime().listSessions({
          ...(cwd !== undefined ? { cwd } : {}),
          ...(includeSubagents !== undefined ? { includeSubagents } : {}),
        });
      },
      "runtime.usageStats": (p) => {
        const days = p.days;
        if (
          days !== undefined &&
          (typeof days !== "number" || !Number.isInteger(days) || days <= 0)
        )
          throw new InvalidParamsError("days 必须是正整数");
        return this.runtime().usageStats(days === undefined ? {} : { days });
      },
      "runtime.createSession": (p) =>
        this.track(
          (async () => {
            const options: CreateSessionOptions = { model: reqModel(p, "model") };
            const preset = optString(p, "permissionPreset");
            if (preset !== undefined) options.permissionPreset = preset;
            const effort = optString(p, "reasoningEffort");
            if (effort !== undefined) {
              if (!isReasoningEffort(effort)) {
                throw new InvalidParamsError(`reasoningEffort 不是已知档位：${effort}`);
              }
              options.reasoningEffort = effort;
            }
            // 会话级工作区（ADR-0051）：单后台模式下客户端按会话传 cwd
            const sessionCwd = optString(p, "cwd");
            if (sessionCwd !== undefined) options.cwd = sessionCwd;
            const sessionRoot = optString(p, "workspaceRoot");
            if (sessionRoot !== undefined) options.workspaceRoot = sessionRoot;
            const opened = await this.register(await this.runtime().createSession(options));
            this.hub.notifySessionsChanged();
            return opened;
          })(),
        ),
      "runtime.resumeSession": (p) =>
        this.track(
          (async () => {
            const sessionId = reqString(p, "sessionId");
            if (this.sessions.has(sessionId) || this.openingIds.has(sessionId)) {
              throw new RpcProtocolError(
                "session_already_open",
                `会话已在本连接中打开：${sessionId}`,
              );
            }
            const force = optBool(p, "force");
            const model =
              p.model === undefined || p.model === null ? undefined : reqModel(p, "model");
            this.openingIds.add(sessionId);
            try {
              const session = await this.hub.resume(sessionId, {
                ...(force !== undefined ? { force } : {}),
                ...(model !== undefined ? { model } : {}),
              });
              return await this.register(session, true);
            } finally {
              this.openingIds.delete(sessionId);
            }
          })(),
        ),
      "runtime.forkSession": async (p) => {
        const targetSeq = optInt(p, "targetSeq");
        const sessionId = await this.runtime().forkSession(reqString(p, "sessionId"), {
          ...(targetSeq !== undefined ? { targetSeq } : {}),
        });
        this.hub.notifySessionsChanged();
        return { sessionId };
      },
      "runtime.listModels": async (p) => {
        const includeDisabled = optBool(p, "includeDisabled");
        return this.runtime().listModels({
          workspaceRoot: await this.workspaceOf(p),
          ...(includeDisabled !== undefined ? { includeDisabled } : {}),
        });
      },
      "runtime.defaultModel": async (p) =>
        this.runtime().defaultModel({ workspaceRoot: await this.workspaceOf(p) }) ?? null,
      "runtime.listRecentModels": () => this.runtime().listRecentModels(),
      "runtime.describeSettings": async (p) =>
        this.runtime().describeSettings({ workspaceRoot: await this.workspaceOf(p) }),
      "runtime.listShells": async (p) =>
        this.runtime().listShells({ workspaceRoot: await this.workspaceOf(p) }),
      // 不在 REMOTE_METHODS：只服务本机面板（ADR-0060），远程调用报 remote_not_allowed
      "runtime.readFile": async (p) => {
        const file = await this.runtime().readFile(reqString(p, "path"));
        if (file.kind === "text") return file;
        return { ...file, data: Buffer.from(file.data).toString("base64") };
      },
      "runtime.setShellSetting": async (p) =>
        this.runtime().setShellSetting(reqString(p, "kind"), {
          workspaceRoot: await this.workspaceOf(p),
        }),
      "runtime.updateSettings": async (p) => {
        const reviewerKey = optString(p, "reviewerKey");
        const workspaceRoot = await this.workspaceOf(p);
        return this.runtime().updateSettings(
          reqObject(p, "patch") as SettingsPatch,
          reviewerKey !== undefined || workspaceRoot !== undefined
            ? {
                ...(reviewerKey !== undefined ? { reviewerKey } : {}),
                ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
              }
            : undefined,
        );
      },
      "runtime.setDefaultModel": async (p) => {
        const effort = optString(p, "reasoningEffort");
        if (effort !== undefined && !isReasoningEffort(effort)) {
          throw new InvalidParamsError(`reasoningEffort 不是已知档位：${effort}`);
        }
        const workspaceRoot = await this.workspaceOf(p);
        return this.runtime().setDefaultModel(
          reqString(p, "model"),
          effort ?? null,
          workspaceRoot !== undefined ? { workspaceRoot } : undefined,
        );
      },
      "runtime.describeModelRoles": async (p) =>
        this.runtime().describeModelRoles({ workspaceRoot: await this.workspaceOf(p) }),
      "runtime.setModelRole": async (p) => {
        const role = reqString(p, "role");
        if (!(MODEL_ROLES as readonly string[]).includes(role)) {
          throw new InvalidParamsError(`role 必须是 ${MODEL_ROLES.join("/")} 之一`);
        }
        const workspaceRoot = await this.workspaceOf(p);
        return this.runtime().setModelRole(
          role as ModelRole,
          optString(p, "ref") ?? null,
          workspaceRoot !== undefined ? { workspaceRoot } : undefined,
        );
      },
      "runtime.getPreference": (p) => this.runtime().getPreference(reqString(p, "key")) ?? null,
      "runtime.setPreference": async (p) => {
        await this.runtime().setPreference(reqString(p, "key"), optString(p, "value"));
        return null;
      },
      "runtime.listReviewerProviders": async (p) =>
        this.runtime().listReviewerProviders({ workspaceRoot: await this.workspaceOf(p) }),
      // 与配置变更方法走同一串行队列；完成后照常推 providersChanged。多后台客户端
      // 不能再拿这条通知去触发别处的 reloadConfig，否则成环（rpc.md 3.1）
      "runtime.reloadConfig": async () => {
        await this.enqueueConfig(() => this.reloadProviders());
        return null;
      },
      "mcp.describeMcpServers": (p) => this.runtime().describeMcpServers(p),
      "agents.describeExternalAgents": (p) =>
        this.runtime().describeExternalAgents({ workspaceRoot: optString(p, "workspaceRoot") }),
      "agents.saveExternalAgent": (p) =>
        this.enqueueConfig(async () => {
          const result = await this.runtime().saveExternalAgent(
            p as unknown as Parameters<Runtime["saveExternalAgent"]>[0],
          );
          this.hub.notifyProvidersChanged();
          return result;
        }),
      "agents.deleteExternalAgent": (p) =>
        this.enqueueConfig(async () => {
          await this.runtime().deleteExternalAgent({ name: reqString(p, "name") });
          this.hub.notifyProvidersChanged();
          return null;
        }),
      "agents.setExternalAgentEnabled": (p) =>
        this.enqueueConfig(async () => {
          const enabled = optBool(p, "enabled");
          if (enabled === undefined) throw new InvalidParamsError("enabled 必须是布尔值");
          await this.runtime().setExternalAgentEnabled({ name: reqString(p, "name"), enabled });
          this.hub.notifyProvidersChanged();
          return null;
        }),
      "agents.probeExternalAgent": (p) =>
        this.runtime().probeExternalAgent(
          p as unknown as Parameters<Runtime["probeExternalAgent"]>[0],
        ),
      "session.describeExternalAgents": (p) => this.session(p).session.describeExternalAgents(),
      "skills.describeSkills": (p) =>
        this.runtime().describeSkills({ workspaceRoot: optString(p, "workspaceRoot") }),
      "skills.setSkillEnabled": (p) => {
        const enabled = optBool(p, "enabled");
        if (enabled === undefined) throw new InvalidParamsError("enabled 必须是布尔值");
        return this.enqueueConfig(async () => {
          const result = await this.runtime().setSkillEnabled({
            name: reqString(p, "name"),
            enabled,
          });
          this.hub.notifyProvidersChanged();
          return result;
        });
      },
      "skills.importSkills": (p) => {
        const mode = reqString(p, "mode");
        if (mode === "preview") {
          const workspaceRoot = optString(p, "workspaceRoot");
          return this.runtime().importSkills({
            mode: "preview",
            sourceDir: reqString(p, "sourceDir"),
            target: parseImportTarget(p),
            ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
          });
        }
        if (mode === "commit") {
          const workspaceRoot = optString(p, "workspaceRoot");
          return this.enqueueConfig(async () => {
            const result = await this.runtime().importSkills({
              mode: "commit",
              target: parseImportTarget(p),
              ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
              decisions: parseImportDecisions(p),
            });
            this.hub.notifyProvidersChanged();
            return result;
          });
        }
        throw new InvalidParamsError("mode 必须是 preview 或 commit");
      },
      "session.describeSkills": (p) => this.session(p).session.describeSkills(),
      "mcp.saveMcpServer": (p) =>
        this.mutateAndReload(
          () =>
            this.runtime().saveMcpServer(p as unknown as Parameters<Runtime["saveMcpServer"]>[0]),
          false,
        ),
      "mcp.deleteMcpServer": (p) =>
        this.mutateAndReload(async () => {
          await this.runtime().deleteMcpServer(
            p as unknown as Parameters<Runtime["deleteMcpServer"]>[0],
          );
          return null;
        }, false),
      "mcp.setMcpServerEnabled": (p) =>
        this.mutateAndReload(async () => {
          await this.runtime().setMcpServerEnabled(
            p as unknown as Parameters<Runtime["setMcpServerEnabled"]>[0],
          );
          return null;
        }, false),
      "mcp.probeMcpServer": (p) =>
        this.runtime().probeMcpServer(p as unknown as Parameters<Runtime["probeMcpServer"]>[0]),
      "schedule.list": () => this.runtime().listSchedules(),
      "schedule.save": (p) =>
        this.runtime().saveSchedule(p as unknown as Parameters<Runtime["saveSchedule"]>[0]),
      "schedule.delete": async (p) => {
        await this.runtime().deleteSchedule({ id: reqString(p, "id") });
        return null;
      },
      "schedule.runNow": (p) => this.runtime().runSchedule({ id: reqString(p, "id") }),
      "schedule.history": (p) => this.runtime().scheduleHistory({ id: reqString(p, "id") }),
      "runtime.defaultReviewer": async (p) => {
        const baseURL = optString(p, "baseURL");
        const workspaceRoot = await this.workspaceOf(p);
        return this.runtime().defaultReviewer(
          reqString(p, "endpoint") as JevEndpoint,
          baseURL,
          workspaceRoot !== undefined ? { workspaceRoot } : undefined,
        );
      },
      "runtime.listReviewerSamples": () => this.runtime().listReviewerSamples(),
      "runtime.testReviewerSample": async (p) => {
        const workspaceRoot = await this.workspaceOf(p);
        return this.runtime().testReviewerSample(
          reqString(p, "sampleId"),
          this.abort.signal,
          workspaceRoot !== undefined ? { workspaceRoot } : undefined,
        );
      },
      "runtime.listReviewerModels": async (p) => {
        const workspaceRoot = await this.workspaceOf(p);
        return this.runtime().listReviewerModels(
          reqObject(p, "reviewer") as unknown as JevReviewerConfig,
          this.abort.signal,
          workspaceRoot !== undefined ? { workspaceRoot } : undefined,
        );
      },

      // 服务商配置（rpc.md 3.3）：只读方法用最近一次重载出的配置对象；
      // Core 的预设/凭据判断不在此复制，RPC 层只做形状校验与转发。
      "provider.listProviderPresets": () => {
        this.providerConfig();
        return listProviderPresets();
      },
      "provider.describeProviders": async (p) => {
        const { current, workspaceRoot } = this.providerConfig();
        const providers = await current.describeProviders(
          (await this.workspaceOf(p)) ?? workspaceRoot,
        );
        const setupWarning = current.providerSetupWarning;
        return {
          providers,
          ...(setupWarning !== undefined ? { setupWarning } : {}),
        };
      },
      "provider.describeProviderSetup": (p) =>
        describeProviderSetup(this.providerConfig().current, reqString(p, "presetId")),
      "provider.describeAccountStorage": (p) => {
        const { current } = this.providerConfig();
        const providerId = reqString(p, "providerId");
        const entry = current.base.providers.find((item) => item.id === providerId);
        return describeAccountStorage(current, entry ?? {}) ?? null;
      },
      "provider.prepareProvider": async (p) => {
        const input = parsePrepareInput(p);
        // 引用本连接草稿登录时用该登录创建时的配置对象：Core 的暂存凭据
        // 按 RuntimeConfig 对象登记，重载出的新对象上找不到它
        let config = this.providerConfig().current;
        if (input.credential.kind === "login") {
          config = this.draftLogins.get(input.credential.loginId) ?? config;
        }
        const result = await prepareProvider(config, input, {
          signal: this.abort.signal,
          workspaceRoot: this.providerConfig().workspaceRoot,
        });
        this.providerDrafts.set(result.draftId, {
          config,
          ...(input.credential.kind === "login" ? { loginId: input.credential.loginId } : {}),
        });
        return result;
      },
      "provider.commitProvider": async (p) => {
        const draftId = reqString(p, "draftId");
        const manualModelId = optString(p, "manualModelId");
        return await this.mutateAndReload(async () => {
          const record = this.providerDrafts.get(draftId);
          const config = record?.config ?? this.providerConfig().current;
          const result = await commitProvider(
            config,
            draftId,
            manualModelId !== undefined ? { manualModelId } : {},
          );
          // 只在保存成功后移除草稿记录（Core 侧草稿随之失效）；失败可重试
          this.providerDrafts.delete(draftId);
          if (record?.loginId !== undefined) this.draftLogins.delete(record.loginId);
          return result;
        });
      },
      "provider.discardProvider": (p) => {
        const draftId = reqString(p, "draftId");
        const record = this.providerDrafts.get(draftId);
        discardProvider(record?.config ?? this.providerConfig().current, draftId);
        this.providerDrafts.delete(draftId);
        return null;
      },
      "provider.setCredential": async (p) => {
        const providerId = reqString(p, "providerId");
        const key = reqString(p, "key");
        return await this.mutateAndReload(async (config) => {
          await config.setCredential(providerId, key);
          return null;
        });
      },
      "provider.listModelSettings": async (p) => {
        const { current, workspaceRoot } = this.providerConfig();
        return current.listModelSettings(
          reqString(p, "providerId"),
          (await this.workspaceOf(p)) ?? workspaceRoot,
        );
      },
      "provider.saveModelSettings": async (p) => {
        const providerId = reqString(p, "providerId");
        const modelId = reqString(p, "modelId");
        const patch = reqObject(p, "patch");
        const workspaceRoot = await this.workspaceOf(p);
        return await this.mutateAndReload(async (config) => {
          await config.saveModelSettings(
            providerId,
            modelId,
            patch,
            workspaceRoot ?? this.providerConfig().workspaceRoot,
          );
          return null;
        });
      },
      "provider.refreshUpstreamLimits": async (p) => {
        const providerId = reqString(p, "providerId");
        return await this.mutateAndReload(async (config) => ({
          warning: (await config.refreshUpstreamLimits(providerId)) ?? null,
        }));
      },
      "provider.refreshModelsDev": async () =>
        await this.mutateAndReload(async (config) => ({
          warning: (await config.refreshModelsDev()) ?? null,
        })),
      "provider.removeSetupProvider": async (p) => {
        const providerId = reqString(p, "providerId");
        return await this.mutateAndReload(async (config) => {
          // "正在使用拒绝删除"是客户端规则（同 CLI/TUI）；服务端持有会话，
          // 所以在服务端对后台全部已打开会话判断——Core 不判断这条
          for (const session of this.hub.openSessions()) {
            if (session.state().config.model.provider === providerId) {
              throw new RpcProtocolError(
                "provider_in_use",
                `当前会话正在使用 ${providerId}，不能删除；先切换到其他服务商的模型`,
              );
            }
          }
          await config.removeSetupProvider(providerId);
          return null;
        });
      },
      "provider.logoutProvider": async (p) => {
        const providerId = reqString(p, "providerId");
        return await this.mutateAndReload(async (config) => {
          await logoutProvider(config, providerId);
          return null;
        });
      },
      // 编辑自定义服务商（U-07）：条目原文只含配置形状，凭据不经此返回
      "provider.describeSetupProvider": async (p) =>
        (await this.providerConfig().current.describeSetupProvider(reqString(p, "providerId"))) ??
        null,
      "provider.probeSetupProviderModels": async (p) => {
        const type = reqString(p, "type");
        if (type !== "openai-compatible" && type !== "anthropic") {
          throw new InvalidParamsError(`type 必须是 openai-compatible 或 anthropic`);
        }
        const headers = p.headers;
        if (
          headers !== undefined &&
          (typeof headers !== "object" || headers === null || Array.isArray(headers))
        ) {
          throw new InvalidParamsError("headers 必须是对象");
        }
        if (headers !== undefined) {
          for (const [name, value] of Object.entries(headers)) {
            if (typeof value !== "string") {
              throw new InvalidParamsError(`headers.${name} 必须是字符串`);
            }
          }
        }
        const models = await probeSetupProviderModels(
          this.providerConfig().current,
          {
            providerId: reqString(p, "providerId"),
            type,
            ...(optString(p, "baseURL") !== undefined ? { baseURL: optString(p, "baseURL") } : {}),
            ...(headers !== undefined ? { headers: headers as Record<string, string> } : {}),
          },
          { signal: this.abort.signal },
        );
        return { models };
      },
      "provider.updateSetupProvider": async (p) => {
        const providerId = reqString(p, "providerId");
        const patch = parseUpdatePatch(reqObject(p, "patch"));
        return await this.mutateAndReload(async (config) =>
          updateSetupProvider(config, providerId, patch),
        );
      },
      // 服务商/模型启停（ADR-0054 §3）：写 settings.json 专用字段，不重载配置
      // （写入落在当前配置对象的 settings store，registry 随 providersChanged 重建）
      "provider.setProviderEnabled": (p) => {
        const enabled = optBool(p, "enabled");
        if (enabled === undefined) throw new InvalidParamsError("enabled 必须是布尔值");
        return this.enqueueConfig(async () => {
          await this.runtime().setProviderEnabled({ provider: reqString(p, "provider"), enabled });
          this.hub.notifyProvidersChanged();
          return null;
        });
      },
      "provider.setModelsEnabled": (p) => {
        const enabled = optBool(p, "enabled");
        if (enabled === undefined) throw new InvalidParamsError("enabled 必须是布尔值");
        const models = p.models;
        if (
          !Array.isArray(models) ||
          models.length === 0 ||
          models.some((model) => typeof model !== "string" || model.trim() === "")
        )
          throw new InvalidParamsError("models 必须是非空字符串数组");
        return this.enqueueConfig(async () => {
          await this.runtime().setModelsEnabled({
            provider: reqString(p, "provider"),
            models: models as string[],
            enabled,
          });
          this.hub.notifyProvidersChanged();
          return null;
        });
      },
      "provider.describeToggleImpact": (p) => {
        const models = p.models;
        if (
          models !== undefined &&
          (!Array.isArray(models) ||
            models.some((model) => typeof model !== "string" || model.trim() === ""))
        )
          throw new InvalidParamsError("models 必须是字符串数组");
        return this.runtime().describeToggleImpact({
          provider: reqString(p, "provider"),
          ...(models !== undefined ? { models: models as string[] } : {}),
        });
      },

      // 登录会话（rpc.md 3.4）：start 返回句柄，完成经 login.completed 通知
      "login.start": async (p) => {
        const { current } = this.providerConfig();
        const unstored: LoginEntry["unstored"] = { value: undefined };
        const session = await startProviderLogin(
          current,
          reqString(p, "providerId"),
          this.loginOptions(p, unstored),
        );
        // 已保存服务商的 loginId 由服务端生成（rpc.md 3.4）
        const loginId = randomUUID();
        this.registerLogin(loginId, "saved", current, session, unstored);
        return this.loginStarted(loginId, session);
      },
      "login.startDraft": async (p) => {
        const { current } = this.providerConfig();
        const name = reqString(p, "name");
        const baseURL = optString(p, "baseURL");
        const unstored: LoginEntry["unstored"] = { value: undefined };
        const session = await startDraftProviderLogin(
          current,
          {
            presetId: reqString(p, "presetId"),
            name,
            ...(baseURL !== undefined ? { baseURL } : {}),
          },
          this.loginOptions(p, unstored),
        );
        // 草稿登录沿用 Core 分配的 loginId——暂存凭据按它登记
        const loginId = session.loginId;
        this.draftLogins.set(loginId, current);
        this.registerLogin(loginId, "draft", current, session, unstored);
        return this.loginStarted(loginId, session);
      },
      "login.submitManual": async (p) => {
        this.providerConfig();
        const entry = this.logins.get(reqString(p, "loginId"));
        if (entry === undefined) {
          throw new RpcProtocolError("unknown_login", "登录会话不存在或已结束");
        }
        await entry.session.submitManual(reqString(p, "text"));
        return null;
      },
      "login.cancel": (p) => {
        this.providerConfig();
        const loginId = reqString(p, "loginId");
        const entry = this.logins.get(loginId);
        if (entry !== undefined) {
          // 进行中：取消后照常推带 cancelled 错误的 login.completed
          entry.session.cancel();
          return null;
        }
        const draftConfig = this.draftLogins.get(loginId);
        if (draftConfig !== undefined) {
          // 已完成但未提交的草稿登录：丢弃暂存凭据，不推通知
          discardDraftLogin(draftConfig, loginId);
          this.draftLogins.delete(loginId);
          return null;
        }
        throw new RpcProtocolError("unknown_login", "登录会话不存在或已结束");
      },

      // 不在 REMOTE_METHODS：只服务本机面板（ADR-0060 第 4 轮），远程在 Core 调用前被拒
      "subagent.list": (p) =>
        this.runtime().listSubagents({ parentSessionId: reqString(p, "parentSessionId") }),
      "subagent.readAttachment": async (p) => {
        const attachment = await this.runtime().readSubagentAttachment({
          parentSessionId: reqString(p, "parentSessionId"),
          childSessionId: reqString(p, "childSessionId"),
          file: reqString(p, "file"),
        });
        return {
          data: Buffer.from(attachment.data).toString("base64"),
          mimeType: attachment.mimeType,
          bytes: attachment.bytes,
        };
      },
      "subagent.subscribe": (p) => this.subscribeSubagent(p),
      "subagent.unsubscribe": (p) => {
        const watch = this.subagentWatches.get(reqString(p, "subscriptionId"));
        if (watch !== undefined) this.cancelSubagentWatch(watch);
        return null;
      },
      "session.subscribe": async (p) => {
        const entry = this.session(p);
        const lastSeq = await this.subscribe(entry, optInt(p, "afterSeq") ?? 0);
        return { lastSeq };
      },
      "session.interrupt": (p) => {
        this.interrupt(p);
        return null;
      },
      "session.unsubscribe": (p) => {
        const entry = this.session(p);
        entry.generation++;
        entry.unsubscribe?.();
        entry.unsubscribe = undefined;
        return null;
      },
      "session.readAttachment": async (p) => {
        const attachment = await this.session(p).session.readAttachment(reqString(p, "file"));
        if (
          this.origin === "remote" &&
          attachment.bytes > remoteAttachmentLimit(this.remoteLimit)
        ) {
          throw new RpcProtocolError("attachment_too_large", "图片过大，请在电脑上查看");
        }
        return {
          data: Buffer.from(attachment.data).toString("base64"),
          mimeType: attachment.mimeType,
          bytes: attachment.bytes,
        };
      },
      "session.submit": async (p) => {
        const { session } = this.session(p);
        const input: SubmitInput = {};
        if (p.skill !== undefined) {
          const skill = reqObject(p, "skill");
          input.skill = {
            name: reqString(skill, "name"),
            arguments: optString(skill, "arguments"),
          };
        }
        if (p.delegate !== undefined) {
          const delegate = reqObject(p, "delegate");
          input.delegate = {
            agent: reqString(delegate, "agent"),
            task: reqString(delegate, "task"),
          };
        }
        const text = optString(p, "text");
        if (text !== undefined) input.text = text;
        if (p.content !== undefined && p.content !== null) {
          input.content = parseContent(p.content);
        }
        if (p.attachments !== undefined && p.attachments !== null) {
          input.attachments = parseAttachments(p.attachments);
        }
        return await this.hub.operate(session, () => session.submit(input));
      },
      "session.respondPermission": async (p) => {
        await this.session(p).session.respondPermission(
          reqString(p, "requestId"),
          reqObject(p, "reply") as unknown as PermissionReply,
        );
        return null;
      },
      "session.respondQuestion": async (p) => {
        await this.session(p).session.respondQuestion(
          reqString(p, "requestId"),
          reqObject(p, "reply") as unknown as QuestionReply,
        );
        return null;
      },
      "session.setModel": async (p) => {
        await this.session(p).session.setModel(reqModel(p, "model"));
        return null;
      },
      "session.setPermissionPreset": async (p) => {
        await this.session(p).session.setPermissionPreset(reqString(p, "name"));
        return null;
      },
      "session.setReasoningEffort": async (p) => {
        await this.session(p).session.setReasoningEffort(reqString(p, "level"));
        return null;
      },
      "session.setShell": async (p) => {
        await this.session(p).session.setShell(reqString(p, "kind"));
        return null;
      },
      "session.compact": async (p) => {
        const { session } = this.session(p);
        await this.hub.operate(session, () => session.compact());
        return null;
      },
      "session.rewindTargets": (p) => this.session(p).session.rewindTargets(),
      "session.turnChanges": (p) => this.session(p).session.turnChanges(),
      "session.turnChangeDiff": (p) => {
        const seq = reqInt(p, "seq");
        const path = reqString(p, "path");
        if (!Number.isSafeInteger(seq) || seq < 1 || !path.trim())
          throw new InvalidParamsError("seq 必须是正整数，path 不能为空");
        return this.session(p).session.turnChangeDiff(seq, path);
      },
      "session.rewind": (p) => {
        const mode = reqString(p, "mode");
        const { session } = this.session(p);
        return this.hub.operate(session, () =>
          session.rewind(reqInt(p, "targetSeq"), mode as RewindMode),
        );
      },
      "session.state": (p) => {
        const state = this.session(p).session.state();
        return {
          meta: state.meta,
          config: state.config,
          todos: state.todos,
          usage: state.usage,
          lastSeq: state.lastSeq,
          openTurn: state.openTurn,
        };
      },
      "session.describeContext": (p) => {
        const built = this.session(p).session.describeContext();
        return {
          report: built.report,
          overBudget: built.overBudget,
          mustCompact: built.mustCompact,
          ...(built.compaction !== undefined ? { compaction: built.compaction } : {}),
          ...(built.missingAttachments !== undefined
            ? { missingAttachments: built.missingAttachments }
            : {}),
        };
      },
      "session.reasoningEffortInfo": (p) => this.session(p).session.reasoningEffortInfo(),
      "session.shellInfo": (p) => this.session(p).session.shellInfo(),
      "session.listShells": (p) => this.session(p).session.listShells(),
      "session.visionInfo": (p) => this.session(p).session.visionInfo(),
      "session.mcpServers": (p) => this.session(p).session.mcpServers(),
      "session.fileIndex": (p) => this.session(p).session.fileIndex(),
      "session.resolveFiles": (p) => {
        const paths: unknown = p.paths;
        if (!Array.isArray(paths) || paths.some((item: unknown) => typeof item !== "string")) {
          throw new InvalidParamsError("paths 必须是非空字符串数组");
        }
        return this.session(p).session.resolveFiles(paths as string[]);
      },
      "session.readInputHistory": (p) => this.session(p).session.readInputHistory(),
      "session.recordInputHistory": async (p) => {
        await this.session(p).session.recordInputHistory(reqString(p, "text"));
        return null;
      },
      "session.close": async (p) => {
        const entry = this.session(p);
        this.sessions.delete(entry.session.id);
        entry.generation++;
        entry.unsubscribe?.();
        // 父会话关闭：以它为 parent 的子会话观察一并撤销
        this.cancelSubagentWatches((watch) => watch.parentSessionId === entry.session.id);
        await this.hub.release(entry.session.id);
        return null;
      },
    };
  }
}

const subagentPairKey = (parentSessionId: string, childSessionId: string): string =>
  `${parentSessionId}\u0000${childSessionId}`;

/** skills.importSkills 的 target：只有用户级与项目两处 */
function parseImportTarget(p: Params): "user" | "project" {
  const target = p.target;
  if (target !== "user" && target !== "project") {
    throw new InvalidParamsError("target 必须是 user 或 project");
  }
  return target;
}

/** skills.importSkills commit 的逐项决定：至少一项，action 逐项校验 */
function parseImportDecisions(
  p: Params,
): { sourcePath: string; name?: string; action: "rename" | "overwrite" | "skip" }[] {
  const decisions = p.decisions;
  if (!Array.isArray(decisions) || decisions.length === 0) {
    throw new InvalidParamsError("decisions 必须是非空数组");
  }
  return decisions.map((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new InvalidParamsError(`decisions[${i}] 必须是对象`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.sourcePath !== "string" || record.sourcePath === "") {
      throw new InvalidParamsError(`decisions[${i}].sourcePath 必须是非空字符串`);
    }
    const action = record.action;
    if (action !== "rename" && action !== "overwrite" && action !== "skip") {
      throw new InvalidParamsError(`decisions[${i}].action 必须是 rename、overwrite 或 skip`);
    }
    if (record.name !== undefined && typeof record.name !== "string") {
      throw new InvalidParamsError(`decisions[${i}].name 必须是字符串`);
    }
    return {
      sourcePath: record.sourcePath,
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      action,
    };
  });
}

/** provider.updateSetupProvider 的 patch 形状：逐字段校验，未提供的保留原值 */
function parseUpdatePatch(p: Params): UpdateSetupProviderPatch {
  const patch: UpdateSetupProviderPatch = {};
  for (const key of ["displayName", "baseURL", "sessionHeader"] as const) {
    const value = p[key];
    if (value !== undefined) {
      if (typeof value !== "string") throw new InvalidParamsError(`patch.${key} 必须是字符串`);
      patch[key] = value;
    }
  }
  const type = p.type;
  if (type !== undefined) {
    if (type !== "openai-compatible" && type !== "anthropic") {
      throw new InvalidParamsError(`patch.type 必须是 openai-compatible 或 anthropic`);
    }
    patch.type = type;
  }
  const headers = p.headers;
  if (headers !== undefined) {
    if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
      throw new InvalidParamsError("patch.headers 必须是对象");
    }
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== "string") {
        throw new InvalidParamsError(`patch.headers.${name} 必须是字符串`);
      }
    }
    patch.headers = headers as Record<string, string>;
  }
  const models = p.models;
  if (models !== undefined) {
    if (!Array.isArray(models)) throw new InvalidParamsError("patch.models 必须是数组");
    for (const m of models) {
      if (typeof m !== "object" || m === null || typeof (m as { id?: unknown }).id !== "string") {
        throw new InvalidParamsError("patch.models 的每一项必须带字符串 id");
      }
    }
    patch.models = models as UpdateSetupProviderPatch["models"];
  }
  return patch;
}

/** provider.prepareProvider 的入参形状：presetId 必填，其余字段按 credential.kind 判别 */
function parsePrepareInput(p: Params): AddProviderInput {
  const input: AddProviderInput = {
    presetId: reqString(p, "presetId"),
    credential: parseCredential(p.credential),
  };
  const name = optString(p, "name");
  if (name !== undefined) input.name = name;
  const baseURL = optString(p, "baseURL");
  if (baseURL !== undefined) input.baseURL = baseURL;
  const sessionHeader = optString(p, "sessionHeader");
  if (sessionHeader !== undefined) input.sessionHeader = sessionHeader;
  return input;
}

function parseCredential(value: unknown): ProviderCredentialInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidParamsError("参数 credential 必须是对象");
  }
  const o = value as Params;
  switch (o.kind) {
    case "apiKey":
      return { kind: "apiKey", key: reqString(o, "key") };
    case "env":
      return { kind: "env", name: reqString(o, "name") };
    case "login":
      return { kind: "login", loginId: reqString(o, "loginId") };
    case "external-file":
      return { kind: "external-file" };
    default:
      throw new InvalidParamsError("credential.kind 必须是 apiKey/env/login/external-file 之一");
  }
}

function parseContent(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) throw new InvalidParamsError("content 必须是数组");
  for (const block of value) {
    if (
      typeof block !== "object" ||
      block === null ||
      typeof (block as { type?: unknown }).type !== "string"
    ) {
      throw new InvalidParamsError("content 的每一项必须是带 type 的对象");
    }
  }
  return value as ContentBlock[];
}

function parseAttachments(value: unknown): NonNullable<SubmitInput["attachments"]> {
  if (!Array.isArray(value)) throw new InvalidParamsError("attachments 必须是数组");
  return value.map((raw: unknown, i) => {
    const o = asParams(raw) as Partial<Record<keyof WireAttachment, unknown>>;
    if (typeof o.data !== "string") {
      throw new InvalidParamsError(`attachments[${i}].data 必须是 base64 字符串`);
    }
    if (typeof o.mimeType !== "string") {
      throw new InvalidParamsError(`attachments[${i}].mimeType 必须是字符串`);
    }
    if (o.label !== undefined && typeof o.label !== "string") {
      throw new InvalidParamsError(`attachments[${i}].label 必须是字符串`);
    }
    return {
      data: decodeBase64(o.data, `attachments[${i}].data`),
      mimeType: o.mimeType as WireAttachment["mimeType"],
      ...(o.label !== undefined ? { label: o.label } : {}),
    };
  });
}
